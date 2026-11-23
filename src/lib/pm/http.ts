import { NextResponse } from "next/server";
import { getRequestUser, type RequestUser } from "@/lib/request-user";
import { claimPendingInvites } from "@/lib/pm/members";

/**
 * Request/response plumbing shared by every /api/pm route: auth, JSON parsing,
 * and input validators. Validation lives here (the system boundary) so the data
 * layer in src/lib/pm/* can assume well-formed input.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 64 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function json(status: number, body: unknown) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Map a denied access check to its response. 404 never says "forbidden". */
export function denied(status: 403 | 404) {
  return json(status, { error: status === 404 ? "Not found" : "Forbidden" });
}

/**
 * The acting user, or null. Also binds any invites addressed to this user's
 * email, so a teammate's first request after signing in makes them a member.
 */
export async function requireUser(request: Request): Promise<RequestUser | null> {
  const user = await getRequestUser(request);
  if (!user) return null;
  await claimPendingInvites(user);
  return user;
}

/**
 * Public origin for links we hand out. Behind Caddy, request.url is the
 * internal localhost address, so APP_BASE_URL wins when set.
 */
export function appBaseUrl(request: Request): string {
  return process.env.APP_BASE_URL?.replace(/\/$/, "") || new URL(request.url).origin;
}

export class BadRequestError extends Error {}

/** Parse a JSON object body, rejecting oversized or non-object payloads. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (length > MAX_BODY_BYTES) throw new BadRequestError("Payload too large");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Body must be a JSON object");
  }
  // Narrowed above to a non-array object.
  return body as Record<string, unknown>;
}

/** Trimmed, length-capped text. Empty or missing → null. */
export function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BadRequestError("Expected a string");
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function requiredText(value: unknown, max: number, field: string): string {
  const text = optionalText(value, max);
  if (!text) throw new BadRequestError(`${field} is required`);
  return text;
}

/** A real calendar day as YYYY-MM-DD, or null. Rejects 2026-02-31. */
export function optionalIsoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new BadRequestError(`${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestError(`${field} is not a real date`);
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const match = allowed.find((option) => option === value);
  if (!match) throw new BadRequestError(`${field} must be one of: ${allowed.join(", ")}`);
  return match;
}

export function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) {
    throw new BadRequestError(`${field} must be an id`);
  }
  return value;
}

/**
 * Run a handler, turning validation errors into 400 and anything else into a
 * logged 500 whose message doesn't leak internals.
 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BadRequestError) return json(400, { error: err.message });
    console.error("[pm] request failed:", err);
    return json(500, { error: "Internal error" });
  }
}
