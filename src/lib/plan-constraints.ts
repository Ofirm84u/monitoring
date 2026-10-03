// Relative, with the extension, and a type-only import for the manifest shape:
// the same convention gates.ts follows, and what lets scripts/agent-validate.ts
// import this directly under `node --experimental-strip-types`. Living in
// claude.ts made it untestable, because that file's own imports do not resolve
// outside the bundler.
import { DIFF_BUDGET } from "./agent-packet.ts";
import type { RepoManifest } from "./repo-manifests";

/**
 * What the plan is allowed to require, stated to the planner.
 *
 * Exported and pure so it can be asserted on: this text is the only thing
 * standing between a plan and a step that cannot be carried out, and a silent
 * regression in it would show up as a wasted dispatch rather than a failed test.
 */
export function buildPlanConstraintsBlock(constraints?: {
  deniedPaths: readonly string[];
  manifests: RepoManifest[];
  /** The repository's source paths. Empty when they could not be read. */
  files?: string[];
}): string {
  if (!constraints) return "";

  // Knowing the packages stopped it inventing dependencies; knowing the files is
  // what stops it inventing locations. The previous plan proposed a `tasks/`
  // package for a repo whose task code is one file called `tasks.py`, and
  // imported a module that does not exist.
  const files = constraints.files ?? [];
  const treeBlock =
    files.length > 0
      ? `\nREPOSITORY FILES — the complete source listing. Every path you name must either appear here or be a new file you explicitly say is new:\n${files.join("\n")}\n`
      : "";

  const manifests =
    constraints.manifests.length > 0
      ? `\nDEPENDENCY MANIFESTS — the only packages available, because adding one is not possible:\n${constraints.manifests
          .map((m) => `--- ${m.path} ---\n${m.text}`)
          .join("\n")}\n`
      : `\nDEPENDENCY MANIFESTS: could not be read. Do not assume any package is available beyond what the stack implies, and prefer naming a prerequisite over guessing.\n`;

  return `${manifests}${treeBlock}
WHAT THE IMPLEMENTER CANNOT DO. These are enforced as a gate rather than requested in a prompt, so a plan that requires one of them cannot be carried out at all:
- It cannot edit any of these paths: ${constraints.deniedPaths.join(", ")}
- So it cannot add a dependency, write a database migration, change CI, or touch Docker or env files.
- Its entire change must fit within ${DIFF_BUDGET.maxFiles} files and ${DIFF_BUDGET.maxLines} changed lines.

Therefore:
- Use only packages that appear in the manifests. If the obvious library is absent, either use one that is present, or make adding it an explicit prerequisite step stated as requiring a human.
- A step needing a new table or column needs a migration, which is a denied path. Say so inside the step instead of proposing the model class alone: code for a table nothing creates passes every test and then fails on deploy.
- Never leave a placeholder in code you propose — no "yourdomain", no "TODO", no "your-api-key". If a value must be configured, name the environment variable and say that it is new.
- Keep the plan internally consistent: a file path or symbol named in one step must be the same one the QA criteria will exercise.
- Do not invent a location. A directory you have not seen in the listing does not exist, and neither does a module you have not seen — if a symbol you need lives somewhere, name the file from the listing that defines it rather than assuming a conventional path.
`;
}

/**
 * The implementation plan, given to the QA planner.
 *
 * These two plans used to be generated in parallel from the same article and
 * never shown to each other. They agreed by coincidence — both read "citation
 * monitoring" out of the article and wrote about that — until the implementation
 * planner started receiving the repository's real constraints and chose
 * different work. The QA planner, still working from the article alone, then
 * produced criteria naming `run_citation_check`, `citation_log`, psycopg2 and
 * `anthropic.APIError` for a change that was two TypeScript files.
 *
 * G4 graded the diff against those criteria and answered "unclear" eleven times
 * out of eleven, which was the honest answer to a question about a different
 * project. Acceptance criteria have to describe the plan that will actually be
 * carried out, so the QA planner is given it.
 */
export function buildQaPlanContextBlock(implementationPlan?: string | null): string {
  if (!implementationPlan?.trim()) return "";

  return `
THE IMPLEMENTATION PLAN YOU ARE WRITING CRITERIA FOR. This is the change that will actually be made — not a suggestion, and not something to improve upon:

${implementationPlan.trim()}

Therefore:
- Every criterion must be verifiable against THAT plan. Name the files, functions and symbols it names; do not introduce others.
- Do not write criteria for work the plan does not contain. A criterion nothing in the plan addresses cannot be met, and reports as a failure of the change rather than of the criterion.
- Tag each criterion with the step it belongs to, as "(שלב N)". The steps are reviewed one at a time, and a criterion that belongs to a later step must be recognisable as such.
- Prefer criteria a reviewer can settle by reading the diff. Where a check genuinely requires running the code, say so explicitly in the criterion.
`;
}
