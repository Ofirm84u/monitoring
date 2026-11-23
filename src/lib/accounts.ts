import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { passwordSetupTokens, users } from "@/db/schema";
import { normalizeEmail } from "@/lib/email-normalize";
import { hashPassword, hashSetupToken, newSetupToken, verifyAgainstDummy, verifyPasswordHash } from "@/lib/password";
import { unmetPasswordRules } from "@/lib/password-policy";
import { isUserAllowed } from "@/lib/team";

/**
 * Email + password accounts.
 *
 * Nobody chooses a password without a setup link from an admin (or, for the
 * owner, from their break-glass session). The same link doubles as a password
 * reset: issuing a new one invalidates any earlier unused link for that email.
 */

const SETUP_LINK_TTL_MS = 72 * 60 * 60 * 1000;
const NAME_MAX = 80;

type UserRow = typeof users.$inferSelect;

/**
 * The account for a normalized email. Auth.js-created rows store the email as
 * the provider sent it, so fall back to normalizing every row (team-sized).
 */
export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const exact = await db.select().from(users).where(eq(users.email, email)).get();
  if (exact) return exact;
  const all = await db.select().from(users).all();
  return all.find((row) => normalizeEmail(row.email) === email);
}

export type SetupLinkResult =
  | { ok: true; url: string; expiresAt: Date }
  | { ok: false; status: 400 | 404; error: string };

export async function createSetupLink(
  rawEmail: string,
  createdBy: string | null,
  baseUrl: string,
): Promise<SetupLinkResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, error: "A valid email is required" };
  if (!(await isUserAllowed(email))) return { ok: false, status: 404, error: "Not on the team" };

  const { token, tokenHash } = newSetupToken();
  const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_MS);
  db.transaction((tx) => {
    tx.update(passwordSetupTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordSetupTokens.email, email), isNull(passwordSetupTokens.usedAt)))
      .run();
    tx.insert(passwordSetupTokens).values({ tokenHash, email, expiresAt, createdBy }).run();
  });
  return { ok: true, url: `${baseUrl.replace(/\/$/, "")}/setup?token=${token}`, expiresAt };
}

async function findLiveToken(token: string) {
  return db
    .select()
    .from(passwordSetupTokens)
    .where(
      and(
        eq(passwordSetupTokens.tokenHash, hashSetupToken(token)),
        isNull(passwordSetupTokens.usedAt),
        gt(passwordSetupTokens.expiresAt, new Date()),
      ),
    )
    .get();
}

/** The email a live link is for, so the setup page can show it. */
export async function peekSetupToken(token: string): Promise<{ email: string; hasAccount: boolean } | null> {
  const row = await findLiveToken(token);
  if (!row || !(await isUserAllowed(row.email))) return null;
  const account = await findUserByEmail(row.email);
  return { email: row.email, hasAccount: !!account?.passwordHash };
}

export type CompleteSetupResult =
  | { ok: true; email: string }
  | { ok: false; status: 400 | 404; error: string };

export async function completeSetup(token: string, password: string, rawName: string | null): Promise<CompleteSetupResult> {
  const unmet = unmetPasswordRules(password);
  if (unmet.length > 0) return { ok: false, status: 400, error: `Password needs: ${unmet.join(", ")}` };

  const row = await findLiveToken(token);
  if (!row || !(await isUserAllowed(row.email))) {
    return { ok: false, status: 404, error: "This link is invalid or has expired. Ask an admin for a new one." };
  }

  const passwordHash = await hashPassword(password);
  const name = rawName?.trim().slice(0, NAME_MAX) || null;
  const existing = await findUserByEmail(row.email);

  // Consume the token in the same transaction as the write; the usedAt guard
  // makes a concurrent second submit of the same link a no-op.
  const consumed = db.transaction((tx) => {
    const claim = tx
      .update(passwordSetupTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordSetupTokens.tokenHash, row.tokenHash), isNull(passwordSetupTokens.usedAt)))
      .run();
    if (claim.changes === 0) return false;
    if (existing) {
      tx.update(users)
        .set({ passwordHash, ...(name ? { name } : {}) })
        .where(eq(users.id, existing.id))
        .run();
    } else {
      tx.insert(users).values({ email: row.email, name, passwordHash }).run();
    }
    return true;
  });

  if (!consumed) return { ok: false, status: 404, error: "This link was already used." };
  return { ok: true, email: row.email };
}

/** The account for a correct email + password of a current team member, else null. */
export async function authenticate(
  rawEmail: string,
  password: string,
): Promise<{ id: string; email: string | null; name: string | null } | null> {
  const email = normalizeEmail(rawEmail);
  const account = email ? await findUserByEmail(email) : undefined;
  if (!account?.passwordHash) return verifyAgainstDummy(password).then(() => null);
  if (!(await verifyPasswordHash(password, account.passwordHash))) return null;
  if (!(await isUserAllowed(account.email))) return null;
  return { id: account.id, email: account.email, name: account.name };
}
