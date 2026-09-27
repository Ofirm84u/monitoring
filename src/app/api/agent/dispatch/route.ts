import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { dispatchStep } from "@/lib/dispatch";

/**
 * Send one step to its repo's workflow.
 *
 * Authenticated like the rest of the app — this is the human (or the bot acting
 * for them) starting work, not the agent calling in. Dispatch is deliberately
 * one step at a time: `dispatchStep` takes the per-project lock, so asking for
 * a second step on a busy repo is refused rather than queued.
 */

const RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 1000 };

/** Reasons that are the caller's fault rather than ours. */
const CLIENT_ERROR_REASONS = new Set([
  "no_repo",
  "no_verify_contract",
  "unmeasured_baseline",
  "locked",
]);

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface DispatchBody {
  stepId?: string;
  dryRun?: boolean;
}

export async function POST(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`agent-dispatch:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  let body: DispatchBody;
  try {
    body = (await request.json()) as DispatchBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (typeof body.stepId !== "string" || !body.stepId) {
    return json(400, { error: "stepId is required" });
  }

  const result = await dispatchStep(body.stepId, { dryRun: body.dryRun === true });
  if (!result.ok) {
    const status = CLIENT_ERROR_REASONS.has(result.reason) ? 409 : 502;
    return json(status, { error: result.detail, reason: result.reason });
  }

  return json(200, {
    ok: true,
    branch: result.branch,
    baseSha: result.baseSha,
  });
}
