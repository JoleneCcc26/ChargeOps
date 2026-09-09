// src/pages/CloudOps.tsx — the live infrastructure view
//
// This page is the demo. Everything else in the app is a normal admin UI; this
// is where the cloud architecture stops being a diagram and starts being a
// running system you can point a camera at.
//
// It polls /api/ops/stats once a second and keeps a rolling 120-second window
// client-side, so the charts show what just happened without the server having
// to store any time series. Run `npm run loadtest` with this page open and the
// whole story plays out on screen: backlog spikes, workers scale out,
// throughput climbs, backlog drains, workers scale back in.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Boxes, Cpu, Database, Gauge, HardDrive,
  Layers, RefreshCw, Trash2, Zap,
} from "lucide-react";
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import {
  fetchOpsStats, fetchDeadLetters, fetchArchitecture, fetchTelemetryStats,
  redriveDeadLetters, purgeCompletedJobs,
  type OpsStats, type DeadLetter, type ArchitectureRow, type TelemetryStats,
} from "../api";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../context/AuthContext";
import { cn, cardShell, inputShell } from "../lib/cn";

/** How many one-second samples to keep on the charts. */
const WINDOW = 120;

interface Sample {
  t: string;
  backlog: number;
  workers: number;
  throughput: number;
  latencyMs: number;
}

