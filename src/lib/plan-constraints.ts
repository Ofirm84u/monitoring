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
}): string {
  if (!constraints) return "";

  const manifests =
    constraints.manifests.length > 0
      ? `\nDEPENDENCY MANIFESTS — the only packages available, because adding one is not possible:\n${constraints.manifests
          .map((m) => `--- ${m.path} ---\n${m.text}`)
          .join("\n")}\n`
      : `\nDEPENDENCY MANIFESTS: could not be read. Do not assume any package is available beyond what the stack implies, and prefer naming a prerequisite over guessing.\n`;

  return `${manifests}
WHAT THE IMPLEMENTER CANNOT DO. These are enforced as a gate rather than requested in a prompt, so a plan that requires one of them cannot be carried out at all:
- It cannot edit any of these paths: ${constraints.deniedPaths.join(", ")}
- So it cannot add a dependency, write a database migration, change CI, or touch Docker or env files.
- Its entire change must fit within ${DIFF_BUDGET.maxFiles} files and ${DIFF_BUDGET.maxLines} changed lines.

Therefore:
- Use only packages that appear in the manifests. If the obvious library is absent, either use one that is present, or make adding it an explicit prerequisite step stated as requiring a human.
- A step needing a new table or column needs a migration, which is a denied path. Say so inside the step instead of proposing the model class alone: code for a table nothing creates passes every test and then fails on deploy.
- Never leave a placeholder in code you propose — no "yourdomain", no "TODO", no "your-api-key". If a value must be configured, name the environment variable and say that it is new.
- Keep the plan internally consistent: a file path or symbol named in one step must be the same one the QA criteria will exercise.
`;
}
