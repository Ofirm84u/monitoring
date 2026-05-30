import { readFile, writeFile, rename } from "fs/promises";
import { randomBytes } from "crypto";

const ARTICLES_FILE = process.env.ARTICLES_FILE ?? "/home/ofir/monitor/articles.json";

export type ArticleStatus = "processing" | "pending_assignment" | "assigned" | "error";
export type ArticleSourceKind = "url" | "text" | "pdf";
export type AssignmentKind = "project" | "standalone";

export interface ArticleSuggestion {
  projectId: string;
  projectName: string;
  relevance: "high" | "medium" | "low";
  howToUse: string;
}

export interface ArticleSummary {
  tldr: string;
  keyIdeas: string[];
}

export interface ArticleAssignment {
  kind: AssignmentKind;
  projectId: string | null;
  assignedAt: string;
}

export interface ArticleSource {
  kind: ArticleSourceKind;
  url?: string;
  filename?: string;
}

export interface Article {
  id: string;
  createdAt: string;
  source: ArticleSource;
  title: string;
  rawTextSnippet: string;
  fullText?: string;
  summary: ArticleSummary | null;
  suggestions: ArticleSuggestion[];
  tags: string[];
  status: ArticleStatus;
  assignment: ArticleAssignment | null;
  gapAnalysis?: {
    projectId: string;
    text: string;
    generatedAt: string;
  } | null;
  implementationPlan?: {
    projectId: string;
    generatedAt: string;
  } | null;
  error?: string;
}

interface ArticlesStore {
  articles: Article[];
}

export function newArticleId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function readStore(): Promise<ArticlesStore> {
  try {
    const raw = await readFile(ARTICLES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ArticlesStore;
    if (!parsed.articles || !Array.isArray(parsed.articles)) {
      return { articles: [] };
    }
    return parsed;
  } catch {
    return { articles: [] };
  }
}

async function writeStore(store: ArticlesStore): Promise<void> {
  const tmp = `${ARTICLES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await rename(tmp, ARTICLES_FILE);
}

export async function listArticles(): Promise<Article[]> {
  const store = await readStore();
  return [...store.articles].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function getArticle(id: string): Promise<Article | null> {
  const store = await readStore();
  return store.articles.find((a) => a.id === id) ?? null;
}

export async function createArticle(article: Article): Promise<Article> {
  const store = await readStore();
  store.articles.push(article);
  await writeStore(store);
  return article;
}

export async function updateArticle(
  id: string,
  patch: Partial<Article>,
): Promise<Article | null> {
  const store = await readStore();
  const idx = store.articles.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  store.articles[idx] = { ...store.articles[idx], ...patch };
  await writeStore(store);
  return store.articles[idx];
}

export async function assignArticle(
  id: string,
  projectId: string | null,
): Promise<Article | null> {
  return updateArticle(id, {
    status: "assigned",
    assignment: {
      kind: projectId === null ? "standalone" : "project",
      projectId,
      assignedAt: new Date().toISOString(),
    },
  });
}

export async function deleteArticle(id: string): Promise<boolean> {
  const store = await readStore();
  const before = store.articles.length;
  store.articles = store.articles.filter((a) => a.id !== id);
  if (store.articles.length === before) return false;
  await writeStore(store);
  return true;
}
