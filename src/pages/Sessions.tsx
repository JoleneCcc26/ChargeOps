import {useMemo, useState} from "react";
import {
  CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatCard }   from "../components/StatCard";
import { useApi }     from "../hooks/useApi";
import { fetchSessionsPage, fetchSessionCountByDay, stopSession, type ChargingSession } from "../api/index";
import { useAuth } from "../context/AuthContext";
import { Square } from "lucide-react";
import { cardShell, cn, inputShell } from "../lib/cn";

const CHART = { line: "#38bdf8", grid: "rgba(148,163,184,0.12)", axis: "#64748b" };
const TT = { backgroundColor: "#1a2332", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", fontSize: "12px" };

const STATUS_BADGE: Record<string, string> = {
  Completed: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40",
  Active:    "bg-sky-500/20     text-sky-700 dark:text-sky-300     ring-sky-500/40",
  Pending:   "bg-amber-500/20   text-amber-700 dark:text-amber-200   ring-amber-500/40",
  Cancelled: "bg-rose-500/20    text-rose-700 dark:text-rose-300    ring-rose-500/40",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_BADGE[status] ?? "bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-slate-400/40";
  return <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", cls)}>{status}</span>;
}

function safeDate(v: string | null | undefined) {
  if (!v) return "—";
  try { return new Date(v).toLocaleString(); } catch { return v; }
}

function Loading() {
  return <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-ink-muted">Loading…</div>;
}
function Err({ msg }: { msg: string }) {
  return <div className="flex h-40 items-center justify-center text-sm text-rose-400">{msg}</div>;
}

/**
 * A figure for a session that has not settled yet.
 *
 * Rendered differently from a final number on purpose: the tilde and the muted
 * weight say "this will move", so nobody reads a running estimate as the amount
 * that was actually charged.
 */
function LiveValue({ main, sub }: { main: string; sub: string }) {
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="text-sky-700 dark:text-sky-300">{main}</span>
      <span className="text-[10px] text-slate-400 dark:text-ink-faint">{sub}</span>
    </span>
  );
}

