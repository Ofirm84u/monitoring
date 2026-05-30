"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type SourceKind = "url" | "text" | "pdf";
type Status = "processing" | "pending_assignment" | "assigned" | "error";
type Relevance = "high" | "medium" | "low";
type AssignmentKind = "project" | "standalone";

interface Suggestion {
  projectId: string;
  projectName: string;
  relevance: Relevance;
  howToUse: string;
}

interface Article {
  id: string;
  createdAt: string;
  source: { kind: SourceKind; url?: string; filename?: string };
  title: string;
  rawTextSnippet: string;
  summary: { tldr: string; keyIdeas: string[] } | null;
  suggestions: Suggestion[];
  tags: string[];
  status: Status;
  assignment: {
    kind: AssignmentKind;
    projectId: string | null;
    assignedAt: string;
  } | null;
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

interface ProjectOption {
  id: string;
  name: string;
}

const RELEVANCE_COLOR: Record<Relevance, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-slate-50 text-slate-600 border-slate-200",
};

function formatTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ArticlesPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [tab, setTab] = useState<SourceKind>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reassignId, setReassignId] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [gapAnalysisId, setGapAnalysisId] = useState<string | null>(null);

  const projectsById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const fetchArticles = useCallback(async () => {
    try {
      setListLoading(true);
      const res = await fetch("/api/articles");
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setArticles(json.articles ?? []);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setListLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) return;
      const json = await res.json();
      setProjects(
        ((json.projects ?? []) as Array<{ id: string; name: string }>).map(
          (p) => ({ id: p.id, name: p.name }),
        ),
      );
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    fetchArticles();
    fetchProjects();
  }, [fetchArticles, fetchProjects]);

  const submit = useCallback(async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { kind: tab };
      if (tab === "url") {
        if (!url.trim()) throw new Error("Enter a URL");
        body.url = url.trim();
      } else if (tab === "text") {
        if (text.trim().length < 50) {
          throw new Error("Text must be at least 50 characters");
        }
        body.text = text;
      } else {
        if (!pdfFile) throw new Error("Pick a PDF file");
        body.pdfBase64 = await fileToBase64(pdfFile);
        body.filename = pdfFile.name;
      }
      const res = await fetch("/api/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      setUrl("");
      setText("");
      setPdfFile(null);
      await fetchArticles();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }, [tab, url, text, pdfFile, fetchArticles]);

  const assign = useCallback(
    async (id: string, kind: AssignmentKind, projectId: string | null) => {
      setAssigningId(id);
      try {
        const res = await fetch(`/api/articles/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignment: { kind, projectId: kind === "project" ? projectId : null },
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        setReassignId(null);
        await fetchArticles();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Assignment failed");
      } finally {
        setAssigningId(null);
      }
    },
    [fetchArticles],
  );

  const runGapAnalysis = useCallback(
    async (id: string) => {
      setGapAnalysisId(id);
      try {
        const res = await fetch(`/api/articles/${id}/gap-analysis`, {
          method: "POST",
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        await fetchArticles();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Gap analysis failed");
      } finally {
        setGapAnalysisId(null);
      }
    },
    [fetchArticles],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Delete this article from the log?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/articles/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchArticles();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    },
    [fetchArticles],
  );

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Articles</h1>
            <p className="text-xs text-slate-400">Summarize + suggest project relevance</p>
          </div>
        </div>
        <Link
          href="/"
          className="text-sm text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to dashboard
        </Link>
      </div>

      {/* Submit form */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <div className="flex gap-2 mb-4 border-b border-slate-100">
          {(["url", "text", "pdf"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === k
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {k === "url" ? "URL" : k === "text" ? "Paste text" : "PDF upload"}
            </button>
          ))}
        </div>

        {tab === "url" && (
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            disabled={submitting}
          />
        )}
        {tab === "text" && (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder="Paste article text..."
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
            disabled={submitting}
          />
        )}
        {tab === "pdf" && (
          <div>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
              className="text-sm text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 file:font-medium hover:file:bg-indigo-100"
              disabled={submitting}
            />
            {pdfFile && (
              <p className="text-xs text-slate-500 mt-1.5">
                {pdfFile.name} ({Math.round(pdfFile.size / 1024)} KB)
              </p>
            )}
          </div>
        )}

        {submitError && (
          <div className="mt-3 p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs">
            {submitError}
          </div>
        )}

        <button
          onClick={submit}
          disabled={submitting}
          className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {submitting && (
            <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
          {submitting ? "Analyzing..." : "Summarize"}
        </button>
      </div>

      {/* List */}
      {listError && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
          {listError}
        </div>
      )}

      {listLoading && articles.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">Loading...</div>
      ) : articles.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm bg-white rounded-2xl border border-dashed border-slate-200">
          No articles yet. Submit one above.
        </div>
      ) : (
        <div className="space-y-3">
          {articles.map((article) => {
            const isExpanded = expandedId === article.id;
            const isReassigning = reassignId === article.id;
            const showAssignmentUi =
              article.status === "pending_assignment" || isReassigning;
            const isAssigning = assigningId === article.id;
            const isDeleting = deletingId === article.id;
            const suggestedIds = new Set(article.suggestions.map((s) => s.projectId));
            const otherProjects = projects.filter((p) => !suggestedIds.has(p.id));
            const assignedName =
              article.assignment?.kind === "project" && article.assignment.projectId
                ? (projectsById.get(article.assignment.projectId) ?? article.assignment.projectId)
                : null;

            return (
              <div
                key={article.id}
                className={`rounded-2xl border shadow-sm p-4 transition-colors ${
                  showAssignmentUi
                    ? "bg-amber-50/40 border-amber-200"
                    : "bg-white border-slate-200"
                }`}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        {article.source.kind}
                      </span>
                      {article.source.url && (
                        <a
                          href={article.source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-indigo-600 hover:underline truncate"
                        >
                          {new URL(article.source.url).host}
                        </a>
                      )}
                      <span className="text-[10px] text-slate-400">
                        · {formatTimeAgo(article.createdAt)}
                      </span>
                    </div>
                    <h3 className="font-semibold text-slate-800 text-base leading-snug">
                      {article.title}
                    </h3>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {article.status === "pending_assignment" ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                        NEEDS ASSIGNMENT
                      </span>
                    ) : article.assignment?.kind === "standalone" ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
                        STANDALONE
                      </span>
                    ) : assignedName && article.assignment?.projectId ? (
                      <Link
                        href={`/projects/${article.assignment.projectId}`}
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
                        title="Open project plan"
                      >
                        → {assignedName.toUpperCase()}
                      </Link>
                    ) : null}
                    <button
                      onClick={() => remove(article.id)}
                      disabled={isDeleting}
                      className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      title="Delete"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Summary */}
                {article.summary && (
                  <p className="text-sm text-slate-700 mb-2 leading-relaxed">
                    {article.summary.tldr}
                  </p>
                )}

                {/* Tags */}
                {article.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {article.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600"
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                )}

                {/* Implementation plan badge */}
                {article.implementationPlan?.projectId && (
                  <div className="mt-2 mb-1">
                    <Link
                      href={`/projects/${article.implementationPlan.projectId}`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-semibold hover:bg-emerald-100 transition-colors"
                      title={`Implementation plan generated ${new Date(article.implementationPlan.generatedAt).toLocaleString()}`}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Implementation plan ready
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                    </Link>
                  </div>
                )}

                {/* Expand toggle */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : article.id)}
                  className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  {isExpanded ? "Hide details" : "Show key ideas + suggestions"}
                </button>

                {isExpanded && (
                  <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                    {/* Key ideas */}
                    {article.summary?.keyIdeas && article.summary.keyIdeas.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                          Key Ideas
                        </p>
                        <ul className="space-y-1">
                          {article.summary.keyIdeas.map((idea, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                              <span className="text-indigo-400 mt-0.5 shrink-0">›</span>
                              <span>{idea}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* AI suggestions */}
                    {article.suggestions.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                          AI Suggestions
                        </p>
                        <div className="space-y-2">
                          {article.suggestions.map((s) => (
                            <div
                              key={s.projectId}
                              className={`rounded-lg border p-2.5 ${RELEVANCE_COLOR[s.relevance]}`}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-semibold text-sm">{s.projectName}</span>
                                <span className="text-[10px] font-mono uppercase">
                                  {s.relevance}
                                </span>
                              </div>
                              <p className="text-xs leading-relaxed">{s.howToUse}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {article.suggestions.length === 0 && (
                      <p className="text-xs text-slate-400 italic">
                        No clear project match from AI.
                      </p>
                    )}
                  </div>
                )}

                {/* Assignment controls */}
                {showAssignmentUi && (
                  <div className="mt-3 border-t border-amber-200 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-slate-700">
                        Assign to project:
                      </p>
                      {isReassigning && (
                        <button
                          onClick={() => setReassignId(null)}
                          className="text-[10px] text-slate-400 hover:text-slate-600"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {article.suggestions.map((s) => (
                        <button
                          key={s.projectId}
                          onClick={() => assign(article.id, "project", s.projectId)}
                          disabled={isAssigning}
                          className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                        >
                          🎯 {s.projectName}
                        </button>
                      ))}
                      <button
                        onClick={() => assign(article.id, "standalone", null)}
                        disabled={isAssigning}
                        className="px-3 py-1.5 bg-purple-100 text-purple-700 rounded-lg text-xs font-medium hover:bg-purple-200 disabled:opacity-50 transition-colors border border-purple-200"
                      >
                        💡 Standalone idea
                      </button>
                    </div>
                    {otherProjects.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value) {
                            assign(article.id, "project", e.target.value);
                          }
                        }}
                        disabled={isAssigning}
                        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      >
                        <option value="">Other project...</option>
                        {otherProjects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {!showAssignmentUi && article.assignment && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    {/* Project plan link */}
                    {article.assignment.kind === "project" &&
                      article.assignment.projectId && (
                        <div className="mb-3">
                          <Link
                            href={`/projects/${article.assignment.projectId}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 transition-colors"
                          >
                            📋 View project plan
                            <svg
                              className="w-3 h-3"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M14 5l7 7m0 0l-7 7m7-7H3"
                              />
                            </svg>
                          </Link>
                        </div>
                      )}
                    {/* Gap analysis section */}
                    {article.assignment.kind === "project" && (
                      <div className="mb-2">
                        {article.gapAnalysis ? (
                          <details className="group">
                            <summary className="cursor-pointer text-xs font-semibold text-indigo-600 hover:text-indigo-700 select-none flex items-center gap-1">
                              <span className="group-open:rotate-90 inline-block transition-transform">›</span>
                              Gap analysis for{" "}
                              {projectsById.get(article.gapAnalysis.projectId) ??
                                article.gapAnalysis.projectId}
                            </summary>
                            <pre className="mt-2 text-xs text-slate-700 bg-slate-50 border border-slate-100 rounded-lg p-3 whitespace-pre-wrap font-sans leading-relaxed">
                              {article.gapAnalysis.text}
                            </pre>
                            <button
                              onClick={() => runGapAnalysis(article.id)}
                              disabled={gapAnalysisId === article.id}
                              className="mt-2 text-[10px] text-slate-500 hover:text-indigo-600 underline disabled:opacity-50"
                            >
                              {gapAnalysisId === article.id
                                ? "Regenerating..."
                                : "Regenerate"}
                            </button>
                          </details>
                        ) : (
                          <button
                            onClick={() => runGapAnalysis(article.id)}
                            disabled={gapAnalysisId === article.id}
                            className="px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-medium hover:bg-indigo-100 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                          >
                            {gapAnalysisId === article.id && (
                              <svg
                                className="w-3 h-3 animate-spin"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                />
                              </svg>
                            )}
                            {gapAnalysisId === article.id
                              ? "Analyzing gap..."
                              : "🔍 Analyze gap with project"}
                          </button>
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => setReassignId(article.id)}
                      className="text-[10px] text-slate-400 hover:text-slate-600 underline"
                    >
                      Change assignment
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
