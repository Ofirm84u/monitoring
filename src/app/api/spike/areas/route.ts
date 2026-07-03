import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getRequestUser } from "@/lib/request-user";
import { db } from "@/db";
import { areas } from "@/db/schema";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Spike: a tenant-scoped resource. Every query is filtered by the acting user's
 * id, so a user can only ever see/create their own areas (FR-AUTH-6) — the
 * basis for the cross-tenant isolation test.
 */
export async function GET(request: Request) {
  const user = await getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const rows = await db.select().from(areas).where(eq(areas.userId, user.id)).all();
  return NextResponse.json({ areas: rows }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const user = await getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  let body: { name?: unknown; color?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400, headers: NO_STORE });
  }
  const color = typeof body.color === "string" && body.color ? body.color : "#3b82f6";
  const row = await db
    .insert(areas)
    .values({ userId: user.id, name: body.name.trim().slice(0, 80), color })
    .returning()
    .get();
  return NextResponse.json({ area: row }, { status: 201, headers: NO_STORE });
}
