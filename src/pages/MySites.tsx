// src/pages/MySites.tsx — the site host's home screen
//
// ═════════════════════════════════════════════════════════════════════════════
// WHO A SITE HOST IS
// ═════════════════════════════════════════════════════════════════════════════
// The chargers sit in somebody else's car park: a shopping centre, a hotel, an
// office block. That business is a real user of the platform, but not an
// operator of it. They want two things — how busy were my bays, and what am I
// owed — and they must never see another host's sites, another host's revenue,
// or any driver's identity.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FILTER IS NOT HERE
// ═════════════════════════════════════════════════════════════════════════════
// Nothing on this page filters by company. It could not usefully: rows filtered
// in the browser have already crossed the wire, and a host who opened the
// network tab would read the whole estate. The scoping happens in SQL, from the
// company id signed into the token — see server/lib/scope.js. This page simply
// renders whatever the server was willing to send.
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Building2, Receipt, TrendingUp } from "lucide-react";
import { apiFetch, apiFetchPage } from "../api/client";
import { useApi } from "../hooks/useApi";
import { cardShell, cn } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";

interface Site {
  id: number;
  name: string;
  city: string;
  state: string;
  address: string;
  chargers: number;
  chargersDown: number;
  chargersInUse: number;
  sessions: number;
  energyKwh: number;
  grossRevenue: number;
  hostRevenue: number;
  utilisationPercent: number;
}

interface Performance {
  days: number;
  hostSharePercent: number;
  scopedToCompany: number | null;
  totals: {
    sites: number;
    chargers: number;
    chargersDown: number;
    sessions: number;
    energyKwh: number;
    grossRevenue: number;
    hostRevenue: number;
  };
  sites: Site[];
}

