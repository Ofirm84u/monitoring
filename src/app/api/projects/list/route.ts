import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { PROJECTS } from "@/lib/projects";

const RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 1000 };

export async function GET(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`projects-list:${ip}`, RATE_LIMIT).allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }
  const projects = PROJECTS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
  return NextResponse.json(
    { projects },
    { headers: { "Cache-Control": "no-store" } },
  );
}
