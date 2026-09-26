import { NextResponse } from "next/server";
import { isAuthenticatedOrBot } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { PROJECTS } from "@/lib/projects";
import {
  applyTriage,
  createDefect,
  listDefects,
  markTriageFailed,
  type CreateDefectInput,
} from "@/lib/defects";
import { InvalidImageError, readDefectImageAsBase64 } from "@/lib/defect-images";
import { analyzeDefect, type DefectImageInput } from "@/lib/claude";

const SUBMIT_RATE_LIMIT = { maxAttempts: 10, windowMs: 60 * 1000 };
const LIST_RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 1000 };
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_FIELD_CHARS = 5_000;

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`defects-list:${ip}`, LIST_RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId") ?? undefined;

  try {
    const defects = await listDefects({ projectId });
    return json(200, { defects });
  } catch (err) {
    return json(500, {
      error: err instanceof Error ? err.message : "Failed to load defects",
    });
  }
}

interface SubmitBody {
  projectId?: string;
  whatHappened?: string;
  whatExpected?: string;
  reproSteps?: string;
  route?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  userAgent?: string;
  imagesBase64?: string[];
  reportedVia?: "web" | "telegram";
}

/** Trim and cap a free-text field; empty becomes null rather than "". */
function cleanText(value: unknown, max = MAX_TEXT_FIELD_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** A positive, plausible pixel dimension, or null. */
function cleanDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded <= 0 || rounded > 20_000) return null;
  return rounded;
}

export async function POST(request: Request) {
  if (!(await isAuthenticatedOrBot(request))) {
    return json(401, { error: "Unauthorized" });
  }
  const ip = getClientIp(request);
  if (!checkRateLimit(`defects-submit:${ip}`, SUBMIT_RATE_LIMIT).allowed) {
    return json(429, { error: "Rate limit exceeded" });
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return json(400, { error: "Payload too large" });
  }

  let body: SubmitBody;
  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const project = PROJECTS.find((p) => p.id === body.projectId);
  if (!project) {
    return json(400, { error: `Unknown projectId: ${String(body.projectId)}` });
  }

  const whatHappened = cleanText(body.whatHappened);
  if (!whatHappened) {
    return json(400, { error: "Describe what happened" });
  }

  const images = Array.isArray(body.imagesBase64)
    ? body.imagesBase64.filter((i): i is string => typeof i === "string")
    : [];

  const input: CreateDefectInput = {
    projectId: project.id,
    whatHappened,
    whatExpected: cleanText(body.whatExpected),
    reproSteps: cleanText(body.reproSteps),
    route: cleanText(body.route, 2_000),
    viewportWidth: cleanDimension(body.viewportWidth),
    viewportHeight: cleanDimension(body.viewportHeight),
    userAgent: cleanText(body.userAgent, 500),
    reportedVia: body.reportedVia === "telegram" ? "telegram" : "web",
    imagesBase64: images,
  };

  // Images are validated inside createDefect, before the row is written — an
  // unreadable screenshot fails here rather than leaving evidence-less defects.
  let defect;
  try {
    defect = await createDefect(input);
  } catch (err) {
    if (err instanceof InvalidImageError) {
      return json(400, { error: err.message });
    }
    return json(500, {
      error: err instanceof Error ? err.message : "Failed to save defect",
    });
  }

  // Triage runs inline: a defect with no analysis isn't actionable, and the
  // record already exists, so a failure here is recorded rather than lost.
  const visionImages: DefectImageInput[] = [];
  for (const image of defect.images) {
    const base64 = await readDefectImageAsBase64(image.filename);
    if (base64) {
      visionImages.push({
        mediaType: image.mediaType as DefectImageInput["mediaType"],
        base64,
      });
    }
  }

  try {
    const analysis = await analyzeDefect(project, defect, visionImages);
    const triaged = await applyTriage(defect.id, analysis);
    return json(201, {
      defect: { ...triaged, images: defect.images },
      analysis,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Triage failed";
    await markTriageFailed(defect.id, message);
    // 201, not 5xx: the defect was captured, which is the part that matters.
    // Triage can be retried; a lost bug report cannot.
    return json(201, {
      defect: { ...defect, status: "failed", triageError: message },
      error: message,
    });
  }
}
