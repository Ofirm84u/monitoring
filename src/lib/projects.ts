import { exec } from "child_process";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_USER = "Ofirm84u";
const EXEC_TIMEOUT_MS = 15_000;

// --- Project definitions ---

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
}

const PROJECTS: ProjectConfig[] = [
  {
    id: "bizitis",
    name: "Bizitis",
    description: "Israeli Business Academy Platform",
    stack: ["Next.js", "Postgres", "Redis", "Prisma"],
    repo: "bizitis",
    url: "https://bizitis.co.il",
    runtime: "pm2",
    pm2Name: "bizitis",
    dockerPrefix: "bizitis",
  },
  {
    id: "hudson",
    name: "Hudson",
    description: "Hudson Learning Center",
    stack: ["Next.js", "Redis", "Docker"],
    repo: "hudson",
    url: "https://hudson.m84.me",
    runtime: "docker",
    dockerPrefix: "hudson",
  },
  {
    id: "seoapp",
    name: "SEO App",
    description: "SEO Audit Web Platform",
    stack: ["Next.js", "FastAPI", "Celery", "Postgres", "Redis"],
    repo: "seoapp",
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
    url: "https://beiteden.m84.me",
    runtime: "docker",
    dockerPrefix: "beiteden",
  },
  {
    id: "eyeindsky",
    name: "EyeInDSKY",
    description: "CV-powered inventory scanner",
    stack: ["React", "Python", "Postgres", "Redis", "Docker"],
    repo: "EyeInDSKY",
    runtime: "docker",
    dockerPrefix: "home_eye",
  },
  {
    id: "monitor",
    name: "Monitor",
    description: "Server monitoring dashboard",
    stack: ["Next.js", "Tailwind"],
    repo: "monitoring",
    url: "https://mon.m84.me",
    runtime: "pm2",
    pm2Name: "monitor",
  },
  {
    id: "bookme",
    name: "BookMe",
    description: "Multi-tenant appointment booking SaaS",
    stack: ["Next.js"],
    repo: "BookMe",
    runtime: "none",
  },
  {
    id: "trading",
    name: "Trading App",
    description: "Trading application",
    stack: ["Python", "Node.js"],
    repo: "trading-app",
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
    runtime: "none",
  },
  {
    id: "learning-center",
    name: "Learning Center",
    description: "Reusable Next.js training module",
    stack: ["Next.js"],
    repo: "learning-center",
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
