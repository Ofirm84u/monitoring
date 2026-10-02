import Anthropic from "@anthropic-ai/sdk";
import { PROJECTS, type ProjectConfig } from "./projects";
import { buildPlanConstraintsBlock } from "./plan-constraints";
import type { RepoManifest } from "./repo-manifests";
import type { Article, ArticleSuggestion, ArticleSummary } from "./articles";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 1500;
const VALID_RELEVANCE = new Set(["high", "medium", "low"]);

export interface ClaudeAnalysis {
  title: string;
  summary: ArticleSummary;
  suggestions: ArticleSuggestion[];
  tags: string[];
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  client = new Anthropic({ apiKey });
  return client;
}

function buildSystemPrompt(projects: ProjectConfig[]): string {
  const projectList = projects
    .map(
      (p) =>
        `- id: ${p.id}\n  name: ${p.name}\n  description: ${p.description}\n  stack: ${p.stack.join(", ")}`,
    )
    .join("\n");

  return `You are an analyst helping a solo developer/founder process articles, blog posts, papers and ideas. The user maintains the following set of projects. Your job is to summarize the article and suggest which of these projects (if any) could benefit from the ideas in it, and how.

PROJECTS:
${projectList}

OUTPUT REQUIREMENTS:
- Respond in English regardless of article language (summary, ideas, suggestions).
- Return ONLY a valid JSON object — no markdown fences, no commentary before/after.
- The JSON object must match this exact schema:
{
  "title": "string — concise article title (max 100 chars)",
  "summary": {
    "tldr": "string — 1-2 sentence summary (max 280 chars)",
    "keyIdeas": ["string", "string", ...]   // 3-5 actionable ideas/insights, each a complete sentence
  },
  "suggestions": [
    {
      "projectId": "string — MUST be one of the project ids above",
      "projectName": "string — matching project name",
      "relevance": "high" | "medium" | "low",
      "howToUse": "string — 1-3 sentences explaining concretely how the article's ideas apply to this project"
    }
  ],
  "tags": ["string", ...]   // 2-5 lowercase topic tags
}

SUGGESTION RULES:
- Provide between 0 and 3 suggestions, ordered by relevance (highest first).
- Only include a suggestion if there is a real, concrete connection — not a vague theme match.
- If no project is clearly relevant, return an empty suggestions array. Do NOT force a match.
- Never invent project ids; only use ids from the list above.`;
}

function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model returned no JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validateAnalysis(parsed: unknown): ClaudeAnalysis {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Analysis is not an object");
  }
  const p = parsed as Record<string, unknown>;

  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (!title) throw new Error("Missing title");

  const summary = p.summary as Record<string, unknown> | undefined;
  const tldr = typeof summary?.tldr === "string" ? summary.tldr.trim() : "";
  const keyIdeasRaw = Array.isArray(summary?.keyIdeas) ? summary.keyIdeas : [];
  const keyIdeas = keyIdeasRaw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tldr || keyIdeas.length === 0) {
    throw new Error("Missing tldr or keyIdeas");
  }

  const validIds = new Set(PROJECTS.map((p) => p.id));
  const idToName = new Map(PROJECTS.map((p) => [p.id, p.name]));

  const suggestionsRaw = Array.isArray(p.suggestions) ? p.suggestions : [];
  const suggestions: ArticleSuggestion[] = suggestionsRaw
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((s) => {
      const projectId = typeof s.projectId === "string" ? s.projectId : "";
      const relevance = typeof s.relevance === "string" ? s.relevance : "";
      const howToUse = typeof s.howToUse === "string" ? s.howToUse.trim() : "";
      if (!validIds.has(projectId)) return null;
      if (!VALID_RELEVANCE.has(relevance)) return null;
      if (!howToUse) return null;
      return {
        projectId,
        projectName: idToName.get(projectId) ?? projectId,
        relevance: relevance as ArticleSuggestion["relevance"],
        howToUse,
      };
    })
    .filter((x): x is ArticleSuggestion => x !== null)
    .slice(0, 3);

  const tagsRaw = Array.isArray(p.tags) ? p.tags : [];
  const tags = tagsRaw
    .filter((x): x is string => typeof x === "string")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 5);

  return {
    title: title.slice(0, 100),
    summary: { tldr: tldr.slice(0, 280), keyIdeas: keyIdeas.slice(0, 5) },
    suggestions,
    tags,
  };
}

