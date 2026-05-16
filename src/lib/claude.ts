import Anthropic from "@anthropic-ai/sdk";
import { PROJECTS, type ProjectConfig } from "./projects";
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

export async function synthesizeProjectPlan(
  project: ProjectConfig,
  articles: Article[],
  codeContext?: string | null,
): Promise<string> {
  if (articles.length === 0) {
    throw new Error("No articles assigned to this project yet");
  }

  const articleBlocks = articles
    .map((a, i) => {
      const summary = a.summary
        ? `TL;DR: ${a.summary.tldr}\nKey ideas:\n${a.summary.keyIdeas.map((k) => `  - ${k}`).join("\n")}`
        : "";
      const gap = a.gapAnalysis?.text
        ? `\nGap analysis:\n${a.gapAnalysis.text}`
        : "";
      const source = a.source.url ? `URL: ${a.source.url}` : `Source: ${a.source.kind}`;
      return `--- Article ${i + 1}: ${a.title} ---\n${source}\n${summary}${gap}`;
    })
    .join("\n\n");

  const codeBlock = codeContext
    ? `\n\nPROJECT CODE (excerpt — cite specific functions/locations when relevant):\n${codeContext}\n`
    : "";

  const system = `You are consolidating multiple article-driven suggestions into a single, prioritised implementation plan for a project. The plan must be concrete enough to paste into Claude Code and execute.

PROJECT IN FOCUS:
- name: ${project.name}
- description: ${project.description}
- stack: ${project.stack.join(", ")}${codeBlock}

OUTPUT REQUIREMENTS:
- Respond in HEBREW (RTL). Use Hebrew for narrative, English for code identifiers/keywords.
- Use Markdown formatting (headings, bold, tables, code fences).
- Deduplicate and MERGE overlapping suggestions across articles — don't list the same idea twice.
- Cite source article numbers in parentheses, e.g. "(מאמר 1, 3)".
- Reference specific functions/files/line numbers ONLY if the PROJECT CODE excerpt contains them — never invent.
- Length: 600–1200 words.
- End with a copy-pasteable Claude Code prompt block.
- Follow this exact structure:

# תכנית יישום — ${project.name}

## סיכום
משפט-שניים על מה ההצעות מציעות במצטבר ולמה זה רלוונטי לפרויקט.

## עדיפות גבוהה (יישום ראשון — השבוע)
### 1. [כותרת ההצעה]
**מקור:** (מאמר 1, 3)
**מה:** משפט-שניים.
**איפה / איך:** מיקום בקוד (אם ידוע מהקטע למעלה — לצטט בדיוק).
\`\`\`${project.stack.includes("Python") ? "python" : "typescript"}
// example code — 5-15 שורות
\`\`\`
**תועלת:** ...

### 2. [...]
[אותו פורמט]

## עדיפות בינונית (Sprint הבא)
### 3. [...]

## עדיפות נמוכה (חקירה / nice-to-have)
### 4. [...]

## טבלת סיכום
| # | הצעה | מקור | מורכבות | ערך |
|---|------|------|---------|-----|
| 1 | ... | מאמר X | נמוכה/בינונית/גבוהה | נמוך/בינוני/גבוה |

## פרומפט מוכן ל-Claude Code (למעבר לפרויקט ${project.name})
\`\`\`
אני עובד על פרויקט ${project.name} (${project.stack.join(", ")}). יש לי תכנית עבודה שאני רוצה ליישם בעדיפות:

[להעתיק לכאן את ההצעות בעדיפות גבוהה כפי שמופיעות למעלה, כולל קטעי הקוד]

תתחיל מהצעה 1: [כותרת]. תקרא את הקוד הרלוונטי, תציג לי diff לפני שאתה משנה.
\`\`\``;

  const userMessage = `Source articles (in chronological order, newest last):

${articleBlocks}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response shape from Claude");
  }
  return block.text.trim();
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
