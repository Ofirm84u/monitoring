import { readFile, writeFile, rename, mkdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import { join, resolve } from "path";

/**
 * Storage for defect screenshots.
 *
 * Nothing else in this app keeps binaries — PDFs are parsed to text and the
 * bytes discarded. A defect screenshot is evidence, so it has to survive, which
 * makes this the one place untrusted binary input is written to disk. Three
 * rules follow from that:
 *
 *  1. The format is decided by magic bytes, never by what the client claimed.
 *     A caller that says "image/png" over a 400KB HTML file gets rejected.
 *  2. SVG is refused outright. It is a script container that happens to render,
 *     and serving one back would be stored XSS.
 *  3. Files live outside the webroot and are served through an authenticated
 *     route. Anything under `public/` would be world-readable.
 */

const IMAGES_DIR = process.env.DEFECT_IMAGES_DIR ?? "/home/ofir/monitor/defect-images";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Formats Claude's vision API accepts and a browser renders inertly. */
const ALLOWED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
// WebP is a RIFF container: "RIFF" <4-byte length> "WEBP".
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");
const WEBP_HEADER_BYTES = 12;

const EXTENSION_BY_MEDIA_TYPE: Record<AllowedMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface StoredImage {
  filename: string;
  sha256: string;
  mediaType: AllowedMediaType;
  byteSize: number;
}

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

/**
 * Identify a buffer by its leading bytes. Returns null for anything not on the
 * allowlist — including SVG, GIF, and any file merely renamed to look like an
 * image.
 */
export function sniffMediaType(buf: Buffer): AllowedMediaType | null {
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return "image/png";
  }
  if (buf.length >= JPEG_MAGIC.length && buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return "image/jpeg";
  }
  if (
    buf.length >= WEBP_HEADER_BYTES &&
    buf.subarray(0, 4).equals(RIFF_MAGIC) &&
    buf.subarray(8, 12).equals(WEBP_MAGIC)
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Validate and persist one screenshot. Content-addressed, so re-reporting the
 * same screenshot twice costs one file rather than two.
 *
 * @throws InvalidImageError when the payload is unreadable, oversized, or not a
 *         PNG/JPEG/WebP by its own bytes.
 */
export async function storeDefectImage(base64: string): Promise<StoredImage> {
  if (!base64 || typeof base64 !== "string") {
    throw new InvalidImageError("Image data is missing");
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    throw new InvalidImageError("Image data is not valid base64");
  }

  if (buf.length === 0) {
    throw new InvalidImageError("Image is empty");
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    const mb = (MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0);
    throw new InvalidImageError(`Image is larger than ${mb}MB`);
  }

  const mediaType = sniffMediaType(buf);
  if (!mediaType) {
    throw new InvalidImageError(
      "Unsupported image format. Screenshots must be PNG, JPEG, or WebP.",
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const filename = `${sha256}.${EXTENSION_BY_MEDIA_TYPE[mediaType]}`;

  await mkdir(IMAGES_DIR, { recursive: true });

  // Write-then-rename, matching the JSON stores: a reader never sees a partial
  // file, and a concurrent write of identical content is harmless.
  const target = join(IMAGES_DIR, filename);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new Error(
      `Failed to store defect image: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { filename, sha256, mediaType, byteSize: buf.length };
}

/**
 * Read a stored screenshot back.
 *
 * `filename` comes from a database row rather than a request, but it is still
 * joined into a path, so the resolved path is checked to be inside the images
 * directory. A traversal here would turn an image route into arbitrary file read.
 */
export async function readDefectImage(filename: string): Promise<Buffer | null> {
  const dir = resolve(IMAGES_DIR);
  const target = resolve(join(dir, filename));
  if (target !== join(dir, filename) || !target.startsWith(`${dir}/`)) {
    return null;
  }
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

/** Base64 for the vision API, read back from disk rather than kept in memory. */
export async function readDefectImageAsBase64(filename: string): Promise<string | null> {
  const buf = await readDefectImage(filename);
  return buf ? buf.toString("base64") : null;
}