export interface ArticlePlan {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const IMPL_MAX_TOKENS = 3500;
const QA_MAX_TOKENS = 2500;

function codeLanguage(stack: string[]): string {
  if (stack.includes("Python")) return "python";
  return "typescript";
}

export async function planArticleImplementation(
  project: ProjectConfig,
  article: Article,
  codeContext?: string | null,
  /**
   * What the agent that executes this plan is actually allowed to do.
   *
   * Without it the planner proposed `import anthropic` for a package that is not
   * a dependency, and a database table whose migration would have to live under a
   * denied path. Both were caught — by the implementer, after a dispatch and a
   * runner had been spent finding out. The planner was not being careless; it had
   * no way to know either fact.
   */
  constraints?: { deniedPaths: readonly string[]; manifests: RepoManifest[] },
): Promise<ArticlePlan> {
  const codeBlock = codeContext
    ? `\nPROJECT CODE (excerpt — cite exact functions/lines if present, never invent):\n${codeContext}\n`
    : "";

  const constraintBlock = buildPlanConstraintsBlock(constraints);

  const keyIdeas = article.summary?.keyIdeas.map((k) => `  - ${k}`).join("\n") ?? "";
  const gapBlock = article.gapAnalysis?.text
    ? `\nGAP ANALYSIS:\n${article.gapAnalysis.text}`
    : "";
  const source = article.source.url ? `URL: ${article.source.url}` : `Source: ${article.source.kind}`;
  const lang = codeLanguage(project.stack);

  const system = `You are writing a complete, executable implementation plan for a single article's contribution to a project. The plan is pasted directly into Claude Code — it must be 100% complete, never truncated.

PROJECT: ${project.name}
STACK: ${project.stack.join(", ")}
DESCRIPTION: ${project.description}${codeBlock}${constraintBlock}
RULES:
- Respond in HEBREW. Use English for code identifiers, keywords, and file paths.
- COMPLETE every section. Do not summarise or skip.
- Cite exact file/function locations only if they appear in the PROJECT CODE excerpt above.
- Length: 400–700 words.

STRUCTURE — follow exactly, no additions or omissions:

# תכנית יישום — ${article.title}

## תמצית השינוי
2 משפטים: מה המאמר מציע וכיצד ישתלב בפרויקט.

## שלבי יישום

### שלב 1 — [כותרת ספציפית]
**מה לשנות:** משפט אחד.
**איפה / איך:**
\`\`\`${lang}
// קוד לדוגמה — 5–12 שורות, מוכן להעתקה
\`\`\`
**תוצאה מצופה:** משפט אחד.

### שלב 2 — [כותרת ספציפית]
[אותו פורמט]

(הוסף שלב 3 רק אם נדרש — לא יותר)

## טבלת עדיפויות
| שלב | מורכבות | ערך | זמן משוער |
|-----|---------|-----|-----------|
| 1 — ... | נמוכה/בינונית/גבוהה | נמוך/בינוני/גבוה | Xh |
| 2 — ... | ... | ... | ... |

## פרומפט ל-Claude Code
\`\`\`
אני עובד על ${project.name} (${project.stack.join(", ")}).
[תאר כאן את השלב הראשון במשפט אחד-שניים, כולל איפה לקרוא ומה לשנות]
תקרא את הקוד הרלוונטי, הצג diff לפני ביצוע, וכתוב unit test לכל שינוי.
\`\`\`

## סטטוס תכנית
בדוק שכל הסעיפים הבאים הושלמו במלואם:
- תמצית השינוי (2 משפטים)
- שלב 1 מלא עם קוד ותוצאה מצופה
- שלב 2 מלא עם קוד ותוצאה מצופה
- טבלת עדיפויות עם ערכים אמיתיים
- פרומפט ל-Claude Code מוכן להעתקה

אם כל הסעיפים הושלמו, כתוב בדיוק:
✅ **מוכן ליישום** — כל הסעיפים הושלמו. ניתן להעתיק את הפרומפט ולהתחיל.

אם חסר משהו, כתוב בדיוק:
⚠️ **לא מוכן** — חסר: [פרט מה חסר, שורה לכל פריט]`;

  const userMessage = `ARTICLE: ${article.title}
SOURCE: ${source}
TLDR: ${article.summary?.tldr ?? ""}
KEY IDEAS:
${keyIdeas}${gapBlock}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: IMPL_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Implementation plan for "${article.title}" hit the token limit — cannot return a truncated plan. Reduce article scope or contact support.`,
    );
  }

  const block = response.content[0];
  if (!block || block.type !== "text") throw new Error("Unexpected response from Claude");

  return {
    text: block.text.trim(),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export async function planArticleQA(
  project: ProjectConfig,
  article: Article,
): Promise<ArticlePlan> {
  const lang = codeLanguage(project.stack);
  const keyIdeas = article.summary?.keyIdeas.map((k) => `  - ${k}`).join("\n") ?? "";
  const gapBlock = article.gapAnalysis?.text
    ? `\nGAP ANALYSIS:\n${article.gapAnalysis.text}`
    : "";

  const system = `You are writing a complete QA & testing plan. This document is for a QA agent — not the developer. It must be 100% complete and actionable, never truncated or summarised.

PROJECT: ${project.name}
STACK: ${project.stack.join(", ")}

RULES:
- Respond in HEBREW. Use English for code identifiers, test names, CLI commands.
- Be specific to this article's proposed changes. No generic filler.
- COMPLETE every section without exception.
- Length: 300–500 words.

STRUCTURE — follow exactly:

# תכנית QA — ${article.title}

## מה נבדק
1–2 משפטים: אילו שינויים יש לאמת.

## בדיקות יחידה (Unit Tests)
**פונקציה / מודול:** \`...\`
**קייסים:** happy path | edge case | שגיאה
\`\`\`${lang}
// דוגמת unit test — 5–10 שורות
\`\`\`

## בדיקות עשן (Smoke Tests)
- [ ] [בדיקה 1 — מה בדיוק לוודא]
- [ ] [בדיקה 2]
- [ ] [בדיקה 3]

## בדיקות אבטחה
- [ ] [בדיקה ספציפית לשינוי — לא generic]
- [ ] [בדיקה נוספת]

## סקירת קוד — Checklist
- [ ] אין רגרסיות בפונקציונליות קיימת
- [ ] טיפוסים נכונים (strict mode)
- [ ] אין חשיפת secrets
- [ ] error handling ב-boundaries
- [ ] ולידציה של כל input חיצוני

## קריטריון הצלחה
✅ [משפט אחד — מתי ה-QA עובר]

## סטטוס תכנית QA
בדוק שכל הסעיפים הבאים הושלמו:
- מה נבדק (1–2 משפטים)
- בדיקות יחידה עם קוד לדוגמה
- לפחות 3 בדיקות עשן ספציפיות
- לפחות 2 בדיקות אבטחה ספציפיות לשינוי
- כל 5 פריטי ה-checklist
- קריטריון הצלחה ספציפי

אם הכל הושלם, כתוב בדיוק:
✅ **תכנית QA מוכנה** — מוכן להעברה לסוכן QA.

אם חסר משהו, כתוב בדיוק:
⚠️ **תכנית QA לא מוכנה** — חסר: [פרט מה חסר, שורה לכל פריט]`;

  const userMessage = `ARTICLE: ${article.title}
TLDR: ${article.summary?.tldr ?? ""}
KEY IDEAS:
${keyIdeas}${gapBlock}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: QA_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `QA plan for "${article.title}" hit the token limit — cannot return a truncated plan.`,
    );
  }

  const block = response.content[0];
  if (!block || block.type !== "text") throw new Error("Unexpected response from Claude");

  return {
    text: block.text.trim(),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export async function analyzeGap(
  project: ProjectConfig,
  articleTitle: string,
  articleText: string,
  codeContext?: string | null,
): Promise<string> {
  const codeBlock = codeContext
    ? `\n\nPROJECT CODE (excerpt — use this to cite specific functions/locations):\n${codeContext}\n`
    : "";

  const system = `You are advising a solo developer/founder on how to apply ideas from an article to one of their projects.

PROJECT IN FOCUS:
- name: ${project.name}
- description: ${project.description}
- stack: ${project.stack.join(", ")}${codeBlock}

OUTPUT REQUIREMENTS:
- Respond in HEBREW (RTL). Use Hebrew for narrative, English for code identifiers/keywords.
- Use Markdown formatting (headings, bold, tables, code fences).
- Be concrete and actionable. Reference specific functions/files/line numbers ONLY if the PROJECT CODE excerpt above contains them — never invent locations.
- Length: 350–700 words.
- Follow this exact structure:

# ניתוח המאמר

## 1. תמצית
2–3 משפטים שמסכמים את המאמר.

## 2. רלוונטיות לפרויקט
**מה הכלי כבר מכסה:** רשימת bullet קצרה (אם אפשר להסיק מהתיאור/קוד).

**מה חסר:** רשימת bullet — היכן יש פער בין הרעיונות במאמר לפרויקט.

## 3. הצעות קונקרטיות

### הצעה א׳ — [כותרת קצרה]
**מה:** תיאור קצר במשפט-שניים.
**איפה / איך ליישם:** מיקום בקוד (אם ידוע מהקטע למעלה — צטט פונקציה/שורות; אחרת תיאור כללי של איפה זה ישתלב).
\`\`\`${project.stack.includes("Python") ? "python" : project.stack.includes("Next.js") || project.stack.includes("React") ? "typescript" : "javascript"}
// example code snippet — דוגמה מעשית קצרה (5-15 שורות)
\`\`\`
**תועלת:** למה זה שווה — תוצאה מצופה.

### הצעה ב׳ — [כותרת]
[אותו פורמט]

### הצעה ג׳ — [כותרת]
[אותו פורמט]

(הוסף הצעה ד׳ אם המאמר באמת מצדיק 4 רעיונות.)

## 4. סיכום עדיפויות
| הצעה | מורכבות | ערך |
|------|---------|-----|
| א׳ — ... | נמוכה/בינונית/גבוהה | נמוך/בינוני/גבוה |
| ב׳ — ... | ... | ... |
| ג׳ — ... | ... | ... |`;

  const userMessage = `ARTICLE TITLE: ${articleTitle}

ARTICLE TEXT:
${articleText}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 3000,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response shape from Claude");
  }
  return block.text.trim();
}

export async function analyzeArticle(
  articleTitle: string,
  articleText: string,
): Promise<ClaudeAnalysis> {
  const system = buildSystemPrompt(PROJECTS);

  const userMessage = `Analyze this article.

Source title (may be unreliable, override if needed): ${articleTitle}

ARTICLE TEXT:
${articleText}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response shape from Claude");
  }
  const parsed = parseJsonResponse(block.text);
  return validateAnalysis(parsed);
}

