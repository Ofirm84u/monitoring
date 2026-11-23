import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import { projects, tasks, users } from "@/db/schema";
import type { Priority, Task } from "@/db/schema";
import { listAccessibleProjectIds } from "@/lib/access";
import { listAssignableUserIds } from "@/lib/pm/members";

/**
 * PM Hub tasks (FR-TASK-1..4) with team assignment.
 *
 * `userId` is who created/owns the row; `assigneeId` is who should do it. A
 * personal task (no project) is private and can only be assigned to its owner.
 * A project task can be assigned to the project owner or any active member.
 */

export const TASK_TEXT_MAX = 500;

export const TASK_SCOPES = ["my", "delegated", "project"] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

export interface TaskInput {
  text: string;
  projectId: string | null;
  assigneeId: string | null;
  priority: Priority;
  dueDate: string | null;
}

export interface TaskView extends Task {
  projectName: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
}

const assignee = alias(users, "assignee");

function selectTaskViews() {
  return db
    .select({
      task: tasks,
      projectName: projects.name,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
    })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(assignee, eq(assignee.id, tasks.assigneeId));
}

type TaskViewRow = Awaited<ReturnType<ReturnType<typeof selectTaskViews>["all"]>>[number];

function toView({ task, projectName, assigneeName, assigneeEmail }: TaskViewRow): TaskView {
  return { ...task, projectName, assigneeName, assigneeEmail };
}

/**
 * - `my`: what I should do — my own unassigned/self-assigned tasks, plus tasks
 *   assigned to me in projects I can still see.
 * - `delegated`: tasks I created and assigned to someone else.
 * - `project`: every task in one project (caller has already checked access).
 */
export async function listTasks(
  userId: string,
  scope: TaskScope,
  projectId: string | null,
): Promise<TaskView[]> {
  const query = selectTaskViews().orderBy(tasks.done, desc(tasks.createdAt));

  if (scope === "project") {
    if (!projectId) return [];
    return (await query.where(eq(tasks.projectId, projectId)).all()).map(toView);
  }

  if (scope === "delegated") {
    return (
      await query
        .where(and(eq(tasks.userId, userId), ne(tasks.assigneeId, userId)))
        .all()
    ).map(toView);
  }

  const accessible = await listAccessibleProjectIds(userId);
  const mine = and(
    eq(tasks.userId, userId),
    or(isNull(tasks.assigneeId), eq(tasks.assigneeId, userId)),
  );
  const assignedToMe =
    accessible.length > 0
      ? and(eq(tasks.assigneeId, userId), inArray(tasks.projectId, accessible))
      : undefined;
  return (await query.where(assignedToMe ? or(mine, assignedToMe) : mine).all()).map(toView);
}

export async function getTaskView(taskId: string): Promise<TaskView | undefined> {
  const row = await selectTaskViews().where(eq(tasks.id, taskId)).get();
  return row ? toView(row) : undefined;
}

export async function getTask(taskId: string): Promise<Task | undefined> {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).get();
}

/**
 * Whether `assigneeId` may hold a task owned by `ownerId` in `projectId`.
 * Null (unassigned) is always valid.
 */
export async function isValidAssignee(
  assigneeId: string | null,
  ownerId: string,
  projectId: string | null,
): Promise<boolean> {
  if (!assigneeId) return true;
  if (!projectId) return assigneeId === ownerId;
  return (await listAssignableUserIds(projectId)).has(assigneeId);
}

export async function createTask(userId: string, input: TaskInput): Promise<Task> {
  return db.insert(tasks).values({ userId, ...input }).returning().get();
}

export interface TaskPatch extends Partial<TaskInput> {
  done?: boolean;
}

export async function updateTask(taskId: string, patch: TaskPatch): Promise<Task | undefined> {
  const { done, ...rest } = patch;
  const completion =
    done === undefined ? {} : { done, completedAt: done ? new Date() : null };
  return db
    .update(tasks)
    .set({ ...rest, ...completion })
    .where(eq(tasks.id, taskId))
    .returning()
    .get();
}

export async function deleteTask(taskId: string): Promise<void> {
  await db.delete(tasks).where(eq(tasks.id, taskId)).run();
}
