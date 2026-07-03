import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { randomUUID } from "crypto";
import type { AdapterAccountType } from "next-auth/adapters";

/**
 * PM Hub data model (SQLite via Drizzle).
 *
 * Auth.js adapter tables (`user`, `account`, `session`, `verificationToken`)
 * follow the standard Auth.js Drizzle schema. With the JWT session strategy the
 * `session` table is unused at runtime, but the adapter still expects it to be
 * defined, so we keep it.
 *
 * App tables are tenant-scoped: every row traces back to a `user` (directly via
 * `userId`/`ownerId`, or transitively through a project). Tenant isolation is
 * enforced server-side on every route (FR-AUTH-6 / NFR-SEC-1); the schema's
 * indexes exist to make those scoped lookups cheap.
 *
 * Dates that represent a calendar day (deadlines, due dates, milestone dates)
 * are stored as ISO `YYYY-MM-DD` TEXT, never timestamps, so all-day Google
 * Calendar mapping stays timezone-stable with no off-by-one (FR-CAL-5).
 * Moments in time (createdAt, updatedAt, completedAt) use epoch-ms integers.
 */

/* ----------------------------- Enum unions ------------------------------- */
// Persisted as TEXT with a compile-time union via `$type<>()`. Kept as exported
// const arrays so the API layer and UI can validate against the same source.

export const PROJECT_STATUSES = [
  "planning",
  "active",
  "blocked",
  "done",
  "archived",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

// The user's self-described relationship to a project (FR-PROJ-1). Distinct from
// MEMBER_ROLES, which governs access control on a shared project.
export const PROJECT_ROLES = ["owner", "contributor", "advisor"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const MEMBER_ROLES = ["owner", "editor", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ["pending", "active"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const RECURRENCES = ["none", "daily", "weekly", "monthly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

/* --------------------------- Auth.js adapter ----------------------------- */

export const users = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
});

export const accounts = sqliteTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    // refresh_token / access_token are stored ENCRYPTED at rest (see src/lib/crypto.ts).
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = sqliteTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
});

export const verificationTokens = sqliteTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/* ----------------------- App (tenant-scoped) tables ----------------------- */

export const areas = sqliteTable(
  "areas",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#3b82f6"),
    order: integer("order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("areas_user_idx").on(t.userId)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Area delete nulls this (FR-AREA-3) rather than cascading away the project.
    areaId: text("area_id").references(() => areas.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<ProjectStatus>().notNull().default("planning"),
    priority: text("priority").$type<Priority>().notNull().default("medium"),
    role: text("role").$type<ProjectRole>().notNull().default("owner"),
    deadline: text("deadline"), // ISO YYYY-MM-DD
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("projects_owner_idx").on(t.ownerId),
    index("projects_area_idx").on(t.areaId),
  ],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Null until a pending invite binds to a real user on first login (FR-COLLAB-2).
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email").notNull(), // normalized at write time
    role: text("role").$type<MemberRole>().notNull().default("viewer"),
    status: text("status").$type<MemberStatus>().notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("project_members_project_idx").on(t.projectId),
    index("project_members_user_idx").on(t.userId),
    index("project_members_email_idx").on(t.invitedEmail),
    // One membership row per (project, invited email).
    uniqueIndex("project_members_project_email_uq").on(
      t.projectId,
      t.invitedEmail,
    ),
  ],
);

export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    dueDate: text("due_date"), // ISO YYYY-MM-DD
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    googleEventId: text("google_event_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("milestones_project_idx").on(t.projectId)],
);

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role"),
    contact: text("contact"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("people_project_idx").on(t.projectId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    areaId: text("area_id").references(() => areas.id, { onDelete: "set null" }),
    // Project delete preserves the task (FR-PROJ-3): null the link, keep the row.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    priority: text("priority").$type<Priority>().notNull().default("medium"),
    dueDate: text("due_date"), // ISO YYYY-MM-DD
    recurrence: text("recurrence").$type<Recurrence>().notNull().default("none"),
    recurrenceParentId: text("recurrence_parent_id"),
    googleEventId: text("google_event_id"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("tasks_user_idx").on(t.userId),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_area_idx").on(t.areaId),
    // Idempotent recurrence materialization (FR-REC-3): a parent chain can have
    // at most one occurrence per due date, so double-completion can't duplicate.
    uniqueIndex("tasks_recurrence_occurrence_uq").on(
      t.recurrenceParentId,
      t.dueDate,
    ),
  ],
);

export const telegramLinks = sqliteTable("telegram_links", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  telegramId: text("telegram_id").notNull().unique(),
  linkedAt: integer("linked_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const telegramLinkCodes = sqliteTable(
  "telegram_link_codes",
  {
    code: text("code").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("telegram_link_codes_user_idx").on(t.userId)],
);

export const calendarSyncState = sqliteTable("calendar_sync_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  syncToken: text("sync_token"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* ------------------------------- Row types ------------------------------- */

export type Area = typeof areas.$inferSelect;
export type NewArea = typeof areas.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
export type Milestone = typeof milestones.$inferSelect;
export type NewMilestone = typeof milestones.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TelegramLink = typeof telegramLinks.$inferSelect;
export type TelegramLinkCode = typeof telegramLinkCodes.$inferSelect;
export type CalendarSyncState = typeof calendarSyncState.$inferSelect;