/* =========================================================================
 * Defect triage (vision).
 *
 * The first vision call in this codebase. It reads a GUI screenshot and returns
 * structured findings — never prose — because everything downstream (the tier,
 * the gate, the plan) branches on the fields.
 * ===================================================================== */

// Deliberately separate from MODEL: the article pipeline keeps whatever it was
// tuned on, while triage — which has to read a screenshot and reason about
// unfamiliar UI — uses the current flagship. Both stay env-overridable.
const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL ?? "claude-opus-5";
const TRIAGE_MAX_TOKENS = 4000;

const DEFECT_TIER_VALUES = new Set(["state", "flow", "visual", "unknown"]);
const SEVERITY_VALUES = new Set(["low", "medium", "high", "critical"]);
const CONFIDENCE_VALUES = new Set(["low", "medium", "high"]);

export interface DefectAnalysis {
  title: string;
  tier: "state" | "flow" | "visual" | "unknown";
  severity: "low" | "medium" | "high" | "critical";
  symptom: string;
  suspectedCauses: string[];
  /** Text read off the screenshot — the index used to locate the component. */
  visibleStrings: string[];
  suspectedFiles: string[];
  confidence: "low" | "medium" | "high";
  missingInfo: string[];
}

export interface DefectImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

export interface DefectReportInput {
  whatHappened: string;
  whatExpected?: string | null;
  reproSteps?: string | null;
  route?: string | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  userAgent?: string | null;
}

