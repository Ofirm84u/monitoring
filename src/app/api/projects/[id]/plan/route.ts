import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { listArticles } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";
import { synthesizeProjectPlan } from "@/lib/claude";

const RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 1000 };
const MAX_CODE_CONTEXT_CHARS = 12_000;
const MAX_ARTICLES = 30;

async function loadProjectCodeContext(
  projectId: string,
): Promise<string | null> {
  const envKey = `CODE_CONTEXT_${projectId.toUpperCase().replace(/-/g, "_")}`;
  const path = process.env[envKey];
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf-8");
    if (raw.length <= MAX_CODE_CONTEXT_CHARS) return raw;
    const head = raw.slice(0, Math.floor(MAX_CODE_CONTEXT_CHARS * 0.7));
    const tail = raw.slice(-Math.floor(MAX_CODE_CONTEXT_CHARS * 0.3));
    return `${head}\n\n/* ... [truncated middle of file] ... */\n\n${tail}`;
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

  const allArticles = await listArticles();
  const projectArticles = allArticles
    .filter(
      (a) =>
        a.assignment?.kind === "project" &&
        a.assignment.projectId === project.id,
    )
    .slice(0, MAX_ARTICLES);

  if (projectArticles.length === 0) {
    return json(400, {
      error: "No articles are assigned to this project yet",
    });
  }

  const codeContext = await loadProjectCodeContext(project.id);

  let plan: string;
  try {
    plan = await synthesizeProjectPlan(project, projectArticles, codeContext);
  } catch (err) {
    return json(502, {
      error:
        err instanceof Error ? err.message : "Plan synthesis failed",
    });
  }

  return json(200, {
    project: { id: project.id, name: project.name, stack: project.stack },
    articleCount: projectArticles.length,
    plan,
    generatedAt: new Date().toISOString(),
  });
}
