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
): Promise<ArticlePlan> {
  const codeBlock = codeContext
    ? `\nPROJECT CODE (excerpt — cite exact functions/lines if present, never invent):\n${codeContext}\n`
    : "";

  const keyIdeas = article.summary?.keyIdeas.map((k) => `  - ${k}`).join("\n") ?? "";
  const gapBlock = article.gapAnalysis?.text
    ? `\nGAP ANALYSIS:\n${article.gapAnalysis.text}`
    : "";
  const source = article.source.url ? `URL: ${article.source.url}` : `Source: ${article.source.kind}`;
  const lang = codeLanguage(project.stack);

  const system = `You are writing a complete, executable implementation plan for a single article's contribution to a project. The plan is pasted directly into Claude Code — it must be 100% complete, never truncated.

PROJECT: ${project.name}
STACK: ${project.stack.join(", ")}
DESCRIPTION: ${project.description}${codeBlock}

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
\`\`\``;

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
✅ [משפט אחד — מתי ה-QA עובר]`;

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
