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

/** `### שלב 1 — כותרת` / `### Step 2 - title`, and anything else at H3. */
const STEP_HEADING = /^###\s+(.+?)\s*$/;
/** A markdown task-list item, checked or not. */
const CHECKLIST_ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;
/** Headings whose H3 sections are structure, not work to be done. */
const NON_STEP_HEADINGS = [
  "סטטוס",
  "טבלת",
  "פרומפט",
  "status",
  "priorit",
  "prompt",
];

const MAX_STEPS = 6;
const MAX_ACCEPTANCE = 12;

function isStepHeading(heading: string): boolean {
  const lower = heading.toLowerCase();
  return !NON_STEP_HEADINGS.some((skip) => lower.includes(skip.toLowerCase()));
}

/**
 * Split an implementation plan into steps.
 *
 * Each step carries its full section text as the instruction, because the code
 * block and expected result inside it are exactly what the implementer needs —
 * summarising here would throw away the detail the plan exists to carry.
 */
export function parsePlanSteps(planText: string): Array<Omit<StepInput, "acceptance">> {
  const lines = planText.split("\n");
  const steps: Array<Omit<StepInput, "acceptance">> = [];

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
    const match = line.match(STEP_HEADING);
    if (match) {
      flush();
      const heading = match[1].trim();
      if (isStepHeading(heading)) currentTitle = heading.slice(0, 120);
      continue;
    }
    if (currentTitle !== null) currentBody.push(line);
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
