import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getProjectsData } from "@/lib/projects";

// 10 requests per minute
const PROJECTS_RATE_LIMIT = { maxAttempts: 10, windowMs: 60 * 1000 };

export async function GET(request: Request) {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = getClientIp(request);
  const limit = checkRateLimit(`projects:${ip}`, PROJECTS_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const projects = await getProjectsData();
    return NextResponse.json(
      { projects, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
