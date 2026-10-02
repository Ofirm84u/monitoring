import type { AgentRun, AgentStep } from "@/db/schema";
import { PROJECTS } from "@/lib/projects";
import { signPacketToken } from "@/lib/agent-auth";
import {
  acquireProjectLock,
  getStep,
  listChecks,
  releaseProjectLock,
  setRunBaseline,
  updateStep,
} from "@/lib/runs";
import { getRun } from "@/lib/runs";
import { branchNameFor } from "@/lib/agent-packet";

/**
 * Sending one step to GitHub Actions.
 *
 * The dispatch payload carries ids and a short-lived token and nothing else —
 * the workflow fetches the real packet back from this app. `client_payload` is
 * visible in the Actions UI and in webhook deliveries, so keeping plan text and
 * defect detail out of it means the packet has exactly one authoritative copy
 * and no sensitive context leaks into GitHub's logs.
 */

const GITHUB_USER = "Ofirm84u";
const DISPATCH_EVENT = "idea-agent";
const GITHUB_TIMEOUT_MS = 15_000;

export type DispatchResult =
  | { ok: true; branch: string; baseSha: string }
  | {
      ok: false;
      reason:
        | "unconfigured"
        | "no_repo"
        | "no_verify_contract"
        | "unmeasured_baseline"
        | "locked"
        | "baseline_unavailable"
        | "dispatch_failed";
      detail: string;
    };

function appBaseUrl(): string | null {
  const url = process.env.APP_BASE_URL;
  if (!url) return null;
  return url.replace(/\/$/, "");
}

