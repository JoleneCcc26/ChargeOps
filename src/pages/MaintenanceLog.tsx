// src/pages/MaintenanceLog.tsx — the dispatch board
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SCREEN IS FOR
// ─────────────────────────────────────────────────────────────────────────────
// This used to be a rendering of the maintenance_log table. Every row arrived
// with a technician already in it, because the column was NOT NULL — so there
// was nothing to decide and nothing to do, and the screen read as a database
// viewer wearing a web page.
//
// It is now the operations manager's working queue, laid out around the
// decision rather than around the table:
//
//   1. Awaiting dispatch — reports with nobody assigned. First, because it is
//                          the only part of the screen waiting on a person.
//   2. Work orders       — everything, ordered by what needs attention.
//
// A technician sees the same screen scoped to their own jobs, plus the action
// that matters to them: reporting a fault they are standing in front of.
import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ClipboardList, Inbox, PlayCircle, UserPlus, Wrench, X,
} from "lucide-react";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { useApi } from "../hooks/useApi";
import {
  fetchMaintenancePage, fetchStations, fetchTechnicians,
  assignWorkOrder, startWorkOrder, resolveWorkOrder, rejectWorkOrder, reportFault,
  type MaintenanceLog, type Technician,
} from "../api/index";
import { cardShell, cn, inputShell } from "../lib/cn";
import { useAuth } from "../context/AuthContext";

const STATUS_BADGE: Record<string, string> = {
  Reported:      "bg-rose-500/20    text-rose-700    dark:text-rose-300    ring-rose-500/40",
  Assigned:      "bg-sky-500/20     text-sky-700     dark:text-sky-300     ring-sky-500/40",
  "In Progress": "bg-amber-500/20   text-amber-700   dark:text-amber-200   ring-amber-500/40",
  Resolved:      "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40",
  Rejected:      "bg-slate-500/20   text-slate-700   dark:text-slate-300   ring-slate-400/40",
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-rose-500/15  text-rose-700   dark:text-rose-300",
  major:    "bg-amber-500/15 text-amber-700  dark:text-amber-200",
  minor:    "bg-slate-500/15 text-slate-700  dark:text-slate-300",
};

/** Where a report came from. Managers triage differently depending on it. */
const SOURCE_LABEL: Record<string, string> = {
  telemetry:    "charger self-report",
  field_report: "technician",
  ops_report:   "operations",
  inspection:   "inspection",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1",
      STATUS_BADGE[status] ?? "bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-slate-400/40")}>
      {status}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return <span className="text-xs text-slate-400 dark:text-ink-faint">—</span>;
  return (
    <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
      SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.minor)}>
      {severity}
    </span>
  );
}

function safeDate(v: string | null | undefined) {
  if (!v) return "—";
  try { return new Date(v).toLocaleString(); } catch { return v; }
}

