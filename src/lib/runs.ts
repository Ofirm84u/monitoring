import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  agentChecks,
  agentDecisions,
  agentLocks,
  agentRuns,
  agentSteps,
  type AgentCheck,
  type AgentDecision,
  type AgentRun,
  type AgentStep,
  type CheckStatus,
  type Gate,
  type RunSource,
  type RunStatus,
  type StepStatus,
} from "@/db/schema";
import { randomBytes } from "crypto";

/**
 * Agent runs: the durable record of one idea or defect being turned into code.
 *
 * Before this existed, `activate` generated an implementation plan and a QA
 * plan and returned them in an HTTP response — after which they were gone.
 * Nothing downstream could dispatch, verify, or resume anything. A run is the
 * object that fixes that: the plans, the baseline commit they were written
 * against, and the ordered steps that carry them out.
 */

export interface CreateRunInput {
  source: RunSource;
  /** An articles.json id, or a `defects.id`. */
  sourceId: string;
  projectId: string;
  /**
   * Optional because a run is now created *before* its plans are generated.
   * Planning takes two model calls and tens of seconds; a run that only exists
   * once they return is a run that vanishes if the process dies mid-request —
   * which is exactly what happened in production. A defect run passes both in
   * directly, since its plan is its triage and needs no model call.
   */
  implementationPlan?: string;
  qaPlan?: string;
}

export async function createRun(input: CreateRunInput): Promise<AgentRun> {
  const [run] = await db
    .insert(agentRuns)
    .values({
      source: input.source,
      sourceId: input.sourceId,
      projectId: input.projectId,
      implementationPlan: input.implementationPlan ?? null,
      qaPlan: input.qaPlan ?? null,
      status: "planning",
    })
    .returning();
  return run;
}

/**
 * Fill in the plans of a run that was created before they existed.
 *
 * Leaves `status` alone: the caller decides whether planning finishing means
 * the run is ready (`baseline`) or still has work to do, and conflating the two
 * here would hide a failure behind a successful write.
 */
export async function setRunPlans(
  id: string,
  plans: { implementationPlan: string; qaPlan: string },
): Promise<AgentRun | null> {
  const [run] = await db
    .update(agentRuns)
    .set({ ...plans, updatedAt: new Date() })
    .where(eq(agentRuns.id, id))
    .returning();
  return run ?? null;
}

export async function getRun(id: string): Promise<AgentRun | null> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return run ?? null;
}

/** The most recent run for a source, if one exists. */
export async function findRunBySource(
  source: RunSource,
  sourceId: string,
): Promise<AgentRun | null> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.source, source), eq(agentRuns.sourceId, sourceId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function listRuns(limit = 50): Promise<AgentRun[]> {
  return db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(limit);
}

export async function setRunStatus(
  id: string,
  status: RunStatus,
  error?: string,
): Promise<AgentRun | null> {
  const [run] = await db
    .update(agentRuns)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(agentRuns.id, id))
    .returning();
  return run ?? null;
}

/**
 * Record the commit the baseline was measured at.
 *
 * Every gate after G0 is a comparison against this commit, so a run without one
 * has nothing to compare to and must not dispatch.
 */
export async function setRunBaseline(
  id: string,
  baseSha: string,
): Promise<AgentRun | null> {
  const [run] = await db
    .update(agentRuns)
    .set({ baseSha, status: "running", updatedAt: new Date() })
    .where(eq(agentRuns.id, id))
    .returning();
  return run ?? null;
}

export interface StepInput {
  title: string;
  instruction: string;
  acceptance: string[];
}

/** Steps are created together and dispatched one at a time, in `idx` order. */
export async function createSteps(
  runId: string,
  steps: StepInput[],
): Promise<AgentStep[]> {
  if (steps.length === 0) return [];
  return db
    .insert(agentSteps)
    .values(
      steps.map((step, idx) => ({
        runId,
        idx,
        title: step.title,
        instruction: step.instruction,
        acceptance: step.acceptance,
      })),
    )
    .returning();
}

export async function listSteps(runId: string): Promise<AgentStep[]> {
  return db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.idx);
}

export async function getStep(id: string): Promise<AgentStep | null> {
  const [step] = await db.select().from(agentSteps).where(eq(agentSteps.id, id)).limit(1);
  return step ?? null;
}

export async function updateStep(
  id: string,
  patch: Partial<Pick<AgentStep, "status" | "branch" | "prNumber" | "headSha" | "attempt" | "question" | "answer">>,
): Promise<AgentStep | null> {
  const [step] = await db
    .update(agentSteps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agentSteps.id, id))
    .returning();
  return step ?? null;
}

export async function setStepStatus(
  id: string,
  status: StepStatus,
): Promise<AgentStep | null> {
  return updateStep(id, { status });
}

