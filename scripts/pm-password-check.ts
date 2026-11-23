/**
 * Email + password sign-in end-to-end: password policy, single-use setup
 * links, real Auth.js credential logins (CSRF → callback → session cookie),
 * reset, rate limiting, and revocation. Same setup as pm-api-check.ts, plus an
 * AUTH_SECRET on the dev server so it can mint sessions:
 *
 *   SQLITE_PATH=/tmp/pm.db BOT_API_TOKEN=test-token AUTH_SECRET=test-secret npx next dev --port 3041
 *   SQLITE_PATH=/tmp/pm.db BOT_API_TOKEN=test-token BASE_URL=http://localhost:3041 \
 *     node --experimental-strip-types scripts/pm-password-check.ts
 *
 * Never point SQLITE_PATH at a real database: this inserts users.
 */
import { randomUUID } from "crypto";

const { default: Database } = await import("better-sqlite3");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3041";
const BOT_TOKEN = process.env.BOT_API_TOKEN;
const SQLITE_PATH = process.env.SQLITE_PATH;
if (!BOT_TOKEN || !SQLITE_PATH) throw new Error("Set BOT_API_TOKEN and SQLITE_PATH");

const GOOD_PASSWORD = "Str0ng!Pass";
const SESSION_COOKIE = "authjs.session-token";
const FAILED_LOGINS_TO_LOCK = 8;

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  console.log(`${condition ? "✓" : "✗"} ${name}${condition || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
}

const run = randomUUID().slice(0, 8);
const sqlite = new Database(SQLITE_PATH);
sqlite.pragma("foreign_keys = ON");

function seedBotUser(label: string, teamRole: "admin" | "member") {
  const id = randomUUID();
  const email = `${label}-${run}@example.com`;
  const telegramId = `tg-${label}-${run}`;
  sqlite.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)").run(id, label, email);
  sqlite.prepare("INSERT INTO telegram_links (user_id, telegram_id, linked_at) VALUES (?, ?, ?)").run(id, telegramId, Date.now());
  sqlite.prepare("INSERT INTO allowed_users (id, email, role, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), email, teamRole, Date.now());
  return { id, email, telegramId };
}
type BotActor = ReturnType<typeof seedBotUser>;

async function api(actor: BotActor | null, method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) {
    headers["X-Bot-Token"] = BOT_TOKEN as string;
    headers["X-Telegram-Id"] = actor.telegramId;
  }
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null) };
}

/**
 * name=value pairs from Set-Cookie, last one per name winning — as a browser
 * does. /api/auth/csrf sets the CSRF cookie twice (middleware's Auth.js
 * wrapper, then the route), and only the second matches the token in the body.
 */
function cookiePairs(response: Response): string[] {
  const byName = new Map<string, string>();
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    byName.set(pair.split("=")[0], pair);
  }
  return [...byName.values()];
}

/** A real Auth.js credentials login. Returns the session cookie, or null. */
async function login(email: string, password: string): Promise<string | null> {
  const csrfResponse = await fetch(`${BASE_URL}/api/auth/csrf`);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
  const response = await fetch(`${BASE_URL}/api/auth/callback/password`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiePairs(csrfResponse).join("; ") },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: BASE_URL }),
  });
  return cookiePairs(response).find((pair) => pair.startsWith(`${SESSION_COOKIE}=`) && pair.length > SESSION_COOKIE.length + 1) ?? null;
}

const tokenOf = (url: string | null | undefined) => new URL(url ?? "http://x/").searchParams.get("token") ?? "";

const admin = seedBotUser("admin", "admin");
const member = seedBotUser("member", "member");
const project = (await api(admin, "POST", "/api/pm/projects", { name: "Shared" })).data?.project?.id;

// Adding a user returns a setup link
const newEmail = `dana-${run}@example.com`;
const added = await api(admin, "POST", "/api/pm/team", { email: newEmail, projects: [{ projectId: project }] });
const token = tokenOf(added.data?.setupUrl);
check("adding a user returns a /setup link", added.status === 201 && added.data?.setupUrl?.includes("/setup?token="), added);
const peek = await api(null, "GET", `/api/pm/setup?token=${token}`);
check("link resolves to the email, no account yet", peek.status === 200 && peek.data?.email === newEmail && peek.data?.hasAccount === false, peek);
check("garbage token → 404", (await api(null, "GET", "/api/pm/setup?token=nope")).status === 404);

// Password policy
for (const [label, weak] of [
  ["8 chars", "Ab1!abcd"],
  ["no uppercase", "lowercase1!"],
  ["no lowercase", "UPPERCASE1!"],
  ["no digit", "NoDigits!!x"],
  ["no symbol", "NoSymbol123"],
]) {
  check(`weak password (${label}) → 400`, (await api(null, "POST", "/api/pm/setup", { token, password: weak })).status === 400);
}
check("weak attempts didn't burn the link", (await api(null, "GET", `/api/pm/setup?token=${token}`)).status === 200);

const setup = await api(null, "POST", "/api/pm/setup", { token, password: GOOD_PASSWORD, name: "Dana" });
check("valid 9+ complex password → 200", setup.status === 200, setup);
check("link is single-use", (await api(null, "POST", "/api/pm/setup", { token, password: GOOD_PASSWORD })).status === 404);
const stored = sqlite.prepare("SELECT password_hash AS h, name FROM user WHERE email = ?").get(newEmail) as { h: string; name: string } | undefined;
check("stored as scrypt hash, never plaintext", !!stored?.h?.startsWith("scrypt$") && !stored.h.includes(GOOD_PASSWORD), stored);
check("name saved", stored?.name === "Dana");
const tokenRow = sqlite.prepare("SELECT count(*) AS n FROM password_setup_tokens WHERE token_hash = ?").get(token) as { n: number };
check("raw token is not stored", tokenRow.n === 0);

// Real logins
check("wrong password → no session", (await login(newEmail, "Wr0ng!Pass")) === null);
check("unknown email → no session", (await login(`ghost-${run}@example.com`, GOOD_PASSWORD)) === null);
const session = await login(newEmail.toUpperCase(), GOOD_PASSWORD);
check("correct password (any case email) → session", session !== null);
const viaSession = await api(null, "GET", `/api/pm/projects/${project}`, undefined, session ?? "");
check("session reaches the project they were added to", viaSession.status === 200 && viaSession.data?.myRole === "editor", viaSession);
check("new member isn't an admin", (await api(null, "GET", "/api/pm/team", undefined, session ?? "")).status === 403);

// Reset: a new link supersedes the old one
const first = tokenOf((await api(admin, "POST", "/api/pm/team/setup-link", { email: newEmail })).data?.url);
const second = await api(admin, "POST", "/api/pm/team/setup-link", { email: newEmail });
check("older link dies when a new one is issued", (await api(null, "GET", `/api/pm/setup?token=${first}`)).status === 404);
const resetPeek = await api(null, "GET", `/api/pm/setup?token=${tokenOf(second.data?.url)}`);
check("reset link knows the account exists", resetPeek.data?.hasAccount === true, resetPeek);
await api(null, "POST", "/api/pm/setup", { token: tokenOf(second.data?.url), password: "N3w#Password" });
check("old password stops working after reset", (await login(newEmail, GOOD_PASSWORD)) === null);
check("new password works", (await login(newEmail, "N3w#Password")) !== null);

// Link gating
check("member can't issue links → 403", (await api(member, "POST", "/api/pm/team/setup-link", { email: newEmail })).status === 403);
check("link for someone off the team → 404", (await api(admin, "POST", "/api/pm/team/setup-link", { email: `x-${run}@example.com` })).status === 404);
check("owner bootstrap without owner session → 401", (await api(null, "POST", "/api/pm/setup/owner")).status === 401);
const expiring = tokenOf((await api(admin, "POST", "/api/pm/team/setup-link", { email: member.email })).data?.url);
sqlite.prepare("UPDATE password_setup_tokens SET expires_at = ? WHERE email = ? AND used_at IS NULL").run(Date.now() - 1000, member.email);
check("expired link → 404", (await api(null, "POST", "/api/pm/setup", { token: expiring, password: GOOD_PASSWORD })).status === 404);

// Rate limiting locks an account after repeated failures, even for the right password
const victimEmail = `victim-${run}@example.com`;
const victimLink = await api(admin, "POST", "/api/pm/team", { email: victimEmail });
await api(null, "POST", "/api/pm/setup", { token: tokenOf(victimLink.data?.setupUrl), password: GOOD_PASSWORD });
for (let attempt = 0; attempt < FAILED_LOGINS_TO_LOCK; attempt++) await login(victimEmail, "Wr0ng!Pass");
check("after 8 failures, even the right password is refused", (await login(victimEmail, GOOD_PASSWORD)) === null);

// Removal revokes a live session and future logins
const liveSession = await login(newEmail, "N3w#Password");
await api(admin, "DELETE", `/api/pm/team?email=${encodeURIComponent(newEmail)}`);
check("removed user's live session → 401", (await api(null, "GET", "/api/pm/projects", undefined, liveSession ?? "")).status === 401);
check("removed user can't log in", (await login(newEmail, "N3w#Password")) === null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
