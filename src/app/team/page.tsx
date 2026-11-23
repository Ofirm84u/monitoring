"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readError } from "@/lib/pm-ui";

type TeamRole = "owner" | "admin" | "member";
type ProjectRole = "editor" | "viewer";

interface TeamMember {
  email: string;
  role: TeamRole;
  source: "owner" | "team" | "env";
  name: string | null;
  isActive: boolean;
}

interface OwnedProject {
  id: string;
  name: string;
  myRole: string;
}

const ROLE_LABEL: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export default function TeamPage() {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [projects, setProjects] = useState<OwnedProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isForbidden, setIsForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Signed in only with the break-glass owner password: no PM account yet.
  const [needsOwnerAccount, setNeedsOwnerAccount] = useState(false);
  const [shareLink, setShareLink] = useState<{ email: string; url: string } | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [grants, setGrants] = useState<Record<string, ProjectRole>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [teamResponse, projectsResponse] = await Promise.all([
        fetch("/api/pm/team", { cache: "no-store" }),
        fetch("/api/pm/projects", { cache: "no-store" }),
      ]);
      if (teamResponse.status === 401) {
        setNeedsOwnerAccount(true);
        return;
      }
      if (teamResponse.status === 403) {
        setIsForbidden(true);
        return;
      }
      if (!teamResponse.ok) throw new Error(await readError(teamResponse, "Could not load the team"));
      setTeam(((await teamResponse.json()) as { team: TeamMember[] }).team);
      if (projectsResponse.ok) {
        const data = (await projectsResponse.json()) as { projects: OwnedProject[] };
        // Only owners can invite to a project, so only offer those.
        setProjects(data.projects.filter((project) => project.myRole === "owner"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the team");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showLink = (linkEmail: string, url: string) => {
    setShareLink({ email: linkEmail, url });
    setIsCopied(false);
  };

  const copyLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink.url);
      setIsCopied(true);
    } catch (err) {
      console.error("Clipboard write failed:", err);
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  };

  const issueLink = async (member: TeamMember) => {
    setError(null);
    setNotice(null);
    const response = await fetch("/api/pm/team/setup-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: member.email }),
    });
    if (!response.ok) {
      setError(await readError(response, "Could not create a link"));
      return;
    }
    const data = (await response.json()) as { url: string };
    setNotice(`New setup link for ${member.email}. Any older link for them no longer works.`);
    showLink(member.email, data.url);
  };

  const createOwnerAccount = async () => {
    setError(null);
    const response = await fetch("/api/pm/setup/owner", { method: "POST" });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) {
      setError(await readError(response, "Could not start account setup"));
      return;
    }
    window.location.href = ((await response.json()) as { url: string }).url;
  };

  const toggleProject = (projectId: string) => {
    setGrants((current) => {
      const { [projectId]: existing, ...rest } = current;
      return existing ? rest : { ...current, [projectId]: "editor" };
    });
  };

  const addUser = async () => {
    setIsSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/pm/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          projects: Object.entries(grants).map(([projectId, projectRole]) => ({ projectId, role: projectRole })),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "Could not add user"));
      const data = (await response.json()) as { email: string; invitedProjectIds: string[]; setupUrl: string | null };
      const projectCount = data.invitedProjectIds.length;
      setNotice(
        `${data.email} was added${projectCount ? ` to the team and ${projectCount} project${projectCount === 1 ? "" : "s"}` : ""}. Send them the link below so they can set a password.`,
      );
      if (data.setupUrl) showLink(data.email, data.setupUrl);
      setEmail("");
      setRole("member");
      setGrants({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add user");
    } finally {
      setIsSubmitting(false);
    }
  };

  const changeRole = async (member: TeamMember, nextRole: "admin" | "member") => {
    setError(null);
    const response = await fetch("/api/pm/team", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: member.email, role: nextRole }),
    });
    if (!response.ok) {
      setError(await readError(response, "Could not change role"));
      return;
    }
    await load();
  };

  const removeUser = async (member: TeamMember) => {
    if (!window.confirm(`Remove ${member.email}? They lose sign-in and access to every shared project.`)) return;
    setError(null);
    setNotice(null);
    const response = await fetch(`/api/pm/team?email=${encodeURIComponent(member.email)}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await readError(response, "Could not remove user"));
      return;
    }
    const data = (await response.json()) as { stillAllowedByEnv?: boolean };
    if (data.stillAllowedByEnv) {
      setNotice(`${member.email} is also in ALLOWED_EMAILS on the server, so they can still sign in until it's removed there.`);
    }
    await load();
  };

  const canSubmit = email.trim().includes("@") && !isSubmitting;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Team</h1>
          <p className="text-sm text-slate-500">Who can sign in, and which projects they start in</p>
        </div>
        <Link href="/" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
          ← Back to dashboard
        </Link>
      </div>

      {needsOwnerAccount ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 text-sm text-slate-600">
          {error && <p className="mb-3 text-red-600">{error}</p>}
          <p className="mb-3">
            You&apos;re signed in with the owner backup password, which only covers the monitoring pages. Create your
            email + password account to manage the team and projects.
          </p>
          <button
            type="button"
            onClick={() => void createOwnerAccount()}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            Create my account
          </button>
        </div>
      ) : isForbidden ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 text-sm text-slate-600">
          Only admins can manage the team. Ask an admin to add people.
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
          )}
          {notice && (
            <div className="mb-3 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-sm">{notice}</div>
          )}
          {shareLink && (
            <div className="mb-6 p-4 bg-white border border-indigo-200 rounded-2xl shadow-sm">
              <p className="text-xs font-semibold text-slate-600 mb-2">
                Setup link for {shareLink.email} · works once, expires in 72 hours
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareLink.url}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 min-w-0 px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono bg-slate-50"
                />
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
                >
                  {isCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
            <h2 className="text-sm font-bold text-slate-800 mb-3">Add user</h2>
            <div className="grid sm:grid-cols-[1fr_auto] gap-3 mb-3">
              <label className="block">
                <span className="block text-xs font-semibold text-slate-600 mb-1">Google email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@gmail.com"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-semibold text-slate-600 mb-1">Role</span>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin — can add and remove people</option>
                </select>
              </label>
            </div>

            <div className="mb-4">
              <span className="block text-xs font-semibold text-slate-600 mb-1">Add to projects (optional)</span>
              {projects.length === 0 ? (
                <p className="text-xs text-slate-400">
                  You don&apos;t own any projects yet. <Link href="/work" className="text-indigo-600 hover:underline">Create one</Link>.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {projects.map((project) => {
                    const grant = grants[project.id];
                    return (
                      <div key={project.id} className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-sm text-slate-700 min-w-0 flex-1">
                          <input type="checkbox" checked={!!grant} onChange={() => toggleProject(project.id)} />
                          <span className="truncate">{project.name}</span>
                        </label>
                        {grant && (
                          <select
                            value={grant}
                            onChange={(e) =>
                              setGrants((current) => ({
                                ...current,
                                [project.id]: e.target.value === "viewer" ? "viewer" : "editor",
                              }))
                            }
                            className="px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white"
                          >
                            <option value="editor">Editor</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void addUser()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? "Adding…" : "Add user"}
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {isLoading && <p className="p-5 text-sm text-slate-400">Loading…</p>}
            {team.map((member) => (
              <div key={member.email} className="p-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 truncate">{member.name ?? member.email}</p>
                  {member.name && <p className="text-xs text-slate-500 truncate">{member.email}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => void issueLink(member)}
                  className="text-xs text-indigo-600 hover:text-indigo-800"
                  title="One-time link to set or reset their password"
                >
                  Setup link
                </button>
                <span
                  className={`px-2 py-0.5 rounded-md text-xs font-semibold ${
                    member.isActive ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {member.isActive ? "Active" : "Invited"}
                </span>
                {member.source === "team" ? (
                  <>
                    <select
                      value={member.role}
                      onChange={(e) => void changeRole(member, e.target.value === "admin" ? "admin" : "member")}
                      className="px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void removeUser(member)}
                      className="text-xs text-slate-400 hover:text-red-600"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-slate-500" title={member.source === "env" ? "Set in ALLOWED_EMAILS on the server" : undefined}>
                    {ROLE_LABEL[member.role]}
                    {member.source === "env" && " · server list"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
