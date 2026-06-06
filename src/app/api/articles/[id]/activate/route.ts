import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getArticle, updateArticle } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { planArticleImplementation, planArticleQA } from "@/lib/claude";
import { createTask } from "@/lib/tasks";

const RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 1000 };
const MAX_CODE_CONTEXT_CHARS = 12_000;

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function loadCodeContext(projectId: string): Promise<string | null> {
  const envKey = `CODE_CONTEXT_${projectId.toUpperCase().replace(/-/g, "_")}`;
  const path = process.env[envKey];
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf-8");
    if (raw.length <= MAX_CODE_CONTEXT_CHARS) return raw;
    const head = raw.slice(0, Math.floor(MAX_CODE_CONTEXT_CHARS * 0.7));
    const tail = raw.slice(-Math.floor(MAX_CODE_CONTEXT_CHARS * 0.3));
    return `${head}\n\n/* ... [truncated] ... */\n\n${tail}`;
  } catch {
    return null;
  }
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(`activate:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { id } = await params;
  const article = await getArticle(id);

  if (!article) {
    return json(404, { error: "Article not found" });
  }
  if (article.assignment?.kind !== "project" || !article.assignment.projectId) {
    return json(400, { error: "Article must be assigned to a project before activating" });
  }
  if (!article.summary) {
    return json(400, { error: "Article has no summary — run analysis first" });
  }

  const projectId = article.assignment.projectId;
  const project = PROJECTS.find((p) => p.id === projectId);
  if (!project) {
    return json(400, { error: `Project not found: ${projectId}` });
  }

  const codeContext = await loadCodeContext(projectId);

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

  // Create one task per key idea
  const tasksCreated = await Promise.all(
    (article.summary.keyIdeas ?? []).map((idea) =>
      createTask(idea, projectId),
    ),
  );

  // Mark the article as having an implementation plan
  await updateArticle(id, {
    implementationPlan: {
      projectId,
      generatedAt: new Date().toISOString(),
    },
  });

  return json(200, {
    implementationPlan: implPlan.text,
    qaPlan: qaPlan.text,
    tasksCreated,
    projectId,
    projectName: project.name,
  });
}
