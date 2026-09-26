/**
 * Phase 1 validation for the Idea Runner. No API key, no network. Run with:
 *   SQLITE_PATH=./.data/app.db DEFECT_IMAGES_DIR=./.data/defect-images \
 *   node --experimental-strip-types scripts/agent-validate.ts
 *
 * Covers the four things Phase 1 claims: images are admitted by their bytes and
 * nothing else, plans survive as runs and steps, one repo can only have one
 * active step, and a decision token spends exactly once.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

async function expectReject(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

// Keep test images out of the real store.
const imagesDir = mkdtempSync(join(tmpdir(), "defect-images-"));
process.env.DEFECT_IMAGES_DIR = imagesDir;
process.env.SQLITE_PATH ??= "./.data/app.db";

const { sniffMediaType, storeDefectImage, readDefectImage } = await import(
  "../src/lib/defect-images.ts"
);
const { parsePlanSteps, parseAcceptanceCriteria, buildSteps } = await import(
  "../src/lib/plan-parse.ts"
);

/* ---------------------------------------------------------------- images -- */
console.log("\n— Image admission is decided by magic bytes —");

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(64),
]);
const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
  "utf8",
);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(64)]);

check("PNG is recognised", sniffMediaType(PNG) === "image/png");
check("JPEG is recognised", sniffMediaType(JPEG) === "image/jpeg");
check("WebP is recognised", sniffMediaType(WEBP) === "image/webp");
check("SVG is refused — it is a script container", sniffMediaType(SVG) === null);
check("GIF is refused — not on the allowlist", sniffMediaType(GIF) === null);
check(
  "a RIFF file that is not WebP is refused",
  sniffMediaType(
    Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WAVE", "ascii"),
      Buffer.alloc(64),
    ]),
  ) === null,
);

await expectReject("an SVG claiming to be a screenshot is rejected", () =>
  storeDefectImage(SVG.toString("base64")),
);
await expectReject("an empty payload is rejected", () => storeDefectImage(""));

const stored = await storeDefectImage(PNG.toString("base64"));
check("a real PNG is stored", stored.mediaType === "image/png");
check(
  "storage is content-addressed",
  stored.filename === `${stored.sha256}.png`,
);
const readBack = await readDefectImage(stored.filename);
check("stored bytes read back identically", !!readBack && readBack.equals(PNG));

const again = await storeDefectImage(PNG.toString("base64"));
check("the same screenshot twice is one file", again.filename === stored.filename);

check(
  "path traversal in a filename reads nothing",
  (await readDefectImage("../../etc/passwd")) === null,
);

/* ----------------------------------------------------------- plan parsing -- */
console.log("\n— Plans become steps, not key ideas —");

const SAMPLE_PLAN = `# תכנית יישום — Cache SERP lookups

## תמצית השינוי
שתי שורות.

## שלבי יישום

### שלב 1 — הוספת שכבת cache
**מה לשנות:** להוסיף Redis cache.
\`\`\`typescript
const cached = await redis.get(key);
\`\`\`
**תוצאה מצופה:** פחות קריאות.

### שלב 2 — פינוי cache במחיקת פרויקט
**מה לשנות:** invalidate.
**תוצאה מצופה:** אין stale data.

## טבלת עדיפויות
| שלב | מורכבות |

## פרומפט ל-Claude Code
\`\`\`
prompt here
\`\`\`

## סטטוס תכנית
בדוק שהכל הושלם.`;

const SAMPLE_QA = `# תכנית QA

## בדיקות עשן (Smoke Tests)
- [ ] הדף נטען ללא שגיאות console
- [ ] cache מחזיר תוצאה זהה לקריאה ישירה
- [ ] מחיקת פרויקט מנקה את ה-cache

## סקירת קוד — Checklist
- [ ] אין רגרסיות בפונקציונליות קיימת
- [ ] [placeholder שלא מולא]
`;

const steps = parsePlanSteps(SAMPLE_PLAN);
check("both plan steps are found", steps.length === 2);
check(
  "step titles come from the plan headings",
  steps[0]?.title.includes("שלב 1") === true,
);
check(
  "a step keeps its code block, not a summary",
  steps[0]?.instruction.includes("redis.get") === true,
);
check(
  "the priorities table is not treated as a step",
  !steps.some((s) => s.title.includes("טבלת")),
);
check(
  "the Claude Code prompt section is not treated as a step",
  !steps.some((s) => s.title.includes("פרומפט")),
);
check(
  "the plan-status section is not treated as a step",
  !steps.some((s) => s.title.includes("סטטוס")),
);

