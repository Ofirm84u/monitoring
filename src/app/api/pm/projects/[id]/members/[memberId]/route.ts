import { assertProjectAccess } from "@/lib/access";
import { denied, handle, json, oneOf, readBody, requireUser } from "@/lib/pm/http";
import { GRANTABLE_ROLES, findMember, removeMember, setMemberRole } from "@/lib/pm/members";

interface RouteContext {
  params: Promise<{ id: string; memberId: string }>;
}

/** Change a member's role. Owner only. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id, memberId } = await params;

    const access = await assertProjectAccess(user, id, "owner");
    if (!access.ok) return denied(access.status);
    const member = await findMember(id, memberId);
    if (!member) return denied(404);

    const body = await readBody(request);
    await setMemberRole(member.id, oneOf(body.role, GRANTABLE_ROLES, "role"));
    return json(200, { ok: true });
  });
}

/** Remove a member or revoke an invite. The owner can remove anyone; a member can leave. */
export async function DELETE(request: Request, { params }: RouteContext) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    const { id, memberId } = await params;

    const access = await assertProjectAccess(user, id);
    if (!access.ok) return denied(access.status);
    const member = await findMember(id, memberId);
    if (!member) return denied(404);

    const isLeaving = member.userId === user.id;
    if (access.role !== "owner" && !isLeaving) return denied(403);

    await removeMember(member);
    return json(200, { ok: true });
  });
}
