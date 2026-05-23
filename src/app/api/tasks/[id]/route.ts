import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { updateTask, deleteTask } from "@/lib/tasks";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authed = await isAuthenticatedOrBot(request);
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const { id } = await params;

  let body: { done?: unknown; projectId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: { done?: boolean; projectId?: string | null } = {};
  if (typeof body.done === "boolean") patch.done = body.done;
  if (body.projectId === null || (typeof body.projectId === "string" && body.projectId)) {
    patch.projectId = body.projectId as string | null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const task = await updateTask(id, patch);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json({ task }, { headers: NO_STORE });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authed = await isAuthenticatedOrBot(request);
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const { id } = await params;
  const deleted = await deleteTask(id);
  if (!deleted) {
    return NextResponse.json({ error: "Task not found" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