const criteria = parseAcceptanceCriteria(SAMPLE_QA);
check("checklist items become acceptance criteria", criteria.length === 4);
check(
  "unfilled template placeholders are dropped",
  !criteria.some((c) => c.startsWith("[")),
);

const built = buildSteps(SAMPLE_PLAN, SAMPLE_QA);
check("every step carries the acceptance criteria", built.every((s) => s.acceptance.length === 4));
check(
  "an unparseable plan still yields one actionable step",
  buildSteps("no headings at all, just prose", SAMPLE_QA).length === 1,
);

/* ------------------------------------------------------------------ runs -- */
console.log("\n— Runs, the per-repo lock, and single-use decisions —");

// Build the drizzle instance inline (mirrors src/db/index.ts, same reason as
// scripts/spike-validate.ts): this runs under Node's raw TS loader, which
// resolves neither the app's extensionless imports nor its "@/" alias. So the
// guarantees below are exercised against the real schema directly — the lock,
// the cascade, and the single-use redemption are enforced by SQLite, which is
// the part worth proving. The thin wrappers in src/lib/runs.ts that issue these
// same statements are covered over HTTP in Phase 2.
const { eq, and, isNull } = await import("drizzle-orm");
const { default: Database } = await import("better-sqlite3");
const { drizzle } = await import("drizzle-orm/better-sqlite3");
const schema = await import("../src/db/schema.ts");

const sqlite = new Database(process.env.SQLITE_PATH ?? "./.data/app.db");
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite, { schema });
const { agentRuns, agentSteps, agentLocks, agentDecisions } = schema;

const PROJECT = `validate-${Date.now()}`;
let runId: string | null = null;

