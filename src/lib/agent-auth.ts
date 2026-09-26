import { createHmac, timingSafeEqual } from "crypto";

/**
 * Authentication between MonitoringApp and the GitHub Actions workflow.
 *
 * Two directions, two mechanisms, one shared secret:
 *
 *  - Outbound, the workflow fetches its packet. The dispatch payload carries
 *    only ids and a short-lived token, so the plan text never travels through
 *    `client_payload` (which is visible in the Actions UI and in webhook
 *    deliveries) and the packet stays single-source-of-truth.
 *
 *  - Inbound, the workflow reports results. `/api/agent/callback` is the only
 *    new externally reachable surface in this design, so it verifies a
 *    signature over the exact bytes it received and refuses anything stale.
 *
 * Everything here fails closed. With no `AGENT_SECRET` configured, nothing
 * verifies and nothing can be minted — an unconfigured deployment rejects the
 * agent rather than trusting it.
 */

const TOKEN_TTL_MS = 30 * 60 * 1000;
/** Callbacks are refused outside this window, so a captured one can't be replayed later. */
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const SIGNATURE_PREFIX = "sha256=";

export const AGENT_SIGNATURE_HEADER = "x-agent-signature";
export const AGENT_TIMESTAMP_HEADER = "x-agent-timestamp";

function getSecret(): string | null {
  const secret = process.env.AGENT_SECRET;
  if (!secret || secret.length < 32) return null;
  return secret;
}

export function isAgentConfigured(): boolean {
  return getSecret() !== null;
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** Constant-time compare that also tolerates length mismatch without leaking it. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do the work, so a wrong length isn't measurably faster than a wrong value.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Mint the token a workflow run uses to fetch its own packet.
 *
 * Bound to the step *and its attempt*, so a token from a previous attempt stops
 * working the moment the step is re-dispatched — a re-run can't quietly fetch
 * and act on a superseded packet.
 */
export function signPacketToken(
  stepId: string,
  attempt: number,
  ttlMs: number = TOKEN_TTL_MS,
): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const expiresAt = Date.now() + ttlMs;
  const signature = hmacHex(secret, `${stepId}.${attempt}.${expiresAt}`);
  return `${attempt}.${expiresAt}.${signature}`;
}

export type PacketTokenResult =
  | { valid: true; attempt: number }
  | { valid: false; reason: "unconfigured" | "malformed" | "expired" | "bad_signature" };

export function verifyPacketToken(
  stepId: string,
  token: string | null,
): PacketTokenResult {
  const secret = getSecret();
  if (!secret) return { valid: false, reason: "unconfigured" };
  if (!token) return { valid: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  const [attemptRaw, expiresRaw, signature] = parts;
  const attempt = Number(attemptRaw);
  const expiresAt = Number(expiresRaw);
  if (!Number.isInteger(attempt) || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "malformed" };
  }

  // Signature before expiry: an attacker shouldn't learn whether a forged
  // token's embedded timestamp was in range.
  const expected = hmacHex(secret, `${stepId}.${attempt}.${expiresAt}`);
  if (!safeEqual(expected, signature)) return { valid: false, reason: "bad_signature" };
  if (expiresAt < Date.now()) return { valid: false, reason: "expired" };

  return { valid: true, attempt };
}

/** Sign a callback body the way the workflow must sign it. */
export function signPayload(rawBody: string, timestamp: number): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return `${SIGNATURE_PREFIX}${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: "unconfigured" | "missing" | "stale" | "bad_signature" };

/**
 * Verify a callback.
 *
 * The signature covers the timestamp *and* the raw body, so neither can be
 * changed independently: swapping in a different result keeps the old timestamp
 * but breaks the digest, and replaying the whole thing later fails the skew
 * check. Verify against the bytes as received — re-serialising parsed JSON
 * would change them and the signature would never match.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
): SignatureResult {
  const secret = getSecret();
  if (!secret) return { valid: false, reason: "unconfigured" };
  if (!signatureHeader || !timestampHeader) return { valid: false, reason: "missing" };

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "missing" };

  const expected = `${SIGNATURE_PREFIX}${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
  if (!safeEqual(expected, signatureHeader)) {
    return { valid: false, reason: "bad_signature" };
  }

  // Checked after the signature so an unsigned probe learns nothing about clock skew.
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_MAX_AGE_MS) {
    return { valid: false, reason: "stale" };
  }

  return { valid: true };
}
