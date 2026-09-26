import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyPacketToken } from "@/lib/agent-auth";
import { getRun, getStep } from "@/lib/runs";
import { getDefect } from "@/lib/defects";
import { buildPacket } from "@/lib/agent-packet";
import { PROJECTS } from "@/lib/projects";

/**
 * The work order for one dispatched step.
 *
 * Authenticated by the short-lived token minted at dispatch — deliberately not
 * the bot token or a session, because this is fetched from inside a GitHub
 * Actions runner and a long-lived credential has no business travelling there.
 * The token is bound to the step and its attempt, so a re-run of a superseded
 * workflow cannot pull a packet it should no longer act on.
 */

const RATE_LIMIT = { maxAttempts: 30, windowMs: 60 * 1000 };

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

interface RouteContext {
  params: Promise<{ stepId: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`agent-packet:${ip}`, RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { stepId } = await params;

  // Prefer the header; the query parameter exists because some runner steps
  // find it easier to curl a URL than to set a header.
  const { searchParams } = new URL(request.url);
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : searchParams.get("token");

  const verification = verifyPacketToken(stepId, token);
  if (!verification.valid) {
    // One opaque message for every failure: a caller probing this endpoint
    // should not learn whether the step exists, or why its token was refused.
    return json(401, { error: "Unauthorized" });
  }

  const step = await getStep(stepId);
  if (!step) return json(404, { error: "Not found" });

  // The token is bound to an attempt. A stale workflow re-run holds a token for
  // an attempt that has moved on, and must not receive current instructions.
  if (step.attempt !== verification.attempt) {
    return json(409, { error: "This step has been re-dispatched; token is superseded" });
  }

  const run = await getRun(step.runId);
  if (!run) return json(404, { error: "Not found" });

  const project = PROJECTS.find((p) => p.id === run.projectId);
  if (!project) return json(404, { error: "Not found" });

  // A defect run whose defect has gone is not an article run. Silently building
  // a packet without the defect context would drop the reproduction gate and
  // the screenshot's visible strings, and the agent would attempt a fix with no
  // way to prove it — better to refuse than to produce a weaker work order.
  let defect = null;
  if (run.source === "defect") {
    defect = await getDefect(run.sourceId);
    if (!defect) {
      return json(409, {
        error: `Run ${run.id} references defect ${run.sourceId}, which no longer exists`,
      });
    }
  }

  const base = process.env.APP_BASE_URL?.replace(/\/$/, "") ?? "";

  try {
    const packet = buildPacket({
      run,
      step,
      project,
      defect,
      callbackUrl: `${base}/api/agent/callback`,
      dryRun: false,
    });
    return json(200, { packet });
  } catch (err) {
    // A packet that cannot be built is a precondition failure, not a 500 —
    // typically a missing verify contract or an unrecorded baseline.
    return json(409, {
      error: err instanceof Error ? err.message : "Could not build packet",
    });
  }
}
