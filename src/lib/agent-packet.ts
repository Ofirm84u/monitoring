import type { AgentRun, AgentStep, Defect } from "@/db/schema";
import type { ProjectConfig } from "@/lib/projects";

/**
 * The work order handed to one implementer run.
 *
 * A packet is self-contained: everything the implementer may act on is in here,
 * and anything not in here it has to ask about rather than infer. It is fetched
 * from this app rather than carried in the dispatch payload, so the plan text
 * never appears in the Actions UI or a webhook delivery, and so there is exactly
 * one copy of the instruction that can be superseded.
 */

/**
 * Paths the agent may never touch, enforced as a gate rather than requested in
 * a prompt. Each one is here because a change to it invalidates the very thing
 * the gates rely on: dependencies and lockfiles change what "the suite passes"
 * means, workflow files change what runs, migrations change state the baseline
 * was measured against, compose files change what is deployed, and env files
 * are secrets. A step that genuinely needs one of these is a step a human does.
 */
export const DENIED_PATHS = [
  ".env",
  ".env.*",
  ".github/workflows/**",
  "alembic/**",
  "migrations/**",
  "**/migrations/**",
  "docker-compose*.yml",
  "Dockerfile",
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
] as const;

/**
 * A diff past either bound stops for a human look rather than auto-passing.
 * The point is not that big changes are wrong — it is that a step which grew
 * this far is no longer the step that was planned and reviewed.
 */
export const DIFF_BUDGET = { maxFiles: 8, maxLines: 400 } as const;

export interface DefectContext {
  tier: Defect["tier"];
  severity: Defect["severity"];
  symptom: string | null;
  /** Grep these to locate the component — the screenshot's own words. */
  visibleStrings: string[];
  suspectedFiles: string[];
  route: string | null;
  viewport: { width: number; height: number } | null;
  whatHappened: string;
  whatExpected: string | null;
  reproSteps: string | null;
}

export interface AgentPacket {
  runId: string;
  stepId: string;
  attempt: number;
  dryRun: boolean;
  project: {
    id: string;
    name: string;
    repo: string;
    stack: string[];
    verifyCmd: string;
    setupCmd: string | null;
    smokeCmd: string | null;
    pythonVersion: string;
    hasPlaywright: boolean;
  };
  baseSha: string;
  branch: string;
  step: {
    idx: number;
    title: string;
    instruction: string;
    acceptance: string[];
    /**
     * A question a previous attempt asked, and the answer it was given.
     *
     * The whole point of letting the implementer ask instead of guess is that the
     * answer comes back to it. Without these the packet for attempt 2 was
     * identical to attempt 1, so an answered question changed nothing and the
     * same question would be asked again.
     */
    priorQuestion: string | null;
    answer: string | null;
  };
  /** Present only for defect runs; shapes how the fix must be proven. */
  defect: DefectContext | null;
  /** How this step's fix will be proven, decided by the defect tier. */
  reproductionGate: "G5-A" | "G5-B" | "G5-C" | null;
  constraints: {
    deniedPaths: readonly string[];
    maxFiles: number;
    maxLines: number;
    /** Restated in the packet because the implementer never sees this file. */
    rules: string[];
  };
  callbackUrl: string;
  /** Where G2 and G4 are evaluated; both live server-side, not in workflow bash. */
  reviewUrl: string;
  /**
   * The prompt handed to the implementer, built here rather than assembled in
   * workflow bash so there is one definition of what the agent is told and it
   * can be asserted on in tests.
   */
  implementerPrompt: string;
}

/**
 * Commit-message prefix the reproduction test must carry.
 *
 * G5 finds the test commit by this prefix and cherry-picks it onto the baseline
 * to prove it fails there. Without a reliable marker the gate would have to
 * guess which commit is the test, and a wrong guess makes the proof worthless.
 */
export const TEST_COMMIT_PREFIX = "test(idea-runner):";

/**
 * Which gate can prove this defect fixed.
 *
 * A state bug is provable by a component test and a flow bug by a browser test.
 * A purely visual bug is provable by neither — no assertion expresses "the
 * button overlaps" — so it gets a before/after render and a human decides.
 * Tier B in a repo without Playwright has no harness to run in, and degrades to
 * a component-level attempt rather than silently claiming browser coverage.
 */
export function reproductionGateFor(
  tier: Defect["tier"] | null,
  hasPlaywright: boolean,
): AgentPacket["reproductionGate"] {
  if (!tier) return null;
  if (tier === "visual") return "G5-C";
  if (tier === "flow") return hasPlaywright ? "G5-B" : "G5-A";
  if (tier === "state") return "G5-A";
  return null;
}

export function branchNameFor(run: AgentRun, step: AgentStep): string {
  const prefix = run.source === "defect" ? "fix" : "idea";
  return `${prefix}/${run.id.slice(0, 8)}-${step.idx}`;
}

