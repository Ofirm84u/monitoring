import { createSetupLink } from "@/lib/accounts";
import { denied, appBaseUrl, handle, json, readBody, requiredText, requireUser } from "@/lib/pm/http";
import { isTeamAdmin } from "@/lib/team";

const EMAIL_MAX = 254;

/**
 * Admin issues a fresh setup link — for someone who lost theirs, or as a
 * password reset. Any earlier unused link for that email stops working.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    if (!user) return json(401, { error: "Unauthorized" });
    if (!(await isTeamAdmin(user.email))) return denied(403);

    const body = await readBody(request);
    const link = await createSetupLink(requiredText(body.email, EMAIL_MAX, "email"), user.id, appBaseUrl(request));
    if (!link.ok) return json(link.status, { error: link.error });
    return json(200, { url: link.url, expiresAt: link.expiresAt });
  });
}
