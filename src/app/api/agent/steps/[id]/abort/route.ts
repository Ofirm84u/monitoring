import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  getProjectLock,
  getRun,
  getStep,
  releaseProjectLock,
  setRunStatus,
  updateStep,
} from "@/lib/runs";

/**
 * Abandon a dispatched step and free its repo.
 *
 * The lock exists so two agents never edit one checkout at once, and it is
 * released by the callback or by a decision. Both of those assume the workflow
 * actually ran. A workflow that never starts — a bad input type is enough, and
 * it fails in under a second with no logs — reports nothing, so the lock is
 * held by a step that will never settle and every later dispatch for that repo
 * answers `409 locked`. There was no way out of that over HTTP; clearing it
 * meant deleting a row in SQLite over SSH.
 *
 * Bumping `attempt` is the part that matters for safety. The packet token is
 * bound to the step *and* its attempt, so a runner that is somehow still alive
 * cannot use its token after an abort — it gets a 409 instead of writing gate
 * results for work nobody is waiting on.
 */

// Mutates a step and frees a repo lock.
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
  if (!checkRateLimit(`agent-abort:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { id } = await params;
  const step = await getStep(id);
  if (!step) return json(404, { error: "Step not found" });

  const run = await getRun(step.runId);
  if (!run) return json(409, { error: "Step has no run" });

  // A settled step holds no lock, and rewinding it would discard a verdict.
  if (step.status === "merged" || step.status === "rejected") {
    return json(409, {
      error: `This step is already ${step.status}; there is nothing to abort.`,
    });
  }

  // Release only a lock this step actually holds. Another step's lock belongs
  // to a live dispatch, and freeing it would let two runners into one repo —
  // the exact thing the lock exists to prevent.
  const lock = await getProjectLock(run.projectId);
  const heldByThisStep = lock?.stepId === step.id;
  if (heldByThisStep) {
    await releaseProjectLock(run.projectId);
  }

  const updated = await updateStep(step.id, {
    status: "queued",
    attempt: step.attempt + 1,
    // The branch may exist on GitHub from a partial run. Keeping the name
    // recorded is more useful than pretending it was never created.
  });

  // The run keeps its measured baseline — G0 ran against a commit, and that
  // observation is still true. It is the step that is being rewound.
  await setRunStatus(run.id, run.baseSha ? "baseline" : "planning");

  return json(200, {
    stepId: step.id,
    status: updated?.status ?? "queued",
    attempt: updated?.attempt ?? step.attempt + 1,
    lockReleased: heldByThisStep,
    // Said plainly because it is not true of the lock: aborting here does not
    // reach into GitHub. A branch or PR the runner already created stays.
    note: heldByThisStep
      ? `${run.projectId} is free; this step can be dispatched again.`
      : `No lock was held by this step${lock ? ` — ${run.projectId} is locked by ${lock.stepId}` : ""}.`,
  });
}
