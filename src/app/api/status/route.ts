import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { readFile } from "fs/promises";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const STATUS_FILE = process.env.STATUS_FILE ?? "/home/ofir/monitoring/status.json";
const LOG_FILE = process.env.LOG_FILE ?? "/home/ofir/monitoring/monitor.log";

// 30 requests per minute
const STATUS_RATE_LIMIT = { maxAttempts: 30, windowMs: 60 * 1000 };

/**
 * GET /api/status
 * Returns monitoring status + live HTTP checks.
 */
export async function GET(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(`status:${ip}`, STATUS_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  let lastCheck = null;
  let recentLogs: string[] = [];

  // Read status file from cron
  try {
    const raw = await readFile(STATUS_FILE, "utf-8");
    lastCheck = JSON.parse(raw);
  } catch {
    // Not created yet
  }

  // Read recent logs
  try {
    const logContent = await readFile(LOG_FILE, "utf-8");
    const lines = logContent.trim().split("\n");
    recentLogs = lines.slice(-30);
  } catch {
    // Not created yet
  }

  // Live HTTP checks
  const sites: Record<string, string> = {
    bizitis: "https://bizitis.co.il",
    hudson: "https://hudson.m84.me",
    seoapp: "https://app.m84.me",
    beiteden: "https://beiteden.m84.me",
  };

  const liveChecks: Record<string, { status: string; responseTime: number }> = {};

  const checks = Object.entries(sites).map(async ([name, url]) => {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        redirect: "follow",
      });
      liveChecks[name] = {
        status: res.ok ? "up" : `error:${res.status}`,
        responseTime: Date.now() - start,
      };
    } catch {
      liveChecks[name] = {
        status: "down",
        responseTime: Date.now() - start,
      };
    }
  });

  await Promise.all(checks);

  return NextResponse.json(
    { lastCheck, liveChecks, recentLogs, monitoringActive: lastCheck !== null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
