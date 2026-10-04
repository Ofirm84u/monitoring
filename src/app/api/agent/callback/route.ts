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
  listChecks,
  recordCheck,
  releaseProjectLock,
  setRunStatus,
  setStepStatus,
  updateStep,
} from "@/lib/runs";
import { GATES, type CheckStatus, type Gate } from "@/db/schema";
import { evaluateReproduction, evaluateSmoke, isReadyForDecision } from "@/lib/gates";
import { PROJECTS } from "@/lib/projects";
import { requiredReproductionGate } from "@/lib/reproduction";
import { sendDecisionCard } from "@/lib/telegram";

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
  /** Which attempt the runner was dispatched for; see the check below. */
  attempt?: number;
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
    /** G5-A / G5-B report observations; the verdict is decided server-side. */
    reproduction?: { failedAtBase?: boolean; passedAtHead?: boolean };
    /** G3 likewise. */
    smoke?: { smokeCmd?: string; baselineOk?: boolean; headOk?: boolean };
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

  // A verdict belongs to the attempt that produced it. Answering a question or
  // aborting a step bumps the attempt, which retires the runner working on the
  // old one — and a late callback from that runner would otherwise be filed
  // against the current attempt, describing code it never saw. The packet route
  // already refuses a superseded token; this is the same refusal on the way back.
  if (typeof body.attempt === "number" && body.attempt !== step.attempt) {
    return json(409, {
      error: "Superseded",
      detail: `This callback is for attempt ${body.attempt}; the step is on attempt ${step.attempt}.`,
    });
  }

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
      if (!gate || !GATE_SET.has(gate)) {
        return json(400, { error: `Unknown gate: ${String(gate)}` });
      }

      // For G3 and G5 the workflow reports what it observed, and the verdict is
      // decided here. The interesting question in both is a comparison against
      // the baseline, and a runner that judged it for itself could report "the
      // test passes" as a success when what it means is "the test never failed".
      if (gate === "G5-A" || gate === "G5-B") {
        const repro = body.gate?.reproduction;
        if (
          typeof repro?.failedAtBase !== "boolean" ||
          typeof repro?.passedAtHead !== "boolean"
        ) {
          return json(400, {
            error: "A reproduction gate must report failedAtBase and passedAtHead",
          });
        }
        const verdict = evaluateReproduction(gate, repro.failedAtBase, repro.passedAtHead);
        await recordCheck({ stepId: step.id, attempt: step.attempt, ...verdict });
        return json(200, { ok: true, verdict });
      }

      if (gate === "G3") {
        const smoke = body.gate?.smoke;
        const verdict = evaluateSmoke(
          typeof smoke?.smokeCmd === "string" ? smoke.smokeCmd : null,
          typeof smoke?.baselineOk === "boolean" ? smoke.baselineOk : null,
          typeof smoke?.headOk === "boolean" ? smoke.headOk : null,
        );
        await recordCheck({ stepId: step.id, attempt: step.attempt, ...verdict });
        return json(200, { ok: true, verdict });
      }

      // G0 and G1 are a single command's exit code, so the runner's own result
      // is the observation and the verdict at once.
      const status = body.gate?.status;
      if (!status || !CHECK_STATUS_SET.has(status)) {
        return json(400, { error: `Unknown check status: ${String(status)}` });
      }
      await recordCheck({
        stepId: step.id,
        attempt: step.attempt,
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
      // "ready" is the runner's claim, not a verdict. The workflow does check
      // the review endpoint's answer before posting this, but that check lives
      // on the runner — and a runner is exactly what this design refuses to
      // take the word of. The decision token is minted here, so this is where
      // readiness has to be established, from the gate rows the server wrote.
      const project = PROJECTS.find((p) => p.id === run.projectId);
      const reproduction = project
        ? await requiredReproductionGate(run, project)
        : null;
      const verdict = isReadyForDecision(await listChecks(step.id, step.attempt), reproduction);
      if (!verdict.ready) {
        return json(409, {
          error: "Not ready for a decision",
          blockedBy: verdict.blockedBy,
          missing: verdict.missing,
          detail:
            verdict.missing.length > 0
              ? `These gates never reported: ${verdict.missing.join(", ")}. A gate that did not run is not a gate that passed.`
              : `Blocked by ${verdict.blockedBy.join(", ")}.`,
        });
      }

      // Gates have run. The step now waits on a person — the lock deliberately
      // stays held, so no other step starts on this repo while a PR is pending.
      await setStepStatus(step.id, "awaiting_decision");
      // Clear a failure left by an earlier attempt. Without this, a run whose
      // first dispatch failed stayed `failed` for ever while its step sat at
      // `awaiting_decision` with an open PR — the listing showed a stale error
      // beside a step asking to be merged, which is the kind of disagreement
      // that makes a status worth less than no status at all.
      if (run.status !== "running") {
        await setRunStatus(run.id, "running");
      }
      const prNumber =
        step.prNumber ?? (typeof body.prNumber === "number" ? body.prNumber : null);
      const decision = await createDecision({
        stepId: step.id,
        kind: "approve",
        prompt: decisionPrompt(step.title, prNumber, await listChecks(step.id, step.attempt)),
      });

      // Best-effort, and awaited only so the result can be reported. A Telegram
      // failure must not fail this callback: the gates have already run and the
      // decision is already recorded, so the worst case is falling back to the
      // database lookup this card exists to replace.
      const delivery = await sendDecisionCard({
        token: decision.token,
        kind: "approve",
        prompt: decision.prompt,
        projectId: run.projectId,
        repo: project?.repo ?? null,
        prNumber,
      });

      return json(200, { ok: true, decisionId: decision.id, telegram: delivery });
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

      const asked = await sendDecisionCard({
        token: decision.token,
        kind: "question",
        prompt: question,
        projectId: run.projectId,
        repo: PROJECTS.find((p) => p.id === run.projectId)?.repo ?? null,
        // A parked step has no pull request: it is parked precisely because
        // nothing was pushed.
        prNumber: null,
      });

      return json(200, { ok: true, decisionId: decision.id, telegram: asked });
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


/**
 * What a person sees when asked to approve a merge.
 *
 * The acceptance review's concerns were the sharpest read anyone had of the first
 * real change — it was the only gate to notice that a pull request contained no
 * code — and they were buried in a JSON evidence blob reachable only through the
 * API. This design puts its safety in an informed human decision, so withholding
 * the best signal available from exactly that decision was the real defect.
 *
 * Gate summaries come first, because a reviewer needs to know what was *not*
 * checked as much as what passed: a skipped G3 means nothing verified that the
 * application still starts.
 */
function decisionPrompt(
  title: string,
  prNumber: number | null,
  checks: Array<{ gate: Gate; status: CheckStatus; summary: string; evidence?: unknown }>,
): string {
  const lines = [`${title} — PR #${prNumber ?? "?"}`];

  // Latest verdict per gate, in the order the ladder runs them.
  const latest = new Map<Gate, { status: CheckStatus; summary: string; evidence?: unknown }>();
  for (const check of checks) latest.set(check.gate, check);

  const gateLines = [...latest.entries()]
    .filter(([, c]) => c.status !== "pass")
    .map(([gate, c]) => `${gate} ${c.status}: ${c.summary}`);

  if (gateLines.length === 0) {
    lines.push("", "All gates passed.");
  } else {
    lines.push("", "Not a clean pass:", ...gateLines.map((l) => `- ${l}`));
  }

  const review = latest.get("G4")?.evidence as
    | { verdicts?: Array<{ criterion: string; verdict: string }>; concerns?: string[] }
    | undefined;

  const unmet = (review?.verdicts ?? []).filter((v) => v.verdict === "not_met");
  if (unmet.length > 0) {
    lines.push(
      "",
      `Criteria the review found unmet (${unmet.length}):`,
      ...unmet.slice(0, 5).map((v) => `- ${v.criterion}`),
    );
  }

  const concerns = review?.concerns ?? [];
  if (concerns.length > 0) {
    lines.push(
      "",
      "Concerns raised that no criterion covers:",
      ...concerns.slice(0, 5).map((c) => `- ${c}`),
    );
  }

  return lines.join("\n").slice(0, 4_000);
}