function buildRules(
  packetDefect: DefectContext | null,
  gate: AgentPacket["reproductionGate"],
): string[] {
  const rules = [
    "Change only what this step describes. Anything else is a separate step.",
    "Never edit a denied path. If the step cannot be done without one, stop and ask.",
    // The first real run obeyed the rule above and still produced a change that
    // cannot ship: a SQLAlchemy model for a table with no migration, because the
    // migration belongs under a denied path. Every gate passed it — the tests
    // build their own schema, so nothing failed — and the gap would only appear
    // on deploy. Not editing a denied path is not the same as not needing one.
    "A change that needs a denied path to be complete is not complete. A model without its migration, or an import without its dependency, passes tests and breaks on deploy. Report a question instead of leaving that behind.",
    "Cite a file only after reading it. Do not invent paths or symbols.",
    "If a decision is genuinely ambiguous, report a question instead of guessing.",
  ];

  if (!packetDefect) return rules;

  if (gate === "G5-A" || gate === "G5-B") {
    rules.unshift(
      "Write the failing test FIRST, in its own commit. It must fail at the base commit and pass after the fix — a test that never failed proves nothing.",
    );
  }
  if (gate === "G5-C") {
    rules.unshift(
      "This is a visual defect: no assertion can prove it. Make the fix, then state exactly which route and viewport to render so the before/after can be compared.",
    );
  }
  if (packetDefect.visibleStrings.length > 0) {
    rules.push(
      "Locate the component by grepping for the strings under defect.visibleStrings — they were read off the screenshot and are the reliable index into this repo.",
    );
  }
  return rules;
}

/** Markdown block quote, so a multi-line answer cannot break the prompt's structure. */
function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function buildPacket(input: {
  run: AgentRun;
  step: AgentStep;
  project: ProjectConfig;
  defect: Defect | null;
  callbackUrl: string;
  dryRun: boolean;
}): AgentPacket {
  const { run, step, project, defect, callbackUrl, dryRun } = input;

  if (!project.repo) {
    throw new Error(`Project ${project.id} has no repo — nothing to dispatch to`);
  }
  if (!project.verify) {
    throw new Error(
      `Project ${project.id} has no verify contract — G0 has nothing to measure, so no run can start`,
    );
  }
  if (!run.baseSha) {
    throw new Error(
      `Run ${run.id} has no baseline commit — breakage could not be attributed`,
    );
  }

  const defectContext: DefectContext | null = defect
    ? {
        tier: defect.tier,
        severity: defect.severity,
        symptom: defect.symptom,
        visibleStrings: defect.visibleStrings ?? [],
        suspectedFiles: defect.suspectedFiles ?? [],
        route: defect.route,
        viewport:
          defect.viewportWidth && defect.viewportHeight
            ? { width: defect.viewportWidth, height: defect.viewportHeight }
            : null,
        whatHappened: defect.whatHappened,
        whatExpected: defect.whatExpected,
        reproSteps: defect.reproSteps,
      }
    : null;

  const reproductionGate = reproductionGateFor(
    defect?.tier ?? null,
    project.verify.hasPlaywright,
  );

  return {
    runId: run.id,
    stepId: step.id,
    attempt: step.attempt,
    dryRun,
    project: {
      id: project.id,
      name: project.name,
      repo: project.repo,
      stack: project.stack,
      verifyCmd: project.verify.cmd,
      setupCmd: project.verify.setupCmd ?? null,
      smokeCmd: project.verify.smokeCmd ?? null,
      pythonVersion: project.verify.pythonVersion ?? "3.12",
      hasPlaywright: project.verify.hasPlaywright,
    },
    baseSha: run.baseSha,
    branch: branchNameFor(run, step),
    step: {
      idx: step.idx,
      title: step.title,
      instruction: step.instruction,
      acceptance: step.acceptance ?? [],
      priorQuestion: step.question ?? null,
      answer: step.answer ?? null,
    },
    defect: defectContext,
    reproductionGate,
    constraints: {
      deniedPaths: DENIED_PATHS,
      maxFiles: DIFF_BUDGET.maxFiles,
      maxLines: DIFF_BUDGET.maxLines,
      rules: buildRules(defectContext, reproductionGate),
    },
    callbackUrl,
    reviewUrl: callbackUrl.replace(/\/callback$/, "/review"),
    implementerPrompt: buildImplementerPrompt({
      project,
      step,
      defect: defectContext,
      reproductionGate,
      rules: buildRules(defectContext, reproductionGate),
    }),
  };
}

/**
 * What the implementer is actually told.
 *
 * Written as instructions to an engineer with no context beyond this text: it
 * cannot see the plan it came from, the conversation that produced it, or any
 * earlier step. Everything it may rely on is here, and everything absent is
 * something it must ask about rather than assume.
 */
