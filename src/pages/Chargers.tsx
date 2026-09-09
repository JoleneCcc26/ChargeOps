import {useMemo, useState} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, MapPin } from "lucide-react";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { useApi } from "../hooks/useApi";
import { fetchChargersPage, updateChargerStatus, type Charger } from "../api/index";
import { cardShell, cn, inputShell } from "../lib/cn";
import { useAuth } from "../context/AuthContext";

// ── Badges keyed on Charger_Availability_Status values from MySQL ─────────────
const AVAIL_BADGE: Record<string, { cls: string }> = {
  Available:   { cls: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40" },
  "In Use":    { cls: "bg-sky-500/20     text-sky-700 dark:text-sky-300     ring-sky-500/40"     },
  "Out of Service": { cls: "bg-rose-500/20 text-rose-700 dark:text-rose-300 ring-rose-500/40" },
  Reserved: { cls: "bg-amber-500/20 text-amber-700 dark:text-amber-200 ring-amber-500/40" },
};

function AvailBadge({ status }: { status: string }) {
  const b = AVAIL_BADGE[status] ?? { cls: "bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-slate-400/40" };
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", b.cls)}>
      {status}
    </span>
  );
}

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  try { return new Date(v).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return v; }
}

function Loading() {
  return <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-ink-muted">Loading…</div>;
}
function Err({ msg }: { msg: string }) {
  return <div className="flex h-40 items-center justify-center text-sm text-rose-400">{msg}</div>;
}

