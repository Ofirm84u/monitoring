import { cookies } from "next/headers";
import { createHmac, timingSafeEqual, randomBytes } from "crypto";

const SESSION_COOKIE = "mon_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Session tokens are HMAC-SHA256 signed values derived from a random session ID
 * and the MONITOR_PASSWORD. This prevents brute-force of the cookie value.
 *
 * We use a server-side in-memory session store. Sessions survive restarts
 * because the token is verifiable via HMAC — if the signature is valid,
 * the session is accepted.
 */
const HMAC_KEY_SOURCE = "monitor-session-signing-key-v1";

function getHmacKey(): string {
  return process.env.MONITOR_PASSWORD ?? HMAC_KEY_SOURCE;
}

/** Sign a session ID to produce a tamper-proof token */
export function signSessionId(sessionId: string): string {
  const hmac = createHmac("sha256", getHmacKey());
  hmac.update(sessionId);
  return `${sessionId}.${hmac.digest("hex")}`;
}

/** Verify a signed token — returns the session ID if valid, null otherwise */
export function verifySessionToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const sessionId = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const hmac = createHmac("sha256", getHmacKey());
  hmac.update(sessionId);
  const expectedSignature = hmac.digest("hex");

  // Timing-safe comparison
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
    return sessionId;
  } catch {
    return null;
  }
}

/** Generate a new cryptographically random session token */
export function generateSessionToken(): string {
  const sessionId = randomBytes(32).toString("hex");
  return signSessionId(sessionId);
}

/** Check if the request has a valid session */
export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE);
  if (!session?.value) return false;
  return verifySessionToken(session.value) !== null;
}

/** Timing-safe password comparison */
export function verifyPassword(input: string): boolean {
  const expected = process.env.MONITOR_PASSWORD ?? "";
  if (!expected) return false;
  try {
    const inputBuf = Buffer.from(input);
    const expectedBuf = Buffer.from(expected);
    if (inputBuf.length !== expectedBuf.length) {
      // Compare against expected anyway to avoid timing leak on length
      timingSafeEqual(expectedBuf, expectedBuf);
      return false;
    }
    return timingSafeEqual(inputBuf, expectedBuf);
  } catch {
    return false;
  }
}

/** Timing-safe secret comparison */
export function verifySecret(input: string, expected: string): boolean {
  if (!expected || !input) return false;
  try {
    const inputBuf = Buffer.from(input);
    const expectedBuf = Buffer.from(expected);
    if (inputBuf.length !== expectedBuf.length) {
      timingSafeEqual(expectedBuf, expectedBuf);
      return false;
    }
    return timingSafeEqual(inputBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function getSessionCookieConfig(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_MAX_AGE,
    path: "/",
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
