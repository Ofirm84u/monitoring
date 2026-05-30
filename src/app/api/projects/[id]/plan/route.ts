import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { listArticles } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { planArticleImplementation, planArticleQA } from "@/lib/claude";
import { updateArticle } from "@/lib/articles";

const RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 1000 };
const MAX_CODE_CONTEXT_CHARS = 12_000;
const MAX_ARTICLES = 30;

// Stop before starting a new article if remaining budget < this.
// impl (3500) + qa (2500) + 500 buffer = 6500
const MIN_TOKENS_PER_ARTICLE = 6_500;
const PHASE_OUTPUT_BUDGET = 30_000;

export interface ArticlePlanResult {
  articleIndex: number;
  articleTitle: string;
  implementationPlan: string;
  qaPlan: string;
  outputTokensUsed: number;
}

async function loadProjectCodeContext(projectId: string): Promise<string | null> {
  const envKey = `CODE_CONTEXT_${projectId.toUpperCase().replace(/-/g, "_")}`;
  const path = process.env[envKey];
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf-8");
    if (raw.length <= MAX_CODE_CONTEXT_CHARS) return raw;
    const head = raw.slice(0, Math.floor(MAX_CODE_CONTEXT_CHARS * 0.7));
    const tail = raw.slice(-Math.floor(MAX_CODE_CONTEXT_CHARS * 0.3));
    return `${head}\n\n/* ... [truncated middle] ... */\n\n${tail}`;
  } catch {
    return null;
  }
}

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
  if (!checkRateLimit(`project-plan:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { id } = await params;
  const project = PROJECTS.find((p) => p.id === id);
  if (!project) return json(404, { error: "Project not found" });

  const body = await request.json().catch(() => ({})) as { startIndex?: number };
  const startIndex = typeof body.startIndex === "number" && body.startIndex >= 0
    ? body.startIndex
    : 0;

  const allArticles = await listArticles();
  const projectArticles = allArticles
    .filter(
      (a) =>
        a.assignment?.kind === "project" &&
        a.assignment.projectId === project.id,
    )
    .slice(0, MAX_ARTICLES);

  if (projectArticles.length === 0) {
    return json(400, { error: "No articles assigned to this project yet" });
  }

  if (startIndex >= projectArticles.length) {
    return json(400, { error: "startIndex is out of range" });
  }

  const codeContext = await loadProjectCodeContext(project.id);
  // Process exactly ONE article per request to stay within Caddy's proxy timeout.
  // The frontend calls this endpoint once per article and accumulates results.
  const article = projectArticles[startIndex];

  let implPlan: Awaited<ReturnType<typeof planArticleImplementation>>;
  let qaPlan: Awaited<ReturnType<typeof planArticleQA>>;

  try {
    [implPlan, qaPlan] = await Promise.all([
      planArticleImplementation(project, article, codeContext),
      planArticleQA(project, article),
    ]);
  } catch (err) {
    return json(502, {
      error: err instanceof Error ? err.message : "Plan generation failed",
    });
  }

  await updateArticle(article.id, {
    implementationPlan: {
      projectId: project.id,
      generatedAt: new Date().toISOString(),
    },
  });

  const nextIndex = startIndex + 1;
  const hasMore = nextIndex < projectArticles.length;

  return json(200, {
    project: { id: project.id, name: project.name, stack: project.stack },
    plan: {
      articleIndex: startIndex,
      articleTitle: article.title,
      implementationPlan: implPlan.text,
      qaPlan: qaPlan.text,
      outputTokensUsed: implPlan.outputTokens + qaPlan.outputTokens,
    } satisfies ArticlePlanResult,
    totalArticles: projectArticles.length,
    startIndex,
    hasMore,
    nextStartIndex: hasMore ? nextIndex : null,
    generatedAt: new Date().toISOString(),
  });
}
