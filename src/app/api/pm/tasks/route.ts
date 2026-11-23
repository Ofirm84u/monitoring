import { PRIORITIES } from "@/db/schema";
import { assertProjectAccess } from "@/lib/access";
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
import { TASK_SCOPES, TASK_TEXT_MAX, createTask, getTaskView, isValidAssignee, listTasks } from "@/lib/pm/tasks";

/** ?scope=my (default) | delegated | project&projectId=… */
export async function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });

    const { searchParams } = new URL(request.url);
    const scope = oneOf(searchParams.get("scope") ?? "my", TASK_SCOPES, "scope");
    const projectId = optionalId(searchParams.get("projectId"), "projectId");

    if (scope === "project") {
      if (!projectId) throw new BadRequestError("projectId is required for scope=project");
      const access = await assertProjectAccess(user, projectId);
      if (!access.ok) return denied(access.status);
    }
    return json(200, { tasks: await listTasks(user.id, scope, projectId) });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });

    const body = await readBody(request);
    const projectId = optionalId(body.projectId, "projectId");
    if (projectId) {
      const access = await assertProjectAccess(user, projectId, "editor");
      if (!access.ok) return denied(access.status);
    }

    const assigneeId = optionalId(body.assigneeId, "assigneeId");
    if (!(await isValidAssignee(assigneeId, user.id, projectId))) {
      throw new BadRequestError("assigneeId is not a member of this project");
    }

    const task = await createTask(user.id, {
      text: requiredText(body.text, TASK_TEXT_MAX, "text"),
      projectId,
      assigneeId,
      priority: body.priority === undefined ? "medium" : oneOf(body.priority, PRIORITIES, "priority"),
      dueDate: optionalIsoDate(body.dueDate, "dueDate"),
    });
    return json(201, { task: await getTaskView(task.id) });
  });
}
