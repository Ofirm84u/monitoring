"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PRIORITY_STYLE, STATUS_STYLE, readError, type Priority, type ProjectStatus } from "@/lib/pm-ui";

interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  priority: Priority;
  deadline: string | null;
  myRole: "owner" | "editor" | "viewer";
  openTasks: number;
  doneTasks: number;
  memberCount: number;
}

export default function WorkPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [deadline, setDeadline] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/pm/projects", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Could not load projects"));
      setProjects(((await response.json()) as { projects: ProjectSummary[] }).projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createProject = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/pm/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, priority, status: "active", deadline: deadline || null }),
      });
      if (!response.ok) throw new Error(await readError(response, "Could not create project"));
      setName("");
      setDescription("");
      setPriority("medium");
      setDeadline("");
      setIsFormOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Projects</h1>
          <p className="text-sm text-slate-500">Shared projects and the tasks in them</p>
        </div>
        <Link href="/" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
          ← Back to dashboard
        </Link>
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
      )}

      {isFormOpen ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
          <h2 className="text-sm font-bold text-slate-800 mb-3">New project</h2>
          <label className="block mb-3">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Website relaunch"
              maxLength={120}
              autoFocus
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </label>
          <label className="block mb-3">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            <label className="block">
              <span className="block text-xs font-semibold text-slate-600 mb-1">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)} // options below are exactly the Priority values
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-slate-600 mb-1">Deadline (optional)</span>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void createProject()}
              disabled={!name.trim() || isSubmitting}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? "Creating…" : "Create project"}
            </button>
            <button type="button" onClick={() => setIsFormOpen(false)} className="text-sm text-slate-500 hover:text-slate-700">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsFormOpen(true)}
          className="mb-6 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
        >
          + New project
        </button>
      )}

      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {!isLoading && projects.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 text-sm text-slate-500">
          No projects yet. Create one, then add teammates from the project page or the{" "}
          <Link href="/team" className="text-indigo-600 hover:underline">Team</Link> page.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {projects.map((project) => (
          <Link
            key={project.id}
            href={`/work/${project.id}`}
            className="block bg-white rounded-2xl border border-slate-200 shadow-sm p-5 hover:border-indigo-300 transition-colors"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <h2 className="font-bold text-slate-900 truncate">{project.name}</h2>
              <span className={`shrink-0 px-2 py-0.5 rounded-md text-xs font-semibold ${STATUS_STYLE[project.status]}`}>
                {project.status}
              </span>
            </div>
            {project.description && <p className="text-sm text-slate-500 line-clamp-2 mb-3">{project.description}</p>}
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className={`px-2 py-0.5 rounded-md font-semibold ${PRIORITY_STYLE[project.priority]}`}>{project.priority}</span>
              <span>{project.openTasks} open · {project.doneTasks} done</span>
              <span>· {project.memberCount} {project.memberCount === 1 ? "person" : "people"}</span>
              {project.deadline && <span>· due {project.deadline}</span>}
              {project.myRole !== "owner" && <span>· you&apos;re {project.myRole}</span>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
