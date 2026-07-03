/**
 * Phase 1 schema integrity check — verifies the ON DELETE semantics and the
 * recurrence idempotency constraint that the SRS data model depends on. Run:
 *   SQLITE_PATH=/tmp/pmhub-fresh.db node --experimental-strip-types scripts/spike-schema-check.ts
 */
import { randomUUID } from "crypto";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

const { eq } = await import("drizzle-orm");
const { default: Database } = await import("better-sqlite3");
const { drizzle } = await import("drizzle-orm/better-sqlite3");
const schema = await import("../src/db/schema.ts");
const { users, areas, projects, milestones, people, tasks } = schema;

const sqlite = new Database(process.env.SQLITE_PATH ?? "/tmp/pmhub-fresh.db");
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite, { schema });

const uid = `sc-${randomUUID()}`;
const areaId = randomUUID();
const projId = randomUUID();

try {
  db.insert(users).values({ id: uid, email: `${uid}@t.test` }).run();
  db.insert(areas).values({ id: areaId, userId: uid, name: "Work" }).run();
  db.insert(projects).values({ id: projId, ownerId: uid, areaId, name: "P1" }).run();
  db.insert(milestones).values({ projectId: projId, title: "M1", dueDate: "2026-07-01" }).run();
  db.insert(people).values({ projectId: projId, name: "Dana", role: "PM" }).run();
  const standaloneId = randomUUID();
  const projTaskId = randomUUID();
  db.insert(tasks).values([
    { id: standaloneId, userId: uid, areaId, text: "standalone", dueDate: "2026-07-02" },
    { id: projTaskId, userId: uid, areaId, projectId: projId, text: "in-project" },
  ]).run();

  console.log("\n— FR-PROJ-3: project delete cascades sub-resources, preserves tasks —");
  db.delete(projects).where(eq(projects.id, projId)).run();
  check("milestones cascade-deleted", db.select().from(milestones).where(eq(milestones.projectId, projId)).all().length === 0);
  check("people cascade-deleted", db.select().from(people).where(eq(people.projectId, projId)).all().length === 0);
  const survived = db.select().from(tasks).where(eq(tasks.id, projTaskId)).get();
  check("attached task preserved (row survives)", !!survived);
  check("attached task projectId nulled", survived?.projectId === null);

  console.log("\n— FR-AREA-3: area delete nulls areaId on tasks (no orphans) —");
  db.delete(areas).where(eq(areas.id, areaId)).run();
  const t = db.select().from(tasks).where(eq(tasks.id, standaloneId)).get();
  check("task survives area delete", !!t);
  check("task areaId nulled", t?.areaId === null);

  console.log("\n— FR-REC-3: recurrence occurrence is idempotent per (parent, dueDate) —");
  const parentId = randomUUID();
  db.insert(tasks).values({ id: parentId, userId: uid, text: "chore", recurrence: "weekly", dueDate: "2026-07-03" }).run();
  db.insert(tasks).values({ userId: uid, text: "chore", recurrenceParentId: parentId, dueDate: "2026-07-10" }).run();
  let dupRejected = false;
  try {
    db.insert(tasks).values({ userId: uid, text: "chore", recurrenceParentId: parentId, dueDate: "2026-07-10" }).run();
  } catch {
    dupRejected = true;
  }
  check("duplicate (parent, dueDate) rejected by unique index", dupRejected);

  console.log("\n— NULL recurrenceParentId rows don't collide (non-recurring tasks) —");
  let bothInserted = true;
  try {
    db.insert(tasks).values([
      { userId: uid, text: "a", dueDate: "2026-08-01" },
      { userId: uid, text: "b", dueDate: "2026-08-01" },
    ]).run();
  } catch {
    bothInserted = false;
  }
  check("two non-recurring tasks share a dueDate fine", bothInserted);

  console.log("\n— Tenant cascade: deleting the user removes all their rows —");
  db.delete(users).where(eq(users.id, uid)).run();
  check("user's tasks gone", db.select().from(tasks).where(eq(tasks.userId, uid)).all().length === 0);
} finally {
  db.delete(users).where(eq(users.id, uid)).run();
}

console.log(`\n${failures === 0 ? "ALL PASS ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
