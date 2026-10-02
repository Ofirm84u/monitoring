// Relative, with the extension, rather than the usual "@/" alias: this is the
// one value import in the file, and keeping it resolvable outside the bundler
// is what lets scripts/agent-validate.ts exercise the gate logic directly.
// `allowImportingTsExtensions` is already set, so the bundler is happy too.
import { DENIED_PATHS, DIFF_BUDGET } from "./agent-packet.ts";
import type { CheckStatus, Gate } from "@/db/schema";

/**
 * Deterministic gate evaluation.
 *
 * These run here rather than in workflow bash so the policy has one definition.
 * A denylist duplicated across fourteen caller workflows drifts, and the copy
 * that drifts is the one that stops catching things.
 */

export interface GateVerdict {
  gate: Gate;
  status: CheckStatus;
  summary: string;
  evidence: unknown;
}

/**
 * Minimal glob matcher for the path denylist.
 *
 * Supports the three forms the denylist actually uses: `*` within a segment,
 * `**` across segments, and literals. Deliberately not a general glob library —
 * this decides whether a change is refused, so it should be small enough to
 * read in full and test exhaustively.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const escapeLiteral = (segment: string) =>
    segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");

  const segments = pattern.split("/");
  let regex = "^";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      // Zero or more path segments. Trailing `**` also matches nothing at all,
      // so `a/**` covers `a/b` and `a/b/c` but not the bare file `a`.
      regex += isLast ? "(?:.*)?" : "(?:[^/]+/)*";
      continue;
    }
    regex += escapeLiteral(segment);
    if (!isLast) regex += "/";
  }
  regex += "$";
  return new RegExp(regex).test(path);
}

/** Which denylist pattern a path trips, or null when it trips none. */
export function deniedBy(path: string): string | null {
  // Normalise away a leading "./" so "./package.json" can't slip past.
  const normalized = path.replace(/^\.\//, "");
  for (const pattern of DENIED_PATHS) {
    if (matchesGlob(normalized, pattern)) return pattern;
  }
  return null;
}

export interface DiffSummary {
  changedFiles: string[];
  additions: number;
  deletions: number;
}

/**
 * Paths that are produced by running the pipeline rather than authored by it.
 *
 * Kept separate from DENIED_PATHS: touching a denied path is a scope violation,
 * whereas these are simply not evidence that anything was implemented.
 */
const ARTIFACT_PATTERNS = [
  "**/*.log",
  "**/*.map",
  ".next/**",
  "dist/**",
  "build/**",
  "coverage/**",
  "**/__pycache__/**",
  ".pytest_cache/**",
  "**/.DS_Store",
] as const;

function isArtifact(path: string): boolean {
  return ARTIFACT_PATTERNS.some((pattern) => matchesGlob(path, pattern));
}

/**
 * G2 — scope control.
 *
 * Three independent reasons to stop. A diff made only of build or run output is
 * not a change set at all, whatever its size. A denied path is a hard refusal:
 * the change would alter what the other gates even mean. And an oversized diff
 * is not wrong in itself, but a step that grew this far is no longer the step
 * that was planned, so it stops for a human rather than passing on its own.
 */
export function evaluateDiffBudget(diff: DiffSummary): GateVerdict {
  const violations = diff.changedFiles
    .map((file) => ({ file, pattern: deniedBy(file) }))
    .filter((v): v is { file: string; pattern: string } => v.pattern !== null);

  const totalLines = diff.additions + diff.deletions;
  const overFiles = diff.changedFiles.length > DIFF_BUDGET.maxFiles;
  const overLines = totalLines > DIFF_BUDGET.maxLines;

  const evidence = {
    changedFiles: diff.changedFiles.length,
    additions: diff.additions,
    deletions: diff.deletions,
    budget: DIFF_BUDGET,
    violations,
  };

  // Scope is not substance. The first real run opened a pull request whose only
  // two files were the workflow's own gate logs, and this gate passed it — the
  // logs were inside the budget and on no denylist. Every mechanical gate agreed,
  // and only the advisory review noticed that nothing had been implemented. A
  // diff made entirely of artifacts is not a change set, so it stops here, where
  // the answer is deterministic, instead of resting on a gate that cannot block.
  const authored = diff.changedFiles.filter((file) => !isArtifact(file));
  if (diff.changedFiles.length > 0 && authored.length === 0) {
    return {
      gate: "G2",
      status: "fail",
      summary: `No authored change: all ${diff.changedFiles.length} changed file${
        diff.changedFiles.length > 1 ? "s are" : " is"
      } build or run output (${diff.changedFiles.join(", ")})`,
      evidence,
    };
  }

  if (violations.length > 0) {
    // Naming the pattern explains *why* a file is refused, but repeating it
    // when the pattern is the filename just reads as a stutter.
    const list = violations
      .map((v) => (v.file === v.pattern ? v.file : `${v.file} (matches ${v.pattern})`))
      .join(", ");
    return {
      gate: "G2",
      status: "fail",
      summary: `Touched denied path${violations.length > 1 ? "s" : ""}: ${list}`,
      evidence,
    };
  }

  if (overFiles || overLines) {
    const reasons: string[] = [];
    if (overFiles) {
      reasons.push(`${diff.changedFiles.length} files (budget ${DIFF_BUDGET.maxFiles})`);
    }
    if (overLines) {
      reasons.push(`${totalLines} lines (budget ${DIFF_BUDGET.maxLines})`);
    }
    return {
      gate: "G2",
      status: "fail",
      summary: `Diff exceeds its budget: ${reasons.join(", ")}. This is no longer the step that was planned.`,
      evidence,
    };
  }

  return {
    gate: "G2",
    status: "pass",
    summary: `${diff.changedFiles.length} file${diff.changedFiles.length === 1 ? "" : "s"}, +${diff.additions}/-${diff.deletions} — within budget, no denied paths`,
    evidence,
  };
}

/**
 * Lint as a delta gate.
 *
 * seoapp's main is red today (10 errors, 19 warnings), so a plain pass/fail
 * would make every agent PR inherit a failure it did not cause. What matters is
 * that the change adds none of its own. Once a project's main is clean this
 * degrades naturally to ordinary pass/fail, and the baseline bookkeeping can go.
 */
export function evaluateLintDelta(
  baselineProblems: number,
  headProblems: number,
): GateVerdict {
  const delta = headProblems - baselineProblems;
  const evidence = { baselineProblems, headProblems, delta };

  if (delta > 0) {
    return {
      gate: "G1",
      status: "fail",
      summary: `Lint introduced ${delta} new problem${delta > 1 ? "s" : ""} (${baselineProblems} → ${headProblems})`,
      evidence,
    };
  }
  if (delta < 0) {
    return {
      gate: "G1",
      status: "pass",
      summary: `Lint improved by ${-delta} (${baselineProblems} → ${headProblems})`,
      evidence,
    };
  }
  return {
    gate: "G1",
    status: "pass",
    summary: `Lint unchanged at ${headProblems} pre-existing problem${headProblems === 1 ? "" : "s"}`,
    evidence,
  };
}

/**
 * G5 — reproduction proof.
 *
 * The whole point is the pair of results, not either one alone. A test that
 * passes on the fix branch proves nothing by itself: it may never have failed.
 * It has to fail at the baseline and pass at the head, and any other
 * combination is a finding rather than a formality.
 */
export function evaluateReproduction(
  gate: "G5-A" | "G5-B",
  failedAtBase: boolean,
  passedAtHead: boolean,
): GateVerdict {
  const evidence = { failedAtBase, passedAtHead };

  if (failedAtBase && passedAtHead) {
    return {
      gate,
      status: "pass",
      summary: "Test failed at the baseline and passes on the branch — the bug is genuinely fixed",
      evidence,
    };
  }
  if (!failedAtBase && passedAtHead) {
    return {
      gate,
      status: "fail",
      summary:
        "Test passes at the baseline too, so it never reproduced the bug. The fix is unproven.",
      evidence,
    };
  }
  if (failedAtBase && !passedAtHead) {
    return {
      gate,
      status: "fail",
      summary: "Test still fails on the branch — the bug is not fixed",
      evidence,
    };
  }
  return {
    gate,
    status: "fail",
    summary: "Test fails at the baseline and does not pass on the branch",
    evidence,
  };
}

/**
 * Gates every step must have reported before it may be offered for a decision.
 *
 * G5-A and G5-B are deliberately absent: at most one of them applies to any
 * given step, and most steps have neither, so requiring both would block every
 * run. The applicable one is passed to `isReadyForDecision` by the caller,
 * which is the only place that knows what kind of run this is.
 *
 * G3 is required even where a project declares no smoke command, because
 * `evaluateSmoke` answers that case with an explicit `skip` that names the gap.
 * A recorded "nothing checks this" is a fact a reviewer can weigh; an absent
 * row is one they never learn about.
 */
const ALWAYS_REQUIRED: readonly Gate[] = ["G0", "G1", "G2", "G3"];

/**
 * Whether a step is ready for a human.
 *
 * G4 is advisory by design — it can raise a concern but never waves a change
 * through on its own — and G5-C is a human gate, so neither blocks here. Both
 * still reach the decision card, which is where they belong.
 */
export function isReadyForDecision(
  verdicts: Array<{ gate: Gate; status: CheckStatus }>,
  /**
   * The reproduction gate this step is expected to satisfy, or null when it has
   * none — an article run, or a visual defect, where G5-C is a human's call.
   * Passed in rather than inferred, because only the caller knows the run.
   */
  requiredReproduction: Gate | null = null,
): { ready: boolean; blockedBy: Gate[]; missing: Gate[] } {
  const latest = new Map<Gate, CheckStatus>();
  for (const verdict of verdicts) latest.set(verdict.gate, verdict.status);

  const required: Gate[] = [...ALWAYS_REQUIRED];
  if (requiredReproduction) required.push(requiredReproduction);

  const failed = required.filter((gate) => latest.get(gate) === "fail");

  // A gate that never reported is not a gate that passed. Readiness used to be
  // computed only over the checks that existed, so a blocking gate which never
  // ran could not appear in `blockedBy` — silence was indistinguishable from a
  // pass, which is the one thing this ladder exists to prevent. G3 demonstrated
  // it in the first live run: no row recorded, and the step was handed a
  // decision token anyway.
  const missing = required.filter((gate) => !latest.has(gate));

  return {
    ready: failed.length === 0 && missing.length === 0,
    blockedBy: [...failed, ...missing],
    missing,
  };
}

/**
 * G3 — behavioural smoke.
 *
 * G1 proves the suite passes; it does not prove the application starts and
 * answers. Those are different failures, and the second is the one users see.
 * Like G5, the meaningful signal is the pair: the comparison is against the
 * baseline, so an app that was already failing to start does not fail the
 * change that happened to be in flight.
 */
export function evaluateSmoke(
  smokeCmd: string | null,
  baselineOk: boolean | null,
  headOk: boolean | null,
): GateVerdict {
  if (!smokeCmd) {
    return {
      gate: "G3",
      status: "skip",
      summary:
        "No smokeCmd in this project's verify contract, so nothing checks that the app still starts and answers. G1 passing is not evidence of that.",
      evidence: { smokeCmd: null },
    };
  }

  const evidence = { smokeCmd, baselineOk, headOk };

  if (baselineOk === false) {
    return {
      gate: "G3",
      status: "skip",
      summary:
        "The app did not come up at the baseline either, so this change cannot be blamed. Fix the baseline before reading G3 here.",
      evidence,
    };
  }
  if (headOk === true) {
    return {
      gate: "G3",
      status: "pass",
      summary: "The app starts and answers on the branch, as it did at the baseline",
      evidence,
    };
  }
  return {
    gate: "G3",
    status: "fail",
    summary:
      "The app came up at the baseline but not on the branch — the suite passes and the application is still broken",
    evidence,
  };
}
