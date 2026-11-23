/**
 * Phase 3 RBAC matrix check (FR-COLLAB-3, NFR-SEC-1). Run:
 *   SQLITE_PATH=/tmp/pmhub-fresh.db node --experimental-strip-types scripts/spike-access-check.ts
 *
 * Node's strip-types loader doesn't resolve the "@/" path alias, so this
 * mirrors the exact resolution logic in src/lib/access.ts against an inline DB
 * (same pattern as spike-validate.ts). It proves the access semantics; the real
 * module is type-checked by `next build` and exercised end-to-end in Phase 4.
 */
import { randomUUID } from "crypto";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

const { and, eq } = await import("drizzle-orm");
const { default: Database } = await import("better-sqlite3");
const { drizzle } = await import("drizzle-orm/better-sqlite3");
const schema = await import("../src/db/schema.ts");
const { users, projects, projectMembers, tasks } = schema;

const sqlite = new Database(process.env.SQLITE_PATH ?? "/tmp/pmhub-fresh.db");
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite, { schema });

const RANK = { viewer: 1, editor: 2, owner: 3 } as const;
type Role = keyof typeof RANK;
const satisfies = (role: Role, min: Role) => RANK[role] >= RANK[min];

// --- mirrors assertProjectAccess ---
async function assertProject(userId: string, projectId: string, min: Role) {
  const proj = db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).get();
  if (!proj) return { ok: false as const, status: 404 };
  let role: Role | null = null;
  if (proj.ownerId === userId) role = "owner";
  else {
    const m = db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId), eq(projectMembers.status, "active")))
      .get();
    role = (m?.role as Role) ?? null;
  }
  if (!role) return { ok: false as const, status: 404 };
  if (!satisfies(role, min)) return { ok: false as const, status: 403 };
  return { ok: true as const, role };
}

// --- mirrors assertTaskAccess ---
async function assertTask(userId: string, taskId: string, mode: "read" | "write") {
  const t = db.select({ userId: tasks.userId, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).get();
  if (!t) return { ok: false as const, status: 404 };
  if (t.userId === userId) return { ok: true as const };
  if (!t.projectId) return { ok: false as const, status: 404 };
  return assertProject(userId, t.projectId, mode === "write" ? "editor" : "viewer");
}

const ownerU = `own-${randomUUID()}`;
const editorU = `edt-${randomUUID()}`;
const viewerU = `vwr-${randomUUID()}`;
const pendingU = `pnd-${randomUUID()}`;
const strangerU = `str-${randomUUID()}`;
const projId = randomUUID();
const personalTaskId = randomUUID();
const projTaskId = randomUUID();

try {
  db.insert(users).values([ownerU, editorU, viewerU, pendingU, strangerU].map((id) => ({ id, email: `${id}@t.test` }))).run();
  db.insert(projects).values({ id: projId, ownerId: ownerU, name: "Shared" }).run();
  db.insert(projectMembers).values([
    { projectId: projId, userId: editorU, invitedEmail: `${editorU}@t.test`, role: "editor", status: "active" },
    { projectId: projId, userId: viewerU, invitedEmail: `${viewerU}@t.test`, role: "viewer", status: "active" },
    { projectId: projId, userId: pendingU, invitedEmail: `${pendingU}@t.test`, role: "editor", status: "pending" },
  ]).run();
  db.insert(tasks).values([
    { id: personalTaskId, userId: ownerU, text: "personal" },
    { id: projTaskId, userId: ownerU, projectId: projId, text: "in-project" },
  ]).run();

  console.log("\n— Project access matrix —");
  check("owner passes owner-level", (await assertProject(ownerU, projId, "owner")).ok);
  check("editor passes editor-level", (await assertProject(editorU, projId, "editor")).ok);
  const editorAsOwner = await assertProject(editorU, projId, "owner");
  check("editor denied owner-level → 403", !editorAsOwner.ok && editorAsOwner.status === 403);
  check("viewer passes viewer-level", (await assertProject(viewerU, projId, "viewer")).ok);
  const viewerAsEditor = await assertProject(viewerU, projId, "editor");
  check("viewer denied editor-level → 403", !viewerAsEditor.ok && viewerAsEditor.status === 403);
  const pending = await assertProject(pendingU, projId, "viewer");
  check("pending invite has no access → 404", !pending.ok && pending.status === 404);
  const stranger = await assertProject(strangerU, projId, "viewer");
  check("stranger → 404 (existence not leaked)", !stranger.ok && stranger.status === 404);
  const ghost = await assertProject(ownerU, randomUUID(), "viewer");
  check("non-existent project → 404", !ghost.ok && ghost.status === 404);

  console.log("\n— Task access —");
  check("owner reads own personal task", (await assertTask(ownerU, personalTaskId, "read")).ok);
  const strangerPersonal = await assertTask(strangerU, personalTaskId, "read");
  check("stranger denied personal task → 404", !strangerPersonal.ok && strangerPersonal.status === 404);
  check("viewer reads project task", (await assertTask(viewerU, projTaskId, "read")).ok);
  const viewerWrite = await assertTask(viewerU, projTaskId, "write");
  check("viewer denied write on project task → 403", !viewerWrite.ok && (viewerWrite as { status?: number }).status === 403);
  check("editor writes project task", (await assertTask(editorU, projTaskId, "write")).ok);

  console.log("\n— Removal revokes access (FR-COLLAB-4) —");
  db.delete(projectMembers).where(and(eq(projectMembers.projectId, projId), eq(projectMembers.userId, editorU))).run();
  const removed = await assertProject(editorU, projId, "viewer");
  check("removed member → 404", !removed.ok && removed.status === 404);
  const removedTask = await assertTask(editorU, projTaskId, "read");
  check("removed member loses task visibility → 404", !removedTask.ok && (removedTask as { status?: number }).status === 404);
} finally {
  db.delete(users).where(eq(users.id, ownerU)).run();
  db.delete(users).where(eq(users.id, editorU)).run();
  db.delete(users).where(eq(users.id, viewerU)).run();
  db.delete(users).where(eq(users.id, pendingU)).run();
  db.delete(users).where(eq(users.id, strangerU)).run();
}

console.log(`\n${failures === 0 ? "ALL PASS ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
