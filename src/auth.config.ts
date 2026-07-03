import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedEmail, normalizeEmail } from "@/lib/email-normalize";

/**
 * Edge-safe Auth.js configuration (C1).
 *
 * This half holds ONLY things that are safe to run in the Edge runtime:
 * providers and pure callbacks. It deliberately imports no database adapter and
 * nothing that pulls in better-sqlite3, so `middleware.ts` can create an Auth.js
 * instance from it and read the JWT session at the edge without bundling native
 * Node modules. The adapter + db live in `src/auth.ts`, used only in the Node
 * runtime (route handlers, server components).
 *
 * Calendar scope is requested at login (C4) with offline access to obtain a
 * refresh token for per-user Google Calendar sync.
 */

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Google({
      authorization: {
        params: {
          scope: `openid email profile ${CALENDAR_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      const email = normalizeEmail(user.email ?? profile?.email);
      if (!email) return false;
      // Require a Google-verified email (NFR-SEC-4).
      if (
        profile &&
        (profile as { email_verified?: boolean }).email_verified === false
      ) {
        return false;
      }
      // Allowlist gate (FR-AUTH-2): non-allowlisted accounts are rejected.
      return isAllowedEmail(email);
    },
    async jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.uid && session.user) {
        (session.user as { id?: string }).id = token.uid as string;
      }
      return session;
    },
  },
};
