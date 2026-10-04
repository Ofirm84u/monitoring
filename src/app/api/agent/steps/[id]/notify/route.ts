import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { findPendingDecision, getRun, getStep } from "@/lib/runs";
import { PROJECTS } from "@/lib/projects";
import { sendDecisionCard } from "@/lib/telegram";

/**
 * Re-send the Telegram card for whatever decision a step is waiting on.
 *
 * Delivery is best-effort by design: the gate callback that creates a decision
 * must not fail because Telegram is unreachable, since the verdict is already
 * computed and recorded by then. The cost of that choice is that a failed send
 * loses the notification, and the first live card proved it — the app was still
 * holding a revoked bot token, Telegram answered 401, and the decision sat in the
 * database with nobody told about it.
 *
 * Deliberately not automatic. A retry loop would keep hammering a misconfigured
 * token, and the failure reason is already in the callback's response; this is
 * for the operator who has fixed the cause and wants the card they missed.
 */

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

  const { id } = await params;
  const step = await getStep(id);
  if (!step) return json(404, { error: "Step not found" });

  const run = await getRun(step.runId);
  if (!run) return json(409, { error: "Step has no run" });

  const decision = await findPendingDecision(step.id);
  if (!decision) {
    return json(409, {
      error: "Nothing to send",
      detail:
        "This step has no unspent, unexpired decision. A spent decision is not re-sent: the thing it was asking about has already been settled.",
    });
  }

  const project = PROJECTS.find((p) => p.id === run.projectId);
  const delivery = await sendDecisionCard({
    token: decision.token,
    kind: decision.kind as "approve" | "question",
    prompt: decision.prompt,
    projectId: run.projectId,
    repo: project?.repo ?? null,
    prNumber: decision.kind === "question" ? null : step.prNumber,
  });

  return json(delivery.sent ? 200 : 502, {
    decisionId: decision.id,
    kind: decision.kind,
    ...delivery,
  });
}
