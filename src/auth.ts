import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { authConfig } from "@/auth.config";

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
});
