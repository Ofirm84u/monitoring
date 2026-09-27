import { exec } from "child_process";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_USER = "Ofirm84u";
const EXEC_TIMEOUT_MS = 15_000;

// --- Project definitions ---

/**
 * What "still working" means for one project, so the gate ladder has something
 * concrete to run. Without a contract a project can be reported against and
 * planned for, but G0 has nothing to measure and so no run can start — that is
 * the intended behaviour, not a gap. Adding a contract is what makes a repo
 * eligible; nothing else special-cases one project over another.
 */
export interface VerifyContract {
  /** Shell command run from the repo root. Must exit 0 on a clean default branch. */
  cmd: string;
  /**
   * Installs whatever `cmd` needs, run from the repo root before it. Kept
   * separate so a failed install is reported as infrastructure rather than as a
   * red baseline — the two mean very different things when attributing breakage.
   */
  setupCmd?: string;
  /**
   * Pinned because it is not a detail. seoapp's requirements.txt pins
   * google-ads 25.1.0, which declares requires_python <3.13, so a runner on a
   * newer Python cannot resolve the file at all. Its Dockerfile already uses
   * python:3.12-slim; CI has to agree or the gate fails for a reason that has
   * nothing to do with the change.
   */
  pythonVersion?: string;
  /**
   * G3 — starts the app and asserts it actually responds, run at the baseline
   * and again on the branch. Absent means G3 records a skip naming this field:
   * a build passing is not evidence that the app still works, and a smoke check
   * that does not exercise the running app would be worse than an honest gap.
   */
  smokeCmd?: string;
  /**
   * Polled after deploy and compared against the G0 snapshot. Only set where a
   * real health endpoint is known — a homepage that returns 200 while the app is
   * broken would make the comparison worse than having none.
   */
  smokeUrl?: string;
  /**
   * Playwright is already installed in this repo, so Tier B (browser) defect
   * reproduction is possible here. The agent can never install it itself: G2's
   * denylist blocks dependency manifests, so onboarding it is a human task.
   */
  hasPlaywright: boolean;
  /**
   * True only where `cmd` has actually been observed exiting 0 on a clean
   * checkout. Everything else is read off the repo and is a guess until G0 runs.
   */
  measured: boolean;
}

export interface ProjectConfig {
  id: string;
  name: string;
  description: string;
  stack: string[];
  repo?: string;
  url?: string;
  runtime?: "pm2" | "docker" | "none";
  pm2Name?: string;
  dockerPrefix?: string;
  /** Absent means the Idea Runner can plan for this project but cannot gate it. */
  verify?: VerifyContract;
}

