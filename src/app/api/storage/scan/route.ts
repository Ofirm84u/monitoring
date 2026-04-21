import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { runScan } from "@/lib/storage";

// 5 scans per minute
const SCAN_RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 1000 };

export async function GET(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(`storage-scan:${ip}`, SCAN_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await runScan();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to scan storage" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