/**
 * Pull the model's text out of a response.
 *
 * Not `content[0]`: on models with thinking enabled by default the first block
 * is a thinking block, and indexing position zero would throw on a perfectly
 * good response.
 */
function firstTextBlock(content: Anthropic.ContentBlock[]): string {
  const block = content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text block");
  }
  return block.text;
}

function asStringArray(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, max);
}

function validateDefectAnalysis(parsed: unknown): DefectAnalysis {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Triage result is not an object");
  }
  const o = parsed as Record<string, unknown>;

  if (typeof o.title !== "string" || !o.title.trim()) {
    throw new Error("Triage result is missing a title");
  }
  if (typeof o.symptom !== "string" || !o.symptom.trim()) {
    throw new Error("Triage result is missing a symptom");
  }
  if (typeof o.tier !== "string" || !DEFECT_TIER_VALUES.has(o.tier)) {
    throw new Error(`Invalid tier: ${String(o.tier)}`);
  }
  if (typeof o.severity !== "string" || !SEVERITY_VALUES.has(o.severity)) {
    throw new Error(`Invalid severity: ${String(o.severity)}`);
  }
  if (typeof o.confidence !== "string" || !CONFIDENCE_VALUES.has(o.confidence)) {
    throw new Error(`Invalid confidence: ${String(o.confidence)}`);
  }

  return {
    title: o.title.trim().slice(0, 120),
    tier: o.tier as DefectAnalysis["tier"],
    severity: o.severity as DefectAnalysis["severity"],
    symptom: o.symptom.trim(),
    suspectedCauses: asStringArray(o.suspectedCauses, "suspectedCauses", 5),
    visibleStrings: asStringArray(o.visibleStrings, "visibleStrings", 12),
    suspectedFiles: asStringArray(o.suspectedFiles, "suspectedFiles", 8),
    confidence: o.confidence as DefectAnalysis["confidence"],
    missingInfo: asStringArray(o.missingInfo, "missingInfo", 5),
  };
}

