import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { allowedUsers, projectMembers, tasks, users } from "@/db/schema";
import type { TeamRole } from "@/db/schema";
import { isAllowedEmail, isOwnerEmail, normalizeEmail } from "@/lib/email-normalize";

/**
 * Team membership: who may sign in at all (FR-AUTH-2), and who may manage that.
 *
 * Three sources, in precedence order:
 *   1. OWNER_EMAIL — always allowed, always admin, cannot be removed.
 *   2. allowed_users — managed from the Team page.
 *   3. ALLOWED_EMAILS env — bootstrap list; members, editable only on the server.
 *
 * Node-only (imports the DB). The edge middleware never calls this; the
 * Node Auth.js instance and getRequestUser do.
 */

export type EffectiveTeamRole = "owner" | TeamRole;

export async function getTeamRole(rawEmail: string | null | undefined): Promise<EffectiveTeamRole | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  if (isOwnerEmail(email)) return "owner";
  const row = await db
    .select({ role: allowedUsers.role })
    .from(allowedUsers)
    .where(eq(allowedUsers.email, email))
    .get();
  if (row) return row.role;
  return isAllowedEmail(email) ? "member" : null;
}

export async function isUserAllowed(email: string | null | undefined): Promise<boolean> {
  return (await getTeamRole(email)) !== null;
}

export async function isTeamAdmin(email: string | null | undefined): Promise<boolean> {
  const role = await getTeamRole(email);
  return role === "owner" || role === "admin";
}

export interface TeamMemberView {
  email: string;
  role: EffectiveTeamRole;
  /** Where the access comes from; only "team" rows can be edited in the UI. */
  source: "owner" | "team" | "env";
  name: string | null;
  image: string | null;
  /** Has signed in at least once. */
  isActive: boolean;
  createdAt: Date | null;
}

function envEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => normalizeEmail(entry))
    .filter((entry): entry is string => !!entry);
}

export async function listTeam(): Promise<TeamMemberView[]> {
  const ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  const rows = await db.select().from(allowedUsers).orderBy(allowedUsers.createdAt).all();
  // Stored emails aren't normalized (Auth.js writes what Google sends), so
  // match in memory. Fine at team scale.
  const accounts = await db
    .select({ email: users.email, name: users.name, image: users.image })
    .from(users)
    .all();
  const accountByEmail = new Map(
    accounts.map((account) => [normalizeEmail(account.email), account]),
  );

  const view = (email: string, role: EffectiveTeamRole, source: TeamMemberView["source"], createdAt: Date | null): TeamMemberView => {
    const account = accountByEmail.get(email);
    return { email, role, source, createdAt, name: account?.name ?? null, image: account?.image ?? null, isActive: !!account };
  };

  const seen = new Set<string>();
  const team: TeamMemberView[] = [];
  if (ownerEmail) {
    team.push(view(ownerEmail, "owner", "owner", null));
    seen.add(ownerEmail);
  }
  for (const row of rows) {
    if (seen.has(row.email)) continue;
    team.push(view(row.email, row.role, "team", row.createdAt));
    seen.add(row.email);
  }
  for (const email of envEmails()) {
    if (seen.has(email)) continue;
    team.push(view(email, "member", "env", null));
    seen.add(email);
  }
  return team;
}

export type TeamChangeResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function addTeamUser(
  rawEmail: string,
  role: TeamRole,
  addedBy: string,
): Promise<TeamChangeResult & { email?: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, error: "A valid email is required" };
  if (isOwnerEmail(email)) return { ok: false, status: 409, error: "That's the owner account" };

  const existing = await db
    .select({ id: allowedUsers.id })
    .from(allowedUsers)
    .where(eq(allowedUsers.email, email))
    .get();
  if (existing) return { ok: false, status: 409, error: "Already on the team" };

  await db.insert(allowedUsers).values({ email, role, addedBy }).run();
  return { ok: true, email };
}

export async function setTeamRole(rawEmail: string, role: TeamRole): Promise<TeamChangeResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, error: "A valid email is required" };
  const updated = await db
    .update(allowedUsers)
    .set({ role })
    .where(eq(allowedUsers.email, email))
    .returning({ id: allowedUsers.id })
    .get();
  return updated ? { ok: true } : { ok: false, status: 404, error: "Not on the team" };
}

/** User ids whose (unnormalized) stored email normalizes to `email`. */
async function userIdsForEmail(email: string): Promise<string[]> {
  const accounts = await db.select({ id: users.id, email: users.email }).from(users).all();
  return accounts
    .filter((account) => normalizeEmail(account.email) === email)
    .map((account) => account.id);
}

/**
 * Revoke sign-in and every project membership/invite. Their own projects and
 * personal tasks stay in the DB (nothing is destroyed), but they can no longer
 * reach them. Returns whether ALLOWED_EMAILS still lets them in.
 */
export async function removeTeamUser(
  rawEmail: string,
): Promise<TeamChangeResult & { stillAllowedByEnv?: boolean }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, error: "A valid email is required" };
  if (isOwnerEmail(email)) return { ok: false, status: 400, error: "The owner can't be removed" };

  const userIds = await userIdsForEmail(email);
  const membershipMatch =
    userIds.length > 0
      ? or(eq(projectMembers.invitedEmail, email), inArray(projectMembers.userId, userIds))
      : eq(projectMembers.invitedEmail, email);

  db.transaction((tx) => {
    tx.delete(allowedUsers).where(eq(allowedUsers.email, email)).run();
    const memberships = tx
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(membershipMatch)
      .all();
    tx.delete(projectMembers).where(membershipMatch).run();
    const projectIds = memberships.map((membership) => membership.projectId);
    if (userIds.length > 0 && projectIds.length > 0) {
      tx.update(tasks)
        .set({ assigneeId: null })
        .where(and(inArray(tasks.projectId, projectIds), inArray(tasks.assigneeId, userIds)))
        .run();
    }
  });

  return { ok: true, stillAllowedByEnv: isAllowedEmail(email) };
}
