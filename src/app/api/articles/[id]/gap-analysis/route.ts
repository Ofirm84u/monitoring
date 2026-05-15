import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getArticle, updateArticle } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { analyzeGap } from "@/lib/claude";

const RATE_LIMIT = { maxAttempts: 10, windowMs: 60 * 1000 };

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`gap-analysis:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { id } = await params;
  const article = await getArticle(id);
  if (!article) return json(404, { error: "Article not found" });

  if (
    !article.assignment ||
    article.assignment.kind !== "project" ||
    !article.assignment.projectId
  ) {
    return json(400, {
      error: "Article must be assigned to a project before gap analysis",
    });
  }

  const project = PROJECTS.find((p) => p.id === article.assignment!.projectId);
  if (!project) {
    return json(400, { error: "Assigned project no longer exists" });
  }

  const text = article.fullText ?? article.rawTextSnippet;
  if (!text) {
    return json(400, { error: "Article has no text content stored" });
  }

  let gapText: string;
  try {
    gapText = await analyzeGap(project, article.title, text);
  } catch (err) {
    return json(502, {
      error: err instanceof Error ? err.message : "Gap analysis failed",
    });
  }

  const updated = await updateArticle(id, {
    gapAnalysis: {
      projectId: project.id,
      text: gapText,
      generatedAt: new Date().toISOString(),
    },
  });

  return json(200, { article: updated });
}
