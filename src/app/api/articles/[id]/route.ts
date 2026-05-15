import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { assignArticle, deleteArticle, getArticle } from "@/lib/articles";
import { PROJECTS } from "@/lib/projects";

const RATE_LIMIT = { maxAttempts: 30, windowMs: 60 * 1000 };

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

function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) return unauthorized();
  const ip = getClientIp(request);
  if (!checkRateLimit(`article-read:${ip}`, RATE_LIMIT).allowed) {
    return rateLimited();
  }
  const { id } = await params;
  const article = await getArticle(id);
  if (!article) return notFound();
  return NextResponse.json(
    { article },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface PatchBody {
  assignment?: { kind: "project" | "standalone"; projectId?: string | null };
}

export async function PATCH(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) return unauthorized();
  const ip = getClientIp(request);
  if (!checkRateLimit(`article-patch:${ip}`, RATE_LIMIT).allowed) {
    return rateLimited();
  }
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const a = body.assignment;
  if (!a || (a.kind !== "project" && a.kind !== "standalone")) {
    return badRequest("assignment.kind must be project|standalone");
  }

  let projectId: string | null = null;
  if (a.kind === "project") {
    if (typeof a.projectId !== "string") {
      return badRequest("projectId is required when kind=project");
    }
    if (!PROJECTS.some((p) => p.id === a.projectId)) {
      return badRequest(`Unknown projectId: ${a.projectId}`);
    }
    projectId = a.projectId;
  }

  const updated = await assignArticle(id, projectId);
  if (!updated) return notFound();
  return NextResponse.json(
    { article: updated },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) return unauthorized();
  const ip = getClientIp(request);
  if (!checkRateLimit(`article-delete:${ip}`, RATE_LIMIT).allowed) {
    return rateLimited();
  }
  const { id } = await params;
  const ok = await deleteArticle(id);
  if (!ok) return notFound();
  return NextResponse.json(
    { success: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
