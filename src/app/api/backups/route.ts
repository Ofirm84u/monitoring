import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getBackupStatus } from "@/lib/backups";

export async function GET() {
  const authed = await isAuthenticated();
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const status = await getBackupStatus();
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
