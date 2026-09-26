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
    hasPlaywright: boolean;
  };
  baseSha: string;
  branch: string;
  step: {
    idx: number;
    title: string;
    instruction: string;
    acceptance: string[];
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
}

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
      hasPlaywright: project.verify.hasPlaywright,
    },
    baseSha: run.baseSha,
    branch: branchNameFor(run, step),
    step: {
      idx: step.idx,
      title: step.title,
      instruction: step.instruction,
      acceptance: step.acceptance ?? [],
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
  };
}
