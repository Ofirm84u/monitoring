import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { defects } from "@/db/schema";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getDefect } from "@/lib/defects";
import { buildDefectStep, defectBlockedReason } from "@/lib/defect-run";
import { createRun, createSteps } from "@/lib/runs";
import { PROJECTS } from "@/lib/projects";

/**
 * Turn a triaged defect into a run the agent can work on.
 *
 * The bridge the defect path was missing: capture and triage produced a record,
 * but nothing made it dispatchable. A defect run carries no generated plan —
 * the step is derived from what triage observed — so unlike an article there is
 * no second model call between reporting a bug and being able to work on it.
 */

const RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 1000 };

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`defect-activate:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { id } = await params;
  const defect = await getDefect(id);
  if (!defect) return json(404, { error: "Not found" });

  // A defect triage was not confident about is not a defect to hand an agent.
  // It goes back to you with its questions instead.
  const blocked = defectBlockedReason(defect);
  if (blocked) return json(409, { error: blocked, missingInfo: defect.missingInfo ?? [] });

  const project = PROJECTS.find((p) => p.id === defect.projectId);
  if (!project) {
    return json(409, { error: `Unknown project: ${defect.projectId}` });
  }
  if (!project.verify) {
    return json(409, {
      error: `${project.name} has no verify contract, so G0 would have nothing to measure. The defect is recorded, but it cannot be worked on here yet.`,
    });
  }

  const run = await createRun({
    source: "defect",
    sourceId: defect.id,
    projectId: defect.projectId,
    // A defect's "plan" is its triage. Kept on the run so the record is
    // self-contained even if the defect row is later deleted.
    implementationPlan: defect.symptom ?? defect.whatHappened,
    qaPlan: (defect.missingInfo ?? []).join("\n"),
  });

  const steps = await createSteps(run.id, [buildDefectStep(defect)]);

  await db
    .update(defects)
    .set({ runId: run.id, status: "planned" })
    .where(eq(defects.id, defect.id));

  return json(201, {
    runId: run.id,
    steps: steps.map((s) => ({ id: s.id, idx: s.idx, title: s.title })),
    reproductionExpected: defect.tier === "state" || defect.tier === "flow",
    projectId: project.id,
  });
}