export const PROJECTS: ProjectConfig[] = [
  {
    id: "bizitis",
    name: "Bizitis",
    description: "Israeli Business Academy Platform",
    stack: ["Next.js", "Postgres", "Redis", "Prisma"],
    repo: "bizitis",
    verify: {
      cmd: "npm run lint && npm test && npm run build",
      hasPlaywright: false,
      measured: false,
    },
    url: "https://bizitis.co.il",
    runtime: "docker",
    dockerPrefix: "bizitis",
  },
  {
    id: "seoapp",
    name: "SEO App",
    description: "SEO Audit Web Platform",
    stack: ["Next.js", "FastAPI", "Celery", "Postgres", "Redis"],
    repo: "seoapp",
    verify: {
      cmd: "pytest -q && npm --prefix apps/web test && npm --prefix apps/web run build",
      setupCmd: "pip install -r requirements.txt && npm --prefix apps/web ci",
      pythonVersion: "3.12",
      smokeUrl: "https://app.m84.me/api/health",
      hasPlaywright: false,
      measured: true,
    },
    url: "https://app.m84.me",
    runtime: "docker",
    dockerPrefix: "seoapp",
  },
  {
    id: "beiteden",
    name: "Beit Eden",
    description: "Resident Management System",
    stack: ["Next.js", "Postgres", "Redis", "Docker"],
    repo: "beiteden",
    verify: {
      cmd: "npm run lint && npm run test:types && npm run test:routes && npm run build",
      hasPlaywright: false,
      measured: false,
    },
    url: "https://beiteden.m84.me",
    runtime: "docker",
    dockerPrefix: "beiteden",
  },
  {
    id: "bookme",
    name: "BookMe",
    description: "Multi-tenant appointment booking SaaS",
    stack: ["Next.js", "Postgres", "Drizzle", "Auth.js"],
    repo: "BookMe",
    verify: {
      cmd: "npm run typecheck && npm run lint && npm run build",
      hasPlaywright: true,
      measured: false,
    },
    url: "https://bookme.m84.me",
    runtime: "docker",
    dockerPrefix: "bookme",
  },
  {
    id: "kosher",
    name: "Kosher",
    description: "Kosher business management platform",
    stack: ["Next.js", "Postgres", "Drizzle", "Cardcom"],
    repo: "cosher",
    url: "https://tzav.m84.me",
    runtime: "docker",
    dockerPrefix: "kosher",
  },
  {
    id: "mati",
    name: "CRM Mati",
    description: "CRM for Mati (QA / pre-MVP)",
    stack: ["Next.js", "React 19", "Prisma", "Postgres"],
    repo: "crm-mati",
    verify: {
      cmd: "npm run typecheck && npm run lint && npm test && npm run build",
      hasPlaywright: false,
      measured: false,
    },
    url: "https://mati.m84.me",
    runtime: "docker",
    dockerPrefix: "crm-mati",
  },
  {
    id: "prdaily",
    name: "PR Daily",
    description: "Daily content pipeline (Anthropic-powered)",
    stack: ["Python", "Postgres", "Redis", "Anthropic"],
    repo: "prdaily",
    verify: {
      cmd: "pytest -q",
      hasPlaywright: false,
      measured: false,
    },
    url: "https://pr.m84.me",
    runtime: "docker",
    dockerPrefix: "prdaily",
  },
  {
    id: "monitor",
    name: "Monitor",
    description: "Server monitoring dashboard",
    stack: ["Next.js", "Tailwind"],
    repo: "monitoring",
    verify: {
      cmd: "npm run build",
      hasPlaywright: false,
      measured: false,
    },
    url: "https://mon.m84.me",
    runtime: "pm2",
    pm2Name: "monitor",
  },
  {
    id: "trading",
    name: "Trading App",
    description: "Trading application",
    stack: ["Python", "Node.js"],
    repo: "trading-app",
    verify: {
      cmd: "pytest -q",
      hasPlaywright: false,
      measured: false,
    },
    runtime: "none",
  },
  {
    id: "cms-manager",
    name: "CMS Manager",
    description: "Reusable page builder CMS for Next.js",
    stack: ["Next.js"],
    repo: "cms-manager",
    runtime: "none",
  },
  {
    id: "whatsapp-bridge",
    name: "WhatsApp Bridge",
    description: "WhatsApp Web REST API via Baileys",
    stack: ["Node.js"],
    repo: "whatsapp-bridge",
    verify: {
      cmd: "npm run typecheck && npm run lint && npm run build",
      hasPlaywright: false,
      measured: false,
    },
    runtime: "none",
  },
  {
    id: "learning-center",
    name: "Learning Center",
    description: "Reusable Next.js training module",
    stack: ["Next.js"],
    repo: "learning-center",
    verify: {
      cmd: "npm run build",
      hasPlaywright: false,
      measured: false,
    },
    runtime: "none",
  },
  {
    id: "qa-automation",
    name: "QA Automation",
    description: "Automated testing suite",
    stack: ["Node.js", "Playwright"],
    repo: "qa-automation",
    runtime: "none",
  },
  {
    id: "linkedin",
    name: "LinkedIn Tool",
    description: "LinkedIn automation, analytics & content scheduling",
    stack: ["Next.js", "Gemini", "LinkedIn API"],
    repo: "linkedin-automation",
    verify: {
      cmd: "npm run build",
      hasPlaywright: false,
      measured: false,
    },
    runtime: "none",
  },
];

// --- GitHub data ---

export interface GitHubInfo {
  lastCommitMessage: string;
  lastCommitDate: string;
  lastCommitAuthor: string;
  openPRs: number;
  isPrivate: boolean;
}

async function fetchGitHub(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getRepoGitHubInfo(repoName: string): Promise<GitHubInfo | null> {
  try {
    const [commitsData, prsData, repoData] = await Promise.all([
      fetchGitHub(`/repos/${GITHUB_USER}/${repoName}/commits?per_page=1`) as Promise<Array<{ commit: { message: string; author: { name: string; date: string } } }> | null>,
      fetchGitHub(`/repos/${GITHUB_USER}/${repoName}/pulls?state=open&per_page=100`) as Promise<Array<unknown> | null>,
      fetchGitHub(`/repos/${GITHUB_USER}/${repoName}`) as Promise<{ private: boolean } | null>,
    ]);

    const lastCommit = Array.isArray(commitsData) && commitsData[0]?.commit;
    return {
      lastCommitMessage: lastCommit ? lastCommit.message.split("\n")[0].slice(0, 80) : "",
      lastCommitDate: lastCommit ? lastCommit.author.date : "",
      lastCommitAuthor: lastCommit ? lastCommit.author.name : "",
      openPRs: Array.isArray(prsData) ? prsData.length : 0,
      isPrivate: repoData ? (repoData as { private: boolean }).private : false,
    };
  } catch {
    return null;
  }
}

// --- Server health ---

export interface ProcessHealth {
  status: "online" | "stopped" | "errored" | "unhealthy" | "unknown";
  uptime: string;
  memoryMb: number;
}

function execCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout?.toString() ?? "");
    });
  });
}

