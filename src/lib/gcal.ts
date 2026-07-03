import { google, type calendar_v3 } from "googleapis";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { maybeDecryptSecret } from "@/lib/crypto";

/**
 * Per-user Google Calendar sync (FR-CAL). The OAuth2 client is built from the
 * user's own stored (encrypted) refresh token — captured at login — so there is
 * no separate credential setup. Events are written to a dedicated "PM Hub"
 * calendar, never the primary (FR-CAL-2), and stamped with extendedProperties
 * so only app-created events are ever touched (H1).
 *
 * All-day events use date-only `date` fields (not `dateTime`), which are
 * timezone-independent — avoiding the classic off-by-one (H2/FR-CAL-5).
 */

const APP_TYPE = "task";
const PM_HUB_CAL_SUMMARY = "PM Hub";

function reuseGoogleCreds() {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are not set");
  }
  return { clientId, clientSecret };
}

async function getOAuthClientForUser(userId: string) {
  const account = await db
    .select({ refresh: accounts.refresh_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")))
    .get();
  const refreshToken = maybeDecryptSecret(account?.refresh ?? null);
  if (!refreshToken) {
    throw new Error(`No Google refresh token for user ${userId}`);
  }
  const { clientId, clientSecret } = reuseGoogleCreds();
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function getCalendarApi(userId: string): Promise<calendar_v3.Calendar> {
  const auth = await getOAuthClientForUser(userId);
  return google.calendar({ version: "v3", auth });
}

/** Find (or create) the user's dedicated "PM Hub" calendar; returns its id. */
export async function ensurePmHubCalendar(userId: string): Promise<string> {
  if (process.env.GCAL_CALENDAR_ID) return process.env.GCAL_CALENDAR_ID;
  const cal = await getCalendarApi(userId);
  const list = await cal.calendarList.list({ maxResults: 250 });
  const existing = list.data.items?.find((c) => c.summary === PM_HUB_CAL_SUMMARY);
  if (existing?.id) return existing.id;
  const created = await cal.calendars.insert({
    requestBody: { summary: PM_HUB_CAL_SUMMARY },
  });
  if (!created.data.id) throw new Error("Failed to create PM Hub calendar");
  return created.data.id;
}

/** YYYY-MM-DD → the next day as YYYY-MM-DD (UTC, TZ-stable). */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface PushInput {
  appId: string;
  summary: string;
  date: string; // YYYY-MM-DD
  googleEventId?: string | null;
}

/** Create or update an all-day event; returns the Google event id. */
export async function pushEvent(userId: string, input: PushInput): Promise<string> {
  const cal = await getCalendarApi(userId);
  const calendarId = await ensurePmHubCalendar(userId);
  const requestBody: calendar_v3.Schema$Event = {
    summary: input.summary,
    start: { date: input.date },
    end: { date: nextDay(input.date) },
    extendedProperties: {
      private: { appType: APP_TYPE, appId: input.appId, userId },
    },
  };
  if (input.googleEventId) {
    const res = await cal.events.update({
      calendarId,
      eventId: input.googleEventId,
      requestBody,
    });
    return res.data.id!;
  }
  const res = await cal.events.insert({ calendarId, requestBody });
  return res.data.id!;
}

export async function deleteEvent(userId: string, eventId: string): Promise<void> {
  const cal = await getCalendarApi(userId);
  const calendarId = await ensurePmHubCalendar(userId);
  await cal.events.delete({ calendarId, eventId });
}

export interface PullResult {
  events: Array<{
    eventId: string | null | undefined;
    appId: string | undefined;
    status: string | null | undefined;
    summary: string | null | undefined;
    date: string | null | undefined;
  }>;
  nextSyncToken: string | null | undefined;
}

/**
 * Pull app-created events changed since `syncToken` (incremental). Only events
 * carrying our extendedProperties are returned — external events are ignored.
 */
export async function pullChanges(
  userId: string,
  syncToken?: string | null,
): Promise<PullResult> {
  const cal = await getCalendarApi(userId);
  const calendarId = await ensurePmHubCalendar(userId);
  const res = await cal.events.list({
    calendarId,
    privateExtendedProperty: [`appType=${APP_TYPE}`],
    showDeleted: true,
    singleEvents: true,
    ...(syncToken ? { syncToken } : {}),
  });
  const events = (res.data.items ?? []).map((e) => ({
    eventId: e.id,
    appId: e.extendedProperties?.private?.appId,
    status: e.status,
    summary: e.summary,
    date: e.start?.date,
  }));
  return { events, nextSyncToken: res.data.nextSyncToken };
}
