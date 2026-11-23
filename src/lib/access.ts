import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, projectMembers, tasks } from "@/db/schema";
import type { MemberRole } from "@/db/schema";
import type { RequestUser } from "@/lib/request-user";

/**
 * Project-level RBAC (FR-COLLAB-3, NFR-SEC-1).
 *
 * Access to a project and all its sub-resources (milestones, people,
 * project-tasks) is resolved server-side here — never trusted from the client.
 * A user's effective role is the higher of: being the project owner, or an
 * ACTIVE membership row. Pending invites and removed members grant nothing.
 *
 * Existence is not leaked: a caller with no relationship to a project gets 404,
 * identical to a project that does not exist (prevents IDOR enumeration). A
 * caller who IS a member but lacks the required level gets 403.
 */

export const MEMBER_ROLE_RANK: Record<MemberRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function roleSatisfies(role: MemberRole, min: MemberRole): boolean {
  return MEMBER_ROLE_RANK[role] >= MEMBER_ROLE_RANK[min];
}

export type AccessResult =
  | { ok: true; role: MemberRole }
  | { ok: false; status: 403 | 404 };

export type TaskAccessResult =
  | { ok: true; isTaskOwner: boolean; projectRole: MemberRole | null }
  | { ok: false; status: 403 | 404 };

/**
 * Effective role of `userId` on `projectId`, or null if the project doesn't
 * exist or the user has no active relationship to it. Callers that need to
 * distinguish 404 vs 403 should use `assertProjectAccess` instead.
 */
export async function resolveProjectRole(
  userId: string,
  projectId: string,
): Promise<MemberRole | null> {
  const proj = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!proj) return null;
  if (proj.ownerId === userId) return "owner";

  const membership = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, "active"),
      ),
    )
    .get();
  return membership?.role ?? null;
}

/**
 * Gate access to a project at `minRole` (default: viewer). Returns a
 * discriminated result the route maps to 200/403/404.
 */
export async function assertProjectAccess(
  user: RequestUser,
  projectId: string,
  minRole: MemberRole = "viewer",
): Promise<AccessResult> {
  const proj = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!proj) return { ok: false, status: 404 };

  let role: MemberRole | null = null;
  if (proj.ownerId === user.id) {
    role = "owner";
  } else {
    const membership = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, user.id),
          eq(projectMembers.status, "active"),
        ),
      )
      .get();
    role = membership?.role ?? null;
  }

  // Not related to the project at all → 404 (don't reveal it exists).
  if (!role) return { ok: false, status: 404 };
  // A member, but below the required level → 403.
  if (!roleSatisfies(role, minRole)) return { ok: false, status: 403 };
  return { ok: true, role };
}

/**
 * IDs of every project the user can see: owned + active memberships
 * (FR-PROJ-4, FR-COLLAB-6). Used to scope board/list queries.
 */
export async function listAccessibleProjectIds(userId: string): Promise<string[]> {
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.ownerId, userId))
    .all();
  const shared = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, "active"),
      ),
    )
    .all();
  return [...new Set([...owned.map((r) => r.id), ...shared.map((r) => r.id)])];
}

/**
 * Gate access to a single task (FR-TASK-2/-4).
 *
 * - `read`: the task owner, or any viewer+ of the task's project.
 * - `write`: the task owner, or an editor+ of the task's project (content edits;
 *   FR-COLLAB-3). Delete has an extra rule (task owner OR project owner) that the
 *   route enforces using the returned `isTaskOwner` / `projectRole`.
 *
 * Standalone personal tasks (no projectId) are private to their owner.
 */
export async function assertTaskAccess(
  user: RequestUser,
  taskId: string,
  mode: "read" | "write",
): Promise<TaskAccessResult> {
  const task = await db
    .select({ userId: tasks.userId, projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task) return { ok: false, status: 404 };

  const isTaskOwner = task.userId === user.id;
  if (isTaskOwner) return { ok: true, isTaskOwner, projectRole: null };

  // Not the owner: access only via the task's shared project, if any.
  if (!task.projectId) return { ok: false, status: 404 };
  const minRole: MemberRole = mode === "write" ? "editor" : "viewer";
  const access = await assertProjectAccess(user, task.projectId, minRole);
  if (!access.ok) return access;
  return { ok: true, isTaskOwner: false, projectRole: access.role };
}
