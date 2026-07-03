/**
 * Phase 0.5 spike validation (no Google needed). Run with:
 *   SQLITE_PATH=./.data/app.db TOKEN_ENC_KEY=<64-hex> \
 *   node --experimental-strip-types scripts/spike-validate.ts
 *
 * Validates: (1) token encryption at rest, (2) email normalization +
 * allowlist/owner gate, (3) tenant isolation in the data layer.
 */
import { randomBytes, randomUUID } from "crypto";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

// Ensure required env before importing modules that read it.
process.env.TOKEN_ENC_KEY ??= randomBytes(32).toString("hex");
process.env.OWNER_EMAIL = "ofir.schwartz@gmail.com";
process.env.ALLOWED_EMAILS = "dana.dev@gmail.com, sam@example.com";

const { encryptSecret, decryptSecret, maybeDecryptSecret } = await import(
  "../src/lib/crypto.ts"
);
const { normalizeEmail, isOwnerEmail, isAllowedEmail } = await import(
  "../src/lib/email-normalize.ts"
);

console.log("\n— Token encryption (NFR-SEC-3) —");
const secret = "1//refresh-token-abc.DEF_123";
const enc = encryptSecret(secret);
check("ciphertext differs from plaintext", enc !== secret);
check("decrypt roundtrips", decryptSecret(enc) === secret);
check("maybeDecrypt passes through plaintext", maybeDecryptSecret("plain") === "plain");
check("maybeDecrypt decrypts our format", maybeDecryptSecret(enc) === secret);

console.log("\n— Email normalization + gate (NFR-SEC-4) —");
check("gmail dots+tag+googlemail", normalizeEmail("F.o.o+promo@googlemail.com") === "foo@gmail.com");
check("non-gmail keeps dots, drops tag", normalizeEmail("First.Last+x@Acme.CO") === "first.last@acme.co");
check("owner recognized via alias", isOwnerEmail("Ofir.Schwartz+x@googlemail.com"));
check("allowlisted non-owner allowed", isAllowedEmail("dana.dev@gmail.com"));
check("owner is allowed", isAllowedEmail("ofir.schwartz@gmail.com"));
check("stranger rejected", !isAllowedEmail("intruder@evil.com"));

console.log("\n— Tenant isolation (FR-AUTH-6) —");
const { eq } = await import("drizzle-orm");
// Build the drizzle instance inline (mirrors src/db/index.ts) so this runs
// under Node's raw TS loader without the app's extensionless imports.
const { default: Database } = await import("better-sqlite3");
const { drizzle } = await import("drizzle-orm/better-sqlite3");
const schemaMod = await import("../src/db/schema.ts");
const { users, areas } = schemaMod;
const sqlite = new Database(process.env.SQLITE_PATH ?? "./.data/app.db");
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite, { schema: schemaMod });

const aId = `spunit-${randomUUID()}`;
const bId = `spunit-${randomUUID()}`;
try {
  db.insert(users).values([
    { id: aId, email: `${aId}@t.test` },
    { id: bId, email: `${bId}@t.test` },
  ]).run();
  db.insert(areas).values([
    { userId: aId, name: "A-Work" },
    { userId: aId, name: "A-Home" },
    { userId: bId, name: "B-Secret" },
  ]).run();

  // The exact query the route uses: filter by acting user's id.
  const aRows = db.select().from(areas).where(eq(areas.userId, aId)).all();
  const bRows = db.select().from(areas).where(eq(areas.userId, bId)).all();

  check("user A sees exactly their 2 areas", aRows.length === 2);
  check("user A cannot see B's area", !aRows.some((r) => r.name === "B-Secret"));
  check("user B sees exactly their 1 area", bRows.length === 1 && bRows[0].name === "B-Secret");
} finally {
  // Cleanup (cascade removes areas).
  db.delete(users).where(eq(users.id, aId)).run();
  db.delete(users).where(eq(users.id, bId)).run();
}

console.log(`\n${failures === 0 ? "ALL PASS ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
