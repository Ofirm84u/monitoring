"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface ArticleSummary {
  tldr: string;
  keyIdeas: string[];
}

interface ArticleSuggestion {
  projectId: string;
  projectName: string;
  relevance: "high" | "medium" | "low";
  howToUse: string;
}

interface Article {
  id: string;
  createdAt: string;
  source: { kind: "url" | "text" | "pdf"; url?: string; filename?: string };
  title: string;
  summary: ArticleSummary | null;
  tags: string[];
  status: string;
  assignment: {
    kind: "project" | "standalone";
    projectId: string | null;
    assignedAt: string;
  } | null;
  gapAnalysis?: {
    projectId: string;
    text: string;
    generatedAt: string;
  } | null;
}

interface ProjectMeta {
  id: string;
  name: string;
  description?: string;
}

export default function ProjectPlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [articles, setArticles] = useState<Article[]>([]);
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [planText, setPlanText] = useState<string | null>(null);
  const [planGeneratedAt, setPlanGeneratedAt] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchArticlesAndProject = useCallback(async () => {
    try {
      setLoading(true);
      const [articlesRes, projectsRes] = await Promise.all([
        fetch("/api/articles"),
        fetch("/api/projects/list"),
      ]);
      if (articlesRes.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!articlesRes.ok) throw new Error(`Articles HTTP ${articlesRes.status}`);
      if (!projectsRes.ok) throw new Error(`Projects HTTP ${projectsRes.status}`);
      const articlesJson = await articlesRes.json();
      const projectsJson = await projectsRes.json();
      const all = (articlesJson.articles ?? []) as Article[];
      setArticles(
        all.filter(
          (a) =>
            a.assignment?.kind === "project" &&
            a.assignment.projectId === id,
        ),
      );
      const proj = ((projectsJson.projects ?? []) as ProjectMeta[]).find(
        (p) => p.id === id,
      );
      setProject(proj ?? { id, name: id });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchArticlesAndProject();
  }, [fetchArticlesAndProject]);

  const generatePlan = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/projects/${id}/plan`, { method: "POST" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const j = await res.json();
      setPlanText(j.plan);
      setPlanGeneratedAt(j.generatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan generation failed");
    } finally {
      setGenerating(false);
    }
  }, [id]);

  const copyPlan = useCallback(async () => {
    if (!planText) return;
    try {
      await navigator.clipboard.writeText(planText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select text via prompt
      alert("Copy failed — select the plan text manually.");
    }
  }, [planText]);

  const downloadPlan = useCallback(() => {
    if (!planText || !project) return;
    const blob = new Blob([planText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.id}-plan-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [planText, project]);

  const articlesWithGap = useMemo(
    () => articles.filter((a) => a.gapAnalysis?.text),
    [articles],
  );

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">
              {project?.name ?? id}
            </h1>
            <p className="text-xs text-slate-400">Project implementation plan</p>
          </div>
        </div>
        <Link
          href="/articles"
          className="text-sm text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to articles
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Stats + action */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
              Source articles
            </p>
            <p className="text-2xl font-bold text-slate-800">
              {loading ? "..." : articles.length}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {articlesWithGap.length} with gap analysis
            </p>
          </div>
          <button
            onClick={generatePlan}
            disabled={generating || articles.length === 0}
            className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {generating && (
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {generating
              ? "Synthesizing plan..."
              : planText
                ? "🔄 Regenerate plan"
                : "✨ Generate implementation plan"}
          </button>
        </div>
      </div>

      {/* Article list (concise) */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3 text-sm">
          Source articles ({articles.length})
        </h2>
        {articles.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            No articles assigned to this project yet. Submit one from{" "}
            <Link href="/articles" className="text-indigo-600 hover:underline">
              Articles
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-1.5">
            {articles.map((a, i) => (
              <li
                key={a.id}
                className="flex items-start gap-2 text-sm text-slate-700"
              >
                <span className="text-slate-400 font-mono text-xs mt-0.5 shrink-0">
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.title}</p>
                  <p className="text-[10px] text-slate-400">
                    {a.source.kind === "url" && a.source.url
                      ? new URL(a.source.url).host
                      : a.source.kind}{" "}
                    · {new Date(a.createdAt).toLocaleDateString()}
                    {a.gapAnalysis ? " · ✓ gap analysis" : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Plan output */}
      {planText && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold text-slate-800 text-sm">
                Implementation plan
              </h2>
              {planGeneratedAt && (
                <p className="text-[10px] text-slate-400">
                  Generated {new Date(planGeneratedAt).toLocaleString()}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={copyPlan}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  copied
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    : "bg-indigo-600 text-white hover:bg-indigo-700"
                }`}
              >
                {copied ? "✓ Copied" : "📋 Copy"}
              </button>
              <button
                onClick={downloadPlan}
                className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-200 transition-colors flex items-center gap-1.5"
              >
                ⬇ Download .md
              </button>
            </div>
          </div>
          <pre
            dir="rtl"
            className="text-sm text-slate-800 bg-slate-50 border border-slate-100 rounded-xl p-4 whitespace-pre-wrap font-sans leading-relaxed max-h-[60vh] overflow-y-auto"
          >
            {planText}
          </pre>
          <div className="mt-3 p-3 bg-indigo-50 border border-indigo-100 rounded-lg text-xs text-indigo-800">
            <strong>Next step:</strong> Copy the plan, open Claude Code in the{" "}
            <code className="bg-indigo-100 px-1 rounded">{project?.id}</code>{" "}
            project directory, and paste it. The bottom section contains a
            ready-to-use prompt.
          </div>
        </div>
      )}
    </div>
  );
}
