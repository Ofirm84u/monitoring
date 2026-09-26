"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type DefectTier = "state" | "flow" | "visual" | "unknown";
type Severity = "low" | "medium" | "high" | "critical";
type Confidence = "low" | "medium" | "high";
type DefectStatus =
  | "triaging"
  | "triaged"
  | "needs_info"
  | "planned"
  | "running"
  | "fixed"
  | "rejected"
  | "failed";

interface DefectImage {
  id: string;
  mediaType: string;
  byteSize: number;
}

interface Defect {
  id: string;
  projectId: string;
  title: string;
  whatHappened: string;
  whatExpected: string | null;
  reproSteps: string | null;
  route: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  tier: DefectTier;
  severity: Severity | null;
  symptom: string | null;
  suspectedCauses: string[] | null;
  visibleStrings: string[] | null;
  suspectedFiles: string[] | null;
  confidence: Confidence | null;
  missingInfo: string[] | null;
  status: DefectStatus;
  triageError: string | null;
  createdAt: string;
  images: DefectImage[];
}

interface ProjectOption {
  id: string;
  name: string;
}

/** How a fix can be proven, which is the thing the tier actually decides. */
const TIER_LABEL: Record<DefectTier, string> = {
  state: "State · component test",
  flow: "Flow · browser test",
  visual: "Visual · before/after render",
  unknown: "Tier unclear",
};

const TIER_STYLE: Record<DefectTier, string> = {
  state: "bg-emerald-50 border-emerald-200 text-emerald-700",
  flow: "bg-sky-50 border-sky-200 text-sky-700",
  visual: "bg-amber-50 border-amber-200 text-amber-700",
  unknown: "bg-slate-50 border-slate-200 text-slate-600",
};

const SEVERITY_STYLE: Record<Severity, string> = {
  low: "bg-slate-50 border-slate-200 text-slate-600",
  medium: "bg-sky-50 border-sky-200 text-sky-700",
  high: "bg-orange-50 border-orange-200 text-orange-700",
  critical: "bg-red-50 border-red-200 text-red-700",
};

const STATUS_STYLE: Record<DefectStatus, string> = {
  triaging: "bg-slate-100 text-slate-600",
  triaged: "bg-emerald-100 text-emerald-700",
  needs_info: "bg-amber-100 text-amber-800",
  planned: "bg-indigo-100 text-indigo-700",
  running: "bg-indigo-100 text-indigo-700",
  fixed: "bg-emerald-100 text-emerald-700",
  rejected: "bg-slate-100 text-slate-600",
  failed: "bg-red-100 text-red-700",
};

const MAX_IMAGES = 4;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

interface PendingImage {
  /** Object URL for the preview; revoked when the image is dropped. */
  previewUrl: string;
  base64: string;
  name: string;
  bytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      // Strip the "data:image/png;base64," prefix — the API takes raw base64.
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export default function DefectsPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [defects, setDefects] = useState<Defect[]>([]);
  const [loading, setLoading] = useState(true);

  const [projectId, setProjectId] = useState("");
  const [whatHappened, setWhatHappened] = useState("");
  const [whatExpected, setWhatExpected] = useState("");
  const [reproSteps, setReproSteps] = useState("");
  const [route, setRoute] = useState("");
  const [viewportWidth, setViewportWidth] = useState("");
  const [viewportHeight, setViewportHeight] = useState("");