function buildTriageSystemPrompt(project: ProjectConfig): string {
  return `You are triaging a defect in a web application's GUI, reported by the developer who maintains it. You will usually be given one or more screenshots plus a short description.

PROJECT: ${project.name}
STACK: ${project.stack.join(", ")}
DESCRIPTION: ${project.description}

Return ONLY a valid JSON object — no markdown fences, no commentary. Schema:
{
  "title": "string — a specific one-line defect title (max 120 chars)",
  "tier": "state" | "flow" | "visual" | "unknown",
  "severity": "low" | "medium" | "high" | "critical",
  "symptom": "string — 1-2 sentences describing precisely what is wrong, in observable terms",
  "suspectedCauses": ["string", ...],
  "visibleStrings": ["string", ...],
  "suspectedFiles": ["string", ...],
  "confidence": "low" | "medium" | "high",
  "missingInfo": ["string", ...]
}

TIER — this decides how the fix can be proven, so choose carefully:
- "state": wrong data, wrong value, wrong text, stale content, incorrect formatting or
  timezone. Reproducible by a component test asserting on rendered output.
- "flow": an interaction that fails — a button that does nothing, a modal that won't
  close, navigation that loops, a form that can't be submitted. Needs a real browser.
- "visual": layout, overlap, clipping, spacing, colour, responsive breakage. NOT
  reproducible by any assertion — it can only be confirmed by looking.
- "unknown": the evidence genuinely doesn't distinguish these. Prefer this over guessing.

VISIBLE STRINGS — the most important field:
List the exact text you can read in the screenshot: button labels, headings, column
names, error messages, visible values. These are used to grep the repository and locate
the component that rendered this screen. Copy them character-for-character as shown.
Do not paraphrase, translate, or normalise capitalisation. Omit anything you are not
certain you can read. If the text is in Hebrew or another non-English language, copy it
in that language.

SUSPECTED FILES:
Only name a file if the report or the visible strings genuinely imply it. You do not
have the repository. An invented path is worse than an empty list — leave it empty.

CONFIDENCE and MISSING INFO:
A screenshot often isn't enough to locate a cause. If you cannot say what is wrong with
reasonable certainty, set confidence to "low" and put the specific questions you would
need answered in missingInfo (e.g. "which timezone is the server configured for?",
"does this happen on desktop too or only at this width?"). An honest "I need X" is more
useful than a confident guess, and the runner will ask the developer rather than plan
against it.

SEVERITY: judge by user impact — "critical" means data loss, a broken purchase or login
path, or an outage; "low" means cosmetic or rare.`;
}

