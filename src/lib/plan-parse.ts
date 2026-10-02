import type { StepInput } from "@/lib/runs";

/**
 * Turn a generated plan into dispatchable steps.
 *
 * The unit of work is a plan step, not an article's key idea. `activate`
 * previously created one task per key idea from the summary, which meant the
 * thing being tracked and the thing being built were different objects — a run
 * scoped that way is measuring the wrong work from its first dispatch.
 *
 * Both plans are Hebrew markdown written to a fixed structure by the prompts in
 * `claude.ts`. Parsing is deliberately forgiving: a plan that drifts from the
 * template should yield fewer steps, never throw.
 */

/** Any markdown heading, at any level. */
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/**
 * A numbered step: `### שלב 1 — כותרת`, `## Step 2 - title`.
 *
 * Matched positively, which is the whole point. Identifying steps by excluding
 * structural headings cost a real step in production: the plan's first step was
 * titled "שלב 1 — GEO-First Prompt Structure + Original Data Injection", the
 * word "Prompt" collided with the "פרומפט ל-Claude Code" section's exclusion
 * term, and the step was silently dropped — a run that would have built half of
 * what the plan asked for, with nothing anywhere saying so.
 */
const NUMBERED_STEP = /^(?:שלב|step)\s*\d+\b/i;
/** A markdown task-list item, checked or not. */
const CHECKLIST_ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;
/** An opening or closing code fence. */
const FENCE = /^\s*(?:```|~~~)/;
/**
 * Sections that are structure rather than work, used only when a plan carries
 * no numbered steps at all.
 *
 * Anchored to the start of the heading: a section *called* "סטטוס" is structure,
 * while a step that merely mentions status in its title is work.
 */
const NON_STEP_PREFIXES = [
  "סטטוס",
  "טבלת",
  "פרומפט",
  "status",
  "priorit",
  "prompt",
];

const MAX_STEPS = 6;
const MAX_ACCEPTANCE = 12;

function isStructuralHeading(heading: string): boolean {
  const lower = heading.toLowerCase();
  return NON_STEP_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

interface PlanLine {
  /** Heading text, or null for body content — including headings inside fences. */
  heading: string | null;
  text: string;
}

/**
 * Classify each line, respecting code fences.
 *
 * Plans embed code blocks whose first line is often a path comment such as
 * `# app/services/content_builder.py`. That is a markdown heading by shape and
 * part of the step's code by intent, so a parser that reads it as a heading
 * truncates the instruction right where the useful detail starts.
 */
function classify(planText: string): PlanLine[] {
  let inFence = false;
  return planText.split("\n").map((text) => {
    if (FENCE.test(text)) {
      inFence = !inFence;
      return { heading: null, text };
    }
    if (inFence) return { heading: null, text };
    const match = text.match(HEADING);
    return { heading: match ? match[2].trim() : null, text };
  });
}

/**
 * Split an implementation plan into steps.
 *
 * Each step carries its full section text as the instruction, because the code
 * block and expected result inside it are exactly what the implementer needs —
 * summarising here would throw away the detail the plan exists to carry.
 */
export function parsePlanSteps(planText: string): Array<Omit<StepInput, "acceptance">> {
  const lines = classify(planText);
  const steps: Array<Omit<StepInput, "acceptance">> = [];

  // When the plan numbers its steps — the template's normal output — those
  // headings and only those start a step. Exclusion is the fallback for a plan
  // that drifted, where a structural heading is the best signal available.
  const hasNumberedSteps = lines.some(
    (line) => line.heading !== null && NUMBERED_STEP.test(line.heading),
  );
  const startsAStep = (heading: string) =>
    hasNumberedSteps ? NUMBERED_STEP.test(heading) : !isStructuralHeading(heading);

  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentTitle === null) return;
    const instruction = currentBody.join("\n").trim();
    if (instruction) {
      steps.push({ title: currentTitle, instruction });
    }
    currentTitle = null;
    currentBody = [];
  };

  for (const line of lines) {
    if (line.heading !== null) {
      // Any heading ends the previous step: a step's body stops where the next
      // section begins, whether or not that section is itself work.
      flush();
      if (startsAStep(line.heading)) currentTitle = line.heading.slice(0, 120);
      continue;
    }
    if (currentTitle !== null) currentBody.push(line.text);
  }
  flush();

  return steps.slice(0, MAX_STEPS);
}

/**
 * Pull acceptance criteria out of a QA plan's checklists.
 *
 * These become what G4 grades the diff against, so they have to be the QA
 * plan's own words — a criterion invented here would be checking something
 * nobody asked for.
 */
export function parseAcceptanceCriteria(qaPlanText: string): string[] {
  const criteria: string[] = [];
  for (const line of qaPlanText.split("\n")) {
    const match = line.match(CHECKLIST_ITEM);
    if (!match) continue;
    const text = match[1].trim();
    // Template placeholders survive when the model doesn't fill a section in.
    if (!text || text.startsWith("[") || text.length < 4) continue;
    criteria.push(text.slice(0, 300));
    if (criteria.length >= MAX_ACCEPTANCE) break;
  }
  return criteria;
}

/**
 * Build the steps for a run, pairing each with the plan's acceptance criteria.
 *
 * Criteria aren't split across steps: which criterion belongs to which step is
 * a judgement the QA plan doesn't record, and guessing at it would let a step
 * pass by being graded against the wrong bar. Every step carries the whole list.
 */
export function buildSteps(
  implementationPlan: string,
  qaPlan: string,
): StepInput[] {
  const acceptance = parseAcceptanceCriteria(qaPlan);
  const steps = parsePlanSteps(implementationPlan);

  // A plan that parsed to nothing still has to be actionable, so fall back to
  // one step carrying the whole plan rather than silently producing a run with
  // no work in it.
  if (steps.length === 0) {
    return [
      {
        title: "Apply the implementation plan",
        instruction: implementationPlan,
        acceptance,
      },
    ];
  }

  return steps.map((step) => ({ ...step, acceptance }));
}
