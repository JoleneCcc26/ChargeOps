// src/pages/Dashboard.tsx — the operations manager's home screen
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT CHANGED, AND WHY
// ═════════════════════════════════════════════════════════════════════════════
// This page used to be a database summary: total users, total stations, total
// membership plans, a pie of charger statuses, a bar of revenue by city. Every
// number was true and none of them changed what anybody did next. That is the
// signature of a report rather than an operations screen.
//
// An operations manager arrives with four questions, in this order:
//
//   1. Is the network up?            → availability, and the trend behind it
//   2. What is broken and waiting?   → the dispatch queue, oldest first
//   3. Are we fixing things fast?    → mean time to repair
//   4. Are we making money today?    → today against yesterday at the same hour
//
// So the page answers those four, then says where to look next: which sites
// break repeatedly, which fault codes cluster, and where they are on a map —
// because a charging network is a geographic business, and a table cannot show
// that three of the four failures are in one city.
//
// The old charts were not deleted, only left where they answer somebody's
// actual question: revenue by city on Payments, the session list on Sessions.
import { Link } from "react-router-dom";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, ArrowRight, Clock, Wrench } from "lucide-react";
import { apiFetch } from "../api/client";
import { useApi } from "../hooks/useApi";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { StationMap, type MapStation } from "../components/StationMap";
import { cardShell, cn } from "../lib/cn";

interface Operations {
  availability: {
    percent: number;
    usable: number;
    total: number;
    breakdown: { available: number; inUse: number; reserved: number; outOfService: number };
  };
  dispatch: {
    awaitingDispatch: number;
    assigned: number;
    inProgress: number;
    criticalWaiting: number;
    longestWaitMinutes: number;
  };
  mttrMinutes: number;
  resolvedLast30Days: number;
  revenue: { today: number; yesterdaySoFar: number; sessionsToday: number };
}

interface TrendPoint {
  date: string;
  chargersDown: number;
  availabilityPercent: number;
}

interface ProblemStation {
  id: number;
  name: string;
  city: string;
  state: string;
  faults_90d: number;
  open_now: number;
  chargers: number;
  faults_per_charger: number;
}