function buildTriageUserText(report: DefectReportInput): string {
  const lines = [`WHAT HAPPENED: ${report.whatHappened}`];
  if (report.whatExpected) lines.push(`WHAT WAS EXPECTED: ${report.whatExpected}`);
  if (report.reproSteps) lines.push(`STEPS TO REPRODUCE: ${report.reproSteps}`);
  if (report.route) lines.push(`ROUTE: ${report.route}`);
  if (report.viewportWidth && report.viewportHeight) {
    lines.push(`VIEWPORT: ${report.viewportWidth}x${report.viewportHeight}`);
  }
  if (report.userAgent) lines.push(`BROWSER: ${report.userAgent}`);
  if (report.viewportWidth && report.viewportWidth <= 500) {
    lines.push(
      "NOTE: this was reported at a narrow viewport — consider whether the defect is responsive-only.",
    );
  }
  return lines.join("\n");
}

/**
 * Triage a GUI defect from its screenshots and description.
 *
 * Returns structured findings only. Whether it can be auto-fixed at all is
 * decided downstream by the tier and the project's verify contract, not here.
 */
export async function analyzeDefect(
  project: ProjectConfig,
  report: DefectReportInput,
  images: DefectImageInput[],
): Promise<DefectAnalysis> {
  const content: Anthropic.ContentBlockParam[] = images.map((image) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: image.mediaType,
      data: image.base64,
    },
  }));

  // Text after the images: the model reads the evidence, then the claim about it.
  content.push({ type: "text", text: buildTriageUserText(report) });

  const response = await getClient().messages.create({
    model: VISION_MODEL,
    max_tokens: TRIAGE_MAX_TOKENS,
    system: buildTriageSystemPrompt(project),
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Triage was declined for this screenshot");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Triage response was cut off — screenshot may be too complex");
  }

  const parsed = parseJsonResponse(firstTextBlock(response.content));
  return validateDefectAnalysis(parsed);
}

/* =========================================================================
 * G4 — acceptance review.
 *
 * A separate call that grades a diff against the QA plan's own criteria. It is
 * deliberately given the change and the criteria and nothing else: not the
 * plan's reasoning, not the implementer's explanation of what it did, not its
 * own earlier turns. A reviewer that has read the argument for a change is no
 * longer checking the change.
 *
 * It returns a verdict per criterion, never prose, and it is advisory — it can
 * raise a concern but cannot pass a change on its own.
 * ===================================================================== */

const REVIEW_MAX_TOKENS = 8000;
const MAX_DIFF_CHARS = 60_000;
const VERDICT_VALUES = new Set(["met", "not_met", "unclear"]);

export interface CriterionVerdict {
  criterion: string;
  verdict: "met" | "not_met" | "unclear";
  evidence: string;
}

export interface AcceptanceReview {
  verdicts: CriterionVerdict[];
  concerns: string[];
  metCount: number;
  totalCount: number;
}

/**
 * Trim a diff to fit, from the middle.
 *
 * Keeping both ends matters: the head shows what the change starts with and the
 * tail often holds the tests. Cutting only the tail would hide exactly the part
 * a reviewer most wants.
 */
function clampDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  const head = diff.slice(0, Math.floor(MAX_DIFF_CHARS * 0.6));
  const tail = diff.slice(-Math.floor(MAX_DIFF_CHARS * 0.4));
  return `${head}\n\n/* ... diff truncated in the middle ... */\n\n${tail}`;
}

function validateReview(parsed: unknown, criteria: string[]): AcceptanceReview {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Review result is not an object");
  }
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.verdicts)) throw new Error("Review returned no verdicts");

  // Verdicts arrive keyed by the criterion's number, and the text is filled in
  // here from the list that was sent. Asking the reviewer to echo each criterion
  // verbatim was what exhausted the output budget on the first real diff — ten
  // long criteria repeated back, plus evidence for each, hit max_tokens and the
  // whole gate was lost. Matching on that echoed text was also fragile: a
  // single reworded character counted as a different criterion, so the original
  // was reported unaddressed *and* the reworded one kept, inflating the total.
  const byIndex = new Map<number, CriterionVerdict["verdict"]>();
  const evidenceByIndex = new Map<number, string>();
  for (const raw of o.verdicts) {
    if (typeof raw !== "object" || raw === null) continue;
    const v = raw as Record<string, unknown>;
    const index = typeof v.index === "number" ? Math.trunc(v.index) : NaN;
    if (!Number.isInteger(index) || index < 1 || index > criteria.length) continue;
    if (typeof v.verdict !== "string" || !VERDICT_VALUES.has(v.verdict)) continue;
    byIndex.set(index, v.verdict as CriterionVerdict["verdict"]);
    evidenceByIndex.set(
      index,
      typeof v.evidence === "string" ? v.evidence.slice(0, 600) : "",
    );
  }

  if (byIndex.size === 0) {
    throw new Error("Review returned no usable verdicts");
  }

  // One entry per criterion, always, in the order they were given. A criterion
  // the reviewer skipped is not a criterion that passed.
  const verdicts: CriterionVerdict[] = criteria.map((criterion, i) => {
    const index = i + 1;
    const verdict = byIndex.get(index);
    return verdict
      ? { criterion: criterion.slice(0, 300), verdict, evidence: evidenceByIndex.get(index) ?? "" }
      : {
          criterion: criterion.slice(0, 300),
          verdict: "unclear" as const,
          evidence: "The reviewer did not address this criterion.",
        };
  });

  return {
    verdicts,
    concerns: asStringArray(o.concerns, "concerns", 6),
    metCount: verdicts.filter((v) => v.verdict === "met").length,
    totalCount: verdicts.length,
  };
}

