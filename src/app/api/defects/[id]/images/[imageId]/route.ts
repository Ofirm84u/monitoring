import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getDefectImage } from "@/lib/defects";
import { readDefectImage } from "@/lib/defect-images";

/**
 * Serve one defect screenshot.
 *
 * Screenshots live outside the webroot precisely so that reading one requires
 * passing through here. The response headers assume the bytes are hostile even
 * though they were sniffed on the way in: the browser is told exactly what the
 * type is, forbidden from guessing otherwise, and denied every capability a
 * document would need to do anything with the page it is rendered on.
 */

const RATE_LIMIT = { maxAttempts: 120, windowMs: 60 * 1000 };

function error(status: number, message: string) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

interface RouteContext {
  params: Promise<{ id: string; imageId: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  if (!(await isAuthenticatedOrBot(request))) {
    return error(401, "Unauthorized");
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`defect-image:${ip}`, RATE_LIMIT).allowed) {
    return error(429, "Rate limit exceeded");
  }

  const { id, imageId } = await params;

  // Scoped by defect id as well as image id, so a valid image id from one
  // defect can't be read through another defect's URL.
  const image = await getDefectImage(id, imageId);
  if (!image) return error(404, "Not found");

  const bytes = await readDefectImage(image.filename);
  if (!bytes) return error(404, "Image file is missing");

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      // The stored type came from magic bytes, never from the uploader.
      "Content-Type": image.mediaType,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      // Nothing in an image needs to load, script, or navigate.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `inline; filename="${image.id}"`,
      // Screenshots of bugs routinely contain session state and customer data;
      // keeping them out of the browser's disk cache costs one re-fetch.
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
