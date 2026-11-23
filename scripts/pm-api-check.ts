/**
 * PM Hub API end-to-end check: tenant isolation + RBAC over real HTTP.
 *
 * Seeds four users into a throwaway SQLite DB, links each to a Telegram id, and
 * drives the running app as each of them via the bot path (X-Bot-Token +
 * X-Telegram-Id), which resolves to the same RequestUser a Google session does.
 *
 *   SQLITE_PATH=/tmp/pm.db npx drizzle-kit migrate
 *   SQLITE_PATH=/tmp/pm.db BOT_API_TOKEN=test-token npx next dev --port 3041
 *   SQLITE_PATH=/tmp/pm.db BOT_API_TOKEN=test-token BASE_URL=http://localhost:3041 \
 *     node --experimental-strip-types scripts/pm-api-check.ts
 *
 * Never point SQLITE_PATH at a real database: this inserts users.
 */
import { randomUUID } from "crypto";

const { default: Database } = await import("better-sqlite3");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3041";
const BOT_TOKEN = process.env.BOT_API_TOKEN;
const SQLITE_PATH = process.env.SQLITE_PATH;
if (!BOT_TOKEN || !SQLITE_PATH) throw new Error("Set BOT_API_TOKEN and SQLITE_PATH");

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  console.log(`${condition ? "✓" : "✗"} ${name}${condition || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
}

/* ------------------------------- Seed users ------------------------------ */

const run = randomUUID().slice(0, 8);
const sqlite = new Database(SQLITE_PATH);
sqlite.pragma("foreign_keys = ON");

function seedUser(label: string) {
  const id = randomUUID();
  const email = `${label}-${run}@example.com`;
  const telegramId = `tg-${label}-${run}`;
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)").run(id, label, email);
  sqlite.prepare("INSERT INTO telegram_links (user_id, telegram_id, linked_at) VALUES (?, ?, ?)").run(id, telegramId, Date.now());
  // Every request re-checks team membership, so test users must be on the team.
  sqlite.prepare("INSERT INTO allowed_users (id, email, role, created_at) VALUES (?, ?, 'member', ?)").run(randomUUID(), email, Date.now());
  return { id, email, telegramId };
}

const owner = seedUser("owner");
const editor = seedUser("editor");
const viewer = seedUser("viewer");
const outsider = seedUser("outsider");
type Actor = typeof owner;

/* ------------------------------ HTTP helper ------------------------------ */

async function call(actor: Actor | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) {
    headers["X-Bot-Token"] = BOT_TOKEN as string;
    headers["X-Telegram-Id"] = actor.telegramId;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

/* --------------------------------- Checks -------------------------------- */

// Auth
check("no credentials → 401", (await call(null, "GET", "/api/pm/projects")).status === 401);
const unlinked = { ...outsider, telegramId: `tg-nobody-${run}` };
check("bot token + unlinked telegram id → 401", (await call(unlinked, "GET", "/api/pm/projects")).status === 401);

// Project create + validation
const created = await call(owner, "POST", "/api/pm/projects", { name: "Launch", deadline: "2026-12-31" });
check("owner creates project → 201", created.status === 201, created);
const projectId: string = created.data?.project?.id;
check("missing name → 400", (await call(owner, "POST", "/api/pm/projects", {})).status === 400);
check("impossible deadline → 400", (await call(owner, "POST", "/api/pm/projects", { name: "x", deadline: "2026-02-31" })).status === 400);
check("bad status → 400", (await call(owner, "POST", "/api/pm/projects", { name: "x", status: "nope" })).status === 400);

// Isolation before invites
check("outsider GET project → 404", (await call(outsider, "GET", `/api/pm/projects/${projectId}`)).status === 404);
check("not-yet-invited GET project → 404", (await call(editor, "GET", `/api/pm/projects/${projectId}`)).status === 404);
const outsiderList = await call(outsider, "GET", "/api/pm/projects");
check("outsider project list is empty", outsiderList.data?.projects?.length === 0, outsiderList);

// Invites
check("owner invites editor → 201", (await call(owner, "POST", `/api/pm/projects/${projectId}/members`, { email: editor.email, role: "editor" })).status === 201);
check("owner invites viewer → 201", (await call(owner, "POST", `/api/pm/projects/${projectId}/members`, { email: viewer.email.toUpperCase(), role: "viewer" })).status === 201);
check("duplicate invite (case-insensitive) → 409", (await call(owner, "POST", `/api/pm/projects/${projectId}/members`, { email: viewer.email })).status === 409);
check("inviting the owner → 400", (await call(owner, "POST", `/api/pm/projects/${projectId}/members`, { email: owner.email })).status === 400);
check("granting owner role → 400", (await call(owner, "POST", `/api/pm/projects/${projectId}/members`, { email: `x-${run}@example.com`, role: "owner" })).status === 400);

// Claim on first request
const editorView = await call(editor, "GET", `/api/pm/projects/${projectId}`);
check("invited editor can now see project", editorView.status === 200 && editorView.data?.myRole === "editor", editorView);
const pendingMembers = editorView.data?.members ?? [];
check("viewer still pending until first request", pendingMembers.find((m: { email: string }) => m.email === viewer.email)?.status === "pending", pendingMembers);
check("viewer sees project", (await call(viewer, "GET", `/api/pm/projects/${projectId}`)).data?.myRole === "viewer");
const members = (await call(owner, "GET", `/api/pm/projects/${projectId}/members`)).data?.members ?? [];
check("members list: owner + 2 active", members.length === 3 && members.every((m: { status: string }) => m.status === "active"), members);
check("editor cannot invite → 403", (await call(editor, "POST", `/api/pm/projects/${projectId}/members`, { email: `y-${run}@example.com` })).status === 403);
check("outsider cannot invite → 404", (await call(outsider, "POST", `/api/pm/projects/${projectId}/members`, { email: `y-${run}@example.com` })).status === 404);

// Project edit rights
check("editor renames project → 200", (await call(editor, "PATCH", `/api/pm/projects/${projectId}`, { name: "Launch v2" })).status === 200);
check("viewer renames project → 403", (await call(viewer, "PATCH", `/api/pm/projects/${projectId}`, { name: "nope" })).status === 403);
check("editor deletes project → 403", (await call(editor, "DELETE", `/api/pm/projects/${projectId}`)).status === 403);

// Tasks + assignment
const assigned = await call(owner, "POST", "/api/pm/tasks", { text: "Write copy", projectId, assigneeId: editor.id, dueDate: "2026-12-01" });
check("owner creates task assigned to editor → 201", assigned.status === 201 && assigned.data?.task?.assigneeName === "editor", assigned);
const taskId: string = assigned.data?.task?.id;
check("assign to outsider → 400", (await call(owner, "POST", "/api/pm/tasks", { text: "x", projectId, assigneeId: outsider.id })).status === 400);
check("viewer creates task in project → 403", (await call(viewer, "POST", "/api/pm/tasks", { text: "x", projectId })).status === 403);
check("outsider creates task in project → 404", (await call(outsider, "POST", "/api/pm/tasks", { text: "x", projectId })).status === 404);

const editorMy = await call(editor, "GET", "/api/pm/tasks?scope=my");
check("editor's My Tasks includes assigned task", editorMy.data?.tasks?.some((t: { id: string }) => t.id === taskId), editorMy);
const ownerDelegated = await call(owner, "GET", "/api/pm/tasks?scope=delegated");
check("owner's Delegated includes it", ownerDelegated.data?.tasks?.some((t: { id: string }) => t.id === taskId), ownerDelegated);
const ownerMy = await call(owner, "GET", "/api/pm/tasks?scope=my");
check("owner's My Tasks excludes it", !ownerMy.data?.tasks?.some((t: { id: string }) => t.id === taskId), ownerMy);
check("outsider scope=project → 404", (await call(outsider, "GET", `/api/pm/tasks?scope=project&projectId=${projectId}`)).status === 404);

// Outsider cannot touch the task
check("outsider GET task → 404", (await call(outsider, "GET", `/api/pm/tasks/${taskId}`)).status === 404);
check("outsider PATCH task → 404", (await call(outsider, "PATCH", `/api/pm/tasks/${taskId}`, { done: true })).status === 404);
check("outsider DELETE task → 404", (await call(outsider, "DELETE", `/api/pm/tasks/${taskId}`)).status === 404);

// Viewer as assignee may only complete
const viewerTask = await call(owner, "POST", "/api/pm/tasks", { text: "Review", projectId, assigneeId: viewer.id });
const viewerTaskId: string = viewerTask.data?.task?.id;
check("viewer assignee marks done → 200", (await call(viewer, "PATCH", `/api/pm/tasks/${viewerTaskId}`, { done: true })).data?.task?.done === true);
check("viewer assignee edits text → 403", (await call(viewer, "PATCH", `/api/pm/tasks/${viewerTaskId}`, { done: false, text: "x" })).status === 403);
check("viewer completes unassigned task → 403", (await call(viewer, "PATCH", `/api/pm/tasks/${taskId}`, { done: true })).status === 403);

// Delete rules
check("editor deletes owner's task → 403", (await call(editor, "DELETE", `/api/pm/tasks/${viewerTaskId}`)).status === 403);
check("owner deletes task → 200", (await call(owner, "DELETE", `/api/pm/tasks/${viewerTaskId}`)).status === 200);

// Personal tasks are private
const personal = await call(editor, "POST", "/api/pm/tasks", { text: "Dentist" });
const personalId: string = personal.data?.task?.id;
check("personal task → 201", personal.status === 201);
check("owner GET editor's personal task → 404", (await call(owner, "GET", `/api/pm/tasks/${personalId}`)).status === 404);
check("personal task assigned to someone else → 400", (await call(editor, "PATCH", `/api/pm/tasks/${personalId}`, { assigneeId: owner.id })).status === 400);

// Moving a task out of a project unassigns a now-invalid assignee
const moving = await call(editor, "POST", "/api/pm/tasks", { text: "Move me", projectId, assigneeId: owner.id });
const moved = await call(editor, "PATCH", `/api/pm/tasks/${moving.data?.task?.id}`, { projectId: null });
check("move to personal clears other assignee", moved.status === 200 && moved.data?.task?.assigneeId === null, moved);
check("non-owner moving task out of project → 403", (await call(editor, "PATCH", `/api/pm/tasks/${taskId}`, { projectId: null })).status === 403);

// Removal revokes access and unassigns
const editorMember = members.find((m: { userId: string }) => m.userId === editor.id);
check("owner removes editor → 200", (await call(owner, "DELETE", `/api/pm/projects/${projectId}/members/${editorMember?.memberId}`)).status === 200);
check("removed editor GET project → 404", (await call(editor, "GET", `/api/pm/projects/${projectId}`)).status === 404);
check("removed editor GET task → 404", (await call(editor, "GET", `/api/pm/tasks/${taskId}`)).status === 404);
const afterRemoval = await call(owner, "GET", `/api/pm/tasks/${taskId}`);
check("removed editor's task is unassigned", afterRemoval.data?.task?.assigneeId === null, afterRemoval);

// Leaving
const viewerMember = members.find((m: { userId: string }) => m.userId === viewer.id);
check("viewer promotes self → 403", (await call(viewer, "PATCH", `/api/pm/projects/${projectId}/members/${viewerMember?.memberId}`, { role: "editor" })).status === 403);
check("viewer leaves → 200", (await call(viewer, "DELETE", `/api/pm/projects/${projectId}/members/${viewerMember?.memberId}`)).status === 200);
check("viewer gone → 404", (await call(viewer, "GET", `/api/pm/projects/${projectId}`)).status === 404);

// Project delete keeps tasks
check("owner deletes project → 200", (await call(owner, "DELETE", `/api/pm/projects/${projectId}`)).status === 200);
const survivor = await call(owner, "GET", `/api/pm/tasks/${taskId}`);
check("task survives as personal", survivor.status === 200 && survivor.data?.task?.projectId === null, survivor);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
