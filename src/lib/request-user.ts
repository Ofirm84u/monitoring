import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { verifyBotTokenHeader } from "@/lib/auth";
import { isOwnerEmail } from "@/lib/email-normalize";
import { db } from "@/db";
import { users, telegramLinks } from "@/db/schema";

export interface RequestUser {
  id: string;
  email: string | null;
  source: "session" | "bot";
}

/**
 * Resolve the acting tenant for a request (FR-AUTH-6, NFR-SEC-2).
 *
 * 1. A valid Auth.js session → that user.
 * 2. A valid bot token (X-Bot-Token) AND an X-Telegram-Id header → the user
 *    that Telegram id is linked to. Identity is resolved SERVER-SIDE from
 *    telegram_links; we never trust a caller-supplied user id, so a leaked bot
 *    token still cannot impersonate an arbitrary tenant.
 */
export async function getRequestUser(request: Request): Promise<RequestUser | null> {
  const session = await auth();
  const sessionUserId = (session?.user as { id?: string } | undefined)?.id;
  if (sessionUserId) {
    return { id: sessionUserId, email: session?.user?.email ?? null, source: "session" };
  }

  if (verifyBotTokenHeader(request)) {
    const telegramId = request.headers.get("x-telegram-id");
    if (telegramId) {
      const link = await db
        .select({ userId: telegramLinks.userId })
        .from(telegramLinks)
        .where(eq(telegramLinks.telegramId, telegramId))
        .get();
      if (link) {
        const user = await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(eq(users.id, link.userId))
          .get();
        if (user) return { id: user.id, email: user.email, source: "bot" };
      }
    }
  }

  return null;
}

export function isOwner(user: RequestUser | null): boolean {
  return !!user && isOwnerEmail(user.email);
}