/** How long a report has been waiting — the manager's real metric. */
function ago(v: string | null | undefined) {
  if (!v) return "—";
  const mins = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Loading() {
  return <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-ink-muted">Loading…</div>;
}
function Err({ msg }: { msg: string }) {
  return <div className="flex h-40 items-center justify-center text-sm text-rose-500">{msg}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────

export function MaintenanceLogPage() {
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterStation, setFilterStation] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<MaintenanceLog | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { user } = useAuth();
  const isManager = user?.role === "ops_manager";
  const isTechnician = user?.role === "technician";
  const canAct = Boolean(isManager || isTechnician);

  const logsPage = useApi(
    () => fetchMaintenancePage({
      status: filterStatus !== "all" ? filterStatus : undefined,
      station: filterStation !== "all" ? filterStation : undefined,
      search: search || undefined,
      page,
      pageSize,
    }),
    [filterStatus, filterStation, search, page, pageSize, reloadKey]
  );

  // The dispatch inbox is fetched separately and unfiltered. It must never be
  // hidden behind whichever filter or page the manager happens to be on: it is
  // the one thing on this screen that is blocked on a human.
  const inbox = useApi(
    () => fetchMaintenancePage({ status: "Reported", page: 1, pageSize: 50 }),
    [reloadKey]
  );

  const stations = useApi(() => fetchStations(), []);
  // Fetched per work order, because the ranking depends on where that charger
  // is. A generic technician list cannot tell the manager who is nearby.
  const technicians = useApi(
    () => (assignTarget ? fetchTechnicians(assignTarget.id) : Promise.resolve([])),
    [assignTarget?.id]
  );

  const logs = logsPage.data?.items ?? [];
  const counts = logsPage.data?.statusCounts;
  const awaiting = inbox.data?.items ?? [];

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const run = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const metrics = useMemo(() => {
    const fromPage = (s: string) => logs.filter((m) => m.status === s).length;
    return {
      awaiting: counts?.["Reported"] ?? fromPage("Reported"),
      assigned: counts?.["Assigned"] ?? fromPage("Assigned"),
      active:   counts?.["In Progress"] ?? fromPage("In Progress"),
      resolved: counts?.["Resolved"] ?? fromPage("Resolved"),
    };
  }, [logs, counts]);

  /** The actions available on a row depend on where it is and who you are. */
  const RowActions = useCallback(({ row }: { row: MaintenanceLog }) => {
    const busy = busyId === row.id;
    const mine = String(row.technician_id ?? "") === String(user?.technicianId ?? "-");

    if (row.status === "Reported") {
      return isManager ? (
        <div className="flex gap-1">
          <button type="button" disabled={busy} onClick={() => setAssignTarget(row)}
            className={cn(inputShell, "flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-accent-glow disabled:opacity-40")}>
            <UserPlus className="h-3.5 w-3.5" /> Dispatch
          </button>
          <button type="button" disabled={busy}
            onClick={() => {
              const reason = window.prompt("Why is this report being rejected?");
              if (reason) run(row.id, () => rejectWorkOrder(row.id, reason));
            }}
            className={cn(inputShell, "px-2 py-1 text-xs text-slate-600 dark:text-ink-muted disabled:opacity-40")}>
            Reject
          </button>
        </div>
      ) : <span className="text-xs text-slate-400 dark:text-ink-faint">awaiting dispatch</span>;
    }

    if (row.status === "Assigned" && (isManager || mine)) {
      return (
        <button type="button" disabled={busy} onClick={() => run(row.id, () => startWorkOrder(row.id))}
          className={cn(inputShell, "flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-200 disabled:opacity-40")}>
          <PlayCircle className="h-3.5 w-3.5" /> Start work
        </button>
      );
    }

    if (row.status === "In Progress" && (isManager || mine)) {
      return (
        <button type="button" disabled={busy}
          onClick={() => {
            const notes = window.prompt("What was done?", "Fault cleared on site");
            if (notes !== null) run(row.id, () => resolveWorkOrder(row.id, notes));
          }}
          className={cn(inputShell, "flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-accent-glow disabled:opacity-40")}>
          <CheckCircle2 className="h-3.5 w-3.5" /> Resolve
        </button>
      );
    }

    return <span className="text-xs text-slate-400 dark:text-ink-faint">—</span>;
  }, [busyId, isManager, run, user?.technicianId]);

  const columns: ColumnDef<MaintenanceLog>[] = useMemo(() => [
    {
      id: "id", header: "ID", sortable: true,
      getSortValue: (m) => Number(m.id),
      cell: (m) => <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">{m.id}</span>,
    },
    {
      id: "severity", header: "Severity", sortable: true,
      getSortValue: (m) => ({ critical: 0, major: 1, minor: 2 } as Record<string, number>)[m.severity ?? "minor"] ?? 3,
      cell: (m) => <SeverityBadge severity={m.severity} />,
    },
    {
      id: "issue", header: "Issue", sortable: false,
      cell: (m) => (
        <div className="max-w-sm">
          <p className="text-slate-700 dark:text-ink">{m.issue_type}</p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-ink-faint">
            {m.fault_code ? <span className="font-mono">{m.fault_code}</span> : null}
            {m.fault_code ? " · " : ""}
            {SOURCE_LABEL[m.report_source ?? ""] ?? m.report_source ?? "—"}
            {m.reported_by ? ` · ${m.reported_by}` : ""}
          </p>
        </div>
      ),
    },
    {
      id: "station", header: "Location", sortable: true,
      getSortValue: (m) => m.station_name,
      cell: (m) => (
        <div>
          <p className="text-slate-700 dark:text-ink-muted">{m.station_name}</p>
          <p className="text-[11px] text-slate-500 dark:text-ink-faint">charger #{m.charger_id}</p>
        </div>
      ),
    },
    {
      id: "assignee", header: "Assigned to", sortable: true,
      getSortValue: (m) => m.technician_name ?? "",
      cell: (m) =>
        m.technician_name ? (
          <div>
            <p className="text-slate-700 dark:text-ink">
              {m.technician_name}
              {/* Same reason as the dispatch dialog: names repeat in this
                  fleet, and the id is how the engineer is addressed
                  everywhere else — including their own sign-in. */}
              {m.technician_id ? (
                <span className="ml-1.5 font-mono text-[11px] text-slate-400 dark:text-ink-faint">
                  #{m.technician_id}
                </span>
              ) : null}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-ink-faint">{m.technician_city}</p>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 dark:text-rose-300">
            <Inbox className="h-3 w-3" /> unassigned
          </span>
        ),
    },
    {
      id: "reported_at", header: "Raised", sortable: true,
      getSortValue: (m) => m.reported_at ?? "",
      cell: (m) => (
        <span className="whitespace-nowrap text-xs text-slate-600 dark:text-ink-muted" title={safeDate(m.reported_at)}>
          {ago(m.reported_at)}
        </span>
      ),
    },
    {
      id: "status", header: "Status", sortable: true,
      getSortValue: (m) => m.status,
      cell: (m) => <StatusBadge status={m.status} />,
    },
    ...(canAct ? [{
      id: "actions", header: "Action", sortable: false,
      cell: (m: MaintenanceLog) => <RowActions row={m} />,
    } as ColumnDef<MaintenanceLog>] : []),
  ], [canAct, RowActions]);

  return (
    <div>
      <PageHeader subtitle={
        isTechnician
          ? "Your assigned work. Report a fault you are standing in front of, then move it through to resolved."
          : "Reports arrive unassigned. Log what comes in by phone or alarm, dispatch each one to a technician, then follow it through to the charger returning to service."
      } />

      {error ? (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Awaiting dispatch" value={String(metrics.awaiting)} hint="Nobody assigned yet" />
        <StatCard label="Assigned"          value={String(metrics.assigned)} hint="Waiting for the technician" />
        <StatCard label="In progress"       value={String(metrics.active)}   hint="Technician on site" />
        <StatCard label="Resolved"          value={String(metrics.resolved)} hint="Charger back in service" />
      </div>

      {/* The inbox: the only part of the screen that needs a decision now. */}
      {isManager && awaiting.length > 0 ? (
        <section className={cn(cardShell, "mb-6 ring-1 ring-rose-500/25")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-white/5">
            <Inbox className="h-4 w-4 text-rose-600 dark:text-rose-300" />
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">
              Awaiting dispatch — {awaiting.length}
            </h2>
            <span className="text-xs text-slate-500 dark:text-ink-faint">
              most severe first · nobody is working on these
            </span>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {awaiting.slice(0, 6).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <SeverityBadge severity={m.severity} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-800 dark:text-ink">{m.issue_type}</p>
                  <p className="text-[11px] text-slate-500 dark:text-ink-faint">
                    {m.station_name} · charger #{m.charger_id}
                    {m.fault_code ? <> · <span className="font-mono">{m.fault_code}</span></> : null}
                    {" · "}{SOURCE_LABEL[m.report_source ?? ""] ?? "—"} · {ago(m.reported_at)}
                  </p>
                </div>
                <button type="button" onClick={() => setAssignTarget(m)}
                  className={cn(inputShell, "flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-accent-glow")}>
                  <UserPlus className="h-3.5 w-3.5" /> Dispatch
                </button>
              </li>
            ))}
          </ul>
          {awaiting.length > 6 ? (
            <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-white/5 dark:text-ink-faint">
              and {awaiting.length - 6} more in the table below
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        {canAct ? (
          <button type="button" onClick={() => setReporting(true)}
            className={cn(inputShell, "flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-800 dark:text-ink")}>
            <Wrench className="h-4 w-4" /> Log a work order
          </button>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">Status</span>
          <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }} className={inputShell}>
            <option value="all">All statuses</option>
            <option value="Reported">Reported (awaiting dispatch)</option>
            <option value="Assigned">Assigned</option>
            <option value="In Progress">In progress</option>
            <option value="Resolved">Resolved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">Station</span>
          <select value={filterStation} onChange={(e) => { setFilterStation(e.target.value); setPage(1); }} className={inputShell}>
            <option value="all">All stations</option>
            {(stations.data ?? []).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </label>

        <p className="pb-2 text-xs text-slate-500 dark:text-ink-faint">
          {logs.length} on this page · {logsPage.data?.total ?? 0} work orders
        </p>
      </div>

      {logsPage.loading ? <Loading /> : logsPage.error ? <Err msg={logsPage.error} /> : (
        <DataTable
          title="Work orders"
          description="Ordered by what needs attention: unassigned first, then by severity."
          columns={columns}
          data={logs}
          rowKey={(m) => String(m.id)}
          searchPlaceholder="Search station, issue, fault code…"
          serverSearch={{ value: search, onChange: (value) => { setSearch(value); setPage(1); } }}
          serverPagination={{
            page,
            pageSize,
            total: logsPage.data?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: (value) => { setPageSize(value); setPage(1); },
          }}
          defaultPageSize={25}
          pageSizeOptions={[10, 25, 50, 100]}
          emptyMessage="No work orders match the selected filters."
        />
      )}

      {assignTarget ? (
        <AssignDialog
          workOrder={assignTarget}
          technicians={technicians.data ?? []}
          onClose={() => setAssignTarget(null)}
          onAssign={(technicianId) => {
            const id = assignTarget.id;
            setAssignTarget(null);
            run(id, () => assignWorkOrder(id, technicianId));
          }}
        />
      ) : null}

      {reporting ? (
        <ReportDialog
          onClose={() => setReporting(false)}
          onSubmit={(body) => {
            setReporting(false);
            run("new", () => reportFault(body));
          }}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Choosing who goes.
 *
 * Technicians are listed with their city and current open workload, because
 * those are the two things the decision actually turns on: who is near the site,
 * and who is not already buried. Lightest load is offered first as a sensible
 * default the manager is free to override.
 */
function AssignDialog({
  workOrder, technicians, onClose, onAssign,
}: {
  workOrder: MaintenanceLog;
  technicians: Technician[];
  onClose: () => void;
  onAssign: (technicianId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const ranked = useMemo(() => {
    const list = technicians.filter(
      (t) => !q ||
        t.name.toLowerCase().includes(q) ||
        String(t.id) === q.replace(/^#/, "") ||
        (t.city ?? "").toLowerCase().includes(q) ||
        (t.state ?? "").toLowerCase().includes(q)
    );
    // Nearest first. Distance leads because a technician four states away is
    // the wrong answer however free their day is; workload only breaks ties
    // between people who are equally close.
    return [...list]
      .sort((a, b) => {
        const da = a.distance_km ?? Number.POSITIVE_INFINITY;
        const db = b.distance_km ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
        return Number(a.open_work_orders ?? 0) - Number(b.open_work_orders ?? 0);
      })
      .slice(0, 40);
  }, [technicians, q]);

  return (
    <Modal title="Dispatch this work order" onClose={onClose}>
      <div className="mb-4 rounded-lg bg-slate-100 px-3 py-2 dark:bg-white/5">
        <p className="text-sm text-slate-800 dark:text-ink">{workOrder.issue_type}</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-ink-faint">
          {workOrder.station_name} · charger #{workOrder.charger_id}
          {workOrder.fault_code ? <> · <span className="font-mono">{workOrder.fault_code}</span></> : null}
        </p>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by name, id, city or state…"
        className={cn(inputShell, "mb-2 w-full")}
      />
      <p className="mb-2 text-[11px] text-slate-500 dark:text-ink-faint">
        Nearest to this charger first. Green is within about an hour&apos;s drive;
        red means a technician in another region.
      </p>

      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-white/5">
        {ranked.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => onAssign(Number(t.id))}
              className="flex w-full items-center justify-between gap-3 rounded px-2 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-white/5">
              <span className="min-w-0">
                {/* The id, not just the name.
                    Two engineers in this fleet are both called Aaron Miller,
                    in different states — a name alone does not identify who
                    was dispatched. It is also how you reach them everywhere
                    else in the system: their sign-in is tech<id>. */}
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm text-slate-800 dark:text-ink">{t.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-400 dark:text-ink-faint">
                    #{t.id}
                  </span>
                </span>
                <span className="block text-[11px] text-slate-500 dark:text-ink-faint">
                  {t.city}, {t.state}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs">
                {t.distance_km != null ? (
                  <span className={cn("block font-medium",
                    t.distance_km <= 80
                      ? "text-emerald-700 dark:text-accent-glow"
                      : t.distance_km <= 400
                      ? "text-amber-700 dark:text-amber-200"
                      : "text-rose-700 dark:text-rose-300")}>
                    {t.distance_km < 1 ? "<1 km" : `${Math.round(t.distance_km)} km`}
                  </span>
                ) : null}
                <span className="block text-slate-500 dark:text-ink-faint">
                  {Number(t.open_work_orders ?? 0)} open
                </span>
              </span>
            </button>
          </li>
        ))}
        {ranked.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-slate-500 dark:text-ink-faint">No technicians match.</li>
        ) : null}
      </ul>
    </Modal>
  );
}

/** Raising a fault. The report is created unassigned; dispatch is separate. */
function ReportDialog({
  onClose, onSubmit,
}: {
  onClose: () => void;
  onSubmit: (body: { chargerId: number; issue: string; severity: string; faultCode?: string; source: string; takeOutOfService: boolean }) => void;
}) {
  const [chargerId, setChargerId] = useState("");
  const [issue, setIssue] = useState("");
  const [severity, setSeverity] = useState("major");
  const [faultCode, setFaultCode] = useState("");
  // A manager is not standing in front of the charger, so where the report came
  // from is a real question with a real answer, and it changes how much a
  // dispatcher should trust it. Defaulting to the commonest case rather than
  // making it required: a form that blocks on a dropdown gets abandoned.
  const [source, setSource] = useState("driver_report");

  // Whether to pull the bay, tracked separately from severity.
  //
  // `null` means "follow the severity default"; once the operator touches the
  // switch it holds their answer, so raising severity to critical no longer
  // silently overrides a decision they made on purpose.
  const [pullBay, setPullBay] = useState<boolean | null>(null);
  const takeOutOfService = pullBay ?? severity === "critical";

  const valid = Number(chargerId) > 0 && issue.trim().length >= 5;

  return (
    <Modal title="Log a work order" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">Charger ID</span>
          <input value={chargerId} onChange={(e) => setChargerId(e.target.value)}
            inputMode="numeric" placeholder="e.g. 412" className={cn(inputShell, "mt-1 w-full")} />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">What is wrong?</span>
          <textarea value={issue} onChange={(e) => setIssue(e.target.value)} rows={3}
            placeholder="Connector will not release; driver unable to unplug"
            className={cn(inputShell, "mt-1 w-full resize-none")} />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">Severity</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={cn(inputShell, "mt-1 w-full")}>
              <option value="critical">Critical — take out of service</option>
              <option value="major">Major</option>
              <option value="minor">Minor</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">Fault code (optional)</span>
            <input value={faultCode} onChange={(e) => setFaultCode(e.target.value)}
              placeholder="E-4021" className={cn(inputShell, "mt-1 w-full font-mono")} />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-slate-500 dark:text-ink-faint">How was this reported?</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={cn(inputShell, "mt-1 w-full")}>
            <option value="driver_report">Driver reported it — phone call or app</option>
            <option value="remote_alarm">Remote alarm — the charger reported itself</option>
            <option value="inspection">Found during a scheduled inspection</option>
            <option value="ops_report">Operations noticed it</option>
          </select>
        </label>

        {/* The consequence, as a control rather than a footnote.
            This rule used to live only in prose under the form: a major fault
            left the bay live, and the operator went to the charger list, found
            it still Available, and could not tell the rule from a failure. */}
        <label className={cn(
          "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3",
          takeOutOfService
            ? "border-rose-500/30 bg-rose-500/10"
            : "border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/5"
        )}>
          <input
            type="checkbox"
            checked={takeOutOfService}
            onChange={(e) => setPullBay(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-rose-600"
          />
          <span className="text-sm">
            <span className={cn(
              "block font-medium",
              takeOutOfService ? "text-rose-800 dark:text-rose-300" : "text-slate-800 dark:text-ink"
            )}>
              Take this charger out of service now
            </span>
            <span className="mt-0.5 block text-xs text-slate-600 dark:text-ink-muted">
              {takeOutOfService
                ? "No driver will be routed here until the work order is resolved."
                : "The bay stays live and keeps taking drivers. Right for a noisy fan; wrong for anything unsafe."}
              {severity === "critical" && pullBay === false
                ? " You have overridden the default for a critical fault."
                : ""}
            </span>
            <span className="mt-1 block text-xs text-slate-500 dark:text-ink-faint">
              A session already in progress is never cut off — the bay goes offline when that driver
              unplugs.
            </span>
          </span>
        </label>

        <p className="text-xs text-slate-500 dark:text-ink-faint">
          The report goes to the operations queue unassigned — dispatch is the manager&apos;s call.
        </p>

        <button type="button" disabled={!valid}
          onClick={() => onSubmit({
            chargerId: Number(chargerId),
            issue: issue.trim(),
            severity,
            faultCode: faultCode.trim() || undefined,
            source,
            takeOutOfService,
          })}
          className={cn(inputShell,
            "flex w-full items-center justify-center gap-2 px-3 py-2 text-sm font-medium",
            valid ? "text-emerald-700 dark:text-accent-glow" : "opacity-40")}>
          <ClipboardList className="h-4 w-4" /> Submit report
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className={cn(cardShell, "relative z-10 w-full max-w-lg p-5")}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">{title}</h2>
          <button type="button" onClick={onClose} className={cn(inputShell, "p-1.5")} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