async function githubRequest(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    return await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** The commit the baseline will be measured at, resolved once per run. */
async function resolveDefaultBranchHead(repo: string): Promise<string | null> {
  const repoRes = await githubRequest(`/repos/${GITHUB_USER}/${repo}`);
  if (!repoRes?.ok) return null;
  const repoData = (await repoRes.json()) as { default_branch?: string };
  const branch = repoData.default_branch;
  if (!branch) return null;

  const refRes = await githubRequest(
    `/repos/${GITHUB_USER}/${repo}/commits/${branch}`,
  );
  if (!refRes?.ok) return null;
  const commit = (await refRes.json()) as { sha?: string };
  return commit.sha ?? null;
}

/**
 * Dispatch one step.
 *
 * Takes the project lock first: two agents editing one checkout produce a diff
 * neither step owns, which would make every gate below it meaningless. The lock
 * is released again if anything after it fails, so a failed dispatch doesn't
 * strand the repo.
 */
export async function dispatchStep(
  stepId: string,
  options?: { dryRun?: boolean },
): Promise<DispatchResult> {
  const dryRun = options?.dryRun ?? false;

  const step = await getStep(stepId);
  if (!step) return { ok: false, reason: "no_repo", detail: "Step not found" };

  const run = await getRun(step.runId);
  if (!run) return { ok: false, reason: "no_repo", detail: "Run not found" };

  const project = PROJECTS.find((p) => p.id === run.projectId);
  if (!project?.repo) {
    return {
      ok: false,
      reason: "no_repo",
      detail: `Project ${run.projectId} has no repo`,
    };
  }
  if (!project.verify) {
    return {
      ok: false,
      reason: "no_verify_contract",
      detail: `${project.name} has no verify contract, so G0 has nothing to measure. Add one before running the agent here.`,
    };
  }

  // The implementer only runs where the baseline has actually been observed
  // green, not merely declared. Everything the gates conclude rests on that
  // measurement; a project whose verify command has never been seen to pass
  // can still do a dry run, which is how it gets measured in the first place.
  if (!dryRun && !project.verify.measured) {
    return {
      ok: false,
      reason: "unmeasured_baseline",
      detail: `${project.name}'s verify command has never been observed passing. Run a dry run first — it measures G0 — then set measured: true.`,
    };
  }

  const base = appBaseUrl();
  const token = signPacketToken(step.id, step.attempt);
  if (!base || !token) {
    return {
      ok: false,
      reason: "unconfigured",
      detail: "APP_BASE_URL and AGENT_SECRET must both be set",
    };
  }

  // Record the commit the run is anchored to before anything is dispatched.
  // G0 measures at this SHA; without it, nothing later can be attributed.
  //
  // A pinned baseline is only sacred once something has been measured against
  // it. Until then it is a stale guess, and re-dispatching a step that never
  // reported would branch from a commit the default branch has moved past —
  // which fails in a way that looks nothing like its cause: a branch carrying
  // an older copy of any workflow file is rejected on push, because GitHub
  // reads that as modifying a workflow and GITHUB_TOKEN can never hold that
  // permission. So re-resolve while no gate result depends on the old value.
  let baseSha = run.baseSha;
  const alreadyMeasured = (await listChecks(step.id)).length > 0;
  if (!baseSha || !alreadyMeasured) {
    const head = await resolveDefaultBranchHead(project.repo);
    if (!head) {
      return {
        ok: false,
        reason: "baseline_unavailable",
        detail: `Could not resolve the head of ${project.repo}'s default branch`,
      };
    }
    if (head !== baseSha) {
      await setRunBaseline(run.id, head);
    }
    baseSha = head;
  }

  const gotLock = await acquireProjectLock(project.id, step.id);
  if (!gotLock) {
    return {
      ok: false,
      reason: "locked",
      detail: `Another step is already running against ${project.name}`,
    };
  }

  const branch = branchNameFor({ ...run, baseSha } as AgentRun, step as AgentStep);

  const res = await githubRequest(`/repos/${GITHUB_USER}/${project.repo}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      event_type: DISPATCH_EVENT,
      client_payload: {
        runId: run.id,
        stepId: step.id,
        token,
        packetUrl: `${base}/api/agent/packet/${step.id}`,
        callbackUrl: `${base}/api/agent/callback`,
        dryRun,
      },
    }),
  });

  if (!res || res.status !== 204) {
    await releaseProjectLock(project.id);
    const detail = res
      ? `GitHub returned ${res.status}`
      : "GitHub request failed or GITHUB_TOKEN is unset";
    return { ok: false, reason: "dispatch_failed", detail };
  }

  await updateStep(step.id, { status: "dispatched", branch });
  return { ok: true, branch, baseSha };
}

/**
 * Landing or discarding a step's pull request.
 *
 * Both paths release the project lock, because either way the step has settled
 * and the next one may start. Neither is ever called by the agent: the only
 * caller is the decision endpoint, which requires a redeemed single-use token.
 */

export type PrActionResult = { ok: true } | { ok: false; detail: string };

export async function mergePullRequest(
  repo: string,
  prNumber: number,
  title: string,
): Promise<PrActionResult> {
  const res = await githubRequest(
    `/repos/${GITHUB_USER}/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      // Squash: one plan step should land as one commit, so a revert is one revert.
      body: JSON.stringify({ merge_method: "squash", commit_title: title }),
    },
  );
  if (!res) return { ok: false, detail: "GitHub request failed" };
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, detail: `GitHub returned ${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

export async function closePullRequest(
  repo: string,
  prNumber: number,
): Promise<PrActionResult> {
  const res = await githubRequest(`/repos/${GITHUB_USER}/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  if (!res?.ok) return { ok: false, detail: `Could not close PR #${prNumber}` };
  return { ok: true };
}

/**
 * Delete a step's branch.
 *
 * Only ever the agent's own `idea/` or `fix/` branch, and never a force-push or
 * a default-branch operation — rejecting a step must not be able to destroy
 * anything a human made.
 */
export async function deleteAgentBranch(
  repo: string,
  branch: string,
): Promise<PrActionResult> {
  if (!branch.startsWith("idea/") && !branch.startsWith("fix/")) {
    return { ok: false, detail: `Refusing to delete a branch the agent did not create: ${branch}` };
  }
  const res = await githubRequest(
    `/repos/${GITHUB_USER}/${repo}/git/refs/heads/${branch}`,
    { method: "DELETE" },
  );
  if (!res) return { ok: false, detail: "GitHub request failed" };
  // 422 means it is already gone, which is the state we wanted.
  if (!res.ok && res.status !== 422) {
    return { ok: false, detail: `Could not delete ${branch} (${res.status})` };
  }
  return { ok: true };
}