try {
  const [run] = db
    .insert(agentRuns)
    .values({
      source: "article",
      sourceId: "validate-article",
      projectId: PROJECT,
      implementationPlan: SAMPLE_PLAN,
      qaPlan: SAMPLE_QA,
      status: "planning",
    })
    .returning()
    .all();
  runId = run.id;

  check("a run persists the implementation plan", run.implementationPlan === SAMPLE_PLAN);
  check("a run persists the QA plan", run.qaPlan === SAMPLE_QA);
  check("a new run has no baseline — nothing can be compared yet", run.baseSha === null);

  const created = db
    .insert(agentSteps)
    .values(
      built.map((step, idx) => ({
        runId: run.id,
        idx,
        title: step.title,
        instruction: step.instruction,
        acceptance: step.acceptance,
      })),
    )
    .returning()
    .all();
  check("steps are created for the run", created.length === built.length);

  const ordered = db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, run.id))
    .orderBy(agentSteps.idx)
    .all();
  check(
    "steps are ordered and indexed from zero",
    ordered[0]?.idx === 0 && ordered[1]?.idx === 1,
  );
  check(
    "acceptance criteria survive the round trip as JSON",
    (ordered[0]?.acceptance ?? []).length === 4,
  );

  let duplicateIdxRejected = false;
  try {
    db.insert(agentSteps)
      .values({ runId: run.id, idx: 0, title: "dupe", instruction: "dupe" })
      .run();
  } catch {
    duplicateIdxRejected = true;
  }
  check("two steps cannot share an index in one run", duplicateIdxRejected);

  // One active step per repo — the primary key is what enforces it.
  db.insert(agentLocks).values({ projectId: PROJECT, stepId: ordered[0].id }).run();
  let secondLockRejected = false;
  try {
    db.insert(agentLocks).values({ projectId: PROJECT, stepId: ordered[1].id }).run();
  } catch {
    secondLockRejected = true;
  }
  check("a second step cannot take the same repo's lock", secondLockRejected);

  db.delete(agentLocks).where(eq(agentLocks.projectId, PROJECT)).run();
  db.insert(agentLocks).values({ projectId: PROJECT, stepId: ordered[1].id }).run();
  check(
    "the lock is reusable once released",
    db.select().from(agentLocks).where(eq(agentLocks.projectId, PROJECT)).all().length === 1,
  );

  // Single-use decision tokens: the conditional update is what makes two
  // racing button presses resolve in the database rather than in app code.
  const [decision] = db
    .insert(agentDecisions)
    .values({
      stepId: ordered[0].id,
      kind: "approve",
      prompt: "Merge PR #1?",
      token: "validate-token-1",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
    .all();

  const firstUse = db
    .update(agentDecisions)
    .set({ usedAt: new Date(), action: "merge" })
    .where(and(eq(agentDecisions.id, decision.id), isNull(agentDecisions.usedAt)))
    .returning()
    .all();
  const replay = db
    .update(agentDecisions)
    .set({ usedAt: new Date(), action: "merge" })
    .where(and(eq(agentDecisions.id, decision.id), isNull(agentDecisions.usedAt)))
    .returning()
    .all();
  check("a decision token redeems once", firstUse.length === 1);
  check("a replayed button press changes nothing", replay.length === 0);

  // Everything hangs off the run.
  db.delete(agentRuns).where(eq(agentRuns.id, run.id)).run();
  runId = null;
  check(
    "deleting a run cascades to its steps",
    db.select().from(agentSteps).where(eq(agentSteps.runId, run.id)).all().length === 0,
  );
  check(
    "deleting a run cascades to its locks",
    db.select().from(agentLocks).where(eq(agentLocks.projectId, PROJECT)).all().length === 0,
  );
  check(
    "deleting a run cascades to its decisions",
    db.select().from(agentDecisions).where(eq(agentDecisions.id, decision.id)).all().length === 0,
  );
} finally {
  if (runId) db.delete(agentRuns).where(eq(agentRuns.id, runId)).run();
  rmSync(imagesDir, { recursive: true, force: true });
}

/* ---------------------------------------------------------- agent auth -- */
console.log("\n— Packet tokens and callback signatures —");

process.env.AGENT_SECRET = "x".repeat(48);
const {
  signPacketToken,
  verifyPacketToken,
  signPayload,
  verifySignature,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
} = await import("../src/lib/agent-auth.ts");

check("header names are lowercase for Headers.get()", AGENT_SIGNATURE_HEADER === "x-agent-signature" && AGENT_TIMESTAMP_HEADER === "x-agent-timestamp");

const STEP = "step-abc";
const token = signPacketToken(STEP, 0);
check("a packet token is minted", typeof token === "string");
check("the token verifies for its own step", verifyPacketToken(STEP, token).valid);
check(
  "the token does not verify for another step",
  !verifyPacketToken("step-xyz", token).valid,
);

// Bound to the attempt: a stale workflow re-run must not fetch current work.
const attemptOne = signPacketToken(STEP, 1);
check(
  "a token carries its attempt",
  verifyPacketToken(STEP, attemptOne).valid &&
    (verifyPacketToken(STEP, attemptOne) as { attempt: number }).attempt === 1,
);
check(
  "a tampered signature is refused",
  !verifyPacketToken(STEP, `${token!.slice(0, -1)}0`).valid,
);
check("a malformed token is refused", !verifyPacketToken(STEP, "nonsense").valid);
check("a missing token is refused", !verifyPacketToken(STEP, null).valid);
check(
  "an expired token is refused",
  !verifyPacketToken(STEP, signPacketToken(STEP, 0, -1_000)).valid,
);

const rawBody = JSON.stringify({ stepId: STEP, event: "ready" });
const now = Date.now();
const signature = signPayload(rawBody, now);
check("a callback signature is produced", typeof signature === "string");
check(
  "a correctly signed callback verifies",
  verifySignature(rawBody, signature, String(now)).valid,
);
check(
  "changing the body invalidates the signature",
  !verifySignature(`${rawBody} `, signature, String(now)).valid,
);
check(
  "changing the timestamp invalidates the signature",
  !verifySignature(rawBody, signature, String(now + 1)).valid,
);
check(
  "a replayed callback outside the window is refused",
  !verifySignature(
    rawBody,
    signPayload(rawBody, now - 10 * 60 * 1000),
    String(now - 10 * 60 * 1000),
  ).valid,
);
check(
  "a callback with no signature is refused",
  !verifySignature(rawBody, null, String(now)).valid,
);

// Fail closed: an unconfigured deployment must reject the agent, not trust it.
const savedSecret = process.env.AGENT_SECRET;
delete process.env.AGENT_SECRET;
check("nothing is minted without AGENT_SECRET", signPacketToken(STEP, 0) === null);
check(
  "nothing verifies without AGENT_SECRET",
  !verifySignature(rawBody, signature, String(now)).valid,
);
check("a short AGENT_SECRET is treated as unset", (() => {
  process.env.AGENT_SECRET = "too-short";
  const refused = signPacketToken(STEP, 0) === null;
  delete process.env.AGENT_SECRET;
  return refused;
})());
process.env.AGENT_SECRET = savedSecret;

/* -------------------------------------------------------------- packets -- */
console.log("\n— Packets carry the constraints, not just the instruction —");

const { reproductionGateFor, buildPacket, DENIED_PATHS, DIFF_BUDGET } =
  await import("../src/lib/agent-packet.ts");

check("a state defect is proven by a component test", reproductionGateFor("state", false) === "G5-A");
check("a flow defect uses a browser where Playwright exists", reproductionGateFor("flow", true) === "G5-B");
check(
  "a flow defect degrades to component level without Playwright",
  reproductionGateFor("flow", false) === "G5-A",
);
check("a visual defect gets the human gate", reproductionGateFor("visual", true) === "G5-C");
check("an article run has no reproduction gate", reproductionGateFor(null, true) === null);

check(
  "dependency manifests are denied",
  DENIED_PATHS.includes("package.json") && DENIED_PATHS.includes("requirements.txt"),
);
check("workflow files are denied", DENIED_PATHS.includes(".github/workflows/**"));
check("env files are denied", DENIED_PATHS.includes(".env"));
check("the diff budget is bounded", DIFF_BUDGET.maxFiles > 0 && DIFF_BUDGET.maxLines > 0);

const fakeProject = {
  id: "seoapp",
  name: "SEO App",
  description: "",
  stack: ["Next.js"],
  repo: "seoapp",
  verify: { cmd: "pytest -q", hasPlaywright: false, measured: true },
};
const fakeRun = {
  id: "run-1234567890",
  source: "defect",
  sourceId: "defect-1",
  projectId: "seoapp",
  baseSha: "abc1234",
} as never;
const fakeStep = {
  id: "step-1",
  runId: "run-1234567890",
  idx: 0,
  title: "Fix the timezone",
  instruction: "do the thing",
  acceptance: ["it works"],
  attempt: 0,
} as never;
const fakeDefect = {
  tier: "state",
  severity: "high",
  symptom: "shows 14:00",
  visibleStrings: ["Booking confirmed"],
  suspectedFiles: [],
  route: "/book",
  viewportWidth: 390,
  viewportHeight: 844,
  whatHappened: "wrong time",
  whatExpected: "16:00",
  reproSteps: null,
} as never;

const packet = buildPacket({
  run: fakeRun,
  step: fakeStep,
  project: fakeProject as never,
  defect: fakeDefect,
  callbackUrl: "https://example.test/api/agent/callback",
  dryRun: true,
});
check("the packet names its reproduction gate", packet.reproductionGate === "G5-A");
check(
  "a defect fix is told to write the failing test first",
  packet.constraints.rules[0].includes("failing test FIRST"),
);
check(
  "the packet tells the agent to grep the screenshot's strings",
  packet.constraints.rules.some((r) => r.includes("visibleStrings")),
);
check("a defect branch is prefixed fix/", packet.branch.startsWith("fix/"));
check("the packet carries the verify command", packet.project.verifyCmd === "pytest -q");

let refusedWithoutContract = false;
try {
  buildPacket({
    run: fakeRun,
    step: fakeStep,
    project: { ...fakeProject, verify: undefined } as never,
    defect: null,
    callbackUrl: "https://example.test/cb",
    dryRun: true,
  });
} catch {
  refusedWithoutContract = true;
}
check("a project with no verify contract cannot be packeted", refusedWithoutContract);

let refusedWithoutBaseline = false;
try {
  buildPacket({
    run: { ...(fakeRun as object), baseSha: null } as never,
    step: fakeStep,
    project: fakeProject as never,
    defect: null,
    callbackUrl: "https://example.test/cb",
    dryRun: true,
  });
} catch {
  refusedWithoutBaseline = true;
}
check("a run with no baseline cannot be packeted", refusedWithoutBaseline);

/* ---------------------------------------------------------------- gates -- */
console.log("\n— Gate evaluation —");

const {
  matchesGlob,
  deniedBy,
  evaluateDiffBudget,
  evaluateLintDelta,
  evaluateReproduction,
  isReadyForDecision,
} = await import("../src/lib/gates.ts");

check("a literal path matches itself", matchesGlob("package.json", "package.json"));
check("a literal path does not match a lookalike", !matchesGlob("mypackage.json", "package.json"));
check("* stays inside one segment", matchesGlob("docker-compose.prod.yml", "docker-compose*.yml"));
check("* does not cross a slash", !matchesGlob("a/docker-compose.yml", "docker-compose*.yml"));
check("** crosses segments", matchesGlob(".github/workflows/deploy.yml", ".github/workflows/**"));
check("** matches a nested path", matchesGlob("apps/api/migrations/001.py", "**/migrations/**"));
check("a dot in a pattern is literal", !matchesGlob("aenv", ".env"));

check("dependency manifests are denied", deniedBy("package.json") === "package.json");
check("lockfiles are denied", deniedBy("package-lock.json") !== null);
check("python requirements are denied", deniedBy("requirements.txt") !== null);
check("workflow files are denied", deniedBy(".github/workflows/idea-agent.yml") !== null);
check("env files are denied", deniedBy(".env.production") !== null);
check("alembic migrations are denied", deniedBy("alembic/versions/abc.py") !== null);
check("a leading ./ cannot dodge the denylist", deniedBy("./package.json") !== null);
check("ordinary source files are allowed", deniedBy("src/lib/foo.ts") === null);
check("a file merely named like a manifest is allowed", deniedBy("src/package.json.md") === null);

const clean = evaluateDiffBudget({ changedFiles: ["src/a.ts", "src/b.ts"], additions: 40, deletions: 10 });
check("a small clean diff passes G2", clean.status === "pass");

const denied = evaluateDiffBudget({ changedFiles: ["src/a.ts", "package.json"], additions: 5, deletions: 1 });
check("touching a denied path fails G2", denied.status === "fail");
check("the failure names the offending path", denied.summary.includes("package.json"));

const tooManyFiles = evaluateDiffBudget({
  changedFiles: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`),
  additions: 10,
  deletions: 0,
});
check("too many files fails G2", tooManyFiles.status === "fail");
const tooManyLines = evaluateDiffBudget({ changedFiles: ["src/a.ts"], additions: 900, deletions: 0 });
check("too many lines fails G2", tooManyLines.status === "fail");

check("lint delta passes when unchanged", evaluateLintDelta(29, 29).status === "pass");
check("lint delta passes when improved", evaluateLintDelta(29, 25).status === "pass");
check("lint delta fails on a new problem", evaluateLintDelta(29, 30).status === "fail");
check(
  "a red baseline does not fail the PR that inherited it",
  evaluateLintDelta(29, 29).summary.includes("pre-existing"),
);

check(
  "fail-then-pass proves the fix",
  evaluateReproduction("G5-A", true, true).status === "pass",
);
check(
  "a test that never failed does not prove anything",
  evaluateReproduction("G5-A", false, true).status === "fail",
);
check(
  "a test that still fails does not prove anything",
  evaluateReproduction("G5-A", true, false).status === "fail",
);
check(
  "the unproven case says so explicitly",
  evaluateReproduction("G5-A", false, true).summary.includes("never reproduced"),
);

check(
  "all gates passing is ready",
  isReadyForDecision([
    { gate: "G0", status: "pass" },
    { gate: "G1", status: "pass" },
    { gate: "G2", status: "pass" },
  ]).ready,
);
check(
  "a failed blocking gate is not ready",
  !isReadyForDecision([{ gate: "G1", status: "pass" }, { gate: "G2", status: "fail" }]).ready,
);
check(
  "an advisory G4 never blocks",
  isReadyForDecision([{ gate: "G1", status: "pass" }, { gate: "G4", status: "advisory" }]).ready,
);
check(
  "a failed reproduction gate blocks",
  !isReadyForDecision([{ gate: "G5-A", status: "fail" }]).ready,
);
check(
  "the visual gate is for a human and does not block automatically",
  isReadyForDecision([{ gate: "G5-C", status: "advisory" }]).ready,
);
check(
  "a re-run gate result supersedes the earlier one",
  isReadyForDecision([{ gate: "G1", status: "fail" }, { gate: "G1", status: "pass" }]).ready,
);

console.log(`\n${failures === 0 ? "ALL PASS ✅" : failures + " FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
