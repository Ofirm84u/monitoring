import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { readNotes, writeNote, ProjectNote, ProjectStage } from "@/lib/project-notes";

const VALID_STAGES: ProjectStage[] = ["production", "qa", "dev", "paused"];

export async function GET() {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const notes = await readNotes();
  return NextResponse.json(notes, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(`project-notes:${ip}`, { maxAttempts: 30, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }

  let body: { id?: unknown; stage?: unknown; brief?: unknown; nextSteps?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (!VALID_STAGES.includes(body.stage as ProjectStage)) {
    return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
  }
  if (typeof body.brief !== "string") {
    return NextResponse.json({ error: "brief must be a string" }, { status: 400 });
  }
  if (!Array.isArray(body.nextSteps) || body.nextSteps.some((s) => typeof s !== "string")) {
    return NextResponse.json({ error: "nextSteps must be string[]" }, { status: 400 });
  }

  const note: ProjectNote = {
    stage: body.stage as ProjectStage,
    brief: body.brief.slice(0, 500),
    nextSteps: (body.nextSteps as string[]).map((s) => s.slice(0, 200)).filter(Boolean),
  };

  const updated = await writeNote(body.id, note);
  return NextResponse.json(updated, { headers: { "Cache-Control": "no-store" } });
}
