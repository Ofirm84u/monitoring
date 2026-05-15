import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { verifySecret } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const MONITOR_SECRET = process.env.MONITOR_SECRET ?? "";
const ALERT_EMAIL = process.env.MONITOR_ALERT_EMAIL ?? "ofir@bizitis.co.il";

// 10 alerts per 15 minutes
const ALERT_RATE_LIMIT = { maxAttempts: 10, windowMs: 15 * 60 * 1000 };

/**
 * POST /api/alert
 * Called by server-monitor.sh to send alert emails.
 * Auth via X-Monitor-Secret header (timing-safe comparison).
 */
export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`alert:${ip}`, ALERT_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  const secret = request.headers.get("x-monitor-secret") ?? "";
  if (!verifySecret(secret, MONITOR_SECRET)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: { subject?: unknown; body?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Validate types and lengths
  if (
    typeof body.subject !== "string" ||
    typeof body.body !== "string" ||
    !body.subject ||
    !body.body
  ) {
    return NextResponse.json(
      { error: "subject and body are required strings" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Sanitize subject: strip newlines to prevent email header injection, limit length
  const sanitizedSubject = body.subject
    .replace(/[\r\n]/g, " ")
    .slice(0, 200);
  const sanitizedBody = body.body.slice(0, 10000);

  try {
    await sendEmail({
      to: ALERT_EMAIL,
      subject: sanitizedSubject,
      html: `
        <div style="font-family: monospace; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #dc2626;">Server Monitor Alert</h2>
          <pre style="background: #f3f4f6; padding: 16px; border-radius: 8px; white-space: pre-wrap; font-size: 14px;">${sanitizedBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</pre>
          <p style="color: #6b7280; font-size: 12px; margin-top: 16px;">
            Dashboard: <a href="https://mon.m84.me">mon.m84.me</a>
          </p>
        </div>
      `,
    });
    return NextResponse.json(
      { sent: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Generic error — don't leak internal SMTP details
    return NextResponse.json(
      { error: "Failed to send alert" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
