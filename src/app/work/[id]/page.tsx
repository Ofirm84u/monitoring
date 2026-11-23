"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PRIORITY_STYLE, STATUS_STYLE, readError, type Priority, type ProjectStatus } from "@/lib/pm-ui";

type MemberRole = "owner" | "editor" | "viewer";

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  priority: Priority;
  deadline: string | null;
}

interface Member {
  memberId: string | null;
  userId: string | null;
  email: string | null;
  name: string | null;
  role: MemberRole;
  status: "pending" | "active";
}

interface Task {
  id: string;
  userId: string;
  text: string;
  done: boolean;
  priority: Priority;
  dueDate: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
}

interface ProjectDetail {
  project: Project;
  myRole: MemberRole;
  myUserId: string;
  members: Member[];
  tasks: Task[];
}

const STATUSES: ProjectStatus[] = ["planning", "active", "blocked", "done", "archived"];

function memberLabel(member: Member): string {
  return member.name ?? member.email ?? "Unknown";
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [isNotFound, setIsNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [taskText, setTaskText] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskPriority, setTaskPriority] = useState<Priority>("medium");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/pm/projects/${id}`, { cache: "no-store" });
      if (response.status === 404) {
        setIsNotFound(true);
        return;
      }
      if (!response.ok) throw new Error(await readError(response, "Could not load project"));
      setDetail((await response.json()) as ProjectDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load project");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Send a mutation, surface its error, and reload on success. */
  const mutate = async (url: string, method: string, body?: unknown): Promise<Response | null> => {
    setError(null);
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      setError(await readError(response, "Something went wrong"));
      return null;
    }
    await load();
    return response;
  };

  if (isNotFound) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 text-sm text-slate-600">
        Project not found. <Link href="/work" className="text-indigo-600 hover:underline">Back to projects</Link>
      </div>
    );
  }
  if (!detail) {
    return <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8 text-sm text-slate-400">{error ?? "Loading…"}</div>;
  }

  const { project, myRole, myUserId, members, tasks } = detail;
  const canEdit = myRole !== "viewer";
  const isOwner = myRole === "owner";
  const assignable = members.filter((member) => member.status === "active" && member.userId);

  const addTask = async () => {
    const response = await mutate("/api/pm/tasks", "POST", {
      text: taskText,
      projectId: id,
      assigneeId: taskAssignee || null,
      dueDate: taskDue || null,
      priority: taskPriority,
    });
    if (!response) return;
    setTaskText("");
    setTaskAssignee("");
    setTaskDue("");
    setTaskPriority("medium");
  };

  const invite = async () => {
    const response = await mutate(`/api/pm/projects/${id}/members`, "POST", { email: inviteEmail, role: inviteRole });
    if (!response) return;
    const data = (await response.json()) as { canSignIn: boolean };
    setInviteEmail("");
    if (!data.canSignIn) {
      setError(`Invited, but ${inviteEmail} isn't on the team yet, so they can't sign in. Add them on the Team page.`);
    }
  };

  const deleteProject = async () => {
    if (!window.confirm(`Delete "${project.name}"? Its tasks are kept as personal tasks of whoever created them.`)) return;
    if (await mutate(`/api/pm/projects/${id}`, "DELETE")) router.push("/work");
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 truncate">{project.name}</h1>
          {project.description && <p className="text-sm text-slate-500">{project.description}</p>}
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
            {canEdit ? (
              <select
                value={project.status}
                onChange={(e) => void mutate(`/api/pm/projects/${id}`, "PATCH", { status: e.target.value })}
                className={`px-2 py-0.5 rounded-md font-semibold border-0 ${STATUS_STYLE[project.status]}`}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            ) : (
              <span className={`px-2 py-0.5 rounded-md font-semibold ${STATUS_STYLE[project.status]}`}>{project.status}</span>
            )}
            <span className={`px-2 py-0.5 rounded-md font-semibold ${PRIORITY_STYLE[project.priority]}`}>{project.priority}</span>
            {project.deadline && <span className="text-slate-500">due {project.deadline}</span>}
          </div>
        </div>
        <Link href="/work" className="shrink-0 text-sm font-semibold text-indigo-600 hover:text-indigo-700">
          ← All projects
        </Link>
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
      )}

      <div className="grid lg:grid-cols-[1fr_280px] gap-6">
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-800 mb-3">Tasks</h2>

          {canEdit && (
            <div className="flex flex-wrap gap-2 mb-4">
              <input
                type="text"
                value={taskText}
                onChange={(e) => setTaskText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && taskText.trim()) void addTask();
                }}
                placeholder="Add a task…"
                maxLength={500}
                className="flex-1 min-w-[12rem] px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
              <select
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                className="px-2 py-2 border border-slate-200 rounded-lg text-sm bg-white"
              >
                <option value="">Unassigned</option>
                {assignable.map((member) => (
                  <option key={member.userId} value={member.userId ?? ""}>{memberLabel(member)}</option>
                ))}
              </select>
              <input
                type="date"
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
                className="px-2 py-2 border border-slate-200 rounded-lg text-sm"
              />
              <select
                value={taskPriority}
                onChange={(e) => setTaskPriority(e.target.value as Priority)} // options are exactly the Priority values
                className="px-2 py-2 border border-slate-200 rounded-lg text-sm bg-white"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <button
                type="button"
                onClick={() => void addTask()}
                disabled={!taskText.trim()}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Add
              </button>
            </div>
          )}

          {tasks.length === 0 && <p className="text-sm text-slate-400">No tasks yet.</p>}
          <ul className="divide-y divide-slate-100">
            {tasks.map((task) => {
              const canToggle = canEdit || task.assigneeId === myUserId;
              const canDelete = isOwner || task.userId === myUserId;
              return (
                <li key={task.id} className="py-2.5 flex flex-wrap items-center gap-3">
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={!canToggle}
                    onChange={() => void mutate(`/api/pm/tasks/${task.id}`, "PATCH", { done: !task.done })}
                    aria-label={task.done ? "Mark not done" : "Mark done"}
                  />
                  <span className={`flex-1 min-w-0 text-sm ${task.done ? "line-through text-slate-400" : "text-slate-800"}`}>
                    {task.text}
                  </span>
                  <span className={`px-2 py-0.5 rounded-md text-xs font-semibold ${PRIORITY_STYLE[task.priority]}`}>{task.priority}</span>
                  {task.dueDate && <span className="text-xs text-slate-500">{task.dueDate}</span>}
                  {canEdit ? (
                    <select
                      value={task.assigneeId ?? ""}
                      onChange={(e) => void mutate(`/api/pm/tasks/${task.id}`, "PATCH", { assigneeId: e.target.value || null })}
                      className="px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white"
                    >
                      <option value="">Unassigned</option>
                      {assignable.map((member) => (
                        <option key={member.userId} value={member.userId ?? ""}>{memberLabel(member)}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-500">{task.assigneeName ?? task.assigneeEmail ?? "Unassigned"}</span>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => void mutate(`/api/pm/tasks/${task.id}`, "DELETE")}
                      className="text-xs text-slate-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <aside className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 self-start">
          <h2 className="text-sm font-bold text-slate-800 mb-3">People</h2>
          <ul className="flex flex-col gap-2 mb-4">
            {members.map((member) => {
              const canRemove = member.memberId && (isOwner || member.userId === myUserId);
              return (
                <li key={member.memberId ?? "owner"} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0 truncate text-slate-800">{memberLabel(member)}</span>
                  <span className="text-xs text-slate-500">
                    {member.status === "pending" ? "invited" : member.role}
                  </span>
                  {canRemove && (
                    <button
                      type="button"
                      onClick={() => void mutate(`/api/pm/projects/${id}/members/${member.memberId}`, "DELETE")}
                      className="text-xs text-slate-400 hover:text-red-600"
                      aria-label={`Remove ${memberLabel(member)}`}
                    >
                      ✕
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {isOwner && (
            <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@gmail.com"
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
              />
              <div className="flex gap-2">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value === "viewer" ? "viewer" : "editor")}
                  className="flex-1 px-2 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  type="button"
                  onClick={() => void invite()}
                  disabled={!inviteEmail.includes("@")}
                  className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Invite
                </button>
              </div>
              <button type="button" onClick={() => void deleteProject()} className="mt-4 text-xs text-slate-400 hover:text-red-600 self-start">
                Delete project
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
