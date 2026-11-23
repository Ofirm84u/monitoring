import { PRIORITIES, PROJECT_ROLES, PROJECT_STATUSES } from "@/db/schema";
import {
  BadRequestError,
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
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  createProject,
  isOwnArea,
  listProjectsForUser,
} from "@/lib/pm/projects";

/** Projects the caller owns or is an active member of. */
export async function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    return json(200, { projects: await listProjectsForUser(user.id) });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });

    const body = await readBody(request);
    const areaId = optionalId(body.areaId, "areaId");
    if (areaId && !(await isOwnArea(user.id, areaId))) {
      throw new BadRequestError("Unknown areaId");
    }

    const project = await createProject(user.id, {
      name: requiredText(body.name, PROJECT_NAME_MAX, "name"),
      description: optionalText(body.description, PROJECT_DESCRIPTION_MAX),
      status: body.status === undefined ? "planning" : oneOf(body.status, PROJECT_STATUSES, "status"),
      priority: body.priority === undefined ? "medium" : oneOf(body.priority, PRIORITIES, "priority"),
      role: body.role === undefined ? "owner" : oneOf(body.role, PROJECT_ROLES, "role"),
      deadline: optionalIsoDate(body.deadline, "deadline"),
      areaId,
    });
    return json(201, { project });
  });
}
