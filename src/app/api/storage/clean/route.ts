import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { runCleanup, runScan } from "@/lib/storage";

// 3 cleanups per minute
const CLEAN_RATE_LIMIT = { maxAttempts: 3, windowMs: 60 * 1000 };

export async function POST(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(`storage-clean:${ip}`, CLEAN_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: { actionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (typeof body.actionId !== "string" || !body.actionId) {
    return NextResponse.json(
      { error: "actionId is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const cleanup = await runCleanup(body.actionId);
    const updatedScan = await runScan();
    return NextResponse.json(
      { cleanup, updatedScan },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message =
      err instanceof Error && err.message === "Unknown cleanup action"
        ? "Unknown cleanup action"
        : "Cleanup failed";
    const status = message === "Unknown cleanup action" ? 400 : 500;
    return NextResponse.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
