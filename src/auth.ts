import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { authConfig, verifiedSignInEmail } from "@/auth.config";
import { isUserAllowed } from "@/lib/team";
import { authenticate } from "@/lib/accounts";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { normalizeEmail } from "@/lib/email-normalize";

const LOGIN_LIMIT_PER_ACCOUNT = { maxAttempts: 8, windowMs: 15 * 60 * 1000 };
const LOGIN_LIMIT_PER_IP = { maxAttempts: 30, windowMs: 15 * 60 * 1000 };

class TooManyAttempts extends CredentialsSignin {
  code = "rate_limited";
}

/**
 * Email + password (the team's primary sign-in). Node-only: it needs the DB, so
 * it is added here rather than in the edge-safe authConfig. Both limits apply —
 * per account stops guessing one password, per IP stops spraying many.
 */
const passwordProvider = Credentials({
  id: "password",
  credentials: { email: {}, password: {} },
  async authorize(credentials, request) {
    const { email, password } = credentials;
    if (typeof email !== "string" || typeof password !== "string") return null;
    const ip = getClientIp(request);
    const account = normalizeEmail(email) ?? "invalid";
    const perAccount = checkRateLimit(`login:${account}`, LOGIN_LIMIT_PER_ACCOUNT);
    const perIp = checkRateLimit(`login-ip:${ip}`, LOGIN_LIMIT_PER_IP);
    if (!perAccount.allowed || !perIp.allowed) throw new TooManyAttempts();
    return authenticate(email, password);
  },
});

/**
 * Node-runtime Auth.js instance (route handlers, server components).
 *
 * It reuses the edge-safe `authConfig` (providers + callbacks) and adds the
 * Drizzle adapter — which imports better-sqlite3 and therefore must never reach
 * the Edge bundle. OAuth tokens are encrypted at rest (NFR-SEC-3) before the
 * adapter persists them; reads decrypt on demand in src/lib/gcal.ts.
 */

function encryptedAdapter(): Adapter {
  const base = DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });
  return {
    ...base,
    linkAccount: async (account: AdapterAccount): Promise<void> => {
      const enc: AdapterAccount = {
        ...account,
        refresh_token: account.refresh_token
          ? encryptSecret(account.refresh_token)
          : account.refresh_token,
        access_token: account.access_token
          ? encryptSecret(account.access_token)
          : account.access_token,
      };
      await base.linkAccount?.(enc);
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: encryptedAdapter(),
  providers: [...authConfig.providers, passwordProvider],
  callbacks: {
    ...authConfig.callbacks,
    // Allowlist gate (FR-AUTH-2) including people added on the Team page.
    // Password sign-ins were already checked against the team in authenticate().
    async signIn({ user, profile, account }) {
      if (account?.provider === "password") return true;
      return isUserAllowed(verifiedSignInEmail(user, profile));
    },
  },
});
