// src/pages/ChargerHistory.tsx — everything that has gone wrong with one unit
//
// The page a technician opens before touching a panel, and the page a manager
// opens before signing off another repair on the same charger.
//
// It exists because a work order in isolation says "screen blank" and nothing
// else. The same charger having gone blank three times this quarter is a
// different fact — it turns a repair decision into a replacement decision — and
// no per-job view can show it.
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, MapPin, Wrench } from "lucide-react";
import { apiFetch } from "../api/client";
import { useApi } from "../hooks/useApi";
import { cardShell, cn } from "../lib/cn";
import { StatCard } from "../components/StatCard";

interface HistoryRow {
  id: number;
  issue: string;
  fault_code: string | null;
  severity: string | null;
  status: string;
  reported_at: string | null;
  reported_by: string | null;
  report_source: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  technician_name: string | null;
  repair_hours: number | null;
}

interface HistoryResponse {
  charger: {
    id: number;
    charger_type: string;
    max_kw: number;
    status: string;
    last_maintenance_date: string | null;
    station_id: number;
    station_name: string;
    city: string;
    state: string;
  };
  stats: {
    faults90d: number;
    openNow: number;
    avgRepairHours: number;
    repeatOffender: boolean;
  };
  history: HistoryRow[];
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-rose-500",
  major: "bg-amber-500",
  minor: "bg-slate-400",
};

function date(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ChargerHistory() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useApi(
    () => apiFetch<HistoryResponse>(`/chargers/${id}/history`),
    [id]
  );

  if (loading) return <p className="text-sm text-slate-500 dark:text-ink-muted">Loading history…</p>;
  if (error) {
    return (
      <div className="rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const { charger, stats, history } = data;

  return (
    <div>
      <Link
        to="/chargers"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-ink-muted dark:hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> All chargers
      </Link>

      <div className={cn(cardShell, "mb-6 p-5")}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-ink">
              Charger #{charger.id}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-ink-muted">
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {charger.station_name} · {charger.city}, {charger.state}
              </span>
              <span>{charger.charger_type}</span>
              <span>{charger.max_kw} kW</span>
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium ring-1",
              charger.status === "Out of Service"
                ? "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300"
                : "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-accent-glow"
            )}
          >
            {charger.status}
          </span>
        </div>
      </div>

      {/* A repeat offender is stated, not left for the reader to count rows.
          Four failures in ninety days is a hardware problem, and the whole
          point of gathering this history is to say so out loud. */}
      {stats.repeatOffender ? (
        <div className="mb-6 flex items-start gap-2 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Repeat offender.</strong> {stats.faults90d} faults in the last 90 days. Consider
            replacing the unit rather than repairing it again.
          </span>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Faults (90 days)" value={String(stats.faults90d)} hint="Rejected reports excluded" />
        <StatCard label="Open now" value={String(stats.openNow)} hint="Reported, assigned or in progress" />
        <StatCard
          label="Average repair"
          value={stats.avgRepairHours ? `${stats.avgRepairHours} h` : "—"}
          hint="Report to resolution"
        />
      </div>

      <h2 className="mb-3 font-display text-base font-semibold text-slate-900 dark:text-ink">
        Maintenance history
      </h2>

      {history.length === 0 ? (
        <div className={cn(cardShell, "p-8 text-center")}>
          <Wrench className="mx-auto h-8 w-8 text-slate-300 dark:text-ink-faint" />
          <p className="mt-3 text-sm text-slate-500 dark:text-ink-muted">
            No maintenance has ever been recorded for this charger.
          </p>
        </div>
      ) : (
        <ol className={cn(cardShell, "divide-y divide-slate-200 dark:divide-white/5")}>
          {history.map((h) => (
            <li key={h.id} className="flex gap-3 p-4">
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  SEVERITY_DOT[h.severity ?? "minor"] ?? "bg-slate-400"
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="font-medium text-slate-900 dark:text-ink">{h.issue}</p>
                  <span className="text-xs text-slate-400 dark:text-ink-faint">
                    {date(h.reported_at)}
                    {h.repair_hours != null ? ` · fixed in ${h.repair_hours}h` : ""}
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-ink-muted">
                  <span>#{h.id}</span>
                  <span>{h.status}</span>
                  {h.fault_code ? <span className="font-mono">{h.fault_code}</span> : null}
                  {h.technician_name ? <span>{h.technician_name}</span> : <span>unassigned</span>}
                  {h.report_source ? <span>via {h.report_source}</span> : null}
                </p>
                {/* The notes are the payload of the whole page: what was
                    actually done last time is what makes this visit shorter. */}
                {h.resolution_notes ? (
                  <p className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700 dark:bg-white/5 dark:text-ink-muted">
                    {h.resolution_notes}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
