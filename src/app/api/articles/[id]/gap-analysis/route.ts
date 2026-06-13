import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getArticle, updateArticle } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { analyzeGap } from "@/lib/claude";

const MAX_CODE_CONTEXT_CHARS = 12_000;

async function loadProjectCodeContext(
  projectId: string,
): Promise<string | null> {
  const envKey = `CODE_CONTEXT_${projectId.toUpperCase().replace(/-/g, "_")}`;
  const path = process.env[envKey];
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf-8");
    if (raw.length <= MAX_CODE_CONTEXT_CHARS) return raw;
    // Take the first half and the last quarter — keeps imports + entry points
    // and recent code, which is usually most relevant for gap analysis.
    const head = raw.slice(0, Math.floor(MAX_CODE_CONTEXT_CHARS * 0.7));
    const tail = raw.slice(-Math.floor(MAX_CODE_CONTEXT_CHARS * 0.3));
    return `${head}\n\n/* ... [truncated middle of file] ... */\n\n${tail}`;
  } catch {
    return null;
  }
}

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

  const body = await request.json().catch(() => ({}));
  const overrideProjectId: string | undefined =
    typeof body?.projectId === "string" ? body.projectId : undefined;

  let projectId: string;
  if (overrideProjectId) {
    projectId = overrideProjectId;
  } else {
    if (
      !article.assignment ||
      article.assignment.kind !== "project" ||
      !article.assignment.projectId
    ) {
      return json(400, {
        error: "Article must be assigned to a project before gap analysis",
      });
    }
    projectId = article.assignment.projectId;
  }

  const project = PROJECTS.find((p) => p.id === projectId);
  if (!project) {
    return json(400, { error: "Assigned project no longer exists" });
  }

  const text = article.fullText ?? article.rawTextSnippet;
  if (!text) {
    return json(400, { error: "Article has no text content stored" });
  }

  const codeContext = await loadProjectCodeContext(projectId);

  let gapText: string;
  try {
    gapText = await analyzeGap(project, article.title, text, codeContext);
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