interface WorkOrder {
  id: number;
  station_name: string;
  charger_id: number | null;
  issue_type: string;
  status: string;
  severity: string | null;
  reported_at: string | null;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function MySites() {
  const perf = useApi(() => apiFetch<Performance>("/dashboard/site-performance", { days: 30 }), []);
  // Open work orders on the host's own sites. What is broken in their car park
  // is their business; the same endpoint scopes by company for them.
  const faults = useApi(
    () => apiFetchPage<WorkOrder>("/maintenance", { pageSize: 100 }),
    []
  );

  const open = (faults.data?.items ?? []).filter((w) =>
    ["Reported", "Assigned", "In Progress"].includes(w.status)
  );
  const t = perf.data?.totals;
  // Busiest site sets the scale for the utilisation bars below.
  const busiest = Math.max(...(perf.data?.sites ?? []).map((s) => s.utilisationPercent), 0.01);

  return (
    <div>
      <PageHeader
        subtitle={`Utilisation and revenue for your sites over the last ${perf.data?.days ?? 30} days. Revenue shown is your share at ${perf.data?.hostSharePercent ?? 15}% of session value, not the platform's gross. Driver identities are never included.`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Your revenue"
          value={t ? money(t.hostRevenue) : "—"}
          hint={t ? `${money(t.grossRevenue)} gross session value` : undefined}
        />
        <StatCard
          label="Sessions"
          value={t ? t.sessions.toLocaleString() : "—"}
          hint={t ? `${t.energyKwh.toLocaleString()} kWh delivered` : undefined}
        />
        <StatCard
          label="Bays"
          value={t ? String(t.chargers) : "—"}
          hint={t ? `across ${t.sites} site${t.sites === 1 ? "" : "s"}` : undefined}
        />
        <StatCard
          label="Out of service"
          value={t ? String(t.chargersDown) : "—"}
          hint="Bays earning nothing right now"
          trend={t && t.chargersDown > 0 ? { text: "lost revenue", positive: false } : undefined}
        />
      </div>

      {open.length ? (
        <div className="mb-6 flex items-start gap-2 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>{open.length} open fault{open.length === 1 ? "" : "s"}</strong> across your sites.
            The operator has been notified; each one is tracked below.
          </span>
        </div>
      ) : null}

      <h2 className="mb-3 font-display text-base font-semibold text-slate-900 dark:text-ink">
        Site performance
      </h2>

      {perf.loading ? (
        <p className="text-sm text-slate-500 dark:text-ink-muted">Loading your sites…</p>
      ) : perf.error ? (
        <div className="rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {perf.error}
        </div>
      ) : (perf.data?.sites.length ?? 0) === 0 ? (
        <div className={cn(cardShell, "p-8 text-center")}>
          <Building2 className="mx-auto h-8 w-8 text-slate-300 dark:text-ink-faint" />
          <p className="mt-3 text-sm text-slate-500 dark:text-ink-muted">
            No sites are linked to your account.
          </p>
        </div>
      ) : (
        <div className={cn(cardShell, "overflow-x-auto")}>
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Site</th>
                <th className="px-4 py-3 text-right font-medium">Bays</th>
                <th className="px-4 py-3 text-right font-medium">Utilisation</th>
                <th className="px-4 py-3 text-right font-medium">Sessions</th>
                <th className="px-4 py-3 text-right font-medium">Energy</th>
                <th className="px-4 py-3 text-right font-medium">Your revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-white/5">
              {perf.data!.sites.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900 dark:text-ink">{s.name}</p>
                    <p className="text-xs text-slate-500 dark:text-ink-muted">
                      {s.city}, {s.state}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.chargers}
                    {s.chargersDown ? (
                      <span className="ml-1 text-xs text-rose-600 dark:text-rose-400">
                        ({s.chargersDown} down)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {/* The bar is scaled against the busiest site, not against
                        100%. Utilisation of a charging bay is a small number by
                        nature — a bay in use four hours out of twenty-four is a
                        good day at 17% — so a bar drawn against a full day is a
                        sliver on every row and compares nothing. The exact
                        figure stays beside it for anyone who wants it. */}
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${(s.utilisationPercent / busiest) * 100}%` }}
                        />
                      </div>
                      <span className="w-12 text-right tabular-nums">{s.utilisationPercent}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.sessions.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.energyKwh.toLocaleString()} kWh
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-900 dark:text-ink">
                    {money(s.hostRevenue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Link
        to="/earnings"
        className={cn(
          cardShell,
          "mt-4 flex items-center gap-3 p-4 transition-colors hover:border-emerald-500/40"
        )}
      >
        <Receipt className="h-5 w-5 shrink-0 text-emerald-600 dark:text-accent-glow" />
        <span className="flex-1 text-sm">
          <span className="block font-medium text-slate-900 dark:text-ink">
            See the statement
          </span>
          <span className="text-slate-500 dark:text-ink-muted">
            Earnings by day and by hour, and every session line the total adds up from.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
      </Link>

      <p className="mt-4 flex items-start gap-1.5 text-xs text-slate-500 dark:text-ink-faint">
        <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Utilisation is charging minutes over total bay-minutes in the period, counting every hour
          of the day. A bay out of service still counts against you — that is the revenue the fault
          is costing. Bars are scaled against your busiest site rather than against a full day,
          because a bay is idle most of the time even when a site is doing well.
        </span>
      </p>

      {open.length ? (
        <section className="mt-8">
          <h2 className="mb-3 font-display text-base font-semibold text-slate-900 dark:text-ink">
            Open faults on your sites
          </h2>
          <div className={cn(cardShell, "divide-y divide-slate-200 dark:divide-white/5")}>
            {open.map((w) => (
              <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-slate-900 dark:text-ink">{w.issue_type}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-ink-muted">
                    {w.station_name}
                    {w.charger_id ? ` · Bay #${w.charger_id}` : ""}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
                    w.status === "In Progress"
                      ? "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-accent-glow"
                      : w.status === "Assigned"
                        ? "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300"
                        : "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300"
                  )}
                >
                  {w.status === "Reported" ? "Awaiting engineer" : w.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
