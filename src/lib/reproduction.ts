import type { AgentRun, Gate } from "@/db/schema";
import type { ProjectConfig } from "@/lib/projects";
import { getDefect } from "@/lib/defects";
import { reproductionGateFor } from "@/lib/agent-packet";

/**
 * Which reproduction gate, if any, a run must satisfy.
 *
 * `reproductionGateFor` is the policy and is pure; this is the part that has to
 * read the defect to apply it. Kept apart from both so the policy stays
 * testable without a database and the gate module stays free of data access.
 *
 * Only G5-A and G5-B are returned as *required*. G5-C is a human looking at two
 * screenshots — a gate, but not one a server can decide — and an article run has
 * no reproduction gate at all, because there is no reported defect to reproduce.
 */
export async function requiredReproductionGate(
  run: AgentRun,
  project: ProjectConfig,
): Promise<Gate | null> {
  if (run.source !== "defect") return null;

  const defect = await getDefect(run.sourceId);
  if (!defect) return null;

  const gate = reproductionGateFor(defect.tier, project.verify?.hasPlaywright ?? false);
  return gate === "G5-A" || gate === "G5-B" ? gate : null;
}
