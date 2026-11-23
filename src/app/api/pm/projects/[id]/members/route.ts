import { assertProjectAccess } from "@/lib/access";
import { denied, handle, json, oneOf, readBody, requiredText, requireUser } from "@/lib/pm/http";
import { GRANTABLE_ROLES, inviteMember, listMembers } from "@/lib/pm/members";

const EMAIL_MAX = 254;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertProjectAccess(user, id);
    if (!access.ok) return denied(access.status);
    return json(200, { members: await listMembers(id) });
  });
}

/** Invite by email. Owner only (FR-COLLAB-1). */
export async function POST(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id } = await params;

    const access = await assertProjectAccess(user, id, "owner");
    if (!access.ok) return denied(access.status);

    const body = await readBody(request);
    const result = await inviteMember(
      id,
      requiredText(body.email, EMAIL_MAX, "email"),
      body.role === undefined ? "editor" : oneOf(body.role, GRANTABLE_ROLES, "role"),
    );
    if (!result.ok) return json(result.status, { error: result.error });
    return json(201, { member: result.member, canSignIn: result.canSignIn });
  });
}
