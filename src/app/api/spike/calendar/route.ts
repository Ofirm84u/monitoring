import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/request-user";
import { pushEvent, pullChanges, deleteEvent } from "@/lib/gcal";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const SPIKE_APP_ID = "spike-roundtrip-1";

/**
 * Spike: one full Google Calendar roundtrip for the acting user —
 * push an all-day event → pull it back → delete it. Validates per-user OAuth
 * (encrypted token), the dedicated PM Hub calendar, date-stable all-day events,
 * and extendedProperties round-tripping. Requires live Google credentials.
 */
export async function POST(request: Request) {
  const user = await getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const eventId = await pushEvent(user.id, {
      appId: SPIKE_APP_ID,
      summary: "PM Hub spike ✅",
      date: today,
    });
    const pulled = await pullChanges(user.id);
    const found = pulled.events.find((e) => e.appId === SPIKE_APP_ID);
    await deleteEvent(user.id, eventId);
    return NextResponse.json(
      {
        ok: true,
        pushedEventId: eventId,
        pulledBack: !!found,
        pulledCount: pulled.events.length,
        cleanedUp: true,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502, headers: NO_STORE },
    );
  }
}
