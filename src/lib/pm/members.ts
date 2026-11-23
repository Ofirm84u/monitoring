import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { projectMembers, projects, tasks, users } from "@/db/schema";
import type { MemberRole, MemberStatus } from "@/db/schema";
import { normalizeEmail } from "@/lib/email-normalize";
import { isUserAllowed } from "@/lib/team";
import type { RequestUser } from "@/lib/request-user";

/**
 * Project membership (FR-COLLAB-1..6).
 *
 * An invite is a `project_members` row keyed by normalized email with no
 * `userId`. It becomes an active membership the first time a signed-in user
 * with that email makes a PM request (see claimPendingInvites) — there is no
 * separate accept step, because only allowlisted Google accounts can sign in.
 */

/** Roles an owner may grant. Ownership itself lives on `projects.ownerId`. */
export const GRANTABLE_ROLES = ["editor", "viewer"] as const satisfies readonly MemberRole[];
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export interface MemberView {
  /** Null for the project owner, who has no membership row. */
  memberId: string | null;
  userId: string | null;
  email: string | null;
  name: string | null;
  image: string | null;
  role: MemberRole;
  status: MemberStatus;
}

export async function claimPendingInvites(user: RequestUser): Promise<void> {
  const email = normalizeEmail(user.email);
  if (!email) return;
  await db
    .update(projectMembers)
    .set({ userId: user.id, status: "active" })
    .where(and(eq(projectMembers.invitedEmail, email), isNull(projectMembers.userId)))
    .run();
}

/** Owner first, then every member row (pending invites included). */
export async function listMembers(projectId: string): Promise<MemberView[]> {
  const owner = await db
    .select({ id: users.id, email: users.email, name: users.name, image: users.image })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.ownerId))
    .where(eq(projects.id, projectId))
    .get();

  const rows = await db
    .select({
      memberId: projectMembers.id,
      userId: projectMembers.userId,
      invitedEmail: projectMembers.invitedEmail,
      role: projectMembers.role,
      status: projectMembers.status,
      name: users.name,
      image: users.image,
    })
    .from(projectMembers)
    .leftJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(projectMembers.createdAt)
    .all();

  const ownerView: MemberView[] = owner
    ? [{ memberId: null, userId: owner.id, email: owner.email, name: owner.name, image: owner.image, role: "owner", status: "active" }]
    : [];
  return [
    ...ownerView,
    ...rows.map((row) => ({
      memberId: row.memberId,
      userId: row.userId,
      email: row.invitedEmail,
      name: row.name,
      image: row.image,
      role: row.role,
      status: row.status,
    })),
  ];
}

/** User ids a task in this project may be assigned to: owner + active members. */
export async function listAssignableUserIds(projectId: string): Promise<Set<string>> {
  const members = await listMembers(projectId);
  return new Set(
    members
      .filter((member) => member.status === "active" && member.userId)
      .map((member) => member.userId as string), // filtered to non-null above
  );
}

export type InviteResult =
  | { ok: true; member: MemberView; canSignIn: boolean }
  | { ok: false; status: 400 | 409; error: string };

export async function inviteMember(
  projectId: string,
  rawEmail: string,
  role: GrantableRole,
): Promise<InviteResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, error: "A valid email is required" };

  const ownerEmail = await db
    .select({ email: users.email })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.ownerId))
    .where(eq(projects.id, projectId))
    .get();
  if (normalizeEmail(ownerEmail?.email) === email) {
    return { ok: false, status: 400, error: "That's the project owner" };
  }

  const existing = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.invitedEmail, email)))
    .get();
  if (existing) return { ok: false, status: 409, error: "Already invited" };

  const row = await db
    .insert(projectMembers)
    .values({ projectId, invitedEmail: email, role, status: "pending" })
    .returning()
    .get();

  return {
    ok: true,
    // Not on the team → Google sign-in rejects them, so the invite can never
    // be claimed. Surface it rather than leave a silently dead invite.
    canSignIn: await isUserAllowed(email),
    member: {
      memberId: row.id,
      userId: null,
      email,
      name: null,
      image: null,
      role: row.role,
      status: row.status,
    },
  };
}

export async function findMember(projectId: string, memberId: string) {
  return db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
    .get();
}

export async function setMemberRole(memberId: string, role: GrantableRole): Promise<void> {
  await db.update(projectMembers).set({ role }).where(eq(projectMembers.id, memberId)).run();
}

/**
 * Delete the membership and unassign the user's tasks in this project, so no
 * task is left pointing at someone who can no longer see it.
 */
export async function removeMember(
  member: { id: string; projectId: string; userId: string | null },
): Promise<void> {
  db.transaction((tx) => {
    tx.delete(projectMembers).where(eq(projectMembers.id, member.id)).run();
    if (!member.userId) return;
    tx.update(tasks)
      .set({ assigneeId: null })
      .where(and(eq(tasks.projectId, member.projectId), eq(tasks.assigneeId, member.userId)))
      .run();
  });
}
