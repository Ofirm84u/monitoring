import { exec } from "child_process";

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execCommand(command: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(command, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error?.code ?? 0,
      });
    });
  });
}

// --- Scan ---

export interface StorageCategory {
  id: string;
  label: string;
  size: string;
  sizeBytes: number;
  cleanable: boolean;
}

export interface StorageScanResult {
  diskOverall: { used: string; total: string; percent: number; available: string };
  categories: StorageCategory[];
  scannedAt: string;
}

function parseSize(sizeStr: string): number {
  const match = sizeStr.trim().match(/^([\d.]+)\s*([KMGT]?B?)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    K: 1024,
    KB: 1024,
    M: 1024 ** 2,
    MB: 1024 ** 2,
    G: 1024 ** 3,
    GB: 1024 ** 3,
    T: 1024 ** 4,
    TB: 1024 ** 4,
  };
  return value * (multipliers[unit] ?? 1);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${bytes}B`;
}

export async function runScan(): Promise<StorageScanResult> {
  const [diskResult, dockerResult, archivesResult, aptResult, journalResult, tmpResult] =
    await Promise.all([
      execCommand("df -h / | tail -1"),
      execCommand("docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null"),
      execCommand("find /home/ofir -maxdepth 2 \\( -name '*.tar.gz' -o -name '*.tar' \\) -exec du -cb {} + 2>/dev/null | tail -1"),
      execCommand("du -sb /var/cache/apt 2>/dev/null"),
      execCommand("journalctl --disk-usage 2>/dev/null"),
      execCommand("du -sb /tmp 2>/dev/null"),
    ]);

  // Parse overall disk
  const dfParts = diskResult.stdout.trim().split(/\s+/);
  const diskOverall = {
    total: dfParts[1] ?? "0",
    used: dfParts[2] ?? "0",
    available: dfParts[3] ?? "0",
    percent: parseInt(dfParts[4]?.replace("%", "") ?? "0", 10),
  };

  const categories: StorageCategory[] = [];

  // Docker reclaimable — report build cache and dangling images separately.
  // Image-layer "reclaimable" from docker system df is misleading: it includes
  // shared-layer headroom on actively-used images that docker image prune
  // cannot remove. We only surface what is actually deletable.
  if (dockerResult.exitCode === 0 && dockerResult.stdout.trim()) {
    let buildCacheReclaimable = 0;
    let danglingImageReclaimable = 0;

    for (const line of dockerResult.stdout.trim().split("\n")) {
      const parts = line.split("\t");
      const type = parts[0]?.trim();
      const reclaimStr = parts[2] ?? "";
      const sizeMatch = reclaimStr.match(/^([\d.]+\s*[KMGT]?B)/i);
      const bytes = sizeMatch ? parseSize(sizeMatch[1]) : 0;

      if (type === "Build Cache") buildCacheReclaimable = bytes;
      // Only count images that are truly dangling (0 containers = truly unused)
      if (type === "Images" && reclaimStr.includes("100%")) danglingImageReclaimable = bytes;
    }

    if (buildCacheReclaimable > 0) {
      categories.push({
        id: "docker-build-cache",
        label: "Docker build cache",
        size: formatSize(buildCacheReclaimable),
        sizeBytes: buildCacheReclaimable,
        cleanable: true,
      });
    }

    if (danglingImageReclaimable > 0) {
      categories.push({
        id: "docker-images",
        label: "Docker dangling images",
        size: formatSize(danglingImageReclaimable),
        sizeBytes: danglingImageReclaimable,
        cleanable: true,
      });
    }
  }

  // Old archives
  if (archivesResult.exitCode === 0 && archivesResult.stdout.trim()) {
    const totalMatch = archivesResult.stdout.trim().match(/^(\d+)/);
    if (totalMatch) {
      const bytes = parseInt(totalMatch[1], 10);
      if (bytes > 0) {
        categories.push({
          id: "old-archives",
          label: "Archive files (.tar.gz)",
          size: formatSize(bytes),
          sizeBytes: bytes,
          cleanable: true,
        });
      }
    }
  }

  // APT cache
  if (aptResult.stdout.trim()) {
    const aptMatch = aptResult.stdout.trim().match(/^(\d+)/);
    if (aptMatch) {
      const bytes = parseInt(aptMatch[1], 10);
      if (bytes > 10 * 1024 * 1024) {
        // Only show if > 10MB
        categories.push({
          id: "apt-cache",
          label: "APT package cache",
          size: formatSize(bytes),
          sizeBytes: bytes,
          cleanable: true,
        });
      }
    }
  }

  // Journal logs
  if (journalResult.stdout.trim()) {
    const journalMatch = journalResult.stdout.match(/([\d.]+\s*[KMGT]?B?)/i);
    if (journalMatch) {
      const bytes = parseSize(journalMatch[1]);
      if (bytes > 50 * 1024 * 1024) {
        // Only show if > 50MB
        categories.push({
          id: "journal-vacuum",
          label: "Systemd journal logs",
          size: formatSize(bytes),
          sizeBytes: bytes,
          cleanable: true,
        });
      }
    }
  }

  // /tmp
  if (tmpResult.stdout.trim()) {
    const tmpMatch = tmpResult.stdout.trim().match(/^(\d+)/);
    if (tmpMatch) {
      const bytes = parseInt(tmpMatch[1], 10);
      if (bytes > 50 * 1024 * 1024) {
        // Only show if > 50MB
        categories.push({
          id: "tmp-cleanup",
          label: "Temp files (/tmp)",
          size: formatSize(bytes),
          sizeBytes: bytes,
          cleanable: false, // too risky to auto-clean
        });
      }
    }
  }

  // Sort by size descending
  categories.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    diskOverall,
    categories,
    scannedAt: new Date().toISOString(),
  };
}

// --- Cleanup ---

const CLEANUP_ACTIONS: Record<string, { label: string; command: string; timeoutMs: number }> = {
  "docker-build-cache": {
    label: "Prune Docker build cache",
    command: "docker builder prune -f",
    timeoutMs: 60_000,
  },
  "docker-images": {
    label: "Prune dangling Docker images",
    command: "docker image prune -f",
    timeoutMs: 60_000,
  },
  "docker-full": {
    label: "Full Docker cleanup (images + volumes)",
    command: "docker system prune -af --volumes",
    timeoutMs: 60_000,
  },
  "old-archives": {
    label: "Delete old archive files",
    command:
      "find /home/ofir -maxdepth 2 \\( -name '*.tar.gz' -o -name '*.tar' \\) -mtime +7 -delete -print",
    timeoutMs: EXEC_TIMEOUT_MS,
  },
  "apt-cache": {
    label: "Clean APT cache",
    command: "sudo apt-get clean",
    timeoutMs: EXEC_TIMEOUT_MS,
  },
  "journal-vacuum": {
    label: "Vacuum journal logs to 100M",
    command: "sudo journalctl --vacuum-size=100M",
    timeoutMs: EXEC_TIMEOUT_MS,
  },
};

export function getCleanupActions(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, action] of Object.entries(CLEANUP_ACTIONS)) {
    result[id] = action.label;
  }
  return result;
}

export interface CleanupResult {
  actionId: string;
  label: string;
  success: boolean;
  output: string;
}

export async function runCleanup(actionId: string): Promise<CleanupResult> {
  const action = CLEANUP_ACTIONS[actionId];
  if (!action) {
    throw new Error("Unknown cleanup action");
  }

  const result = await new Promise<ExecResult>((resolve) => {
    exec(action.command, { timeout: action.timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error?.code ?? 0,
      });
    });
  });

  return {
    actionId,
    label: action.label,
    success: result.exitCode === 0,
    output: result.stdout.trim().slice(0, 2000), // Cap output size
  };
}
