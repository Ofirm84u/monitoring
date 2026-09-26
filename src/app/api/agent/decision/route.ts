import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  getRun,
  getStep,
  redeemDecision,
  releaseProjectLock,
  setRunStatus,
  setStepStatus,
  updateStep,
} from "@/lib/runs";
import {
  closePullRequest,
  deleteAgentBranch,
  mergePullRequest,
} from "@/lib/dispatch";
import { PROJECTS } from "@/lib/projects";

/**
 * Where a human decision lands — the Telegram buttons, and the UI later.
 *
 * This is the only path that can merge anything. It requires both an
 * authenticated caller and an unspent decision token, and the token is redeemed
 * before any GitHub call, so two button presses racing each other resolve in
 * the database rather than in two merges.
 */

const RATE_LIMIT = { maxAttempts: 30, windowMs: 60 * 1000 };

const ACTIONS = new Set(["merge", "reject", "answer"]);

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface DecisionBody {
  token?: string;
  action?: string;
  answer?: string;
}

export async function POST(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`agent-decision:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  let body: DecisionBody;
  try {
    body = (await request.json()) as DecisionBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { token, action } = body;
  if (typeof token !== "string" || !token) {
    return json(400, { error: "token is required" });
  }
  if (!action || !ACTIONS.has(action)) {
    return json(400, { error: "action must be merge, reject, or answer" });
  }

  // Redeem first. Everything below is a side effect that must happen at most
  // once, so the token is spent before any of it is attempted.
  const redemption = await redeemDecision(token, action, body.answer);
  if (!redemption.ok) {
    const status = redemption.reason === "not_found" ? 404 : 409;
    return json(status, { error: `Decision ${redemption.reason.replace("_", " ")}` });
  }

  const step = await getStep(redemption.decision.stepId);
  if (!step) return json(404, { error: "Step not found" });
  const run = await getRun(step.runId);
  if (!run) return json(404, { error: "Run not found" });

  const project = PROJECTS.find((p) => p.id === run.projectId);
  if (!project?.repo) {
    return json(409, { error: `Project ${run.projectId} has no repo` });
  }

  if (action === "answer") {
    // The answer becomes part of the packet and the step is re-dispatched on
    // the next attempt — the agent asked rather than guessed, and now knows.
    await updateStep(step.id, {
      answer: body.answer ?? "",
      status: "queued",
      attempt: step.attempt + 1,
    });
    await setRunStatus(run.id, "running");
    return json(200, { ok: true, step: { id: step.id, status: "queued" } });
  }

  if (!step.prNumber) {
    return json(409, { error: "This step has no pull request to act on" });
  }

  if (action === "merge") {
    const merged = await mergePullRequest(
      project.repo,
      step.prNumber,
      `${step.title} (step ${step.idx + 1})`,
    );
    if (!merged.ok) {
      // The token is spent, but nothing landed. Surfacing the failure beats
      // silently leaving the step looking approved.
      return json(502, { error: merged.detail });
    }
    await setStepStatus(step.id, "merged");
    await releaseProjectLock(run.projectId);
    return json(200, { ok: true, merged: true, prNumber: step.prNumber });
  }

  // reject
  await closePullRequest(project.repo, step.prNumber);
  if (step.branch) {
    await deleteAgentBranch(project.repo, step.branch);
  }
  await setStepStatus(step.id, "rejected");
  await setRunStatus(run.id, "blocked");
  await releaseProjectLock(run.projectId);
  return json(200, { ok: true, rejected: true, prNumber: step.prNumber });
}
