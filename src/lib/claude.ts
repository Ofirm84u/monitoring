import Anthropic from "@anthropic-ai/sdk";
import { PROJECTS, type ProjectConfig } from "./projects";
import type { ArticleSuggestion, ArticleSummary } from "./articles";

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

export async function analyzeGap(
  project: ProjectConfig,
  articleTitle: string,
  articleText: string,
): Promise<string> {
  const system = `You are advising a solo developer/founder on how to apply ideas from an article to one of their projects.

PROJECT IN FOCUS:
- name: ${project.name}
- description: ${project.description}
- stack: ${project.stack.join(", ")}

OUTPUT REQUIREMENTS:
- Respond in English.
- Plain text only (no markdown fences, no JSON).
- Keep it under ~400 words.
- Use the following structure with these exact section headers:

## What's the gap
2-4 bullets describing what this project is likely missing or could improve, based on the article's ideas.

## Concrete next steps
3-5 actionable bullets — specific, scoped tasks the developer could do this week or next sprint.

## Risks / caveats
1-3 bullets — what could go wrong, what to verify first, or where the article's advice doesn't quite fit this stack.`;

  const userMessage = `ARTICLE TITLE: ${articleTitle}

ARTICLE TEXT:
${articleText}`;

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1200,
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
