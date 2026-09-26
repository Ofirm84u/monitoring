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

/* =========================================================================
 * Idea Runner — agent runs, defects, and the gate ladder.
 *
 * Two inputs feed one pipeline: an article idea, or a defect reported through
 * the GUI. Both produce an `agentRuns` row whose `agentSteps` are dispatched to
 * GitHub Actions one at a time. Every gate result is an `agentChecks` row, and
 * anything needing a human answer becomes an `agentDecisions` row surfaced on
 * Telegram.
 *
 * `projectId` here is a `PROJECTS` config id from `src/lib/projects.ts`
 * ("seoapp", "bookme", ...) — deliberately NOT a foreign key to the `projects`
 * table above, which is PM Hub's user-owned project model. The two are
 * different things that happen to share a word.
 * ===================================================================== */

export const RUN_SOURCES = ["article", "defect"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

export const RUN_STATUSES = [
  "planning",
  "baseline",
  "running",
  "awaiting_answer",
  "blocked",
  "completed",
  "failed",
  "aborted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  "queued",
  "dispatched",
  "implemented",
  "verifying",
  "awaiting_decision",
  "merged",
  "rejected",
  "failed",
  "rolled_back",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

// G5 splits by defect tier: a state bug is provable by a component test, a flow
// bug needs a browser, and a purely visual bug cannot be asserted at all — it
// gets a before/after render that a human confirms.
export const GATES = [
  "G0",
  "G1",
  "G2",
  "G3",
  "G4",
  "G5-A",
  "G5-B",
  "G5-C",
] as const;
export type Gate = (typeof GATES)[number];

export const CHECK_STATUSES = ["pass", "fail", "skip", "advisory"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const DECISION_KINDS = ["approve", "question"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

// Tier A is reproducible by a component test, B by a browser test, C by neither.
export const DEFECT_TIERS = ["state", "flow", "visual", "unknown"] as const;
export type DefectTier = (typeof DEFECT_TIERS)[number];

export const DEFECT_STATUSES = [
  "triaging",
  "triaged",
  "needs_info",
  "planned",
  "running",
  "fixed",
  "rejected",
  "failed",
] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

export const DEFECT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const REPORT_SOURCES = ["web", "telegram"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const defects = sqliteTable(
  "defects",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    // A PROJECTS config id, not a `projects` FK — see the block comment above.
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),

    // What the reporter saw, in their words. `whatHappened` is the only one the
    // UI requires — a bug you can't articulate yet is still worth capturing.
    whatHappened: text("what_happened").notNull(),
    whatExpected: text("what_expected"),
    reproSteps: text("repro_steps"),

    // GUI context the screenshot itself doesn't carry. A large share of visual
    // defects are viewport-specific, so these are part of the repro, not metadata.
    route: text("route"),
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),
    userAgent: text("user_agent"),

    // ---- Triage output (null until analyzeDefect has run) ----
    tier: text("tier").$type<DefectTier>().notNull().default("unknown"),
    severity: text("severity").$type<DefectSeverity>(),
    symptom: text("symptom"),
    suspectedCauses: text("suspected_causes", { mode: "json" }).$type<string[]>(),
    // Strings read off the screenshot. These are the index into the codebase:
    // grepping for them locates the component instead of guessing at it.
    visibleStrings: text("visible_strings", { mode: "json" }).$type<string[]>(),
    suspectedFiles: text("suspected_files", { mode: "json" }).$type<string[]>(),
    confidence: text("confidence").$type<ConfidenceLevel>(),
    // What triage still needs before it can plan. Non-empty means ask, not guess.
    missingInfo: text("missing_info", { mode: "json" }).$type<string[]>(),

    status: text("status").$type<DefectStatus>().notNull().default("triaging"),
    triageError: text("triage_error"),
    reportedVia: text("reported_via").$type<ReportSource>().notNull(),
    runId: text("run_id"),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    triagedAt: integer("triaged_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("defects_project_idx").on(t.projectId),
    index("defects_status_idx").on(t.status),
    index("defects_created_idx").on(t.createdAt),
  ],
);

export const defectImages = sqliteTable(
  "defect_images",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    defectId: text("defect_id")
      .notNull()
      .references(() => defects.id, { onDelete: "cascade" }),
    // Content-addressed filename under DEFECT_IMAGES_DIR. Storing the digest
    // separately keeps the on-disk name an implementation detail.
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    // Sniffed from magic bytes, never from what the client claimed.
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("defect_images_defect_idx").on(t.defectId)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    source: text("source").$type<RunSource>().notNull(),
    // An articles.json id or a `defects.id`, depending on `source`.
    sourceId: text("source_id").notNull(),
    projectId: text("project_id").notNull(),
    // The commit the baseline (G0) was measured at. Every later gate compares
    // against this, which is why a run without one cannot start.
    baseSha: text("base_sha"),
    status: text("status").$type<RunStatus>().notNull().default("planning"),
    implementationPlan: text("implementation_plan"),
    qaPlan: text("qa_plan"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("agent_runs_project_idx").on(t.projectId),
    index("agent_runs_status_idx").on(t.status),
    index("agent_runs_source_idx").on(t.source, t.sourceId),
  ],
);

export const agentSteps = sqliteTable(
  "agent_steps",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    // Parsed from the QA plan checklist. G4 grades the diff against these.
    acceptance: text("acceptance", { mode: "json" }).$type<string[]>(),
    status: text("status").$type<StepStatus>().notNull().default("queued"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    attempt: integer("attempt").notNull().default(0),
    // Set when the implementer or verifier hits a decision it shouldn't guess at.
    question: text("question"),
    answer: text("answer"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("agent_steps_run_idx").on(t.runId),
    // A run's steps are ordered and dispatched one at a time; two steps sharing
    // an index would make "which step is next" ambiguous.
    uniqueIndex("agent_steps_run_idx_uq").on(t.runId, t.idx),
  ],
);

/**
 * One active step per repo, enforced by the primary key.
 *
 * Two agents editing the same checkout at once produces diffs that can't be
 * attributed to either step, which would make every gate below meaningless. A
 * lock row is held for the life of a dispatch and released when the step
 * settles. Modelled as its own table rather than a partial unique index so the
 * constraint is legible in the schema and portable across SQLite versions.
 */
export const agentLocks = sqliteTable("agent_locks", {
  projectId: text("project_id").primaryKey(),
  stepId: text("step_id")
    .notNull()
    .references(() => agentSteps.id, { onDelete: "cascade" }),
  acquiredAt: integer("acquired_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentChecks = sqliteTable(
  "agent_checks",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    stepId: text("step_id")
      .notNull()
      .references(() => agentSteps.id, { onDelete: "cascade" }),
    gate: text("gate").$type<Gate>().notNull(),
    status: text("status").$type<CheckStatus>().notNull(),
    summary: text("summary").notNull(),
    // Command output, diff stats, per-criterion verdicts, screenshot ids —
    // whatever makes the verdict auditable after the fact.
    evidence: text("evidence", { mode: "json" }).$type<unknown>(),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("agent_checks_step_idx").on(t.stepId),
    // Re-running a gate on a new attempt appends a row; the latest per gate wins.
    index("agent_checks_gate_idx").on(t.stepId, t.gate),
  ],
);

export const agentDecisions = sqliteTable(
  "agent_decisions",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    stepId: text("step_id")
      .notNull()
      .references(() => agentSteps.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DecisionKind>().notNull(),
    prompt: text("prompt").notNull(),
    // Single-use and expiring: a replayed Telegram button press must not be able
    // to merge the same PR twice.
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    action: text("action"),
    answer: text("answer"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("agent_decisions_step_idx").on(t.stepId)],
);

export type Defect = typeof defects.$inferSelect;
export type NewDefect = typeof defects.$inferInsert;
export type DefectImage = typeof defectImages.$inferSelect;
export type NewDefectImage = typeof defectImages.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type AgentStep = typeof agentSteps.$inferSelect;
export type NewAgentStep = typeof agentSteps.$inferInsert;
export type AgentCheck = typeof agentChecks.$inferSelect;
export type NewAgentCheck = typeof agentChecks.$inferInsert;
export type AgentDecision = typeof agentDecisions.$inferSelect;
export type NewAgentDecision = typeof agentDecisions.$inferInsert;
export type AgentLock = typeof agentLocks.$inferSelect;