export function Chargers() {
  const [filterType,   setFilterType]   = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // `search` is committed by the search box on Enter (or blur), not on every
  // keystroke, so it already changes rarely. Deferring it further only made
  // the value lag behind what the user submitted.
  const { user } = useAuth();

  // Which station we drilled into, if any.
  //
  // Read from the URL rather than held in state so /chargers?stationId=25 is a
  // real address: linkable from the stations table, survives a refresh, and
  // comes back with the browser's back button. A drill-down that only exists
  // in memory is one the user cannot retrace.
  const [params, setParams] = useSearchParams();
  const stationId = params.get("stationId") ?? undefined;
  const clearStation = () => {
    const next = new URLSearchParams(params);
    next.delete("stationId");
    setParams(next, { replace: true });
  };

  const query = useApi(
    () => fetchChargersPage({
      stationId,
      type: filterType !== "all" ? filterType : undefined,
      status: filterStatus !== "all" ? filterStatus : undefined,
      search: search || undefined,
      page,
      pageSize,
    }),
    [stationId, filterType, filterStatus, search, page, pageSize]
  );
  const chargers = query.data?.items ?? [];
  const filtered = chargers;
  const { loading, error } = query;

  // Availability breakdown for the whole filtered fleet.
  //
  // Deliberately NOT computed from `filtered`, which is one page of 25 rows.
  // Counting the page and showing it beside a fleet-wide total produced tiles
  // reading "In Use 5" while 143 chargers were charging. The server sends the
  // real breakdown; the page-derived version is only a fallback for a response
  // that predates the header.
  const counts = useMemo(() => {
    if (query.data?.statusCounts) return query.data.statusCounts;
    const map: Record<string, number> = {};
    for (const c of filtered) map[c.status] = (map[c.status] ?? 0) + 1;
    return map;
  }, [query.data?.statusCounts, filtered]);

  // Charger types from filtered data
  const typeOptions = ["DC Fast", "Level 2"];
  const statusOptions = ["Available", "In Use", "Out of Service", "Reserved"];

  async function changeAvailability(charger: Charger) {
    const disabling = charger.status !== "Out of Service";
    const reason = disabling ? window.prompt("Why is this charger being taken out of service?", "Manual operations hold") : "Returned to service by operations";
    if (reason == null) return;
    setActionError(null);
    try {
      await updateChargerStatus(charger.id, disabling ? "Out of Service" : "Available", reason);
      query.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Status update failed");
    }
  }

  const columns: ColumnDef<Charger>[] = useMemo(() => [
    {
      id: "id", header: "Charger ID", sortable: true,
      getSortValue: (c) => String(c.id),
      cell: (c) => <span className="font-mono text-xs">{c.id}</span>,
    },
    {
      id: "station", header: "Station", sortable: true,
      getSortValue: (c) => c.station_name,
      cell: (c) => <span className="text-slate-600 dark:text-ink-muted">{c.station_name}</span>,
    },
    {
      id: "type", header: "Charger Type", sortable: true,
      getSortValue: (c) => c.charger_type,
      cell: (c) => <span className="text-slate-600 dark:text-ink-muted">{c.charger_type}</span>,
    },
    {
      id: "kw", header: "Power (kW)", sortable: true,
      headerClassName: "text-right", cellClassName: "text-right tabular-nums",
      getSortValue: (c) => Number(c.max_kw),
      cell: (c) => Number(c.max_kw).toFixed(1),
    },
    {
      id: "rate", header: "Rate / kWh", sortable: true,
      headerClassName: "text-right", cellClassName: "text-right tabular-nums",
      getSortValue: (c) => Number(c.rate_per_kwh),
      cell: (c) => `$${Number(c.rate_per_kwh).toFixed(2)}`,
    },
    {
      id: "status", header: "Availability", sortable: true,
      getSortValue: (c) => c.status,
      cell: (c) => <AvailBadge status={c.status} />,
    },
    {
      id: "maint", header: "Last Maintenance", sortable: true,
      getSortValue: (c) => c.last_maintenance_date ?? "",
      cell: (c) => (
        <span className="tabular-nums text-xs text-slate-600 dark:text-ink-muted">
          {formatDate(c.last_maintenance_date)}
        </span>
      ),
    },
    ...(user?.role === "ops_manager" ? [{
      id: "actions", header: "Actions",
      cell: (c: Charger) => (
        <button
          type="button"
          onClick={() => changeAvailability(c)}
          className={c.status === "Out of Service"
            ? "rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300"
            : "rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300"}
        >
          {c.status === "Out of Service" ? "Restore" : "Disable"}
        </button>
      ),
    } as ColumnDef<Charger>] : []),
  ], [user?.role]);

  return (
    <div>
      <PageHeader subtitle="Every bay on the network — power, price, availability and when it was last serviced." />

      {/* Where you came from, and the way back.
          A filtered list that does not say it is filtered is the reason people
          report "the chargers are missing". The station name comes from the
          rows themselves, so this needs no extra request. */}
      {stationId ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-emerald-700 dark:text-accent-glow" aria-hidden />
          <span className="flex-1 text-slate-800 dark:text-ink">
            Bays at{" "}
            <strong>{chargers[0]?.station_name ?? `station #${stationId}`}</strong>
            {query.data?.total != null ? ` · ${query.data.total} of them` : ""}
          </span>
          <button
            type="button"
            onClick={clearStation}
            className="text-xs font-medium text-emerald-800 hover:underline dark:text-accent-glow"
          >
            Show the whole fleet
          </button>
          <Link
            to="/stations"
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:underline dark:text-ink-muted"
          >
            <ArrowLeft className="h-3 w-3" /> Stations
          </Link>
        </div>
      ) : null}

      {loading ? <Loading /> : error ? <Err msg={error} /> : (
        <>
          {/* Summary strip */}
          <div className={cn(cardShell, "mb-6 flex flex-wrap gap-4 px-4 py-3 sm:px-5")}>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-ink-faint">Total Chargers</p>
              <p className="font-display text-xl font-semibold tabular-nums text-slate-900 dark:text-ink">{query.data?.total ?? filtered.length}</p>
            </div>
            {Object.entries(counts).map(([status, count]) => {
              const b = AVAIL_BADGE[status];
              return (
                <div key={status} className={cn("flex flex-col gap-0.5 rounded-lg px-3 py-2 ring-1",
                  status === "Available"   ? "bg-emerald-500/10 ring-emerald-500/20" :
                  status === "In Use"      ? "bg-sky-500/10     ring-sky-500/20"     :
                  status === "Out of Service" ? "bg-rose-500/10 ring-rose-500/20" :
                                            "bg-amber-500/10   ring-amber-500/20"
                )}>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-ink-faint">{status}</span>
                  <span className={cn("font-display text-xl font-semibold tabular-nums", b ? b.cls.split(" ")[1] : "text-slate-900 dark:text-ink")}>{count}</span>
                </div>
              );
            })}
          </div>

          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Charger Type</label>
              <select value={filterType} onChange={(e) => { setFilterType(e.target.value); setPage(1); }} className={inputShell}>
                <option value="all">All types</option>
                {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Availability</label>
              <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }} className={inputShell}>
                <option value="all">All statuses</option>
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <p className="text-xs text-slate-500 dark:text-ink-faint">
              {chargers.length} on this page · {query.data?.total ?? chargers.length} total chargers
            </p>
          </div>
          {actionError ? <p className="mb-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-500 ring-1 ring-rose-500/20">{actionError}</p> : null}

          <DataTable
            columns={columns}
            data={filtered}
            rowKey={(c) => String(c.id)}
            searchPlaceholder="Search charger, station, type, status…"
            globalFilter={(c, q) =>
              [String(c.id), c.station_name, c.charger_type, c.status, formatDate(c.last_maintenance_date)]
                .join(" ").toLowerCase().includes(q)
            }
            serverSearch={{ value: search, onChange: (value) => { setSearch(value); setPage(1); } }}
            serverPagination={{
              page,
              pageSize,
              total: query.data?.total ?? 0,
              onPageChange: setPage,
              onPageSizeChange: (value) => { setPageSize(value); setPage(1); },
            }}
            defaultPageSize={25}
            pageSizeOptions={[10, 25, 50, 100]}
            emptyMessage="No chargers match the selected filters."
          />
        </>
      )}
    </div>
  );
}
