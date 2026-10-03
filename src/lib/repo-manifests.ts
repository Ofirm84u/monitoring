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

/**
 * Directories and file types that tell the planner nothing about where code
 * lives. `history/` and `v13/untitled folder` are real examples from seoapp —
 * twenty-seven paths between them, none of which anyone would implement into.
 */
const TREE_EXCLUDED_DIRS = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "history/",
  "v13/",
  ".git/",
];

const TREE_EXCLUDED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tgz",
  ".map", ".lock", ".log", ".csv",
];

/**
 * How many paths are worth sending. seoapp has 268 after filtering, and the
 * largest repos in this fleet are the same order — so the cap exists to bound a
 * surprise rather than to trim the normal case.
 */
const MAX_TREE_PATHS = 500;

/**
 * The repository's source file paths.
 *
 * Knowing which packages exist stopped the planner inventing dependencies. It
 * still invents *locations*: it proposed `apps/api/tasks/geo_citation_check.py`
 * for a repo whose task code is the single file `apps/api/tasks.py`, and imported
 * `celery_app` from a module that does not exist, when `celery_app` is defined
 * inside that file. Both are answerable from a file listing, and neither is
 * answerable from a stack and a description.
 */
export async function fetchRepoTree(repo: string, ref = "HEAD"): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_USER}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) return [];

    const body = (await response.json()) as {
      tree?: Array<{ path?: string; type?: string }>;
    };

    const paths = (body.tree ?? [])
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => entry.path as string)
      .filter(isInterestingPath)
      .sort();

    return paths.slice(0, MAX_TREE_PATHS);
  } catch {
    return [];
  }
}

function isInterestingPath(path: string): boolean {
  if (TREE_EXCLUDED_DIRS.some((dir) => path.startsWith(dir) || path.includes(`/${dir}`))) {
    return false;
  }
  const lower = path.toLowerCase();
  return !TREE_EXCLUDED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
