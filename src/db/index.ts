import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/**
 * Single SQLite connection for the whole process, reused across HMR reloads in
 * dev via a global. WAL + busy_timeout (NFR-PERF-2) let the web app, bots, and
 * cron write concurrently without SQLITE_BUSY; foreign_keys enforces the
 * schema's ON DELETE rules.
 *
 * A real (non-proxied) drizzle instance is exported because @auth/drizzle-adapter
 * detects the dialect via instanceof. During `next build`, page-data collection
 * runs route modules in parallel workers; pointing those at an in-memory DB
 * avoids file-lock contention while keeping a real instance for detection. The
 * real file is only opened when actually serving.
 */
const IS_BUILD = process.env.NEXT_PHASE === "phase-production-build";
const SQLITE_PATH = IS_BUILD
  ? ":memory:"
  : process.env.SQLITE_PATH ?? "/home/ofir/monitor/app.db";

function createDb() {
  const sqlite = new Database(SQLITE_PATH);
  if (SQLITE_PATH !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
  }
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

type Db = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as { __pmHubDb?: Db };

export const db: Db = globalForDb.__pmHubDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__pmHubDb = db;
}