/**
 * Take the per-project lock for a step.
 *
 * Two agents editing one checkout produce a diff neither step owns, which makes
 * every gate below it meaningless. The primary key on `projectId` is what makes
 * that impossible rather than merely discouraged — a second acquire fails.
 *
 * @returns false when another step already holds this project's lock.
 */
export async function acquireProjectLock(
  projectId: string,
  stepId: string,
): Promise<boolean> {
  try {
    await db.insert(agentLocks).values({ projectId, stepId });
    return true;
  } catch (err) {
    // Only a primary-key collision means "someone else holds it". Anything else
    // is a real failure and must surface — a disk error reported as a busy lock
    // would stall every run on the project with no explanation.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) return false;
    throw err;
  }
}

export async function releaseProjectLock(projectId: string): Promise<void> {
  await db.delete(agentLocks).where(eq(agentLocks.projectId, projectId));
}

export async function getProjectLock(projectId: string) {
  const [lock] = await db
    .select()
    .from(agentLocks)
    .where(eq(agentLocks.projectId, projectId))
    .limit(1);
  return lock ?? null;
}

export interface RecordCheckInput {
  stepId: string;
  /**
   * The attempt this verdict belongs to. Required rather than defaulted: a check
   * silently filed under attempt 0 would be read as evidence about code from a
   * different attempt, which is the failure this column exists to prevent.
   */
  attempt: number;
  gate: Gate;
  status: CheckStatus;
  summary: string;
  evidence?: unknown;
  durationMs?: number;
}

export async function recordCheck(input: RecordCheckInput): Promise<AgentCheck> {
  const [check] = await db
    .insert(agentChecks)
    .values({
      stepId: input.stepId,
      attempt: input.attempt,
      gate: input.gate,
      status: input.status,
      summary: input.summary,
      evidence: input.evidence ?? null,
      durationMs: input.durationMs,
    })
    .returning();
  return check;
}

export async function listChecks(
  stepId: string,
  /** Omit for the whole history; pass an attempt to judge that attempt alone. */
  attempt?: number,
): Promise<AgentCheck[]> {
  const where =
    attempt === undefined
      ? eq(agentChecks.stepId, stepId)
      : and(eq(agentChecks.stepId, stepId), eq(agentChecks.attempt, attempt));
  return db.select().from(agentChecks).where(where).orderBy(agentChecks.createdAt);
}

const DECISION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Create a pending decision and its single-use token.
 *
 * The token is what a Telegram button carries. It is burnt on use and expires
 * on its own, so a forwarded or replayed button press cannot merge a PR twice.
 */
export async function createDecision(input: {
  stepId: string;
  kind: "approve" | "question";
  prompt: string;
  ttlMs?: number;
}): Promise<AgentDecision> {
  const [decision] = await db
    .insert(agentDecisions)
    .values({
      stepId: input.stepId,
      kind: input.kind,
      prompt: input.prompt,
      token: randomBytes(24).toString("base64url"),
      expiresAt: new Date(Date.now() + (input.ttlMs ?? DECISION_TTL_MS)),
    })
    .returning();
  return decision;
}

export type DecisionRedemption =
  | { ok: true; decision: AgentDecision }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

/**
 * Redeem a decision token exactly once.
 *
 * The update is conditional on `usedAt` still being null, so two button presses
 * racing each other resolve in the database rather than in application code —
 * the loser gets `already_used` instead of a second merge.
 */
/**
 * The decision a step is currently waiting on, if any.
 *
 * Unspent and unexpired, newest first. Needed because delivering a decision to
 * Telegram is best-effort by design — a send failure must never fail the gate
 * callback that produced the verdict — which means something has to be able to
 * try again. Without this, a Telegram outage silently costs that step its
 * notification for good.
 */
export async function findPendingDecision(stepId: string) {
  const [decision] = await db
    .select()
    .from(agentDecisions)
    .where(
      and(
        eq(agentDecisions.stepId, stepId),
        isNull(agentDecisions.usedAt),
        gt(agentDecisions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(agentDecisions.createdAt))
    .limit(1);
  return decision ?? null;
}

export async function redeemDecision(
  token: string,
  action: string,
  answer?: string,
): Promise<DecisionRedemption> {
  const [decision] = await db
    .select()
    .from(agentDecisions)
    .where(eq(agentDecisions.token, token))
    .limit(1);

  if (!decision) return { ok: false, reason: "not_found" };
  if (decision.usedAt) return { ok: false, reason: "already_used" };
  if (decision.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const [redeemed] = await db
    .update(agentDecisions)
    .set({ usedAt: new Date(), action, answer: answer ?? null })
    .where(
      and(eq(agentDecisions.id, decision.id), isNull(agentDecisions.usedAt)),
    )
    .returning();

  if (!redeemed) return { ok: false, reason: "already_used" };
  return { ok: true, decision: redeemed };
}
