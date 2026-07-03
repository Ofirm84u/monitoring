import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Authenticated symmetric encryption for secrets at rest (OAuth refresh/access
 * tokens — NFR-SEC-3). AES-256-GCM; key from TOKEN_ENC_KEY (32 bytes, base64 or
 * hex). Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
 *
 * Fail-closed: if the key is missing/invalid we throw rather than persisting
 * plaintext.
 */
const ALGO = "aes-256-gcm";
const VERSION = "v1";
const KEY_LEN = 32;

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENC_KEY is not set — cannot encrypt secrets at rest");
  }
  const key =
    /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`TOKEN_ENC_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`);
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Invalid encrypted payload format");
  }
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Best-effort decrypt: returns the value as-is if it isn't in our format. */
export function maybeDecryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(`${VERSION}:`)) return value;
  return decryptSecret(value);
}