export function buildImplementerPrompt(input: {
  project: ProjectConfig;
  step: AgentStep;
  defect: DefectContext | null;
  reproductionGate: AgentPacket["reproductionGate"];
  rules: string[];
}): string {
  const { project, step, defect, reproductionGate, rules } = input;
  const sections: string[] = [];

  sections.push(
    `You are making one focused change to ${project.name} (${project.stack.join(", ")}).`,
  );

  sections.push(`## The change\n\n### ${step.title}\n\n${step.instruction}`);

  // A previous attempt asked rather than guessed, and was answered. Putting both
  // in front of this attempt is the only thing that makes asking worth doing —
  // without it the packet for attempt 2 is identical to attempt 1, and the same
  // question gets asked again. The question is included alongside the answer
  // because an answer like "use httpx" means nothing without it.
  if (step.answer) {
    const lines = ["## You asked, and this is the answer", ""];
    if (step.question) {
      lines.push("A previous attempt asked:", "", quoteBlock(step.question), "");
    }
    lines.push("The answer:", "", quoteBlock(step.answer), "");
    lines.push(
      "Proceed on that basis. If it still leaves something genuinely undecidable, ask again rather than guessing — but do not re-ask what has just been answered.",
    );
    sections.push(lines.join("\n"));
  }

  if (defect) {
    const lines = [
      `This step fixes a defect reported through the interface.`,
      ``,
      `- **Reported:** ${defect.whatHappened}`,
    ];
    if (defect.whatExpected) lines.push(`- **Expected:** ${defect.whatExpected}`);
    if (defect.reproSteps) lines.push(`- **Steps:** ${defect.reproSteps}`);
    if (defect.symptom) lines.push(`- **Triage:** ${defect.symptom}`);
    if (defect.route) lines.push(`- **Route:** ${defect.route}`);
    if (defect.viewport) {
      lines.push(`- **Viewport:** ${defect.viewport.width}x${defect.viewport.height}`);
    }
    if (defect.visibleStrings.length > 0) {
      lines.push(
        ``,
        `**Text read from the screenshot.** Grep the repository for these to find`,
        `the component that rendered it. They are exact, and they are a more`,
        `reliable index than any guess about file layout:`,
        ...defect.visibleStrings.map((s) => `  - ${JSON.stringify(s)}`),
      );
    }
    if (defect.suspectedFiles.length > 0) {
      lines.push(
        ``,
        `Triage suspected these files, but did not have the repository. Verify`,
        `before trusting them:`,
        ...defect.suspectedFiles.map((f) => `  - ${f}`),
      );
    }
    sections.push(`## The defect\n\n${lines.join("\n")}`);
  }

  if (reproductionGate === "G5-A" || reproductionGate === "G5-B") {
    const kind =
      reproductionGate === "G5-B"
        ? "a browser test (Playwright)"
        : "a component or unit test";
    sections.push(
      [
        `## Prove it, before you fix it`,
        ``,
        `Your **first commit** must be ${kind} that reproduces this bug, and its`,
        `message must start with \`${TEST_COMMIT_PREFIX}\`. Commit the test on its own,`,
        `with no fix alongside it.`,
        ``,
        `That commit will be applied to the unchanged baseline and the suite run`,
        `there. If it passes at the baseline, the test never reproduced the bug and`,
        `the fix is rejected as unproven — so write a test that genuinely fails`,
        `first. Make the fix in a later commit.`,
      ].join("\n"),
    );
  }

  if (reproductionGate === "G5-C") {
    sections.push(
      [
        `## This defect is visual`,
        ``,
        `No assertion can express "it looks wrong", so do not invent a test that`,
        `pretends to. Make the fix, then state plainly in your final message which`,
        `route and viewport should be rendered to compare before and after. A`,
        `person will look at the two images and decide.`,
      ].join("\n"),
    );
  }

  if (step.acceptance && step.acceptance.length > 0) {
    sections.push(
      `## This will be reviewed against\n\n${step.acceptance.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  sections.push(
    [
      `## Rules`,
      ``,
      ...rules.map((r) => `- ${r}`),
      ``,
      `**Never edit these paths.** A change to any of them is refused by a gate,`,
      `not by review, so the work would be discarded:`,
      ...DENIED_PATHS.map((p) => `  - \`${p}\``),
      ``,
      `Keep the change under ${DIFF_BUDGET.maxFiles} files and ${DIFF_BUDGET.maxLines} changed lines.`,
      `Past either bound the step is no longer the step that was planned, and it`,
      `stops for a human rather than proceeding.`,
      ``,
      `Verification runs \`${project.verify?.cmd ?? ""}\`. It passed on the baseline`,
      `before you started, so any failure it reports afterwards is yours.`,
    ].join("\n"),
  );

  return sections.join("\n\n");
}
