import type { Article } from "@/lib/articles";
import { updateArticle } from "@/lib/articles";
import type { ProjectConfig } from "@/lib/projects";
import { planArticleImplementation, planArticleQA } from "@/lib/claude";
import { DENIED_PATHS } from "@/lib/agent-packet";
import { fetchDependencyManifests, fetchRepoTree } from "@/lib/repo-manifests";
import { createSteps, setRunPlans, setRunStatus } from "@/lib/runs";
import { buildSteps } from "@/lib/plan-parse";

/**
 * Planning an article run, off the request path.
 *
 * This used to happen inside `POST /api/articles/[id]/activate`, which only
 * answered once both model calls had returned — tens of seconds later. In
 * production that meant every activate was a race against the process: pm2
 * killed the app mid-flight and the caller got an empty body, a 502, and no
 * run, because the run was written *after* the planning it depended on. The
 * work itself had no reason to be synchronous; only the acknowledgement did.
 *
 * So the route creates the run, hands it to `after()`, and returns an id the
 * caller can poll. Failure is now a recorded state on the run rather than a
 * status code nobody received.
 */

export interface FillArticlePlansInput {
  runId: string;
  articleId: string;
  project: ProjectConfig;
  article: Article;
  codeContext: string | null;
}

export async function fillArticlePlans({
  runId,
  articleId,
  project,
  article,
  codeContext,
}: FillArticlePlansInput): Promise<void> {
  try {
    // Best-effort: a missing token or an unreachable GitHub costs the planner its
    // dependency list, not the plan. What it must never do is guess at the list.
    const [manifests, files] = project.repo
      ? await Promise.all([
          fetchDependencyManifests(project.repo),
          fetchRepoTree(project.repo),
        ])
      : [[], []];

    // Sequential, not parallel, and that ordering is the whole point: acceptance
    // criteria have to describe the plan that will actually be carried out. Run
    // side by side from the same article, the two planners agreed only by
    // coincidence — and stopped agreeing the moment the implementation planner
    // started seeing the repository's real constraints. The extra latency costs
    // nothing now that planning happens off the request path.
    const implPlan = await planArticleImplementation(project, article, codeContext, {
      deniedPaths: DENIED_PATHS,
      manifests,
      files,
    });
    const qaPlan = await planArticleQA(project, article, implPlan.text, manifests);

    await setRunPlans(runId, {
      implementationPlan: implPlan.text,
      qaPlan: qaPlan.text,
    });

    // Steps come from the plan's own sections, not from the summary's key ideas
    // — the unit of work is a step, and scoping a run by key ideas would track
    // something other than what gets built.
    const steps = buildSteps(implPlan.text, qaPlan.text);
    if (steps.length === 0) {
      await setRunStatus(
        runId,
        "failed",
        "The plan produced no steps. Its headings did not parse into work items, so there is nothing to dispatch.",
      );
      return;
    }
    await createSteps(runId, steps);

    // Only now is the article genuinely planned. Writing this marker before the
    // steps existed would have claimed a plan that could not be acted on.
    await updateArticle(articleId, {
      implementationPlan: {
        projectId: project.id,
        generatedAt: new Date().toISOString(),
      },
    });

    // Not "running": G0 has measured nothing yet. `setRunBaseline` moves it on
    // when a dispatch reports the baseline commit.
    await setRunStatus(runId, "baseline");
  } catch (err) {
    // Nothing is waiting on this promise, so an unrecorded throw would be an
    // invisible failure — a run stuck at "planning" with no explanation.
    await setRunStatus(
      runId,
      "failed",
      err instanceof Error ? err.message : "Plan generation failed",
    ).catch(() => undefined);
  }
}
