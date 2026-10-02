import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { listRuns, listSteps } from "@/lib/runs";

/**
 * List runs and their steps.
 *
 * Added because dispatching required a `stepId` and there was no way to learn
 * one: finding a step meant opening an SSH session and querying SQLite by hand.
 * A pipeline you cannot observe over the same interface you drive it with is a
 * pipeline you debug by guessing.
 *
 * Note this sits under `/api/agent`, which the middleware treats as public so
 * that HMAC-signed callbacks from GitHub Actions can reach it. That makes the
 * `isAuthenticatedOrBot` check below the only thing standing in front of the
 * run history — it is not belt-and-braces, it is the belt.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get("limit"));
  const projectFilter = searchParams.get("project");

  const runs = await listRuns(limit);
  const visible = projectFilter
    ? runs.filter((run) => run.projectId === projectFilter)
    : runs;

  const withSteps = await Promise.all(
    visible.map(async (run) => {
      const steps = await listSteps(run.id);
      return {
        id: run.id,
        source: run.source,
        sourceId: run.sourceId,
        projectId: run.projectId,
        status: run.status,
        baseSha: run.baseSha,
        error: run.error,
        createdAt: run.createdAt,
        // The plans themselves are thousands of characters each and are not
        // what you come to a listing for. `/api/agent/runs/<id>` has them.
        hasPlans: !!run.implementationPlan && !!run.qaPlan,
        steps: steps.map((step) => ({
          id: step.id,
          idx: step.idx,
          title: step.title,
          status: step.status,
          attempt: step.attempt,
          branch: step.branch,
          prNumber: step.prNumber,
        })),
      };
    }),
  );

  return json(200, { runs: withSteps });
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}
