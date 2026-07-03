import { NextResponse } from "next/server";
import { getRequestUser, isOwner } from "@/lib/request-user";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// Spike: confirms identity resolution (session OR bot+telegram-id) and owner gate.
export async function GET(request: Request) {
  const user = await getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  return NextResponse.json(
    { id: user.id, email: user.email, source: user.source, owner: isOwner(user) },
    { headers: NO_STORE },
  );
}
