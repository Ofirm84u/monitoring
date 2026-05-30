"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface ArticleSummary { tldr: string; keyIdeas: string[] }
interface Article {
  id: string;
  createdAt: string;
  source: { kind: "url" | "text" | "pdf"; url?: string };
  title: string;
  summary: ArticleSummary | null;
  tags: string[];
  status: string;
  assignment: { kind: "project" | "standalone"; projectId: string | null; assignedAt: string } | null;
  gapAnalysis?: { projectId: string; text: string; generatedAt: string } | null;
}
interface ProjectMeta { id: string; name: string; description?: string }
interface ArticlePlanResult {
  articleIndex: number;
  articleTitle: string;
  implementationPlan: string;
  qaPlan: string;
  outputTokensUsed: number;
}

type PlanTab = "impl" | "qa";

export default function ProjectPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [articles, setArticles] = useState<Article[]>([]);
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<ArticlePlanResult[]>([]);
  const [totalArticles, setTotalArticles] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextStartIndex, setNextStartIndex] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<number, PlanTab>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const fetchArticlesAndProject = useCallback(async () => {
    try {
      setLoading(true);
      const [articlesRes, projectsRes] = await Promise.all([
        fetch("/api/articles"),
        fetch("/api/projects/list"),
      ]);
      if (articlesRes.status === 401) { window.location.href = "/login"; return; }
      if (!articlesRes.ok) throw new Error(`Articles HTTP ${articlesRes.status}`);
      if (!projectsRes.ok) throw new Error(`Projects HTTP ${projectsRes.status}`);
      const articlesJson = await articlesRes.json();
      const projectsJson = await projectsRes.json();
      const all = (articlesJson.articles ?? []) as Article[];
      setArticles(all.filter((a) => a.assignment?.kind === "project" && a.assignment.projectId === id));
      const proj = ((projectsJson.projects ?? []) as ProjectMeta[]).find((p) => p.id === id);
      setProject(proj ?? { id, name: id });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchArticlesAndProject(); }, [fetchArticlesAndProject]);

  const [currentlyGenerating, setCurrentlyGenerating] = useState<number | null>(null);

  // Calls the API once per article and appends results one by one as they arrive.
  const runPhase = useCallback(async (startIndex: number, append: boolean) => {
    setGenerating(true);
    setError(null);
    if (!append) setPlans([]);

    let idx = startIndex;
    let total = 0;

    try {
      while (true) {
        setCurrentlyGenerating(idx);
        const res = await fetch(`/api/projects/${id}/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startIndex: idx }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => null) as { error?: string } | null;
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        const j = await res.json() as {
          plan: ArticlePlanResult;
          totalArticles: number;
          hasMore: boolean;
          nextStartIndex: number | null;
          generatedAt: string;
        };

        total = j.totalArticles;
        setTotalArticles(j.totalArticles);
        setGeneratedAt(j.generatedAt);
        setPlans((prev) => [...prev, j.plan]);

        if (!j.hasMore || j.nextStartIndex === null) {
          setHasMore(false);
          setNextStartIndex(null);
          break;
        }

        // Check token budget: stop and ask permission if we've done 4+ articles in this phase
        const doneInPhase = idx - startIndex + 1;
        if (doneInPhase >= 4) {
          setHasMore(true);
          setNextStartIndex(j.nextStartIndex);
          break;
        }

        idx = j.nextStartIndex;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan generation failed");
    } finally {
      setGenerating(false);
      setCurrentlyGenerating(null);
    }
    void total;
  }, [id]);

  const tabFor = (idx: number): PlanTab => activeTab[idx] ?? "impl";

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch { alert("Copy failed — select text manually."); }
  }, []);

  const downloadAll = useCallback((type: PlanTab) => {
    if (plans.length === 0 || !project) return;
    const combined = plans.map((p) =>
      type === "impl" ? p.implementationPlan : p.qaPlan
    ).join("\n\n---\n\n");
    const label = type === "impl" ? "implementation" : "qa";
    const blob = new Blob([combined], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.id}-${label}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [plans, project]);

  const articlesWithGap = useMemo(() => articles.filter((a) => a.gapAnalysis?.text), [articles]);
  const phaseLabel = plans.length > 0
    ? `Articles ${plans[0].articleIndex + 1}–${plans[plans.length - 1].articleIndex + 1} of ${totalArticles}`
    : null;

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
            <h1 className="text-xl font-bold text-slate-800">{project?.name ?? id}</h1>
            <p className="text-xs text-slate-400">Project implementation plan</p>
          </div>
        </div>
        <Link href="/articles" className="text-sm text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to articles
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
      )}

      {/* Stats + action */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Source articles</p>
            <p className="text-2xl font-bold text-slate-800">{loading ? "..." : articles.length}</p>
            <p className="text-xs text-slate-500 mt-1">{articlesWithGap.length} with gap analysis</p>
          </div>
          <button
            onClick={() => { setPlans([]); runPhase(0, false); }}
            disabled={generating || articles.length === 0}
            className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {generating && <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
            {generating
              ? `Generating article ${(currentlyGenerating ?? 0) + 1} of ${totalArticles || articles.length}...`
              : plans.length > 0 ? "🔄 Restart from Phase 1" : "✨ Generate plans"}
          </button>
        </div>
      </div>

      {/* Article list */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <h2 className="font-semibold text-slate-800 mb-3 text-sm">Source articles ({articles.length})</h2>
        {articles.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No articles assigned yet. <Link href="/articles" className="text-indigo-600 hover:underline">Add from Articles</Link>.</p>
        ) : (
          <ul className="space-y-1.5">
            {articles.map((a, i) => {
              const isDone = plans.some((p) => p.articleIndex === i);
              return (
                <li key={a.id} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className={`font-mono text-xs mt-0.5 shrink-0 ${isDone ? "text-emerald-500" : currentlyGenerating === i ? "text-indigo-500" : "text-slate-400"}`}>
                    {isDone ? "✓" : currentlyGenerating === i ? "⟳" : `${i + 1}.`}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{a.title}</p>
                    <p className="text-[10px] text-slate-400">
                      {a.source.kind === "url" && a.source.url ? new URL(a.source.url).host : a.source.kind}
                      {" · "}{new Date(a.createdAt).toLocaleDateString()}
                      {a.gapAnalysis ? " · ✓ gap analysis" : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Phase plans */}
      {plans.length > 0 && (
        <div className="space-y-4">
          {/* Phase header */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="font-semibold text-slate-800">
                Phase {Math.ceil((plans[0].articleIndex + 1) / Math.max(plans.length, 1))} complete
                {phaseLabel && <span className="ml-2 text-xs font-normal text-slate-400">({phaseLabel})</span>}
              </h2>
              {generatedAt && <p className="text-[10px] text-slate-400">Generated {new Date(generatedAt).toLocaleString()}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => downloadAll("impl")} className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-200 transition-colors">⬇ All implementation .md</button>
              <button onClick={() => downloadAll("qa")} className="px-3 py-1.5 bg-violet-50 text-violet-700 rounded-lg text-xs font-medium hover:bg-violet-100 transition-colors border border-violet-200">⬇ All QA .md</button>
            </div>
          </div>

          {/* Per-article plan cards */}
          {plans.map((plan) => (
            <div key={plan.articleIndex} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              {/* Card header */}
              <div className="px-5 pt-4 pb-3 border-b border-slate-100">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Article {plan.articleIndex + 1}</p>
                    <h3 className="text-sm font-semibold text-slate-800 leading-snug">{plan.articleTitle}</h3>
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-400 mt-1">{plan.outputTokensUsed.toLocaleString()} tokens</span>
                </div>
                {/* Tabs */}
                <div className="flex gap-1 mt-3">
                  <button
                    onClick={() => setActiveTab((t) => ({ ...t, [plan.articleIndex]: "impl" }))}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${tabFor(plan.articleIndex) === "impl" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  >
                    ⚙ Implementation
                  </button>
                  <button
                    onClick={() => setActiveTab((t) => ({ ...t, [plan.articleIndex]: "qa" }))}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${tabFor(plan.articleIndex) === "qa" ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  >
                    🧪 QA Plan
                  </button>
                  <div className="flex-1" />
                  <button
                    onClick={() => copy(
                      tabFor(plan.articleIndex) === "impl" ? plan.implementationPlan : plan.qaPlan,
                      `${plan.articleIndex}-${tabFor(plan.articleIndex)}`
                    )}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${copiedKey === `${plan.articleIndex}-${tabFor(plan.articleIndex)}` ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"}`}
                  >
                    {copiedKey === `${plan.articleIndex}-${tabFor(plan.articleIndex)}` ? "✓ Copied" : "📋 Copy"}
                  </button>
                </div>
              </div>

              {/* Plan content */}
              <div className={`px-5 py-4 ${tabFor(plan.articleIndex) === "qa" ? "bg-violet-50/30" : ""}`}>
                {tabFor(plan.articleIndex) === "impl" ? (
                  <>
                    <p className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide mb-2">Implementation Plan</p>
                    <pre dir="rtl" className="text-sm text-slate-800 bg-slate-50 border border-slate-100 rounded-xl p-4 whitespace-pre-wrap font-sans leading-relaxed max-h-[55vh] overflow-y-auto">
                      {plan.implementationPlan}
                    </pre>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] font-semibold text-violet-500 uppercase tracking-wide mb-2">QA Plan — for QA agent</p>
                    <pre dir="rtl" className="text-sm text-slate-800 bg-violet-50 border border-violet-100 rounded-xl p-4 whitespace-pre-wrap font-sans leading-relaxed max-h-[55vh] overflow-y-auto">
                      {plan.qaPlan}
                    </pre>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Continue / done banner */}
          {hasMore && nextStartIndex !== null ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <p className="text-sm font-semibold text-amber-800">Phase complete — token budget used</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    {totalArticles - nextStartIndex} article{totalArticles - nextStartIndex !== 1 ? "s" : ""} remaining (articles {nextStartIndex + 1}–{totalArticles}).
                    Ready to continue when you are.
                  </p>
                </div>
                <button
                  onClick={() => runPhase(nextStartIndex, true)}
                  disabled={generating}
                  className="px-4 py-2.5 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {generating && <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
                  ▶ Continue — Phase {Math.ceil(nextStartIndex / Math.max(plans.length, 1)) + 1}
                </button>
              </div>
            </div>
          ) : plans.length > 0 && !generating && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-sm text-emerald-800">
              ✅ All {totalArticles} articles processed. Download the .md files above and open Claude Code in the <code className="bg-emerald-100 px-1 rounded">{project?.id}</code> directory.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