/** "1h 12m" since a session started, for rows that have not ended yet. */
function elapsed(startedAt: string | null | undefined): string {
  if (!startedAt) return "in progress";
  const mins = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function Sessions() {
  const { user } = useAuth();
  // Only operations can stop a session — the API says the same thing, and a
  // button that always returns 403 is worse than no button.
  const canStop = user?.role === "ops_manager";
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [datePreset,   setDatePreset]   = useState("30");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  // `search` is committed by the search box on Enter (or blur), not on every
  // keystroke, so it already changes rarely. Deferring it further only made
  // the value lag behind what the user submitted.

  const daysParam = datePreset === "all" ? undefined : Number(datePreset);

  const sessions = useApi(
    () => fetchSessionsPage({
      days: daysParam,
      status: statusFilter !== "all" ? statusFilter : undefined,
      search: search || undefined,
      page,
      pageSize,
    }),
    [statusFilter, datePreset, search, page, pageSize]
  );

  const chart = useApi(
    () => fetchSessionCountByDay(daysParam ?? 90),
    [datePreset]
  );

  const rows = sessions.data?.items ?? [];

  const metrics = useMemo(() => {
    const total = sessions.data?.total ?? rows.length;
    // Charging right now, across the whole filtered window rather than the 25
    // rows that happen to be on screen. Counting the page made this tile read
    // "25" next to a total of 142.
    const active = sessions.data?.statusCounts?.Active ?? rows.filter((s) => s.status === "Active").length;
    // Energy includes the running estimate for sessions still in progress,
    // otherwise filtering to "Active" shows 0.0 kWh while 142 cars are charging.
    const energy = rows.reduce((a, s) => a + Number(s.kwh ?? s.estimated_kwh ?? 0), 0);
    // Revenue stays settled-only. An estimate is not money that has been taken.
    const revenue = rows.filter((s) => s.status === "Completed").reduce((a, s) => a + Number(s.cost_usd ?? 0), 0);
    return { total, active, energy, revenue };
  }, [rows, sessions.data?.total]);

  const chartData = useMemo(() =>
    (chart.data ?? []).map((r) => ({
      day:   new Date(r.date).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }),
      count: Number(r.count),
    })),
  [chart.data]);

  /**
   * End a session the way a driver unplugging would.
   *
   * This is the one control on the page, and it is here because the whole
   * asynchronous story is invisible without it: pressing Stop ends the session,
   * frees the charger immediately (one row, and somebody is standing there
   * waiting to leave), and enqueues the billing work. The payment, the invoice
   * PDF and the wallet debit are produced by a worker moments later.
   *
   * The row does not become "Completed" the instant the button returns — it
   * becomes Completed when the worker settles it, which is exactly the point
   * being demonstrated. The 202 says "accepted", not "done".
   */
  async function handleStop(id: string) {
    setStopping(id);
    setStopError(null);
    try {
      await stopSession(Number(id));
      // Two refetches: one now to show the session ended, one after a beat to
      // catch the worker having settled it. Polling forever would be worse
      // than either.
      sessions.refetch();
      setTimeout(() => sessions.refetch(), 2500);
    } catch (e) {
      setStopError(e instanceof Error ? e.message : "Could not stop the session");
    } finally {
      setStopping(null);
    }
  }

  const columns: ColumnDef<ChargingSession>[] = useMemo(() => [
    {
      id: "id", header: "Session ID", sortable: true,
      getSortValue: (s) => String(s.id),
      cell: (s) => <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">{s.id}</span>,
    },
    {
      id: "user_name", header: "Driver", sortable: true,
      getSortValue: (s) => s.user_name,
      cell: (s) => <span className="font-medium">{s.user_name}</span>,
    },
    {
      id: "charger_id", header: "Charger ID", sortable: true,
      getSortValue: (s) => String(s.charger_id),
      cell: (s) => <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">{s.charger_id}</span>,
    },
    {
      id: "station_name", header: "Station", sortable: true,
      getSortValue: (s) => s.station_name,
      cell: (s) => <span className="text-slate-600 dark:text-ink-muted">{s.station_name}</span>,
    },
    {
      id: "started_at", header: "Start Time", sortable: true,
      getSortValue: (s) => s.started_at ?? "",
      cell: (s) => <span className="tabular-nums text-xs">{safeDate(s.started_at)}</span>,
    },
    {
      id: "ended_at", header: "End Time", sortable: true,
      getSortValue: (s) => s.ended_at ?? "",
      cell: (s) => <span className="tabular-nums text-xs">{safeDate(s.ended_at)}</span>,
    },
    {
      id: "kwh", header: "Energy (kWh)", sortable: true,
      headerClassName: "text-right", cellClassName: "text-right tabular-nums",
      getSortValue: (s) => Number(s.kwh),
      // An in-progress session has no energy reading yet — the meter total is
      // only known when the driver unplugs. Printing "0.00" says the session
      // delivered nothing, which is the opposite of what is happening. Show
      // elapsed time instead, so the row reports something true.
      cell: (s) =>
        s.kwh == null
          ? <LiveValue main={`~${Number(s.estimated_kwh ?? 0).toFixed(1)}`} sub={elapsed(s.started_at)} />
          : Number(s.kwh).toFixed(2),
    },
    {
      id: "cost_usd", header: "Total Cost", sortable: true,
      headerClassName: "text-right", cellClassName: "text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400",
      getSortValue: (s) => Number(s.cost_usd),
      // Same reasoning as energy: the bill does not exist until the billing
      // worker settles the session, so "$0.00" would be a false statement.
      cell: (s) =>
        s.cost_usd == null
          ? <LiveValue main={`~$${Number(s.estimated_cost_usd ?? 0).toFixed(2)}`} sub="running" />
          : `$${Number(s.cost_usd).toFixed(2)}`,
    },
    {
      id: "status", header: "Status", sortable: true,
      getSortValue: (s) => s.status,
      cell: (s) => <StatusBadge status={s.status} />,
    },
    ...(canStop
      ? [{
          id: "actions",
          header: "",
          headerClassName: "text-right",
          cellClassName: "text-right",
          cell: (s: ChargingSession) =>
            s.status === "Active" && !s.ended_at ? (
              <button
                type="button"
                disabled={stopping === s.id}
                onClick={() => handleStop(s.id)}
                title="End the session and queue it for billing"
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                <Square className="h-3 w-3 fill-current" />
                {stopping === s.id ? "Stopping…" : "Stop & bill"}
              </button>
            ) : null,
        } as ColumnDef<ChargingSession>]
      : []),
  ], [canStop, stopping]);

  return (
    <div>
      <PageHeader
        subtitle={
          canStop
            ? "Every charging session, live and settled. Stopping one frees the charger immediately and hands the billing to a worker — the payment and the invoice appear a moment later, not in the same request."
            : "Every charging session, live and settled. Running sessions show an estimate; the figure becomes final when the billing worker settles it."
        }
      />

      {stopError ? (
        <div className="mb-4 rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {stopError}
        </div>
      ) : null}

      {/* KPI Cards */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Sessions"   value={String(metrics.total)}               hint="In current filter" />
        <StatCard label="Charging now"     value={String(metrics.active)}             hint="In current filter" />
        <StatCard label="Energy Consumed"  value={`${metrics.energy.toFixed(1)} kWh`}  hint="Incl. in-progress estimate" />
        <StatCard label="Session Revenue"  value={`$${metrics.revenue.toFixed(2)}`}    hint="Settled on this page" />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Session Status</label>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className={inputShell}>
            <option value="all">All statuses</option>
            {/* The three states a charging session can be in. "Active" means
                the car is plugged in and drawing power right now; it used to be
                stored as "Pending", which reads as "has not started yet". */}
            <option value="Active">Active (charging now)</option>
            <option value="Completed">Completed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Date Range</label>
          <select value={datePreset} onChange={(e) => { setDatePreset(e.target.value); setPage(1); }} className={inputShell}>
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </div>
        {sessions.loading ? null : (
          <p className="text-xs text-slate-500 dark:text-ink-faint">{rows.length} on this page · {sessions.data?.total ?? rows.length} total sessions</p>
        )}
      </div>

      {/* Sessions per day chart */}
      <div className={cn(cardShell, "mb-6 p-4 sm:p-5")}>
        <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">Sessions per Day</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-ink-muted">Count by Start_Time date</p>
        <div className="mt-4 h-56 min-h-[200px] w-full sm:h-64">
          {chart.loading ? <Loading /> : chart.error ? <Err msg={chart.error} /> : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="day" tick={{ fill: CHART.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={TT} formatter={(v: number) => [v, "Sessions"]} />
                <Line type="monotone" dataKey="count" stroke={CHART.line} strokeWidth={2} dot={{ fill: CHART.line, r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-ink-muted">
              No session data for this period.
            </div>
          )}
        </div>
      </div>

      {/* Sessions table */}
      {sessions.loading ? <Loading /> : sessions.error ? <Err msg={sessions.error} /> : (
        <DataTable
          title="Charging Sessions"
          description="From charging_session — joined with user, charger, and station tables."
          columns={columns}
          data={rows}
          rowKey={(s) => String(s.id)}
          searchPlaceholder="Search driver, station, status…"
          globalFilter={(s, q) =>
            [String(s.id), s.user_name, s.station_name, String(s.charger_id), s.status]
              .join(" ").toLowerCase().includes(q)
          }
          serverSearch={{ value: search, onChange: (value) => { setSearch(value); setPage(1); } }}
          serverPagination={{
            page,
            pageSize,
            total: sessions.data?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: (value) => { setPageSize(value); setPage(1); },
          }}
          defaultPageSize={25}
          pageSizeOptions={[10, 25, 50, 100]}
          emptyMessage="No sessions found."
        />
      )}
    </div>
  );
}
