import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  verifySignature,
} from "@/lib/agent-auth";
import { getRun, getStep, listChecks, listSteps, recordCheck } from "@/lib/runs";
import { evaluateDiffBudget, evaluateSmoke, isReadyForDecision } from "@/lib/gates";
import { requiredReproductionGate } from "@/lib/reproduction";
import { reviewAcceptance } from "@/lib/claude";
import { PROJECTS } from "@/lib/projects";

/**
 * G2 and G4, evaluated here rather than in workflow bash.
 *
 * Two reasons this is server-side. The denylist and the diff budget have one
 * definition in `agent-packet.ts`; copied into fourteen caller workflows they
 * would drift, and the copy that drifts is the one that stops catching things.
 * And the acceptance review needs ANTHROPIC_API_KEY, which belongs on one
 * server rather than in fourteen repository secrets.
 */

const RATE_LIMIT = { maxAttempts: 30, windowMs: 60 * 1000 };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface ReviewBody {
  stepId?: string;
  changedFiles?: string[];
  additions?: number;
  deletions?: number;
  diff?: string;
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`agent-review:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return json(413, { error: "Payload too large" });
  }

  const rawBody = await request.text();
  const signature = verifySignature(
    rawBody,
    request.headers.get(AGENT_SIGNATURE_HEADER),
    request.headers.get(AGENT_TIMESTAMP_HEADER),
  );
  if (!signature.valid) return json(401, { error: "Unauthorized" });

  let body: ReviewBody;
  try {
    body = JSON.parse(rawBody) as ReviewBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (typeof body.stepId !== "string" || !Array.isArray(body.changedFiles)) {
    return json(400, { error: "stepId and changedFiles are required" });
  }

  const step = await getStep(body.stepId);
  if (!step) return json(404, { error: "Step not found" });
  const run = await getRun(step.runId);
  if (!run) return json(404, { error: "Run not found" });
  const project = PROJECTS.find((p) => p.id === run.projectId);
  if (!project) return json(404, { error: "Project not found" });

  const changedFiles = body.changedFiles.filter(
    (f): f is string => typeof f === "string",
  );

  // G3 is required, and on a project with no smoke command the workflow's G3
  // steps never run — so nothing reported, and an unreported blocking gate used
  // to read as a pass. Record the verdict the contract already implies: a skip
  // that names the gap, which a reviewer can weigh. If a smoke command *is*
  // declared and still nothing arrived, evaluateSmoke says so and blocks.
  const existing = await listChecks(step.id);
  if (!existing.some((check) => check.gate === "G3")) {
    const smoke = evaluateSmoke(project.verify?.smokeCmd ?? null, null, null);
    await recordCheck({
      stepId: step.id,
      gate: smoke.gate,
      status: smoke.status,
      summary: smoke.summary,
      evidence: smoke.evidence,
    });
  }

  const reproduction = await requiredReproductionGate(run, project);
  const readiness = async () => isReadyForDecision(await listChecks(step.id), reproduction);

  // G2 first. A diff that already broke scope should not also cost a model call,
  // and its verdict would be meaningless anyway — the change under review is not
  // the change that was planned.
  const scope = evaluateDiffBudget({
    changedFiles,
    additions: typeof body.additions === "number" ? body.additions : 0,
    deletions: typeof body.deletions === "number" ? body.deletions : 0,
  });
  await recordCheck({
    stepId: step.id,
    gate: scope.gate,
    status: scope.status,
    summary: scope.summary,
    evidence: scope.evidence,
  });

  if (scope.status === "fail") {
    return json(200, { scope, review: null, ...(await readiness()) });
  }

  // G4. Advisory: it records a verdict per criterion and can raise concerns,
  // but it never decides whether the step proceeds.
  const criteria = step.acceptance ?? [];
  if (criteria.length === 0) {
    await recordCheck({
      stepId: step.id,
      gate: "G4",
      status: "skip",
      summary: "No acceptance criteria were parsed from the QA plan",
      evidence: null,
    });
  } else {
    try {
      const review = await reviewAcceptance({
        project,
        stepTitle: step.title,
        criteria,
        diff: typeof body.diff === "string" ? body.diff : "",
        stepIndex: step.idx + 1,
        stepCount: (await listSteps(run.id)).length,
      });
      const unmet = review.verdicts.filter((v) => v.verdict !== "met");
      await recordCheck({
        stepId: step.id,
        gate: "G4",
        status: "advisory",
        summary:
          unmet.length === 0
            ? `All ${review.totalCount} criteria met`
            : `${review.metCount} of ${review.totalCount} criteria met; ${unmet.length} unresolved`,
        evidence: review,
      });
      return json(200, { scope, review, ...(await readiness()) });
    } catch (err) {
      // A review that could not run is recorded as such. Treating a failed
      // review as a pass would quietly remove the gate.
      await recordCheck({
        stepId: step.id,
        gate: "G4",
        status: "skip",
        summary: `Acceptance review did not run: ${err instanceof Error ? err.message : "unknown error"}`,
        evidence: null,
      });
    }
  }

  return json(200, { scope, review: null, ...(await readiness()) });
}
