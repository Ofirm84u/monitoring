"use client";

import { useState, useEffect, useCallback } from "react";

interface LiveCheck {
  status: string;
  responseTime: number;
}

interface SystemInfo {
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPercent: number;
  memoryAvailableMb: number;
  diskPercent: number;
  diskUsed: string;
  diskTotal: string;
  loadAverage: number;
  uptimeDays: number;
  uptimeHours: number;
}

interface MonitorData {
  lastCheck: {
    timestamp: string;
    overall: "healthy" | "degraded" | "critical";
    sites: Record<string, string>;
    containers: Record<string, string>;
    pm2: string;
    system: SystemInfo;
    issues: string[];
    recoveries: string[];
  } | null;
  liveChecks: Record<string, LiveCheck>;
  recentLogs: string[];
  monitoringActive: boolean;
}

const SITE_LABELS: Record<string, string> = {
  bizitis: "Bizitis (bizitis.co.il)",
  hudson: "Hudson (hudson.m84.me)",
  seoapp: "SEO App (app.m84.me)",
  beiteden: "Beit Eden (beiteden.m84.me)",
};

function StatusDot({ up }: { up: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${
        up ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]" : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] animate-pulse"
      }`}
    />
  );
}

function StatusBadge({ status }: { status: string }) {
  const isUp = status === "up" || status === "running" || status === "active";
  const isRecovered = status === "recovered";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
        isUp
          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
          : isRecovered
            ? "bg-blue-50 text-blue-700 border border-blue-200"
            : "bg-red-50 text-red-700 border border-red-200"
      }`}
    >
      <StatusDot up={isUp || isRecovered} />
      {status.toUpperCase()}
    </span>
  );
}

