import type { Defect } from "@/db/schema";
import type { StepInput } from "@/lib/runs";

/**
 * Turning a triaged defect into the run that fixes it.
 *
 * Deliberately no second model call. An article needs a generated plan because
 * it is abstract — someone has to decide what, if anything, it means for this
 * codebase. A defect is already concrete: a symptom, a place, and what should
 * have happened instead. The only open question is which lines to change, and
 * that is a question for the implementer, which has the repository in front of
 * it, rather than for a planner that would be guessing at file layout from a
 * screenshot.
 *
 * So the step is derived from what triage actually observed. Nothing here is
 * invented, which also means nothing here can be hallucinated.
 */

function describeDefect(defect: Defect): string {
  const lines = [`Fix this defect, reported through the interface.`, ``];

  lines.push(`**Reported:** ${defect.whatHappened}`);
  if (defect.whatExpected) lines.push(`**Expected instead:** ${defect.whatExpected}`);
  if (defect.reproSteps) lines.push(`**Steps to reproduce:** ${defect.reproSteps}`);
  if (defect.symptom) lines.push(`**Triage read it as:** ${defect.symptom}`);
  if (defect.route) lines.push(`**Route:** ${defect.route}`);
  if (defect.viewportWidth && defect.viewportHeight) {
    lines.push(`**Seen at:** ${defect.viewportWidth}×${defect.viewportHeight}`);
  }

  const causes = defect.suspectedCauses ?? [];
  if (causes.length > 0) {
    lines.push(
      ``,
      `Triage suspected, without access to the repository — treat as leads, not findings:`,
      ...causes.map((c) => `- ${c}`),
    );
  }

  return lines.join("\n");
}

/**
 * What the fix has to satisfy, for G4 to grade against.
 *
 * Phrased so a reviewer reading only the diff can reach a verdict. "The bug is
 * fixed" is unreviewable; "the value shown matches the value selected" is not.
 */
function acceptanceFor(defect: Defect): string[] {
  const criteria: string[] = [];

  criteria.push(
    defect.whatExpected
      ? `The reported behaviour is corrected: ${defect.whatExpected}`
      : `The reported behaviour no longer occurs: ${defect.whatHappened}`,
  );

  if (defect.tier === "state" || defect.tier === "flow") {
    criteria.push(
      "A test reproducing this defect is added, and it fails against the unchanged code",
    );
  }
  if (defect.tier === "visual") {
    criteria.push(
      `The change is confined to presentation for the reported viewport${
        defect.viewportWidth ? ` (${defect.viewportWidth}px)` : ""
      }, and alters no behaviour`,
    );
  }

  criteria.push("No existing behaviour is changed beyond what this defect requires");

  return criteria;
}

/**
 * One step, not several.
 *
 * Splitting "write the test" and "make the fix" into separate steps would send
 * them to separate dispatches, and G5 needs both in one branch to compare
 * against the baseline. The ordering is enforced by the implementer's prompt
 * instead, which requires the test as its own first commit.
 */
export function buildDefectStep(defect: Defect): StepInput {
  return {
    title: defect.title,
    instruction: describeDefect(defect),
    acceptance: acceptanceFor(defect),
  };
}

/** Defects that are not ready to be worked on, and why. */
export function defectBlockedReason(defect: Defect): string | null {
  if (defect.status === "triaging") {
    return "Triage has not finished yet";
  }
  if (defect.status === "failed") {
    return "Triage failed for this defect, so there is nothing to work from";
  }
  if (defect.status === "needs_info") {
    const questions = defect.missingInfo ?? [];
    return questions.length > 0
      ? `Triage needs an answer first: ${questions.join("; ")}`
      : "Triage was not confident enough to plan a fix";
  }
  if (defect.runId) {
    return "This defect already has a run";
  }
  return null;
}
