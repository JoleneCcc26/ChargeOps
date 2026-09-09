import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Building2, PlugZap } from "lucide-react";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { useApi } from "../hooks/useApi";
import { fetchStations, type Station } from "../api/index";
import { cardShell, cn, inputShell } from "../lib/cn";

// ── Status badge keyed on Station_Status values from MySQL ────────────────────
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  Open:        { label: "Open",        cls: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40" },
  Closed:      { label: "Closed",      cls: "bg-rose-500/20    text-rose-700 dark:text-rose-300    ring-rose-500/40"    },
  Maintenance: { label: "Maintenance", cls: "bg-amber-500/20   text-amber-700 dark:text-amber-200   ring-amber-500/40"   },
};

function StatusBadge({ status }: { status: string }) {
  const b = STATUS_BADGE[status] ?? { label: status, cls: "bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-slate-400/40" };
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", b.cls)}>
      {b.label}
    </span>
  );
}

function Loading() {
  return <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-ink-muted">Loading…</div>;
}
function Err({ msg }: { msg: string }) {
  return <div className="flex h-40 items-center justify-center text-sm text-rose-400">{msg}</div>;
}

export function Stations() {
  const navigate = useNavigate();
  // The host filter lives in the URL rather than in component state, so a
  // filtered view can be linked to, bookmarked and reached with the back
  // button. Filters that only exist in memory are filters you cannot share.
  const [params, setParams] = useSearchParams();
  const hostFilter = params.get("host") ?? "all";
  const setHostFilter = (host: string) => {
    const next = new URLSearchParams(params);
    if (host === "all") next.delete("host");
    else next.set("host", host);
    setParams(next, { replace: true });
  };

  const [stateFilter,  setStateFilter]  = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data, loading, error } = useApi(fetchStations, []);
  const stations = data ?? [];

  const stateOptions = useMemo(() => [...new Set(stations.map((s) => s.state))].sort(), [stations]);

  /**
   * One entry per site host, with what they own.
   *
   * Derived from the stations already on the page rather than fetched: the
   * data is here, and a second request to count rows this component is holding
   * would be a round trip to learn something it already knows.
   */
  const hosts = useMemo(() => {
    const byHost = new Map<string, { name: string; sites: number; bays: number; states: Set<string> }>();
    for (const st of stations) {
      const key = st.company_name;
      const entry = byHost.get(key) ?? { name: key, sites: 0, bays: 0, states: new Set<string>() };
      entry.sites += 1;
      entry.bays += Number(st.total_slots) || 0;
      entry.states.add(st.state);
      byHost.set(key, entry);
    }
    return [...byHost.values()].sort((a, b) => b.sites - a.sites);
  }, [stations]);

  const filtered = useMemo(() => stations.filter((s) => {
    if (hostFilter   !== "all" && s.company_name       !== hostFilter)   return false;
    if (stateFilter  !== "all" && s.state              !== stateFilter)  return false;
    if (statusFilter !== "all" && s.operational_status !== statusFilter) return false;
    return true;
  }), [stations, hostFilter, stateFilter, statusFilter]);

  const columns: ColumnDef<Station>[] = useMemo(() => [
    {
      id: "id", header: "Station ID", sortable: true,
      getSortValue: (s) => String(s.id),
      cell: (s) => <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">{s.id}</span>,
    },
    {
      id: "name", header: "Station Name", sortable: true,
      getSortValue: (s) => s.name,
      cell: (s) => <span className="font-medium text-slate-900 dark:text-ink">{s.name}</span>,
    },
    {
      // "Host", not "Company". ChargeOps owns the chargers; this names the
      // business whose car park they stand in, and calling that a company
      // invited the reading that the platform manages rival operators.
      id: "host", header: "Site host", sortable: true,
      getSortValue: (s) => s.company_name,
      cell: (s) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setHostFilter(s.company_name); }}
          className="text-left text-slate-600 hover:text-emerald-700 hover:underline dark:text-ink-muted dark:hover:text-accent-glow"
        >
          {s.company_name}
        </button>
      ),
    },
    {
      id: "city", header: "City", sortable: true,
      getSortValue: (s) => s.city_name,
      cell: (s) => <span className="text-slate-600 dark:text-ink-muted">{s.city_name}</span>,
    },
    {
      id: "state", header: "State", sortable: true,
      getSortValue: (s) => s.state,
      cell: (s) => <span className="text-slate-600 dark:text-ink-muted">{s.state}</span>,
    },
    {
      id: "zip", header: "ZIP", sortable: true,
      getSortValue: (s) => s.zip,
      cell: (s) => <span className="tabular-nums text-slate-600 dark:text-ink-muted">{s.zip}</span>,
    },
    {
      id: "slots", header: "Total Slots", sortable: true,
      headerClassName: "text-right", cellClassName: "text-right tabular-nums",
      getSortValue: (s) => Number(s.total_slots),
      cell: (s) => <span className="font-medium">{s.total_slots}</span>,
    },
    {
      id: "status", header: "Status", sortable: true,
      getSortValue: (s) => s.operational_status,
      cell: (s) => <StatusBadge status={s.operational_status} />,
    },
    {
      id: "hours", header: "Opening Hours", sortable: true,
      getSortValue: (s) => s.opening_hours,
      cellClassName: "text-xs max-w-[200px]",
      cell: (s) => <span className="text-slate-600 dark:text-ink-muted">{s.opening_hours}</span>,
    },
  ], []);

  return (
    <div>
      <PageHeader subtitle="Every site on the network, grouped by the host whose land it stands on. Pick a host to narrow the list, then open a station to see the bays at it." />

      {loading ? <Loading /> : error ? <Err msg={error} /> : (
        <>
          {/* Summary strip */}
          <div className={cn(cardShell, "mb-6 flex flex-wrap gap-4 px-4 py-3 sm:px-5")}>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-ink-faint">Total Stations</p>
              <p className="font-display text-xl font-semibold text-slate-900 dark:text-ink">{stations.length}</p>
            </div>
            {Object.entries(STATUS_BADGE).map(([key, b]) => (
              <div key={key}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-ink-faint">{b.label}</p>
                <p className="font-display text-xl font-semibold text-slate-900 dark:text-ink">
                  {stations.filter((s) => s.operational_status === key).length}
                </p>
              </div>
            ))}
          </div>

          {/* ── Site hosts ─────────────────────────────────────────────────
              A row of cards rather than another dropdown.

              The estate divides by landlord before it divides by anything
              else — a hotel group's bays behave nothing like a logistics
              park's — so the split is worth showing rather than hiding one
              level down in a select. Each card is also the first step of the
              only path anyone actually walks here: host, then their sites,
              then the bays at one of them. */}
          <div className="mb-5">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">
                Site hosts
              </h2>
              {hostFilter !== "all" ? (
                <button
                  type="button"
                  onClick={() => setHostFilter("all")}
                  className="text-xs font-medium text-emerald-700 hover:underline dark:text-accent-glow"
                >
                  Show all {stations.length} stations
                </button>
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {hosts.map((h) => {
                const active = hostFilter === h.name;
                return (
                  <button
                    key={h.name}
                    type="button"
                    onClick={() => setHostFilter(active ? "all" : h.name)}
                    aria-pressed={active}
                    className={cn(
                      "flex flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      active
                        ? "border-emerald-500/50 bg-emerald-500/10 dark:border-accent/40 dark:bg-accent/10"
                        : "border-slate-200 bg-white hover:border-emerald-500/30 dark:border-white/5 dark:bg-surface-raised/80 dark:hover:border-accent/25"
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <Building2
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          active ? "text-emerald-600 dark:text-accent-glow" : "text-slate-400 dark:text-ink-faint"
                        )}
                        aria-hidden
                      />
                      <span
                        className={cn(
                          "truncate text-xs font-medium",
                          active ? "text-emerald-800 dark:text-accent-glow" : "text-slate-800 dark:text-ink"
                        )}
                        title={h.name}
                      >
                        {h.name}
                      </span>
                    </span>
                    <span className="text-[11px] tabular-nums text-slate-500 dark:text-ink-muted">
                      {h.sites} site{h.sites === 1 ? "" : "s"} · {h.bays} bays
                    </span>
                    <span className="truncate text-[11px] text-slate-400 dark:text-ink-faint">
                      {[...h.states].sort().join(" · ")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">State</label>
              <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className={inputShell}>
                <option value="all">All states</option>
                {stateOptions.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Status</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputShell}>
                <option value="all">All statuses</option>
                <option value="Open">Open</option>
                <option value="Closed">Closed</option>
                <option value="Maintenance">Maintenance</option>
              </select>
            </div>
            <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-ink-faint">
              {filtered.length} of {stations.length} stations
              <span className="hidden items-center gap-0.5 text-slate-400 dark:text-ink-faint sm:inline-flex">
                · open one for its bays <PlugZap className="h-3 w-3" aria-hidden />
              </span>
            </p>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            rowKey={(s) => String(s.id)}
            // Clicking a station goes to its bays. The chargers page already
            // filters by station id, so this is the drill-down the data
            // always supported and nothing exposed: host, site, bay.
            onRowClick={(st) => navigate(`/chargers?stationId=${st.id}`)}
            searchPlaceholder="Search station, host, city, state…"
            globalFilter={(s, q) =>
              [s.name, s.company_name, s.city_name, s.state, s.zip, s.operational_status, s.opening_hours]
                .join(" ").toLowerCase().includes(q)
            }
            emptyMessage="No stations match the selected filters."
          />
        </>
      )}
    </div>
  );
}
