"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

const INVALID_LOGIN_MESSAGE = "Wrong email or password.";
const RATE_LIMITED_MESSAGE = "Too many attempts. Wait 15 minutes and try again.";
const AFTER_LOGIN_PATH = "/work";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showBreakGlass, setShowBreakGlass] = useState(false);
  const router = useRouter();

  // Auth.js redirects a rejected sign-in back here with ?error=...; surface it.
  // Read from location (not useSearchParams) to avoid a Suspense boundary.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error")) setError(INVALID_LOGIN_MESSAGE);
  }, []);

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const result = await signIn("password", { email, password: accountPassword, redirect: false });
    setLoading(false);
    if (result?.error) {
      setError(result.code === "rate_limited" ? RATE_LIMITED_MESSAGE : INVALID_LOGIN_MESSAGE);
      return;
    }
    router.push(AFTER_LOGIN_PATH);
  }

  async function handleBreakGlass(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.push("/");
    } else {
      setError("Invalid password");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-800">PM Hub</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to continue</p>
        </div>

        <form onSubmit={handlePasswordLogin} className="flex flex-col gap-3">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <input
            type="password"
            autoComplete="current-password"
            value={accountPassword}
            onChange={(e) => setAccountPassword(e.target.value)}
            placeholder="Password"
            className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={loading || !email || !accountPassword}
            className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <p className="text-xs text-slate-400 mt-3 text-center">
          No password yet or forgot it? Ask an admin for a setup link.
        </p>

        {error && <p className="text-red-500 text-sm mt-3 text-center">{error}</p>}

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => setShowBreakGlass((v) => !v)}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            {showBreakGlass ? "Hide" : "Owner break-glass login"}
          </button>
        </div>

        {showBreakGlass && (
          <form onSubmit={handleBreakGlass} className="mt-3">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Owner password"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <button
              type="submit"
              disabled={loading || !password}
              className="w-full mt-3 px-4 py-3 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? "Checking..." : "Log in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
