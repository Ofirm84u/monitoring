// Client-side mirrors of the PM enums in src/db/schema.ts. Duplicated rather
// than imported so client bundles don't pull in the Drizzle schema module.
export type Priority = "low" | "medium" | "high" | "urgent";
export type ProjectStatus = "planning" | "active" | "blocked" | "done" | "archived";

export const PRIORITY_STYLE: Record<Priority, string> = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-sky-50 text-sky-700",
  high: "bg-amber-50 text-amber-700",
  urgent: "bg-red-50 text-red-700",
};

export const STATUS_STYLE: Record<ProjectStatus, string> = {
  planning: "bg-slate-100 text-slate-600",
  active: "bg-emerald-50 text-emerald-700",
  blocked: "bg-red-50 text-red-700",
  done: "bg-indigo-50 text-indigo-700",
  archived: "bg-slate-100 text-slate-400",
};

export async function readError(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}
