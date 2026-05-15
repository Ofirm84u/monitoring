import { exec } from "child_process";

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 512 * 1024;

function execCommand(command: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout) => {
      resolve({ stdout: stdout?.toString() ?? "", exitCode: error?.code ?? 0 });
    });
  });
}

export interface BackupInfo {
  app: string;
  label: string;
  latestFile: string | null;
  latestDate: string | null;
  latestSizeBytes: number;
  latestSizeHuman: string;
  totalObjects: number;
  totalSizeBytes: number;
  totalSizeHuman: string;
  ageHours: number | null;
}

export interface BackupStatus {
  apps: BackupInfo[];
  scannedAt: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function parseGsutil(output: string): {
  files: Array<{ name: string; date: string; sizeBytes: number }>;
  totalObjects: number;
  totalBytes: number;
} {
  const files: Array<{ name: string; date: string; sizeBytes: number }> = [];
  let totalObjects = 0;
  let totalBytes = 0;

  for (const raw of output.trim().split("\n")) {
    const line = raw.trim();
    const totalMatch = line.match(/^TOTAL:\s+(\d+)\s+objects?,\s+(\d+)\s+bytes/);
    if (totalMatch) {
      totalObjects = parseInt(totalMatch[1], 10);
      totalBytes = parseInt(totalMatch[2], 10);
      continue;
    }
    const fileMatch = line.match(/^(\d+)\s+(\S+)\s+(gs:\/\/\S+)$/);
    if (fileMatch) {
      files.push({ sizeBytes: parseInt(fileMatch[1], 10), date: fileMatch[2], name: fileMatch[3] });
    }
  }

  return { files, totalObjects, totalBytes };
}

const SOURCES: Array<{ app: string; label: string; bucket: string }> = [
  { app: "crm-mati", label: "CRM Mati", bucket: "gs://crm-mati-backups/" },
  { app: "homeeye",  label: "HomeEye",  bucket: "gs://m84-backups/homeeye/" },
  { app: "seoapp",  label: "SEO App",  bucket: "gs://m84-backups/seoapp/" },
  { app: "beiteden", label: "Beit Eden", bucket: "gs://m84-backups/beiteden/" },
  { app: "bizitis",  label: "Bizitis",  bucket: "gs://m84-backups/bizitis/" },
  { app: "hudson",   label: "Hudson",   bucket: "gs://m84-backups/hudson/" },
  { app: "prdaily",  label: "PR Daily", bucket: "gs://m84-backups/prdaily/" },
  { app: "env-files", label: ".env Secrets", bucket: "gs://m84-backups/env-files/" },
];

export async function getBackupStatus(): Promise<BackupStatus> {
  const results = await Promise.all(
    SOURCES.map(async ({ app, label, bucket }): Promise<BackupInfo> => {
      const { stdout, exitCode } = await execCommand(`gsutil ls -l ${bucket}`);

      if (exitCode !== 0 || !stdout.trim()) {
        return {
          app, label,
          latestFile: null, latestDate: null,
          latestSizeBytes: 0, latestSizeHuman: "—",
          totalObjects: 0, totalSizeBytes: 0, totalSizeHuman: "—",
          ageHours: null,
        };
      }

      const { files, totalObjects, totalBytes } = parseGsutil(stdout);
      files.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const latest = files[0] ?? null;
      const ageHours = latest
        ? (Date.now() - new Date(latest.date).getTime()) / 3_600_000
        : null;

      return {
        app, label,
        latestFile: latest?.name ?? null,
        latestDate: latest?.date ?? null,
        latestSizeBytes: latest?.sizeBytes ?? 0,
        latestSizeHuman: latest ? formatSize(latest.sizeBytes) : "—",
        totalObjects,
        totalSizeBytes: totalBytes,
        totalSizeHuman: formatSize(totalBytes),
        ageHours,
      };
    })
  );

  return { apps: results, scannedAt: new Date().toISOString() };
}