function GaugeBar({
  value,
  max,
  label,
  detail,
  warnThreshold,
}: {
  value: number;
  max: number;
  label: string;
  detail: string;
  warnThreshold: number;
}) {
  const percent = Math.round((value / max) * 100);
  const isWarn = percent >= warnThreshold;
  const isCritical = percent >= 90;

  return (
    <div>
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-slate-500 font-medium">{label}</span>
        <span className={`font-mono text-sm ${isCritical ? "text-red-600 font-bold" : isWarn ? "text-amber-600 font-semibold" : "text-slate-700"}`}>
          {detail}
        </span>
      </div>
      <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isCritical ? "bg-red-500" : isWarn ? "bg-amber-500" : "bg-emerald-500"
          }`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/status");
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // 30s refresh
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const overall = data?.lastCheck?.overall;
  const overallColor =
    overall === "healthy"
      ? "from-emerald-500 to-emerald-600"
      : overall === "degraded"
        ? "from-amber-500 to-amber-600"
        : overall === "critical"
          ? "from-red-500 to-red-600"
          : "from-slate-400 to-slate-500";

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Server Monitor</h1>
            <p className="text-xs text-slate-400">
              {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : "Loading..."}
            </p>
          </div>
        </div>
        <button
          onClick={fetchStatus}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          <svg className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Overall Status Banner */}
      {data?.lastCheck && (
        <div className={`mb-6 p-5 rounded-2xl text-white bg-gradient-to-r ${overallColor} shadow-lg`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">
                {overall === "healthy" ? "\u2713" : overall === "degraded" ? "\u26A0" : "\u2717"}
              </span>
              <div>
                <p className="font-bold text-lg">
                  {overall === "healthy" ? "All Systems Operational" : overall === "degraded" ? "Degraded Performance" : "Critical Issues Detected"}
                </p>
                <p className="text-sm opacity-80">
                  Last cron check: {new Date(data.lastCheck.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
            {data.lastCheck.system && (
              <div className="text-right text-sm opacity-90 hidden sm:block">
                <p>Uptime: {data.lastCheck.system.uptimeDays}d {data.lastCheck.system.uptimeHours}h</p>
                <p>Load: {data.lastCheck.system.loadAverage}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {!data?.monitoringActive && !loading && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
          Cron monitoring not active yet. Live checks below run directly from this page.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Live Site Checks */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            Website Uptime (Live)
          </h2>
          <div className="space-y-2">
            {data?.liveChecks &&
              Object.entries(data.liveChecks).map(([name, check]) => {
                const isUp = check.status === "up";
                return (
                  <div
                    key={name}
                    className={`flex items-center justify-between p-3 rounded-xl ${isUp ? "bg-emerald-50/50" : "bg-red-50"}`}
                  >
                    <div className="flex items-center gap-3">
                      <StatusDot up={isUp} />
                      <div>
                        <p className="font-medium text-sm text-slate-800">
                          {SITE_LABELS[name] ?? name}
                        </p>
                        <p className="text-xs text-slate-400">
                          {check.responseTime}ms
                        </p>
                      </div>
                    </div>
                    <span className={`text-xs font-mono font-semibold ${isUp ? "text-emerald-600" : "text-red-600"}`}>
                      {check.status.toUpperCase()}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>

        {/* System Resources */}
        {data?.lastCheck?.system ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              System Resources
            </h2>
            <div className="space-y-5">
              <GaugeBar
                value={data.lastCheck.system.memoryUsedMb}
                max={data.lastCheck.system.memoryTotalMb}
                label="Memory"
                detail={`${data.lastCheck.system.memoryUsedMb}MB / ${data.lastCheck.system.memoryTotalMb}MB (${data.lastCheck.system.memoryPercent}%)`}
                warnThreshold={80}
              />
              <GaugeBar
                value={data.lastCheck.system.diskPercent}
                max={100}
                label="Disk"
                detail={`${data.lastCheck.system.diskUsed} / ${data.lastCheck.system.diskTotal} (${data.lastCheck.system.diskPercent}%)`}
                warnThreshold={85}
              />
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="bg-slate-50 rounded-xl p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">CPU Load (5m)</p>
                  <p className={`text-lg font-mono font-bold ${data.lastCheck.system.loadAverage > 3 ? "text-red-600" : "text-slate-700"}`}>
                    {data.lastCheck.system.loadAverage}
                  </p>
                </div>
                <div className="bg-slate-50 rounded-xl p-3 text-center">
                  <p className="text-xs text-slate-400 mb-1">Available RAM</p>
                  <p className={`text-lg font-mono font-bold ${data.lastCheck.system.memoryAvailableMb < 300 ? "text-red-600" : "text-slate-700"}`}>
                    {data.lastCheck.system.memoryAvailableMb}MB
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex items-center justify-center text-slate-400 text-sm">
            System metrics will appear after the first cron run
          </div>
        )}

        {/* Docker Containers */}
        {data?.lastCheck?.containers && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              Docker Containers ({Object.keys(data.lastCheck.containers).length})
            </h2>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {Object.entries(data.lastCheck.containers).map(([name, status]) => (
                <div
                  key={name}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <span className="text-xs font-mono text-slate-600">{name}</span>
                  <StatusBadge status={status} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PM2 + Services */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
            Services
          </h2>
          <div className="space-y-2">
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
              <div>
                <p className="font-medium text-sm text-slate-800">PM2 (bizitis)</p>
                <p className="text-xs text-slate-400">Next.js production — pm2-ofir.service</p>
              </div>
              <StatusBadge status={data?.lastCheck?.pm2 ?? "unknown"} />
            </div>
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
              <div>
                <p className="font-medium text-sm text-slate-800">Caddy</p>
                <p className="text-xs text-slate-400">Reverse proxy + SSL</p>
              </div>
              <StatusBadge status={data?.lastCheck?.containers?.["caddy-caddy-1"] ?? "unknown"} />
            </div>
          </div>
        </div>

        {/* Issues & Recoveries */}
        {data?.lastCheck &&
          (data.lastCheck.issues.length > 0 || data.lastCheck.recoveries.length > 0) && (
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm lg:col-span-2">
              <h2 className="font-semibold text-slate-800 mb-4">Issues & Auto-Recoveries</h2>
              {data.lastCheck.issues.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-red-600 mb-2">
                    Active Issues ({data.lastCheck.issues.length})
                  </h3>
                  <ul className="space-y-1.5">
                    {data.lastCheck.issues.map((issue, i) => (
                      <li key={i} className="text-sm text-red-700 bg-red-50 border border-red-100 p-2.5 rounded-lg">
                        {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.lastCheck.recoveries.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-blue-600 mb-2">
                    Auto-Recoveries ({data.lastCheck.recoveries.length})
                  </h3>
                  <ul className="space-y-1.5">
                    {data.lastCheck.recoveries.map((recovery, i) => (
                      <li key={i} className="text-sm text-blue-700 bg-blue-50 border border-blue-100 p-2.5 rounded-lg">
                        {recovery}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

        {/* Recent Logs */}
        {data?.recentLogs && data.recentLogs.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm lg:col-span-2">
            <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Monitor Log (last 30 entries)
            </h2>
            <div className="bg-slate-900 rounded-xl p-4 overflow-x-auto max-h-64 overflow-y-auto">
              {data.recentLogs.map((line, i) => (
                <div
                  key={i}
                  className={`text-xs font-mono leading-5 ${
                    line.includes("FAIL") || line.includes("WARN")
                      ? "text-red-400"
                      : line.includes("RECOVERY")
                        ? "text-blue-400"
                        : line.includes("OK")
                          ? "text-emerald-400"
                          : line.includes("ALERT")
                            ? "text-amber-400"
                            : "text-slate-400"
                  }`}
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-6 text-center text-xs text-slate-400">
        Auto-refreshes every 30 seconds &middot; Cron runs every 2 minutes
      </div>
    </div>
  );
}
