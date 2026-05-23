import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { readTasks, createTask } from "@/lib/tasks";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const authed = await isAuthenticatedOrBot(request);
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const tasks = await readTasks();
  return NextResponse.json({ tasks }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const authed = await isAuthenticatedOrBot(request);
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(`tasks:${ip}`, { maxAttempts: 60, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: NO_STORE });
  }

  let body: { text?: unknown; projectId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const projectId =
    typeof body.projectId === "string" && body.projectId ? body.projectId : null;

  const task = await createTask(body.text.trim().slice(0, 500), projectId);
  return NextResponse.json({ task }, { status: 201, headers: NO_STORE });
}
