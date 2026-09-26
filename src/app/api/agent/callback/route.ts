import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  verifySignature,
} from "@/lib/agent-auth";
import {
  createDecision,
  getRun,
  getStep,
  recordCheck,
  releaseProjectLock,
  setRunStatus,
  setStepStatus,
  updateStep,
} from "@/lib/runs";
import { GATES, type CheckStatus, type Gate } from "@/db/schema";

/**
 * Where the workflow reports back.
 *
 * This is the only new externally reachable surface in the design, so it trusts
 * nothing: the signature is checked over the exact bytes received, the step id
 * in the body must resolve to a real step, and the event is matched against a
 * closed set. A verified caller still cannot merge anything — landing a PR
 * requires a decision token that only a human can spend.
 */

const RATE_LIMIT = { maxAttempts: 120, windowMs: 60 * 1000 };
const MAX_BODY_BYTES = 512 * 1024;

const GATE_SET = new Set<string>(GATES);
const CHECK_STATUS_SET = new Set<string>(["pass", "fail", "skip", "advisory"]);

type CallbackEvent = "implemented" | "gate" | "ready" | "question" | "failed";
const EVENTS = new Set<string>([
  "implemented",
  "gate",
  "ready",
  "question",
  "failed",
]);

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface CallbackBody {
  stepId?: string;
  event?: string;
  branch?: string;
  prNumber?: number;
  headSha?: string;
  gate?: {
    gate?: string;
    status?: string;
    summary?: string;
    evidence?: unknown;
    durationMs?: number;
  };
  question?: string;
  error?: string;
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`agent-callback:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return json(413, { error: "Payload too large" });
  }

  // Read the raw body and verify against those exact bytes. Re-serialising
  // parsed JSON would change them and the signature would never match.
  const rawBody = await request.text();
  const result = verifySignature(
    rawBody,
    request.headers.get(AGENT_SIGNATURE_HEADER),
    request.headers.get(AGENT_TIMESTAMP_HEADER),
  );
  if (!result.valid) {
    return json(401, { error: "Unauthorized" });
  }

  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody) as CallbackBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (typeof body.stepId !== "string" || !EVENTS.has(body.event ?? "")) {
    return json(400, { error: "stepId and a known event are required" });
  }
  const event = body.event as CallbackEvent;

  const step = await getStep(body.stepId);
  if (!step) return json(404, { error: "Step not found" });
  const run = await getRun(step.runId);
  if (!run) return json(404, { error: "Run not found" });

  switch (event) {
    case "implemented": {
      // The branch is pushed and the PR is open; gates run next.
      await updateStep(step.id, {
        status: "verifying",
        branch: typeof body.branch === "string" ? body.branch : step.branch ?? undefined,
        prNumber: typeof body.prNumber === "number" ? body.prNumber : undefined,
        headSha: typeof body.headSha === "string" ? body.headSha : undefined,
      });
      return json(200, { ok: true });
    }

    case "gate": {
      const gate = body.gate?.gate;
      const status = body.gate?.status;
      if (!gate || !GATE_SET.has(gate)) {
        return json(400, { error: `Unknown gate: ${String(gate)}` });
      }
      if (!status || !CHECK_STATUS_SET.has(status)) {
        return json(400, { error: `Unknown check status: ${String(status)}` });
      }
      await recordCheck({
        stepId: step.id,
        gate: gate as Gate,
        status: status as CheckStatus,
        summary:
          typeof body.gate?.summary === "string"
            ? body.gate.summary.slice(0, 2_000)
            : gate,
        evidence: body.gate?.evidence ?? null,
        durationMs:
          typeof body.gate?.durationMs === "number" ? body.gate.durationMs : undefined,
      });
      return json(200, { ok: true });
    }

    case "ready": {
      // Gates have run. The step now waits on a person — the lock deliberately
      // stays held, so no other step starts on this repo while a PR is pending.
      await setStepStatus(step.id, "awaiting_decision");
      const decision = await createDecision({
        stepId: step.id,
        kind: "approve",
        prompt: `${step.title} — PR #${step.prNumber ?? body.prNumber ?? "?"}`,
      });
      return json(200, { ok: true, decisionId: decision.id });
    }

    case "question": {
      // The agent hit something it should not guess at. Park the run.
      const question =
        typeof body.question === "string" ? body.question.slice(0, 2_000) : "";
      if (!question) return json(400, { error: "question is required" });
      await updateStep(step.id, { question, status: "awaiting_decision" });
      await setRunStatus(run.id, "awaiting_answer");
      const decision = await createDecision({
        stepId: step.id,
        kind: "question",
        prompt: question,
      });
      return json(200, { ok: true, decisionId: decision.id });
    }

    case "failed": {
      const detail =
        typeof body.error === "string" ? body.error.slice(0, 2_000) : "Step failed";
      await setStepStatus(step.id, "failed");
      await setRunStatus(run.id, "failed", detail);
      // The step settled, so the repo is free for the next one.
      await releaseProjectLock(run.projectId);
      return json(200, { ok: true });
    }
  }
}
