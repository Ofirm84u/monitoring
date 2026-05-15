import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  createArticle,
  listArticles,
  newArticleId,
  type Article,
  type ArticleSourceKind,
} from "@/lib/articles";
import {
  extractFromPdfBuffer,
  extractFromText,
  extractFromUrl,
  type ExtractedContent,
} from "@/lib/article-extract";
import { analyzeArticle } from "@/lib/claude";

const SUBMIT_RATE_LIMIT = { maxAttempts: 10, windowMs: 60 * 1000 };
const LIST_RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 1000 };
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const SNIPPET_LENGTH = 500;

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function rateLimited() {
  return NextResponse.json(
    { error: "Rate limit exceeded" },
    { status: 429, headers: { "Cache-Control": "no-store" } },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) return unauthorized();
  const ip = getClientIp(request);
  if (!checkRateLimit(`articles-list:${ip}`, LIST_RATE_LIMIT).allowed) {
    return rateLimited();
  }
  try {
    const articles = await listArticles();
    return NextResponse.json(
      { articles },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to load articles" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

interface SubmitBody {
  kind?: ArticleSourceKind;
  url?: string;
  text?: string;
  pdfBase64?: string;
  filename?: string;
}

export async function POST(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) return unauthorized();
  const ip = getClientIp(request);
  if (!checkRateLimit(`articles-submit:${ip}`, SUBMIT_RATE_LIMIT).allowed) {
    return rateLimited();
  }

  let body: SubmitBody;
  try {
    const contentLength = parseInt(
      request.headers.get("content-length") ?? "0",
      10,
    );
    if (contentLength > MAX_BODY_BYTES) {
      return badRequest("Payload too large");
    }
    body = (await request.json()) as SubmitBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (!body.kind || !["url", "text", "pdf"].includes(body.kind)) {
    return badRequest("kind must be url|text|pdf");
  }

  let extracted: ExtractedContent;
  let source: Article["source"];
  try {
    if (body.kind === "url") {
      if (!body.url || typeof body.url !== "string") {
        return badRequest("url is required");
      }
      extracted = await extractFromUrl(body.url);
      source = { kind: "url", url: body.url };
    } else if (body.kind === "text") {
      if (!body.text || typeof body.text !== "string") {
        return badRequest("text is required");
      }
      extracted = extractFromText(body.text);
      source = { kind: "text" };
    } else {
      if (!body.pdfBase64 || typeof body.pdfBase64 !== "string") {
        return badRequest("pdfBase64 is required");
      }
      const buf = Buffer.from(body.pdfBase64, "base64");
      const filename = body.filename ?? "document.pdf";
      extracted = await extractFromPdfBuffer(buf, filename);
      source = { kind: "pdf", filename };
    }
  } catch (err) {
    return badRequest(
      err instanceof Error ? err.message : "Failed to extract content",
    );
  }

  let analysis;
  try {
    analysis = await analyzeArticle(extracted.title, extracted.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json(
      { error: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const article: Article = {
    id: newArticleId(),
    createdAt: new Date().toISOString(),
    source,
    title: analysis.title || extracted.title,
    rawTextSnippet: extracted.text.slice(0, SNIPPET_LENGTH),
    fullText: extracted.text,
    summary: analysis.summary,
    suggestions: analysis.suggestions,
    tags: analysis.tags,
    status: "pending_assignment",
    assignment: null,
    gapAnalysis: null,
  };

  await createArticle(article);
  return NextResponse.json(
    { article },
    { headers: { "Cache-Control": "no-store" } },
  );
}
