/**
 * Reading a repository's dependency manifests, for the planner.
 *
 * Every blocker the implementer hit on the first real runs originated in the
 * plan, not in the implementation: it proposed `import anthropic` for a package
 * that is not a dependency, and a table whose migration would have to live under
 * a denied path. The implementer caught both — but only after a dispatch, a
 * runner, and a model call had been spent discovering them.
 *
 * The planner could not have known. It is given the project's stack and
 * description and nothing else, so "use the Anthropic SDK" is a reasonable thing
 * for it to write. Handing it the actual manifests turns an unanswerable question
 * into a readable fact.
 *
 * Deliberately best-effort: a plan is still worth having when GitHub is
 * unreachable or the token is missing, so every failure here degrades to "no
 * manifests" rather than refusing to plan.
 */

const GITHUB_USER = "Ofirm84u";

/**
 * Paths worth trying, in priority order. Not exhaustive by design — these are
 * the manifests this fleet actually uses, and a miss costs one 404.
 */
const MANIFEST_PATHS = [
  "requirements.txt",
  "pyproject.toml",
  "package.json",
  "apps/api/requirements.txt",
  "apps/web/package.json",
] as const;

/** Enough to list dependencies; not enough to paste a lockfile into a prompt. */
const MAX_MANIFEST_CHARS = 4_000;

export interface RepoManifest {
  path: string;
  text: string;
}

export async function fetchDependencyManifests(
  repo: string,
  ref = "HEAD",
): Promise<RepoManifest[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  const results = await Promise.all(
    MANIFEST_PATHS.map((path) => fetchOne(repo, path, ref, token)),
  );
  return results.filter((m): m is RepoManifest => m !== null);
}

async function fetchOne(
  repo: string,
  path: string,
  ref: string,
  token: string,
): Promise<RepoManifest | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) return null;

    const body = (await response.json()) as { content?: string; encoding?: string };
    if (body.encoding !== "base64" || typeof body.content !== "string") return null;

    const text = Buffer.from(body.content, "base64").toString("utf-8");
    if (!text.trim()) return null;

    return { path, text: text.slice(0, MAX_MANIFEST_CHARS) };
  } catch {
    // A plan without manifests is worse than one with them, and far better than
    // no plan because GitHub was briefly unreachable.
    return null;
  }
}
