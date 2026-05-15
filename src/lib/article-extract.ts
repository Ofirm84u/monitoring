import { PDFParse } from "pdf-parse";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;

export interface ExtractedContent {
  title: string;
  text: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampText(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[... content truncated]`
    : text;
}

function extractTitleFromHtml(html: string): string {
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogMatch) return decodeEntities(ogMatch[1]).trim();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return decodeEntities(titleMatch[1]).trim();

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) return decodeEntities(h1Match[1]).trim();

  return "Untitled";
}

export async function extractFromUrl(url: string): Promise<ExtractedContent> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MonitorBot/1.0; +article-summarizer)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} from ${parsedUrl.host}`);

  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_HTML_BYTES) {
    throw new Error(`Response too large (${buf.byteLength} bytes)`);
  }

  if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
    return extractFromPdfBuffer(Buffer.from(buf), parsedUrl.host);
  }

  const html = new TextDecoder("utf-8").decode(buf);
  const title = extractTitleFromHtml(html);
  const text = clampText(normalizeWhitespace(decodeEntities(stripTags(html))));

  if (text.length < 50) {
    throw new Error("Could not extract meaningful text from page");
  }

  return { title, text };
}

export async function extractFromPdfBuffer(
  buf: Buffer,
  filename: string,
): Promise<ExtractedContent> {
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF too large (${buf.byteLength} bytes)`);
  }
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo().catch(() => null),
    ]);
    const text = clampText(normalizeWhitespace(textResult.text));
    if (text.length < 50) {
      throw new Error("Could not extract meaningful text from PDF");
    }
    const info = infoResult?.info as { Title?: string } | undefined;
    const title =
      info?.Title?.trim() ||
      filename.replace(/\.pdf$/i, "") ||
      "PDF document";
    return { title, text };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export function extractFromText(raw: string): ExtractedContent {
  const text = clampText(raw.trim());
  if (text.length < 50) {
    throw new Error("Text is too short to summarize");
  }
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const title =
    firstLine.length > 5 && firstLine.length < 120
      ? firstLine.trim()
      : `Note ${new Date().toISOString().slice(0, 10)}`;
  return { title, text };
}