function formatUptime(statusStr: string): string {
  // Docker: "Up 8 days", "Up 11 hours", PM2: computed from uptime
  const match = statusStr.match(/Up\s+(.+?)(?:\s*\(|$)/);
  return match ? match[1].trim() : statusStr;
}

interface Pm2Process {
  name: string;
  pm2_env: { status: string; pm_uptime: number };
  monit: { memory: number };
}

interface ServerHealthMap {
  pm2: Record<string, ProcessHealth>;
  docker: Record<string, ProcessHealth>;
}

async function getServerHealth(): Promise<ServerHealthMap> {
  const [pm2Raw, dockerRaw] = await Promise.all([
    execCommand("source ~/.nvm/nvm.sh 2>/dev/null; pm2 jlist 2>/dev/null"),
    execCommand('docker ps --format "{{.Names}}\t{{.Status}}" 2>/dev/null'),
  ]);

  const pm2: Record<string, ProcessHealth> = {};
  try {
    const pm2Data: Pm2Process[] = JSON.parse(pm2Raw);
    for (const p of pm2Data) {
      const uptimeMs = Date.now() - p.pm2_env.pm_uptime;
      const uptimeDays = Math.floor(uptimeMs / 86400000);
      const uptimeHours = Math.floor((uptimeMs % 86400000) / 3600000);
      pm2[p.name] = {
        status: p.pm2_env.status === "online" ? "online" : "errored",
        uptime: uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours}h` : `${uptimeHours}h`,
        memoryMb: Math.round(p.monit.memory / 1048576),
      };
    }
  } catch { /* parse error */ }

  const docker: Record<string, ProcessHealth> = {};
  for (const line of dockerRaw.trim().split("\n").filter(Boolean)) {
    const [name, ...statusParts] = line.split("\t");
    const statusStr = statusParts.join("\t");
    const isUnhealthy = statusStr.includes("unhealthy");
    docker[name] = {
      status: isUnhealthy ? "unhealthy" : "online",
      uptime: formatUptime(statusStr),
      memoryMb: 0,
    };
  }

  return { pm2, docker };
}

// --- Combined project data ---

export interface EnrichedProject {
  id: string;
  name: string;
  description: string;
  stack: string[];
  url?: string;
  repo?: string;
  repoUrl?: string;
  isPrivate: boolean;
  runtime: "pm2" | "docker" | "none";
  github: GitHubInfo | null;
  health: ProcessHealth | null;
  containers: Array<{ name: string; status: string; uptime: string }>;
}

export async function getProjectsData(): Promise<EnrichedProject[]> {
  // Fetch all GitHub data in parallel
  const repoNames = PROJECTS.filter((p) => p.repo).map((p) => p.repo!);
  const [githubMap, serverHealth] = await Promise.all([
    Promise.all(
      repoNames.map(async (repo) => {
        const info = await getRepoGitHubInfo(repo);
        return [repo, info] as const;
      }),
    ).then((entries) => Object.fromEntries(entries)),
    getServerHealth(),
  ]);

  return PROJECTS.map((project) => {
    const github = project.repo ? (githubMap[project.repo] ?? null) : null;

    // Determine health from PM2 or Docker
    let health: ProcessHealth | null = null;
    const containers: Array<{ name: string; status: string; uptime: string }> = [];

    if (project.runtime === "pm2" && project.pm2Name) {
      health = serverHealth.pm2[project.pm2Name] ?? null;
    } else if (project.runtime === "docker" && project.dockerPrefix) {
      // Find all containers matching prefix
      for (const [containerName, containerHealth] of Object.entries(serverHealth.docker)) {
        if (containerName.startsWith(project.dockerPrefix)) {
          containers.push({
            name: containerName,
            status: containerHealth.status,
            uptime: containerHealth.uptime,
          });
        }
      }
      // Overall health = worst container status
      if (containers.length > 0) {
        const hasUnhealthy = containers.some((c) => c.status === "unhealthy");
        const bestContainer = containers[0];
        health = {
          status: hasUnhealthy ? "unhealthy" : "online",
          uptime: bestContainer.uptime,
          memoryMb: 0,
        };
      }
    }

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      stack: project.stack,
      url: project.url,
      repo: project.repo,
      repoUrl: project.repo ? `https://github.com/${GITHUB_USER}/${project.repo}` : undefined,
      isPrivate: github?.isPrivate ?? false,
      runtime: project.runtime ?? "none",
      github,
      health,
      containers,
    };
  });
}
