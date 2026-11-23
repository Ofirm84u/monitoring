import { createSetupLink } from "@/lib/accounts";
import { isAuthenticated } from "@/lib/auth";
import { appBaseUrl, handle, json } from "@/lib/pm/http";

/**
 * Bootstrap: the owner, signed in with the break-glass MONITOR_PASSWORD, gets
 * a setup link for their own OWNER_EMAIL account. Without this there would be
 * no admin to issue the first link. isAuthenticated() only passes for the
 * owner (legacy cookie or an owner session), so nobody else can mint one.
 */
export async function POST(request: Request) {
  return handle(async () => {
    if (!(await isAuthenticated())) return json(401, { error: "Unauthorized" });
    const ownerEmail = process.env.OWNER_EMAIL;
    if (!ownerEmail) {
      return json(400, { error: "OWNER_EMAIL is not set on the server" });
    }
    const link = await createSetupLink(ownerEmail, null, appBaseUrl(request));
    if (!link.ok) return json(link.status, { error: link.error });
    return json(200, { url: link.url });
  });
}
