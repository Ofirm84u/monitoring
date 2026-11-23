import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "crypto";

/**
 * Password hashing with Node's built-in scrypt (no extra dependency).
 *
 * Stored format: `scrypt$N$r$p$saltB64$hashB64`. Parameters travel with the
 * hash so they can be raised later without invalidating existing passwords.
 * N=2^15 costs ~32 MB and tens of ms per hash — fine for a login, and the VM is
 * shared with ~30 containers, so we stop short of OWASP's 2^17.
 */

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
// scrypt needs 128*N*r bytes; Node's default 32 MB cap is exactly that, so add headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const key = await derive(password, Buffer.from(saltB64, "base64"), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Burn the same work as a real check. Called when the email is unknown so the
 * response time doesn't reveal which emails have accounts.
 */
let dummyHash: Promise<string> | null = null;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPasswordHash(password, await dummyHash);
  return false;
}

/** A URL-safe random token and the hash we store for it. */
export function newSetupToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSetupToken(token) };
}

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
