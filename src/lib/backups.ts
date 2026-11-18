import { exec } from "child_process";

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

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

const GSUTIL = "/snap/bin/gsutil";

const SOURCES: Array<{ app: string; label: string; bucket: string }> = [
  { app: "crm-mati", label: "CRM Mati", bucket: "gs://m84-backups/crm-mati/" },
  { app: "bookme",   label: "BookMe",   bucket: "gs://m84-backups/bookme/" },
  { app: "kosher",   label: "Kosher",   bucket: "gs://m84-backups/kosher/" },
  { app: "seoapp",  label: "SEO App",  bucket: "gs://m84-backups/seoapp/" },
  { app: "beiteden", label: "Beit Eden", bucket: "gs://m84-backups/beiteden/" },
  { app: "bizitis",  label: "Bizitis",  bucket: "gs://m84-backups/bizitis/" },
  { app: "matibot",  label: "MatiBot",  bucket: "gs://m84-backups/matibot/" },
  { app: "prdaily",  label: "PR Daily DB", bucket: "gs://m84-backups/prdaily/" },
  { app: "prdaily-files", label: "PR Daily files", bucket: "gs://m84-backups/prdaily/files/" },
  { app: "env-files", label: ".env Secrets", bucket: "gs://m84-backups/env-files/" },
];

/** Every object in the bucket, from one listing. */
const ALL_OBJECTS = "gs://m84-backups/**";

export async function getBackupStatus(): Promise<BackupStatus> {
  // One listing for the whole bucket, split per app below. Nine parallel
  // `gsutil` processes used to queue on gcloud's shared credential store and
  // took ~31s each on this 2-vCPU VM, past the 30s timeout, so every row read
  // "No backup found" while the backups were fine. One call takes ~3s.
  const { stdout, exitCode } = await execCommand(`${GSUTIL} ls -l "${ALL_OBJECTS}"`);
  const all = exitCode === 0 ? parseGsutil(stdout).files : [];

  const results = await Promise.all(
    SOURCES.map(async ({ app, label, bucket }): Promise<BackupInfo> => {
      // Objects directly under this prefix, not in its subfolders, as the
      // old per-prefix `gsutil ls` returned (prdaily/files/ is its own row).
      const files = all.filter(
        (f) => f.name.startsWith(bucket) && f.name.length > bucket.length && !f.name.slice(bucket.length).includes("/"),
      );

      if (files.length === 0) {
        return {
          app, label,
          latestFile: null, latestDate: null,
          latestSizeBytes: 0, latestSizeHuman: "—",
          totalObjects: 0, totalSizeBytes: 0, totalSizeHuman: "—",
          ageHours: null,
        };
      }

      const totalObjects = files.length;
      const totalBytes = files.reduce((n, f) => n + f.sizeBytes, 0);
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
