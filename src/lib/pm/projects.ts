import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { areas, projectMembers, projects, tasks } from "@/db/schema";
import type { MemberRole, Priority, Project, ProjectRole, ProjectStatus } from "@/db/schema";
import { listAccessibleProjectIds } from "@/lib/access";

/**
 * PM Hub projects (FR-PROJ-1..4). Callers gate access with assertProjectAccess
 * first; these functions trust the ids they're given.
 */

export const PROJECT_NAME_MAX = 120;
export const PROJECT_DESCRIPTION_MAX = 4_000;

export interface ProjectInput {
  name: string;
  description: string | null;
  status: ProjectStatus;
  priority: Priority;
  role: ProjectRole;
  deadline: string | null;
  areaId: string | null;
}

export interface ProjectSummary extends Project {
  myRole: MemberRole;
  openTasks: number;
  doneTasks: number;
  memberCount: number;
}

export async function listProjectsForUser(userId: string): Promise<ProjectSummary[]> {
  const ids = await listAccessibleProjectIds(userId);
  if (ids.length === 0) return [];

  const rows = await db.select().from(projects).where(inArray(projects.id, ids)).all();

  const taskCounts = await db
    .select({
      projectId: tasks.projectId,
      open: sql<number>`sum(case when ${tasks.done} = 0 then 1 else 0 end)`,
      done: sql<number>`sum(case when ${tasks.done} = 1 then 1 else 0 end)`,
    })
    .from(tasks)
    .where(inArray(tasks.projectId, ids))
    .groupBy(tasks.projectId)
    .all();

  const memberships = await db
    .select({ projectId: projectMembers.projectId, userId: projectMembers.userId, role: projectMembers.role, status: projectMembers.status })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, ids))
    .all();

  return rows
    .map((project) => {
      const counts = taskCounts.find((count) => count.projectId === project.id);
      const projectMemberships = memberships.filter((member) => member.projectId === project.id);
      const mine = projectMemberships.find((member) => member.userId === userId && member.status === "active");
      const myRole: MemberRole = project.ownerId === userId ? "owner" : mine?.role ?? "viewer";
      return {
        ...project,
        myRole,
        openTasks: counts?.open ?? 0,
        doneTasks: counts?.done ?? 0,
        // +1 for the owner, who has no membership row.
        memberCount: projectMemberships.filter((member) => member.status === "active").length + 1,
      };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** True when `areaId` is one of the user's own areas (areas are private). */
export async function isOwnArea(userId: string, areaId: string): Promise<boolean> {
  const area = await db
    .select({ id: areas.id })
    .from(areas)
    .where(and(eq(areas.id, areaId), eq(areas.userId, userId)))
    .get();
  return !!area;
}

export async function createProject(ownerId: string, input: ProjectInput): Promise<Project> {
  return db.insert(projects).values({ ownerId, ...input }).returning().get();
}

export async function getProject(projectId: string): Promise<Project | undefined> {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

export async function updateProject(
  projectId: string,
  patch: Partial<ProjectInput>,
): Promise<Project | undefined> {
  return db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning()
    .get();
}

/**
 * Cascades members/milestones/people; tasks survive with projectId nulled
 * (FR-PROJ-3), becoming their creator's personal tasks. A personal task can
 * only be assigned to its owner, so other assignees are cleared first.
 */
export async function deleteProject(projectId: string): Promise<void> {
  db.transaction((tx) => {
    tx.update(tasks)
      .set({ assigneeId: null })
      .where(and(eq(tasks.projectId, projectId), ne(tasks.assigneeId, tasks.userId)))
      .run();
    tx.delete(projects).where(eq(projects.id, projectId)).run();
  });
}
