import { NextResponse, after } from "next/server";
import { readFile } from "fs/promises";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getArticle } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { createTask } from "@/lib/tasks";
import { createRun, findRunBySource, listSteps } from "@/lib/runs";
import { fillArticlePlans } from "@/lib/article-planning";

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

  // Create one task per key idea — sequential to avoid concurrent writes to
  // tasks.json.tmp. These come from the summary, not the plan, so they need no
  // model call and belong on the fast path.
  const tasksCreated = [];
  for (const idea of article.summary.keyIdeas ?? []) {
    tasksCreated.push(await createTask(idea, projectId));
  }

  // Reuse a run that was left mid-planning rather than stacking a duplicate on
  // top of it. A run stuck at "planning" with no steps is the signature of a
  // process that died before its plans landed; re-activating is how you retry.
  const run = (await resumableRun(id)) ?? (await createRun({
    source: "article",
    sourceId: id,
    projectId,
  }));

  // The two planning calls take tens of seconds. Holding the response open for
  // them is what lost every result in production: a restart mid-flight left the
  // caller with a 502 and the database with nothing. `after()` keeps the work
  // on this process without keeping the caller waiting for it.
  after(() => fillArticlePlans({ runId: run.id, articleId: id, project, article, codeContext }));

  return json(202, {
    runId: run.id,
    status: "planning",
    // Planning is no longer finished when this returns, so the only honest
    // answer about steps is where to look for them.
    statusUrl: `/api/agent/runs/${run.id}`,
    tasksCreated,
    projectId,
    projectName: project.name,
  });
}

/**
 * A previous run for this article that never got past planning, if there is one.
 *
 * Narrow on purpose: a run with steps already parsed is a real run, and
 * re-activating should plan afresh rather than silently adopt it.
 */
async function resumableRun(articleId: string) {
  const existing = await findRunBySource("article", articleId);
  if (!existing) return null;
  if (existing.status !== "planning" && existing.status !== "failed") return null;
  const steps = await listSteps(existing.id);
  return steps.length === 0 ? existing : null;
}
