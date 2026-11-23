import { TEAM_ROLES } from "@/db/schema";
import { createSetupLink } from "@/lib/accounts";
import { assertProjectAccess } from "@/lib/access";
import { normalizeEmail } from "@/lib/email-normalize";
import {
  BadRequestError,
  appBaseUrl,
  denied,
  handle,
  json,
  oneOf,
  readBody,
  requiredText,
  requireUser,
} from "@/lib/pm/http";
import { GRANTABLE_ROLES, inviteMember, type GrantableRole } from "@/lib/pm/members";
import type { RequestUser } from "@/lib/request-user";
import { addTeamUser, isTeamAdmin, listTeam, removeTeamUser, setTeamRole } from "@/lib/team";

const EMAIL_MAX = 254;
const MAX_PROJECTS_PER_ADD = 50;

/** The acting admin, or a ready-made error response. */
async function requireAdmin(request: Request): Promise<{ user: RequestUser } | { response: Response }> {
  const user = await requireUser(request);
  if (!user) return { response: json(401, { error: "Unauthorized" }) };
  if (!(await isTeamAdmin(user.email))) return { response: denied(403) };
  return { user };
}

function isSelf(user: RequestUser, email: string): boolean {
  return normalizeEmail(user.email) === normalizeEmail(email);
}

export async function GET(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin(request);
    if ("response" in admin) return admin.response;
    return json(200, { team: await listTeam() });
  });
}

interface ProjectGrant {
  projectId: string;
  role: GrantableRole;
}

function parseProjectGrants(value: unknown): ProjectGrant[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECTS_PER_ADD) {
    throw new BadRequestError("projects must be a list");
  }
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new BadRequestError("Invalid project entry");
    // Narrowed to a non-null object above.
    const { projectId, role } = entry as Record<string, unknown>;
    if (typeof projectId !== "string" || !projectId) throw new BadRequestError("projectId is required");
    return { projectId, role: role === undefined ? "editor" : oneOf(role, GRANTABLE_ROLES, "role") };
  });
}

/**
 * Add someone to the team, optionally inviting them to projects in the same
 * step. Project invites follow normal RBAC: only projects the admin owns.
 * Every grant is checked before anything is written, so a bad project id
 * doesn't leave a half-added user.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin(request);
    if ("response" in admin) return admin.response;
    const { user } = admin;

    const body = await readBody(request);
    const email = requiredText(body.email, EMAIL_MAX, "email");
    const role = body.role === undefined ? "member" : oneOf(body.role, TEAM_ROLES, "role");
    const grants = parseProjectGrants(body.projects);

    for (const grant of grants) {
      const access = await assertProjectAccess(user, grant.projectId, "owner");
      if (!access.ok) return denied(access.status);
    }

    const added = await addTeamUser(email, role, user.id);
    if (!added.ok) return json(added.status, { error: added.error });

    const invited: string[] = [];
    for (const grant of grants) {
      const result = await inviteMember(grant.projectId, email, grant.role);
      // 409 = already invited to that project; harmless here.
      if (result.ok) invited.push(grant.projectId);
    }
    // Hand the admin the link to pass on; the new user picks their own password.
    const link = await createSetupLink(email, user.id, appBaseUrl(request));
    return json(201, {
      email: added.email,
      invitedProjectIds: invited,
      setupUrl: link.ok ? link.url : null,
    });
  });
}

export async function PATCH(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin(request);
    if ("response" in admin) return admin.response;

    const body = await readBody(request);
    const email = requiredText(body.email, EMAIL_MAX, "email");
    if (isSelf(admin.user, email)) throw new BadRequestError("You can't change your own role");

    const result = await setTeamRole(email, oneOf(body.role, TEAM_ROLES, "role"));
    if (!result.ok) return json(result.status, { error: result.error });
    return json(200, { ok: true });
  });
}

/** ?email=… */
export async function DELETE(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin(request);
    if ("response" in admin) return admin.response;

    const email = requiredText(new URL(request.url).searchParams.get("email"), EMAIL_MAX, "email");
    if (isSelf(admin.user, email)) throw new BadRequestError("You can't remove yourself");

    const result = await removeTeamUser(email);
    if (!result.ok) return json(result.status, { error: result.error });
    return json(200, { ok: true, stillAllowedByEnv: result.stillAllowedByEnv });
  });
}
