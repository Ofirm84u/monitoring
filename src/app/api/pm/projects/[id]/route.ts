import { PRIORITIES, PROJECT_ROLES, PROJECT_STATUSES } from "@/db/schema";
import { assertProjectAccess } from "@/lib/access";
import {
  BadRequestError,
  denied,
  handle,
  json,
  oneOf,
  optionalId,
  optionalIsoDate,
  optionalText,
  readBody,
  requiredText,
  requireUser,
} from "@/lib/pm/http";
import { listMembers } from "@/lib/pm/members";
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  deleteProject,
  getProject,
  isOwnArea,
  updateProject,
  type ProjectInput,
} from "@/lib/pm/projects";
import { listTasks } from "@/lib/pm/tasks";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The project with its members and tasks — everything the detail pane needs. */
export async function GET(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertProjectAccess(user, id);
    if (!access.ok) return denied(access.status);

    const [project, members, tasks] = await Promise.all([
      getProject(id),
      listMembers(id),
      listTasks(user.id, "project", id),
    ]);
    return json(200, { project, myRole: access.role, myUserId: user.id, members, tasks });
  });
}

/** Editors may change content; only the owner may file it under one of their areas. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertProjectAccess(user, id, "editor");
    if (!access.ok) return denied(access.status);

    const body = await readBody(request);
    const patch: Partial<ProjectInput> = {};
    if (body.name !== undefined) patch.name = requiredText(body.name, PROJECT_NAME_MAX, "name");
    if (body.description !== undefined) {
      patch.description = optionalText(body.description, PROJECT_DESCRIPTION_MAX);
    }
    if (body.status !== undefined) patch.status = oneOf(body.status, PROJECT_STATUSES, "status");
    if (body.priority !== undefined) patch.priority = oneOf(body.priority, PRIORITIES, "priority");
    if (body.role !== undefined) patch.role = oneOf(body.role, PROJECT_ROLES, "role");
    if (body.deadline !== undefined) patch.deadline = optionalIsoDate(body.deadline, "deadline");
    if (body.areaId !== undefined) {
      if (access.role !== "owner") return denied(403);
      const areaId = optionalId(body.areaId, "areaId");
      if (areaId && !(await isOwnArea(user.id, areaId))) {
        throw new BadRequestError("Unknown areaId");
      }
      patch.areaId = areaId;
    }

    return json(200, { project: await updateProject(id, patch) });
  });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertProjectAccess(user, id, "owner");
    if (!access.ok) return denied(access.status);

    await deleteProject(id);
    return json(200, { ok: true });
  });
}