export function CloudOps() {
  const { user } = useAuth();
  const [stats, setStats] = useState<OpsStats | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryStats | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [architecture, setArchitecture] = useState<ArchitectureRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);

  // Peak marks survive the rolling window so the headline numbers from the last
  // spike stay on screen after the chart has scrolled past them.
  const peaks = useRef({ backlog: 0, workers: 0, throughput: 0 });

  const tick = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([fetchOpsStats(), fetchTelemetryStats()]);
      setStats(s);
      setTelemetry(t);
      setError(null);

      const latencyMs = Math.max(0, ...s.queues.map((q) => q.avgLatencyMs));
      peaks.current = {
        backlog: Math.max(peaks.current.backlog, s.totals.backlog),
        workers: Math.max(peaks.current.workers, s.workers.count),
        throughput: Math.max(peaks.current.throughput, s.totals.throughput),
      };

      setHistory((prev) =>
        [
          ...prev,
          {
            t: new Date(s.timestamp).toLocaleTimeString("en-US", { hour12: false }),
            backlog: s.totals.backlog,
            workers: s.workers.count,
            throughput: s.totals.throughput,
            latencyMs,
          },
        ].slice(-WINDOW)
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "unreachable");
    }
  }, []);

  // The 1 Hz poll. Cheap: /api/ops/stats is a handful of indexed aggregates.
  // A production version would push over WebSocket or SSE instead of polling,
  // which is the obvious Milestone 2 upgrade.
  useEffect(() => {
    if (!live) return;
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [live, tick]);

  useEffect(() => {
    fetchArchitecture().then(setArchitecture).catch(() => {});
  }, []);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      fetchDeadLetters().then(setDeadLetters).catch(() => {});
    }, 4000);
    fetchDeadLetters().then(setDeadLetters).catch(() => {});
    return () => clearInterval(id);
  }, [live]);

  async function withBusy(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await tick();
      setDeadLetters(await fetchDeadLetters());
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  const backlog = stats?.totals.backlog ?? 0;
  const workers = stats?.workers.count ?? 0;
  const scaling = workers > 1;

  return (
    <div className="space-y-6">
      <PageHeader subtitle="Live view of the asynchronous pipeline: queue depth, worker autoscaling, throughput and cache behaviour. Run `npm run loadtest` and watch the backlog spike, the workers scale out, and the queue drain." />

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Ops API unreachable ({error}). Is the server running? <code>npm run dev:server</code>
          </span>
        </div>
      ) : null}

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          className={cn(
            inputShell,
            "flex items-center gap-2 px-3 py-2 text-sm font-medium",
            live && "border-emerald-500/40 text-emerald-700 dark:text-accent-glow"
          )}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              live ? "animate-pulse bg-emerald-500" : "bg-slate-400"
            )}
          />
          {live ? "Live" : "Paused"}
        </button>

        {user?.role === "ops_manager" ? <button
          type="button"
          disabled={busy || deadLetters.length === 0}
          onClick={() => withBusy(() => redriveDeadLetters())}
          className={cn(inputShell, "flex items-center gap-2 px-3 py-2 text-sm disabled:opacity-40")}
          title="Put dead-lettered jobs back on their queue"
        >
          <RefreshCw className="h-4 w-4" />
          Redrive DLQ{deadLetters.length ? ` (${deadLetters.length})` : ""}
        </button> : null}

        {user?.role === "ops_manager" ? <button
          type="button"
          disabled={busy}
          onClick={() => {
            peaks.current = { backlog: 0, workers: 0, throughput: 0 };
            setHistory([]);
            withBusy(() => purgeCompletedJobs());
          }}
          className={cn(inputShell, "flex items-center gap-2 px-3 py-2 text-sm disabled:opacity-40")}
          title="Clear finished jobs and reset the charts before a demo run"
        >
          <Trash2 className="h-4 w-4" />
          Reset counters
        </button> : null}

        <span className="ml-auto text-xs text-slate-500 dark:text-ink-faint">
          peak backlog {peaks.current.backlog} · peak workers {peaks.current.workers} · peak{" "}
          {peaks.current.throughput}/s
        </span>
      </div>

      {/* ── Headline tiles ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-6">
        <Tile
          Icon={Layers}
          label="Queue backlog"
          value={backlog.toLocaleString()}
          hint="ready + in flight"
          tone={backlog > 200 ? "warn" : backlog > 0 ? "active" : "idle"}
        />
        <Tile
          Icon={Cpu}
          label="Workers"
          value={String(workers)}
          hint={scaling ? "scaled out" : "steady state"}
          tone={scaling ? "active" : "idle"}
        />
        <Tile
          Icon={Activity}
          label="Throughput"
          value={`${stats?.totals.throughput ?? 0}/s`}
          hint="jobs completed"
          tone={(stats?.totals.throughput ?? 0) > 0 ? "active" : "idle"}
        />
        <Tile
          Icon={Gauge}
          label="Cache hit rate"
          value={`${stats?.cache.hitRate ?? 0}%`}
          hint={`${stats?.cache.entries ?? 0} keys`}
          tone={(stats?.cache.hitRate ?? 0) > 60 ? "active" : "idle"}
        />
        <Tile
          Icon={AlertTriangle}
          label="Dead letters"
          value={String(stats?.totals.dead ?? 0)}
          hint="exhausted retries"
          tone={(stats?.totals.dead ?? 0) > 0 ? "warn" : "idle"}
        />
        <Tile
          Icon={Zap}
          label="Ingest lag"
          value={`${telemetry?.avgLagMs ?? 0} ms`}
          hint={`${(telemetry?.total ?? 0).toLocaleString()} rows`}
          tone={(telemetry?.avgLagMs ?? 0) > 5000 ? "warn" : "idle"}
        />
      </div>

      {/* ── The money chart ─────────────────────────────────────────────── */}
      <div className={cn(cardShell, "p-4 sm:p-5")}>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">
            Backlog vs. worker count
          </h2>
          <p className="text-xs text-slate-500 dark:text-ink-faint">last {WINDOW}s</p>
        </div>
        <p className="mb-4 max-w-3xl text-xs text-slate-600 dark:text-ink-muted">
          The autoscaler targets ~25 queued jobs per worker. When the backlog area climbs, the
          worker line follows within a couple of seconds; when the queue drains, workers scale back
          down after a cooldown. The API's own latency never changes — it only ever enqueues.
        </p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="backlogFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-700 dark:text-slate-200 dark:text-white/5" />
              <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
              <YAxis yAxisId="left" tick={{ fontSize: 10 }} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} allowDecimals={false} domain={[0, 10]} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                yAxisId="left" type="monotone" dataKey="backlog" name="Queue backlog"
                stroke="#22c55e" strokeWidth={2} fill="url(#backlogFill)" isAnimationActive={false}
              />
              <Line
                yAxisId="right" type="stepAfter" dataKey="workers" name="Workers"
                stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Throughput + latency ────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Jobs completed per second"
          subtitle="Rises as workers are added — this is the capacity the autoscaler bought."
        >
          <LineChart data={history} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-700 dark:text-slate-200 dark:text-white/5" />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={50} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
            <YAxis tick={{ fontSize: 10 }} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="throughput" name="jobs/s" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartCard>

        <ChartCard
          title="Average job latency"
          subtitle="Enqueue → finished. Climbs during a spike, recovers as capacity catches up."
        >
          <LineChart data={history} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-700 dark:text-slate-200 dark:text-white/5" />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={50} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
            <YAxis tick={{ fontSize: 10 }} stroke="currentColor" className="text-slate-400 dark:text-ink-faint" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} ms`, "latency"]} />
            <Line type="monotone" dataKey="latencyMs" name="ms" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartCard>
      </div>

      {/* ── Queues + workers ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={cn(cardShell, "overflow-hidden")}>
          <SectionHeader Icon={Boxes} title="Queues" subtitle="MySQL JOB_QUEUE → Amazon SQS" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Queue</th>
                  <th className="px-3 py-2.5 text-right font-medium">Ready</th>
                  <th className="px-3 py-2.5 text-right font-medium">In flight</th>
                  <th className="px-3 py-2.5 text-right font-medium">Done</th>
                  <th className="px-3 py-2.5 text-right font-medium">Dead</th>
                  <th className="px-4 py-2.5 text-right font-medium">Avg ms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                {(stats?.queues ?? []).map((q) => (
                  <tr key={q.queue}>
                    <td className="px-4 py-2.5 font-medium text-slate-900 dark:text-ink">{q.queue}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{q.ready}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{q.inflight}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 dark:text-ink-muted">{q.done}</td>
                    <td className={cn("px-3 py-2.5 text-right tabular-nums", q.dead > 0 && "text-rose-600 dark:text-rose-400")}>{q.dead}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{q.avgLatencyMs}</td>
                  </tr>
                ))}
                {(stats?.queues ?? []).length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500 dark:text-ink-muted">No jobs yet — run <code>npm run loadtest</code>.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className={cn(cardShell, "overflow-hidden")}>
          <SectionHeader
            Icon={Cpu}
            title={`Workers (${workers} running)`}
            subtitle="Forked Node processes → AWS Lambda / ECS tasks"
          />
          <div className="max-h-[260px] overflow-y-auto">
            {(stats?.workers.nodes ?? []).map((w) => (
              <div key={w.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-sm last:border-0 dark:border-white/5">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                <span className="font-mono text-xs text-slate-900 dark:text-ink">{w.id}</span>
                <span className="text-xs text-slate-500 dark:text-ink-faint">pid {w.pid}</span>
                <span className="ml-auto tabular-nums text-xs text-slate-600 dark:text-ink-muted">
                  {w.processed.toLocaleString()} done
                  {w.failed > 0 ? <span className="text-rose-500"> · {w.failed} failed</span> : null}
                </span>
              </div>
            ))}
            {workers === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-ink-muted">
                No workers running — start them with <code>npm run dev:workers</code>.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Dead letter queue ───────────────────────────────────────────── */}
      {deadLetters.length > 0 ? (
        <div className={cn(cardShell, "overflow-hidden border-rose-500/30")}>
          <SectionHeader
            Icon={AlertTriangle}
            title={`Dead-letter queue (${deadLetters.length})`}
            subtitle="Jobs that exhausted their retries. Fix the cause, then redrive them."
          />
          <div className="max-h-64 overflow-y-auto">
            {deadLetters.map((d) => (
              <div key={d.id} className="border-b border-slate-100 px-4 py-2.5 text-xs last:border-0 dark:border-white/5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-600 dark:text-rose-400">{d.queue}</span>
                  <span className="font-mono text-slate-500 dark:text-ink-faint">#{d.id}</span>
                  <span className="text-slate-500 dark:text-ink-faint">{d.attempts} attempts</span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-slate-600 dark:text-ink-muted">{d.error}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Infrastructure snapshot ─────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <InfoCard Icon={HardDrive} title="Object storage" rows={[
          ["Backend", stats?.storage.backend ?? "—"],
          ["Bucket", stats?.storage.bucket ?? "—"],
          ["Objects", (stats?.storage.objectCount ?? 0).toLocaleString()],
          ["Size", formatBytes(stats?.storage.totalBytes ?? 0)],
        ]} />
        <InfoCard Icon={Database} title="Relational store" rows={[
          ["Telemetry rows", (stats?.data.telemetryRows ?? 0).toLocaleString()],
          ["Attachments", String(stats?.data.attachments ?? 0)],
          ["Invoices", String(stats?.data.invoices ?? 0)],
          ["Pending sessions", String(stats?.data.pendingSessions ?? 0)],
        ]} />
        <InfoCard Icon={Gauge} title="Cache" rows={[
          ["Backend", stats?.cache.backend ?? "—"],
          ["Hits / misses", `${stats?.cache.hits ?? 0} / ${stats?.cache.misses ?? 0}`],
          ["Hit rate", `${stats?.cache.hitRate ?? 0}%`],
          ["Evictions", String(stats?.cache.evictions ?? 0)],
        ]} />
      </div>

      {/* ── Local → cloud mapping ───────────────────────────────────────── */}
      <div className={cn(cardShell, "overflow-hidden")}>
        <SectionHeader
          Icon={Layers}
          title="Milestone 2 migration map"
          subtitle="Every local component and the managed service that replaces it. Served from /api/ops/architecture — the same table that is on slide 2."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Layer</th>
                <th className="px-3 py-2.5 font-medium">Local (Milestone 1)</th>
                <th className="px-3 py-2.5 font-medium">Cloud (Milestone 2)</th>
                <th className="px-4 py-2.5 font-medium">Dimension</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {architecture.map((r) => (
                <tr key={r.layer}>
                  <td className="px-4 py-2.5 font-medium text-slate-900 dark:text-ink">{r.layer}</td>
                  <td className="px-3 py-2.5 text-slate-600 dark:text-ink-muted">{r.local}</td>
                  <td className="px-3 py-2.5 text-slate-600 dark:text-ink-muted">{r.cloud}</td>
                  <td className="px-4 py-2.5">
                    {r.dimension === "-" ? (
                      <span className="text-slate-400 dark:text-ink-faint">—</span>
                    ) : (
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", dimensionTone(r.dimension))}>
                        {r.dimension}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational pieces
// ─────────────────────────────────────────────────────────────────────────────

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  border: "1px solid rgba(148,163,184,0.25)",
  background: "rgba(15,20,25,0.92)",
  color: "#e8eef4",
};

function Tile({
  Icon, label, value, hint, tone,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; hint: string;
  tone: "idle" | "active" | "warn";
}) {
  const toneCls =
    tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "active"
      ? "text-emerald-600 dark:text-accent-glow"
      : "text-slate-900 dark:text-ink";

  return (
    <div className={cn(cardShell, "p-4")}>
      <div className="flex items-center gap-1.5 text-slate-500 dark:text-ink-faint">
        <Icon className="h-3.5 w-3.5" />
        <p className="text-[10px] font-medium uppercase tracking-wider">{label}</p>
      </div>
      <p className={cn("mt-2 font-display text-2xl font-semibold tabular-nums", toneCls)}>{value}</p>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-ink-faint">{hint}</p>
    </div>
  );
}

function SectionHeader({
  Icon, title, subtitle,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  title: string; subtitle: string;
}) {
  return (
    <div className="border-b border-slate-200 px-4 py-3 dark:border-white/5">
      <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-slate-900 dark:text-ink">
        <Icon className="h-4 w-4 opacity-70" />
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-slate-600 dark:text-ink-muted">{subtitle}</p>
    </div>
  );
}

function ChartCard({
  title, subtitle, children,
}: {
  title: string; subtitle: string; children: React.ReactElement;
}) {
  return (
    <div className={cn(cardShell, "p-4 sm:p-5")}>
      <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">{title}</h2>
      <p className="mb-3 mt-0.5 text-xs text-slate-600 dark:text-ink-muted">{subtitle}</p>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

function InfoCard({
  Icon, title, rows,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  title: string; rows: [string, string][];
}) {
  return (
    <div className={cn(cardShell, "p-4")}>
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-slate-900 dark:text-ink">
        <Icon className="h-4 w-4 opacity-70" />
        {title}
      </h3>
      <dl className="mt-3 space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 text-xs">
            <dt className="text-slate-500 dark:text-ink-faint">{k}</dt>
            <dd className="truncate font-medium tabular-nums text-slate-900 dark:text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function dimensionTone(d: string) {
  if (d.startsWith("Async")) return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  if (d.startsWith("Unstructured")) return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
  return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