interface FaultCode {
  code: string;
  count: number;
  critical: number;
  stations_affected: number;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Minutes are how the database stores it; hours are how a person reads it. */
function duration(minutes: number): string {
  if (!minutes) return "—";
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

export function Dashboard() {
  const ops = useApi(() => apiFetch<Operations>("/dashboard/operations"), []);
  const trend = useApi(() => apiFetch<TrendPoint[]>("/dashboard/availability-trend", { days: 14 }), []);
  const problems = useApi(() => apiFetch<ProblemStation[]>("/dashboard/problem-stations", { limit: 6 }), []);
  const faults = useApi(() => apiFetch<FaultCode[]>("/dashboard/fault-codes", { limit: 8 }), []);
  const map = useApi(() => apiFetch<MapStation[]>("/dashboard/station-map"), []);

  const o = ops.data;
  // Today against the same elapsed slice of yesterday. Comparing nine hours
  // against a full day would make every morning look like a collapse.
  const revenueDelta =
    o && o.revenue.yesterdaySoFar > 0
      ? ((o.revenue.today - o.revenue.yesterdaySoFar) / o.revenue.yesterdaySoFar) * 100
      : null;

  const queueTotal = o ? o.dispatch.awaitingDispatch + o.dispatch.assigned + o.dispatch.inProgress : 0;
  const faultMax = Math.max(...(faults.data ?? []).map((f) => f.count), 1);

  return (
    <div>
      <PageHeader subtitle="Live state of the network: what fraction of the fleet is usable, what is waiting on a technician, how fast repairs are closing, and what today has earned against the same hour yesterday." />

      {/* ── The four questions ─────────────────────────────────────────── */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Fleet availability"
          value={o ? `${o.availability.percent}%` : "—"}
          hint={o ? `${o.availability.usable} of ${o.availability.total} bays usable` : undefined}
          trend={
            o
              ? o.availability.percent >= 95
                ? { text: "healthy" }
                : { text: `${o.availability.breakdown.outOfService} bays out of service`, positive: false }
              : undefined
          }
        />
        <StatCard
          label="Awaiting dispatch"
          value={o ? String(o.dispatch.awaitingDispatch) : "—"}
          hint={o ? `${o.dispatch.assigned} assigned · ${o.dispatch.inProgress} in progress` : undefined}
          trend={
            o && o.dispatch.criticalWaiting > 0
              ? { text: `${o.dispatch.criticalWaiting} critical unassigned`, positive: false }
              : o && o.dispatch.longestWaitMinutes
                ? { text: `oldest waiting ${duration(o.dispatch.longestWaitMinutes)}` }
                : undefined
          }
        />
        <StatCard
          label="Mean time to repair"
          value={o ? duration(o.mttrMinutes) : "—"}
          hint={o ? `${o.resolvedLast30Days} repairs closed in 30 days` : undefined}
        />
        <StatCard
          label="Revenue today"
          value={o ? money(o.revenue.today) : "—"}
          hint={o ? `${o.revenue.sessionsToday} sessions settled` : undefined}
          trend={
            revenueDelta == null
              ? undefined
              : {
                  text: `${revenueDelta >= 0 ? "+" : ""}${revenueDelta.toFixed(0)}% vs yesterday at this hour`,
                  positive: revenueDelta >= 0,
                }
          }
        />
      </div>

      {/* Critical work sitting unassigned is the one thing on this page worth
          interrupting the reader for — so it is a link, not a notice. */}
      {o && o.dispatch.criticalWaiting > 0 ? (
        <Link
          to="/maintenance"
          className="mb-6 flex items-start gap-2 rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-500/20 transition-colors hover:bg-rose-500/15 dark:text-rose-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">
            <strong>
              {o.dispatch.criticalWaiting} critical fault
              {o.dispatch.criticalWaiting === 1 ? "" : "s"} with no technician assigned.
            </strong>{" "}
            Oldest has waited {duration(o.dispatch.longestWaitMinutes)}.
          </span>
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0" />
        </Link>
      ) : null}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        {/* ── Availability trend ───────────────────────────────────────── */}
        <section className={cn(cardShell, "p-5 lg:col-span-2")}>
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-ink">
            Availability · last 14 days
          </h2>
          <p className="mb-4 text-sm text-slate-500 dark:text-ink-muted">
            One reading is a status; a line says whether today is a recovery or the start of a slide.
          </p>
          <div className="h-64">
            {trend.loading ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-ink-muted">
                Loading…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend.data ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d: string) =>
                      new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                    }
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  {/* The axis starts below the worst reading rather than at
                      zero. Availability lives between 90% and 100%, and a
                      zero-based axis would draw every day as the same flat line
                      pinned to the top of the chart. */}
                  <YAxis
                    domain={[(min: number) => Math.floor(Math.min(min, 95)) - 1, 100]}
                    unit="%"
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1a2332",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => new Date(String(d)).toLocaleDateString()}
                    formatter={(v: number) => [`${v}%`, "Availability"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="availabilityPercent"
                    name="Availability"
                    stroke="#10b981"
                    strokeWidth={0}
                    fill="#10b981"
                    fillOpacity={0.14}
                  />
                  <Line
                    type="monotone"
                    dataKey="availabilityPercent"
                    name="Availability"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* ── Fault codes ──────────────────────────────────────────────── */}
        <section className={cn(cardShell, "p-5")}>
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-ink">
            What is breaking
          </h2>
          <p className="mb-4 text-sm text-slate-500 dark:text-ink-muted">
            Codes, not prose — one code across many sites is a firmware bug or a warranty claim.
          </p>
          <ul className="space-y-2.5">
            {(faults.data ?? []).map((f) => (
              <li key={f.code}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate font-mono text-xs text-slate-700 dark:text-ink">
                    {f.code}
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-500 dark:text-ink-muted">
                    {f.count}
                    {f.critical ? (
                      <span className="ml-1 text-rose-600 dark:text-rose-400">({f.critical} crit)</span>
                    ) : null}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                  <div
                    className={cn("h-full rounded-full", f.critical ? "bg-rose-500" : "bg-amber-500")}
                    style={{ width: `${(f.count / faultMax) * 100}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400 dark:text-ink-faint">
                  {f.stations_affected} site{f.stations_affected === 1 ? "" : "s"} affected
                </p>
              </li>
            ))}
            {!faults.loading && (faults.data ?? []).length === 0 ? (
              <li className="text-sm text-slate-500 dark:text-ink-muted">
                No faults recorded in the last 90 days.
              </li>
            ) : null}
          </ul>
        </section>
      </div>

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <section className={cn(cardShell, "mb-6 overflow-hidden")}>
        <div className="p-5 pb-3">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-ink">
            Network map
          </h2>
          <p className="text-sm text-slate-500 dark:text-ink-muted">
            Sites sized by bay count, coloured by availability. Failures clustering in one city are a
            different problem from failures scattered across the estate.
          </p>
        </div>
        <StationMap stations={map.data ?? []} loading={map.loading} />
      </section>

      {/* ── Problem stations ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-1 font-display text-base font-semibold text-slate-900 dark:text-ink">
          Sites that keep breaking
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-ink-muted">
          Ranked by faults in the last 90 days. Faults per bay is the column that matters — a
          fourteen-bay site should not be flagged simply for being large.
        </p>
        <div className={cn(cardShell, "overflow-x-auto")}>
          <table className="w-full min-w-[600px] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Site</th>
                <th className="px-4 py-3 text-right font-medium">Bays</th>
                <th className="px-4 py-3 text-right font-medium">Faults (90d)</th>
                <th className="px-4 py-3 text-right font-medium">Per bay</th>
                <th className="px-4 py-3 text-right font-medium">Open now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-white/5">
              {(problems.data ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900 dark:text-ink">{p.name}</p>
                    <p className="text-xs text-slate-500 dark:text-ink-muted">
                      {p.city}, {p.state}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.chargers}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.faults_90d}</td>
                  <td
                    className={cn(
                      "px-4 py-3 text-right tabular-nums",
                      p.faults_per_charger >= 1 ? "font-medium text-rose-600 dark:text-rose-400" : ""
                    )}
                  >
                    {p.faults_per_charger.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {p.open_now ? (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                        <Wrench className="h-3.5 w-3.5" />
                        {p.open_now}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-400 dark:text-ink-faint">
        <Clock className="h-3.5 w-3.5" />
        {queueTotal} work order{queueTotal === 1 ? "" : "s"} currently open across the network.
      </p>
    </div>
  );
}