  const [images, setImages] = useState<PendingImage[]>([]);
  const [screenshotsChecked, setScreenshotsChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDefects = useCallback(async () => {
    try {
      const res = await fetch("/api/defects", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load defects");
      const data = (await res.json()) as { defects: Defect[] };
      setDefects(data.defects);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load defects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDefects();
    void (async () => {
      try {
        const res = await fetch("/api/projects/list", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { projects: ProjectOption[] };
        setProjects(data.projects);
      } catch {
        // The project list is a convenience; the form still works without it.
      }
    })();
  }, [loadDefects]);

  // Prefill the viewport from this browser, but leave it editable: you are
  // often reporting a bug you saw in a different app, on a different screen,
  // and a silently wrong viewport would send triage down the wrong path.
  useEffect(() => {
    setViewportWidth(String(window.innerWidth));
    setViewportHeight(String(window.innerHeight));
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      const accepted = files.filter((f) => ACCEPTED_TYPES.includes(f.type));
      if (accepted.length < files.length) {
        setError("Screenshots must be PNG, JPEG, or WebP.");
      }
      if (accepted.length === 0) return;

      try {
        const encoded = await Promise.all(
          accepted.map(async (file) => ({
            previewUrl: URL.createObjectURL(file),
            base64: await fileToBase64(file),
            name: file.name || "screenshot",
            bytes: file.size,
          })),
        );
        setImages((prev) => [...prev, ...encoded].slice(0, MAX_IMAGES));
        // New evidence means the previous look no longer covers what's attached.
        setScreenshotsChecked(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read screenshot");
      }
    },
    [],
  );

  // Paste is the main path: a screen capture goes to the clipboard, and
  // making you save it to disk first is friction that loses bug reports.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const removeImage = (index: number) => {
    setImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
    setScreenshotsChecked(false);
  };

  const resetForm = () => {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    setWhatHappened("");
    setWhatExpected("");
    setReproSteps("");
    setRoute("");
    setScreenshotsChecked(false);
  };

  const canSubmit =
    !submitting &&
    projectId !== "" &&
    whatHappened.trim().length > 0 &&
    (images.length === 0 || screenshotsChecked);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/defects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          whatHappened,
          whatExpected,
          reproSteps,
          route,
          viewportWidth: viewportWidth ? Number(viewportWidth) : undefined,
          viewportHeight: viewportHeight ? Number(viewportHeight) : undefined,
          userAgent: navigator.userAgent,
          imagesBase64: images.map((i) => i.base64),
          reportedVia: "web",
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not submit defect");
      resetForm();
      await loadDefects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit defect");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Defects</h1>
          <p className="text-sm text-slate-500">
            Report a bug you hit in the interface — get a triage and a fix plan
          </p>
        </div>
        <Link
          href="/"
          className="text-sm font-semibold text-indigo-600 hover:text-indigo-700"
        >
          ← Back to dashboard
        </Link>
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="block text-xs font-semibold text-slate-600 mb-1">
              Which app?
            </span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
            >
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-semibold text-slate-600 mb-1">
              Where? (page URL or route)
            </span>
            <input
              type="text"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              placeholder="/projects/123/audits"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </label>
        </div>

        <label className="block mb-3">
          <span className="block text-xs font-semibold text-slate-600 mb-1">
            What happened?
          </span>
          <textarea
            value={whatHappened}
            onChange={(e) => setWhatHappened(e.target.value)}
            rows={2}
            placeholder="The booking time shows 14:00 but the slot I picked was 16:00"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y"
          />
        </label>

        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="block text-xs font-semibold text-slate-600 mb-1">
              What did you expect?
            </span>
            <textarea
              value={whatExpected}
              onChange={(e) => setWhatExpected(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-slate-600 mb-1">
              How do you reproduce it?
            </span>
            <textarea
              value={reproSteps}
              onChange={(e) => setReproSteps(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y"
            />
          </label>
        </div>

        <div className="mb-3">
          <span className="block text-xs font-semibold text-slate-600 mb-1">
            Viewport where you saw it
          </span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={viewportWidth}
              onChange={(e) => setViewportWidth(e.target.value)}
              className="w-24 px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
            <span className="text-slate-400 text-sm">×</span>
            <input
              type="number"
              value={viewportHeight}
              onChange={(e) => setViewportHeight(e.target.value)}
              className="w-24 px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
            <span className="text-[11px] text-slate-500">
              Prefilled from this window — change it if you saw the bug elsewhere
            </span>
          </div>
        </div>

        <div
          onDrop={(e) => {
            e.preventDefault();
            void addFiles(Array.from(e.dataTransfer.files));
          }}
          onDragOver={(e) => e.preventDefault()}
          className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center mb-3"
        >
          <p className="text-sm text-slate-600 mb-1">
            Paste a screenshot (⌘V), drop one here, or{" "}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-indigo-600 font-semibold hover:text-indigo-700 underline"
            >
              choose a file
            </button>
          </p>
          <p className="text-[11px] text-slate-400">
            PNG, JPEG or WebP · up to {MAX_IMAGES}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(",")}
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>

        {images.length > 0 && (
          <div className="mb-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              {images.map((image, index) => (
                <div
                  key={image.previewUrl}
                  className="relative border border-slate-200 rounded-lg overflow-hidden bg-slate-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- local
                      object URL for a preview that never leaves the browser */}
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="w-full h-28 object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    className="absolute top-1 right-1 px-1.5 py-0.5 bg-white/90 border border-slate-200 rounded text-[10px] font-semibold text-red-600"
                  >
                    Remove
                  </button>
                  <div className="px-2 py-1 text-[10px] text-slate-500 truncate">
                    {formatBytes(image.bytes)}
                  </div>
                </div>
              ))}
            </div>

            {/* This is the whole "preview and confirm" control. The screenshot
                is about to be sent to the Claude API and written to disk on the
                VM, and a bug screenshot routinely has a session token in the URL
                bar or customer data in the frame. */}
            <label className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={screenshotsChecked}
                onChange={(e) => setScreenshotsChecked(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs text-amber-900">
                I&rsquo;ve looked at these screenshots. They go to the Claude API
                and are stored on the server.
              </span>
            </label>
          </div>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Triaging…" : "Report defect"}
        </button>
        {images.length > 0 && !screenshotsChecked && (
          <span className="ml-3 text-xs text-slate-500">
            Confirm the screenshots above first
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading defects…</p>
      ) : defects.length === 0 ? (
        <p className="text-sm text-slate-500">
          No defects reported yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {defects.map((defect) => (
            <DefectCard key={defect.id} defect={defect} onChange={loadDefects} />
          ))}
        </div>
      )}
    </div>
  );
}

function DefectCard({
  defect,
  onChange,
}: {
  defect: Defect;
  onChange: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      await fetch(`/api/defects/${defect.id}`, { method: "DELETE" });
      await onChange();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span
              className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[defect.status]}`}
            >
              {defect.status.replace("_", " ")}
            </span>
            <span className="text-[11px] text-slate-400">{defect.projectId}</span>
            {defect.route && (
              <span className="text-[11px] text-slate-400 truncate">
                {defect.route}
              </span>
            )}
            {defect.viewportWidth && defect.viewportHeight && (
              <span className="text-[11px] text-slate-400">
                {defect.viewportWidth}×{defect.viewportHeight}
              </span>
            )}
          </div>
          <h2 className="font-semibold text-slate-800 text-base leading-snug">
            {defect.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
          className="text-[11px] text-slate-400 hover:text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-2">
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-[11px] font-semibold ${TIER_STYLE[defect.tier]}`}
        >
          {TIER_LABEL[defect.tier]}
        </span>
        {defect.severity && (
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-[11px] font-semibold ${SEVERITY_STYLE[defect.severity]}`}
          >
            {defect.severity}
          </span>
        )}
        {defect.confidence && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 text-[11px] font-semibold">
            confidence: {defect.confidence}
          </span>
        )}
      </div>

      {defect.symptom && (
        <p className="text-sm text-slate-700 mb-2">{defect.symptom}</p>
      )}

      {defect.triageError && (
        <div className="mb-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs">
          Triage failed: {defect.triageError}
        </div>
      )}

      {defect.missingInfo && defect.missingInfo.length > 0 && (
        <div className="mb-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs font-semibold text-amber-900 mb-1">
            Needs an answer before this can be planned
          </p>
          <ul className="list-disc list-inside text-xs text-amber-900 space-y-0.5">
            {defect.missingInfo.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {defect.images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {defect.images.map((image) => (
            <a
              key={image.id}
              href={`/api/defects/${defect.id}/images/${image.id}`}
              target="_blank"
              rel="noreferrer"
              className="block border border-slate-200 rounded-lg overflow-hidden"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- served by
                  an authenticated route, not a static asset the optimizer can read */}
              <img
                src={`/api/defects/${defect.id}/images/${image.id}`}
                alt="Defect screenshot"
                className="h-28 w-auto object-contain bg-slate-50"
              />
            </a>
          ))}
        </div>
      )}

      {(defect.suspectedCauses?.length || defect.visibleStrings?.length) && (
        <details className="group mt-2">
          <summary className="cursor-pointer text-xs font-semibold text-indigo-600 hover:text-indigo-700 select-none">
            Show triage detail
          </summary>
          <div className="mt-2 text-xs text-slate-700 bg-slate-50 border border-slate-100 rounded-lg p-3 space-y-2">
            {defect.suspectedCauses && defect.suspectedCauses.length > 0 && (
              <div>
                <p className="font-semibold text-slate-600 mb-1">Suspected causes</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {defect.suspectedCauses.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {defect.visibleStrings && defect.visibleStrings.length > 0 && (
              <div>
                <p className="font-semibold text-slate-600 mb-1">
                  Text read from the screenshot — used to locate the component
                </p>
                <div className="flex flex-wrap gap-1">
                  {defect.visibleStrings.map((s) => (
                    <code
                      key={s}
                      className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[11px]"
                    >
                      {s}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {defect.suspectedFiles && defect.suspectedFiles.length > 0 && (
              <div>
                <p className="font-semibold text-slate-600 mb-1">Suspected files</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {defect.suspectedFiles.map((f) => (
                    <li key={f}>
                      <code className="text-[11px]">{f}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
