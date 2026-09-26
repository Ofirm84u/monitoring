import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  defectImages,
  defects,
  type Defect,
  type DefectImage,
  type DefectStatus,
  type NewDefect,
} from "@/db/schema";
import type { DefectAnalysis } from "@/lib/claude";
import { storeDefectImage, type StoredImage } from "@/lib/defect-images";

/**
 * Defect records: a GUI bug seen through the interface, its screenshots, and
 * whatever triage made of them.
 *
 * A defect is an input to the Idea Runner, not a thing of its own — once
 * triaged it produces the same `agentRuns` row an article idea does. What is
 * specific to defects is the evidence (screenshots) and the tier, which decides
 * how a fix can be proven at G5.
 */

export interface DefectWithImages extends Defect {
  images: DefectImage[];
}

export interface CreateDefectInput {
  projectId: string;
  whatHappened: string;
  whatExpected?: string | null;
  reproSteps?: string | null;
  route?: string | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  userAgent?: string | null;
  reportedVia: "web" | "telegram";
  /** Base64 screenshots, validated by magic bytes before anything is written. */
  imagesBase64?: string[];
}

const MAX_IMAGES_PER_DEFECT = 4;

/** Until triage runs, the reporter's own words are the best title available. */
function provisionalTitle(whatHappened: string): string {
  const firstLine = whatHappened.trim().split("\n")[0].trim();
  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
}

export async function createDefect(
  input: CreateDefectInput,
): Promise<DefectWithImages> {
  const images = input.imagesBase64 ?? [];
  if (images.length > MAX_IMAGES_PER_DEFECT) {
    throw new Error(`At most ${MAX_IMAGES_PER_DEFECT} screenshots per defect`);
  }

  // Validate and write every image before inserting the row, so a rejected
  // screenshot never leaves a defect behind with missing evidence.
  const stored: StoredImage[] = [];
  for (const base64 of images) {
    stored.push(await storeDefectImage(base64));
  }

  const row: NewDefect = {
    projectId: input.projectId,
    title: provisionalTitle(input.whatHappened),
    whatHappened: input.whatHappened,
    whatExpected: input.whatExpected ?? null,
    reproSteps: input.reproSteps ?? null,
    route: input.route ?? null,
    viewportWidth: input.viewportWidth ?? null,
    viewportHeight: input.viewportHeight ?? null,
    userAgent: input.userAgent ?? null,
    reportedVia: input.reportedVia,
    status: "triaging",
  };

  const [created] = await db.insert(defects).values(row).returning();

  const imageRows: DefectImage[] = [];
  for (const s of stored) {
    const [imageRow] = await db
      .insert(defectImages)
      .values({
        defectId: created.id,
        filename: s.filename,
        sha256: s.sha256,
        mediaType: s.mediaType,
        byteSize: s.byteSize,
      })
      .returning();
    imageRows.push(imageRow);
  }

  return { ...created, images: imageRows };
}

export async function getDefect(id: string): Promise<DefectWithImages | null> {
  const [defect] = await db.select().from(defects).where(eq(defects.id, id)).limit(1);
  if (!defect) return null;
  const images = await db
    .select()
    .from(defectImages)
    .where(eq(defectImages.defectId, id));
  return { ...defect, images };
}

export async function getDefectImage(
  defectId: string,
  imageId: string,
): Promise<DefectImage | null> {
  const [image] = await db
    .select()
    .from(defectImages)
    // Scoped by both ids: an image id alone must not be enough to read an image
    // out of a defect the caller didn't ask for.
    .where(and(eq(defectImages.id, imageId), eq(defectImages.defectId, defectId)))
    .limit(1);
  return image ?? null;
}

export async function listDefects(options?: {
  projectId?: string;
  limit?: number;
}): Promise<DefectWithImages[]> {
  const limit = options?.limit ?? 100;
  const rows = options?.projectId
    ? await db
        .select()
        .from(defects)
        .where(eq(defects.projectId, options.projectId))
        .orderBy(desc(defects.createdAt))
        .limit(limit)
    : await db.select().from(defects).orderBy(desc(defects.createdAt)).limit(limit);

  if (rows.length === 0) return [];

  const allImages = await db.select().from(defectImages);
  const byDefect = new Map<string, DefectImage[]>();
  for (const image of allImages) {
    const list = byDefect.get(image.defectId);
    if (list) list.push(image);
    else byDefect.set(image.defectId, [image]);
  }

  return rows.map((d) => ({ ...d, images: byDefect.get(d.id) ?? [] }));
}

/**
 * Record what triage concluded.
 *
 * A low-confidence analysis, or one that still needs information, lands in
 * `needs_info` rather than `triaged` — that is the state where the runner asks
 * you a question instead of planning against a guess.
 */
export async function applyTriage(
  id: string,
  analysis: DefectAnalysis,
): Promise<Defect | null> {
  const needsInfo =
    analysis.confidence === "low" || analysis.missingInfo.length > 0;

  const [updated] = await db
    .update(defects)
    .set({
      title: analysis.title,
      tier: analysis.tier,
      severity: analysis.severity,
      symptom: analysis.symptom,
      suspectedCauses: analysis.suspectedCauses,
      visibleStrings: analysis.visibleStrings,
      suspectedFiles: analysis.suspectedFiles,
      confidence: analysis.confidence,
      missingInfo: analysis.missingInfo,
      status: needsInfo ? "needs_info" : "triaged",
      triageError: null,
      triagedAt: new Date(),
    })
    .where(eq(defects.id, id))
    .returning();

  return updated ?? null;
}

export async function markTriageFailed(
  id: string,
  message: string,
): Promise<void> {
  await db
    .update(defects)
    .set({ status: "failed", triageError: message, triagedAt: new Date() })
    .where(eq(defects.id, id));
}

export async function setDefectStatus(
  id: string,
  status: DefectStatus,
): Promise<Defect | null> {
  const [updated] = await db
    .update(defects)
    .set({ status })
    .where(eq(defects.id, id))
    .returning();
  return updated ?? null;
}

/**
 * Delete a defect and its image rows (cascade).
 *
 * The image *files* are deliberately left on disk: they are content-addressed,
 * so two defects reporting the same screenshot share one file and deleting it
 * here would blank the other one. Reclaiming orphans is a sweep over filenames
 * no row references, not something a single delete can decide.
 */
export async function deleteDefect(id: string): Promise<boolean> {
  const result = await db.delete(defects).where(eq(defects.id, id)).returning();
  return result.length > 0;
}
