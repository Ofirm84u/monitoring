"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { PASSWORD_RULES, unmetPasswordRules } from "@/lib/password-policy";
import { readError } from "@/lib/pm-ui";

const AFTER_SETUP_PATH = "/work";

type LinkState =
  | { kind: "loading" }
  | { kind: "invalid"; message: string }
  | { kind: "ready"; email: string; hasAccount: boolean };

export default function SetupPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [link, setLink] = useState<LinkState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Read from location (not useSearchParams) to avoid a Suspense boundary.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(value);
    if (!value) {
      setLink({ kind: "invalid", message: "This link is missing its token." });
      return;
    }
    void (async () => {
      const response = await fetch(`/api/pm/setup?token=${encodeURIComponent(value)}`, { cache: "no-store" });
      if (!response.ok) {
        setLink({ kind: "invalid", message: await readError(response, "This link is invalid or has expired.") });
        return;
      }
      const data = (await response.json()) as { email: string; hasAccount: boolean };
      setLink({ kind: "ready", ...data });
    })();
  }, []);

  const isPolicyMet = unmetPasswordRules(password).length === 0;
  const isConfirmed = password.length > 0 && password === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (link.kind !== "ready") return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/pm/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, name }),
      });
      if (!response.ok) throw new Error(await readError(response, "Could not set the password"));
      const result = await signIn("password", { email: link.email, password, redirect: false });
      router.push(result?.error ? "/login" : AFTER_SETUP_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-slate-800 text-center">
          {link.kind === "ready" && link.hasAccount ? "Reset your password" : "Set up your account"}
        </h1>

        {link.kind === "loading" && <p className="text-sm text-slate-400 text-center mt-4">Checking link…</p>}
        {link.kind === "invalid" && <p className="text-sm text-red-600 text-center mt-4">{link.message}</p>}

        {link.kind === "ready" && (
          <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
            <p className="text-sm text-slate-500 text-center">
              Username: <span className="font-semibold text-slate-800">{link.email}</span>
            </p>
            {/* Lets password managers save the email together with the new password. */}
            <input type="email" autoComplete="username" value={link.email} readOnly hidden />
            {!link.hasAccount && (
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                maxLength={80}
                className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm"
              />
            )}
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm"
            />
            <ul className="text-xs flex flex-col gap-1 px-1">
              {PASSWORD_RULES.map((rule) => {
                const isMet = rule.test(password);
                return (
                  <li key={rule.id} className={isMet ? "text-emerald-600" : "text-slate-400"}>
                    {isMet ? "✓" : "○"} {rule.label}
                  </li>
                );
              })}
            </ul>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm"
            />
            {confirm.length > 0 && !isConfirmed && <p className="text-xs text-red-500 px-1">Passwords don&apos;t match</p>}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={!isPolicyMet || !isConfirmed || isSubmitting}
              className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? "Saving…" : "Save password and sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
