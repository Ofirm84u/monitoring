import { completeSetup, peekSetupToken } from "@/lib/accounts";
import { handle, json, optionalText, readBody, requiredText } from "@/lib/pm/http";
import { PASSWORD_MAX_LENGTH } from "@/lib/password-policy";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Public (no session): the setup link itself is the credential. Rate-limited
 * per IP so tokens can't be brute-forced — they're 256-bit anyway.
 */
const SETUP_RATE_LIMIT = { maxAttempts: 20, windowMs: 15 * 60 * 1000 };
const TOKEN_MAX = 100;

function isRateLimited(request: Request): boolean {
  return !checkRateLimit(`pm-setup:${getClientIp(request)}`, SETUP_RATE_LIMIT).allowed;
}

/** ?token=… → which email the link is for. */
export async function GET(request: Request) {
  return handle(async () => {
    if (isRateLimited(request)) return json(429, { error: "Too many attempts. Try again later." });
    const token = requiredText(new URL(request.url).searchParams.get("token"), TOKEN_MAX, "token");
    const link = await peekSetupToken(token);
    if (!link) return json(404, { error: "This link is invalid or has expired. Ask an admin for a new one." });
    return json(200, link);
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    if (isRateLimited(request)) return json(429, { error: "Too many attempts. Try again later." });
    const body = await readBody(request);
    if (typeof body.password !== "string" || body.password.length > PASSWORD_MAX_LENGTH) {
      return json(400, { error: "Password is required" });
    }
    const result = await completeSetup(
      requiredText(body.token, TOKEN_MAX, "token"),
      body.password,
      optionalText(body.name, 80),
    );
    if (!result.ok) return json(result.status, { error: result.error });
    return json(200, { email: result.email });
  });
}
