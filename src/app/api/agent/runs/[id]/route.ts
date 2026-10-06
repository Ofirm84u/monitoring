import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getRun, listChecks, listSteps } from "@/lib/runs";

/**
 * One run in full: its plans, its steps, and every gate result recorded against
 * them.
 *
 * This is what `activate` now points at instead of returning plans inline, and
 * it is where you read whether planning finished — `status: "planning"` with no
 * steps means it is still working, `"failed"` carries the reason in `error`.
 */

// A listing, so generous — but not unbounded.
const RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 1000 };

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`agent-run:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { id } = await params;
  const run = await getRun(id);
  if (!run) return json(404, { error: "Run not found" });

  const steps = await listSteps(run.id);
  const withChecks = await Promise.all(
    steps.map(async (step) => ({
      id: step.id,
      idx: step.idx,
      title: step.title,
      instruction: step.instruction,
      acceptance: step.acceptance ?? [],
      status: step.status,
      attempt: step.attempt,
      branch: step.branch,
      prNumber: step.prNumber,
      headSha: step.headSha,
      question: step.question,
      answer: step.answer,
      checks: (await listChecks(step.id)).map((check) => ({
        gate: check.gate,
        status: check.status,
        summary: check.summary,
        evidence: check.evidence,
        durationMs: check.durationMs,
        createdAt: check.createdAt,
      })),
    })),
  );

  return json(200, {
    id: run.id,
    source: run.source,
    sourceId: run.sourceId,
    projectId: run.projectId,
    status: run.status,
    baseSha: run.baseSha,
    error: run.error,
    implementationPlan: run.implementationPlan,
    qaPlan: run.qaPlan,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    steps: withChecks,
  });
}
