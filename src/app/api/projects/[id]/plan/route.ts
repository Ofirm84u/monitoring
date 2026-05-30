import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { listArticles } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { planArticleImplementation, planArticleQA } from "@/lib/claude";

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
  const results: ArticlePlanResult[] = [];
  let totalOutputTokens = 0;
  let i = startIndex;

  while (i < projectArticles.length) {
    const remaining = PHASE_OUTPUT_BUDGET - totalOutputTokens;
    if (remaining < MIN_TOKENS_PER_ARTICLE) break;

    const article = projectArticles[i];

    try {
      // Run impl and QA in parallel — they don't depend on each other
      const [implPlan, qaPlan] = await Promise.all([
        planArticleImplementation(project, article, codeContext),
        planArticleQA(project, article),
      ]);

      const articleTokens = implPlan.outputTokens + qaPlan.outputTokens;
      totalOutputTokens += articleTokens;

      results.push({
        articleIndex: i,
        articleTitle: article.title,
        implementationPlan: implPlan.text,
        qaPlan: qaPlan.text,
        outputTokensUsed: articleTokens,
      });
    } catch (err) {
      return json(502, {
        error: err instanceof Error ? err.message : "Plan generation failed",
        completedCount: i,
        partialPlans: results,
      });
    }

    i++;
  }

  const hasMore = i < projectArticles.length;

  return json(200, {
    project: { id: project.id, name: project.name, stack: project.stack },
    plans: results,
    totalArticles: projectArticles.length,
    startIndex,
    completedCount: i,
    hasMore,
    nextStartIndex: hasMore ? i : null,
    totalOutputTokens,
    generatedAt: new Date().toISOString(),
  });
}