export async function reviewAcceptance(input: {
  project: ProjectConfig;
  stepTitle: string;
  criteria: string[];
  diff: string;
  /**
   * Which step of the plan this is. The criteria are the QA plan's for the whole
   * plan, not for one step — nothing in the plan records which criterion belongs
   * where — so a reviewer told only "judge these ten" marks the ones describing
   * later steps as not met, and the headline count stops meaning anything. On the
   * first real run that produced "0 of 10" for a change that had done its own
   * step correctly.
   */
  stepIndex: number;
  stepCount: number;
}): Promise<AcceptanceReview> {
  const { project, stepTitle, criteria, diff, stepIndex, stepCount } = input;

  if (criteria.length === 0) {
    throw new Error("No acceptance criteria to review against");
  }

  const system = `You are reviewing a code change against a fixed list of acceptance criteria. You did not write this change and you have not seen the reasoning behind it. Judge only what the diff shows.

PROJECT: ${project.name}
STACK: ${project.stack.join(", ")}

Return ONLY a valid JSON object — no markdown fences, no commentary. Schema:
{
  "verdicts": [
    {
      "index": number — the criterion's number from the list below, exactly as numbered,
      "verdict": "met" | "not_met" | "unclear",
      "evidence": "string — cite the specific hunk, file, or line that justifies the verdict"
    }
  ],
  "concerns": ["string", ...]
}

RULES:
- Return one entry for EVERY criterion given, in the order given, identified by its number. Do not merge or split them, and do not echo the criterion text back — the number is enough.
- "met" requires evidence visible in the diff. A change that looks like it was probably done is "unclear", not "met".
- "not_met" means the diff contradicts the criterion, or omits something this step was supposed to contain.
- The criteria cover the WHOLE plan, not only this step. A criterion describing work that belongs to a different step is "unclear" — say which step you think it belongs to. Do not mark it "not_met": this change was never meant to satisfy it.
- A criterion written as a manual procedure ("run X and verify Y") cannot be settled by reading a diff. Judge whether the code the procedure would exercise is present and plausible, and answer "unclear" when that is as far as the diff takes you.
- "unclear" means the diff neither shows nor contradicts it — for example a runtime behaviour no static reading can settle. Prefer "unclear" over an optimistic "met"; a wrong "met" is the one mistake here that actually costs something.
- Evidence must point at the change. Do not restate the criterion back as its own evidence.
- "concerns" is for problems you noticed that no criterion covers: regressions, unhandled errors, security issues, secrets, debug code left behind. Leave it empty if there are none. Do not use it for style preferences.
- Respond in English.`;

  const criteriaBlock = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const userMessage = `CHANGE UNDER REVIEW: ${stepTitle}
THIS IS STEP ${stepIndex} OF ${stepCount} in the plan. Later steps are not in this diff and were never meant to be.

ACCEPTANCE CRITERIA:
${criteriaBlock}

DIFF:
${clampDiff(diff)}`;

  const response = await getClient().messages.create({
    model: VISION_MODEL,
    max_tokens: REVIEW_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("Acceptance review was cut off — the diff may be too large to review");
  }

  const parsed = parseJsonResponse(firstTextBlock(response.content));
  return validateReview(parsed, criteria);
}
