import { NextResponse } from "next/server";
import { generateSessionToken, getSessionCookieConfig, verifyPassword } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// 5 login attempts per 15 minutes per IP
const LOGIN_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 };

export async function POST(request: Request) {
  // Rate limit by IP
  const ip = getClientIp(request);
  const limit = checkRateLimit(`login:${ip}`, LOGIN_RATE_LIMIT);

  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (typeof body.password !== "string" || !verifyPassword(body.password)) {
    return NextResponse.json(
      { error: "Invalid password" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const token = generateSessionToken();
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(getSessionCookieConfig(token));
  return response;
}
