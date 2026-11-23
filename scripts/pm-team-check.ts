/**
 * Team management end-to-end check: admin gating, add-with-projects, role
 * changes, and that removal revokes an already-signed-in user immediately.
 * Same setup as scripts/pm-api-check.ts (throwaway DB + running app):
 *
 *   SQLITE_PATH=/tmp/pm.db BOT_API_TOKEN=test-token BASE_URL=http://localhost:3041 \
 *     node --experimental-strip-types scripts/pm-team-check.ts
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

const run = randomUUID().slice(0, 8);
const sqlite = new Database(SQLITE_PATH);
sqlite.pragma("foreign_keys = ON");

/** A signed-up account linked to Telegram; `teamRole` null = not on the team. */
function seedUser(label: string, teamRole: "admin" | "member" | null) {
  const id = randomUUID();
  const email = `${label}-${run}@example.com`;
  const telegramId = `tg-${label}-${run}`;
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)").run(id, label, email);
  sqlite.prepare("INSERT INTO telegram_links (user_id, telegram_id, linked_at) VALUES (?, ?, ?)").run(id, telegramId, Date.now());
  if (teamRole) {
    sqlite.prepare("INSERT INTO allowed_users (id, email, role, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), email, teamRole, Date.now());
  }
  return { id, email, telegramId };
}
type Actor = ReturnType<typeof seedUser>;

async function call(actor: Actor, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Bot-Token": BOT_TOKEN as string, "X-Telegram-Id": actor.telegramId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

const admin = seedUser("admin", "admin");
const member = seedUser("member", "member");
const stranger = seedUser("stranger", null);

// Gating
check("account not on the team → 401 everywhere", (await call(stranger, "GET", "/api/pm/projects")).status === 401);
check("member GET team → 403", (await call(member, "GET", "/api/pm/team")).status === 403);
check("member adds user → 403", (await call(member, "POST", "/api/pm/team", { email: `x-${run}@example.com` })).status === 403);
const list = await call(admin, "GET", "/api/pm/team");
check("admin GET team → 200 with self", list.status === 200 && list.data?.team?.some((m: { email: string }) => m.email === admin.email), list);

// Add with projects
const adminProject = (await call(admin, "POST", "/api/pm/projects", { name: "Admin's" })).data?.project?.id;
const memberProject = (await call(member, "POST", "/api/pm/projects", { name: "Member's" })).data?.project?.id;
const newEmail = `new-${run}@example.com`;

const notOwned = await call(admin, "POST", "/api/pm/team", { email: newEmail, projects: [{ projectId: memberProject }] });
check("granting a project the admin doesn't own → 404", notOwned.status === 404, notOwned);
const afterReject = await call(admin, "GET", "/api/pm/team");
check("…and nobody was half-added", !afterReject.data?.team?.some((m: { email: string }) => m.email === newEmail));

const added = await call(admin, "POST", "/api/pm/team", { email: newEmail.toUpperCase(), projects: [{ projectId: adminProject, role: "viewer" }] });
check("admin adds user with a project → 201", added.status === 201 && added.data?.invitedProjectIds?.length === 1, added);
const newcomerEntry = (await call(admin, "GET", "/api/pm/team")).data?.team?.find((m: { email: string }) => m.email === newEmail);
check("new user listed as Invited (not signed in yet)", newcomerEntry?.isActive === false && newcomerEntry?.role === "member", newcomerEntry);
check("duplicate add → 409", (await call(admin, "POST", "/api/pm/team", { email: newEmail })).status === 409);
check("invalid email → 400", (await call(admin, "POST", "/api/pm/team", { email: "not-an-email" })).status === 400);
check("bad team role → 400", (await call(admin, "POST", "/api/pm/team", { email: `y-${run}@example.com`, role: "owner" })).status === 400);

// The newcomer signs in for the first time: their project invite is waiting
const newcomer = seedUser("new", null);
const newcomerProject = await call(newcomer, "GET", `/api/pm/projects/${adminProject}`);
check("newcomer can sign in and sees the project as viewer", newcomerProject.status === 200 && newcomerProject.data?.myRole === "viewer", newcomerProject);
const invitePending = await call(admin, "POST", `/api/pm/projects/${adminProject}/members`, { email: `z-${run}@example.com` });
check("project invite for someone off the team flags canSignIn=false", invitePending.data?.canSignIn === false, invitePending);

// Self-protection
check("admin changes own role → 400", (await call(admin, "PATCH", "/api/pm/team", { email: admin.email, role: "member" })).status === 400);
check("admin removes self → 400", (await call(admin, "DELETE", `/api/pm/team?email=${encodeURIComponent(admin.email)}`)).status === 400);

// Promotion
check("admin promotes member → 200", (await call(admin, "PATCH", "/api/pm/team", { email: member.email, role: "admin" })).status === 200);
check("promoted member can now GET team", (await call(member, "GET", "/api/pm/team")).status === 200);
check("demote back → 200", (await call(admin, "PATCH", "/api/pm/team", { email: member.email, role: "member" })).status === 200);
check("PATCH unknown email → 404", (await call(admin, "PATCH", "/api/pm/team", { email: `nobody-${run}@example.com`, role: "admin" })).status === 404);

// Removal revokes immediately, including an already-active session
const task = await call(admin, "POST", "/api/pm/tasks", { text: "For newcomer", projectId: adminProject, assigneeId: newcomer.id });
check("task assigned to newcomer", task.data?.task?.assigneeId === newcomer.id, task);
check("admin removes newcomer → 200", (await call(admin, "DELETE", `/api/pm/team?email=${encodeURIComponent(newEmail)}`)).status === 200);
check("removed user is locked out on the next request", (await call(newcomer, "GET", "/api/pm/projects")).status === 401);
const memberships = sqlite.prepare("SELECT count(*) AS n FROM project_members WHERE invited_email = ?").get(newEmail) as { n: number };
check("their project memberships are gone", memberships.n === 0, memberships);
const unassigned = await call(admin, "GET", `/api/pm/tasks/${task.data?.task?.id}`);
check("their task is unassigned", unassigned.data?.task?.assigneeId === null, unassigned);

const ownerEmail = process.env.OWNER_EMAIL;
if (ownerEmail) {
  check("owner can't be removed → 400", (await call(admin, "DELETE", `/api/pm/team?email=${encodeURIComponent(ownerEmail)}`)).status === 400);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
