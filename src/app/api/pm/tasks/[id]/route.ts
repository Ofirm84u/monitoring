import { PRIORITIES } from "@/db/schema";
import type { Task } from "@/db/schema";
import { assertProjectAccess, assertTaskAccess } from "@/lib/access";
import type { RequestUser } from "@/lib/request-user";
import {
  BadRequestError,
  denied,
  handle,
  json,
  oneOf,
  optionalId,
  optionalIsoDate,
  readBody,
  requiredText,
  requireUser,
} from "@/lib/pm/http";
import {
  TASK_TEXT_MAX,
  deleteTask,
  getTask,
  getTaskView,
  isValidAssignee,
  updateTask,
  type TaskPatch,
} from "@/lib/pm/tasks";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertTaskAccess(user, id, "read");
    if (!access.ok) return denied(access.status);
    return json(200, { task: await getTaskView(id) });
  });
}

/**
 * Editors (and the task owner) may change anything. An assignee who is only a
 * viewer may still tick their own task done — being given work you can't mark
 * finished would be absurd — but nothing else.
 */
async function canPatch(user: RequestUser, task: Task, keys: string[]): Promise<403 | 404 | null> {
  const write = await assertTaskAccess(user, task.id, "write");
  if (write.ok) return null;
  const isOnlyCompletion = keys.length === 1 && keys[0] === "done";
  if (write.status === 403 && isOnlyCompletion && task.assigneeId === user.id) return null;
  return write.status;
}

/** Moving a task between projects needs editor on the destination; out to personal, ownership. */
async function checkProjectMove(
  user: RequestUser,
  task: Task,
  nextProjectId: string | null,
): Promise<403 | 404 | null> {
  if (nextProjectId === task.projectId) return null;
  if (!nextProjectId) return task.userId === user.id ? null : 403;
  const access = await assertProjectAccess(user, nextProjectId, "editor");
  return access.ok ? null : access.status;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const task = await getTask(id);
    if (!task) return denied(404);

    const body = await readBody(request);
    const keys = Object.keys(body);
    const patchDenied = await canPatch(user, task, keys);
    if (patchDenied) return denied(patchDenied);

    const patch: TaskPatch = {};
    if (body.text !== undefined) patch.text = requiredText(body.text, TASK_TEXT_MAX, "text");
    if (body.priority !== undefined) patch.priority = oneOf(body.priority, PRIORITIES, "priority");
    if (body.dueDate !== undefined) patch.dueDate = optionalIsoDate(body.dueDate, "dueDate");
    if (body.done !== undefined) {
      if (typeof body.done !== "boolean") throw new BadRequestError("done must be a boolean");
      patch.done = body.done;
    }

    const nextProjectId =
      body.projectId === undefined ? task.projectId : optionalId(body.projectId, "projectId");
    const moveDenied = await checkProjectMove(user, task, nextProjectId);
    if (moveDenied) return denied(moveDenied);
    patch.projectId = nextProjectId;

    if (body.assigneeId !== undefined) {
      const assigneeId = optionalId(body.assigneeId, "assigneeId");
      if (!(await isValidAssignee(assigneeId, task.userId, nextProjectId))) {
        throw new BadRequestError("assigneeId is not a member of this project");
      }
      patch.assigneeId = assigneeId;
    } else if (!(await isValidAssignee(task.assigneeId, task.userId, nextProjectId))) {
      // A move left the current assignee outside the new project; unassign
      // rather than reject, since the caller didn't ask about assignment.
      patch.assigneeId = null;
    }

    await updateTask(id, patch);
    return json(200, { task: await getTaskView(id) });
  });
}

/** Task owner, or the owner of the task's project (FR-TASK-4). */
export async function DELETE(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertTaskAccess(user, id, "read");
    if (!access.ok) return denied(access.status);
    if (!access.isTaskOwner && access.projectRole !== "owner") return denied(403);

    await deleteTask(id);
    return json(200, { ok: true });
  });
}
