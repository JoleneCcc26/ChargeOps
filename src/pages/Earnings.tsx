// src/pages/Earnings.tsx — the site host's statement
//
// ═════════════════════════════════════════════════════════════════════════════
// A STATEMENT, NOT A DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
// This lived at the bottom of "My sites", below the fault list, which is the
// wrong place for it twice over. A landlord asks two separate questions at two
// separate times — "are my sites working?" on any given day, and "what am I
// owed, and can I see the lines?" at the end of a month. Scrolling past a
// dispatch queue to reach an invoice is not how either one gets answered.
//
// So this page answers only the second, and answers it the way a statement
// does: the total, how it moved, when it was earned, and every line it adds up
// from. "Trust me, it is $11,901" is not something anybody signs off.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS DELIBERATELY ABSENT
// ═════════════════════════════════════════════════════════════════════════════
// No driver name, email or id, at any level of detail — not filtered out here,
// never selected by the endpoint. The host owns the car park; the drivers are
// ChargeOps' customers, and in most jurisdictions handing their identities to a
// landlord is a privacy breach rather than merely bad manners.
//
// The lines are still specific enough to audit: which bay, when, how long, how
// much energy, what it earned. Everything a landlord needs and nothing that
// belongs to somebody else.
import { useState } from "react";
import {
  Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Receipt } from "lucide-react";
import { apiFetch } from "../api/client";
import { useApi } from "../hooks/useApi";
import { cardShell, cn } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";

interface Earnings {
  days: number;
  hostSharePercent: number;
  daily: { date: string; sessions: number; kwh: number; gross: number; yours: number }[];
  byHour: { hour: number; sessions: number; yours: number }[];
  lines: {
    id: number;
    station: string;
    chargerId: number;
    chargerType: string;
    endedAt: string;
    minutes: number;
    kwh: number;
    rate: number;
    gross: number;
    yours: number;
  }[];
  lineLimit: number;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function Earnings() {
  const earnings = useApi(() => apiFetch<Earnings>("/dashboard/host-earnings", { days: 30 }), []);
  const [showAllLines, setShowAllLines] = useState(false);

  const daily = earnings.data?.daily ?? [];
  const totalYours = daily.reduce((a, d) => a + d.yours, 0);
  const totalGross = daily.reduce((a, d) => a + d.gross, 0);
  const totalKwh = daily.reduce((a, d) => a + d.kwh, 0);
  const totalSessions = daily.reduce((a, d) => a + d.sessions, 0);

  // The hour that earned most, which is the single most actionable fact here.
  const peak = (earnings.data?.byHour ?? []).reduce(
    (best, h) => (h.yours > (best?.yours ?? -1) ? h : best),
    null as { hour: number; sessions: number; yours: number } | null
  );

  return (
    <div>
      <PageHeader
        subtitle={`Your share of what the bays earned over the last ${earnings.data?.days ?? 30} days, at ${earnings.data?.hostSharePercent ?? 15}% of session value. Every line below is auditable; no driver is named on any of them.`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Your share"
          value={money(totalYours)}
          hint={`${money(totalGross)} gross session value`}
        />
        <StatCard label="Sessions" value={totalSessions.toLocaleString()} hint="Completed and billed" />
        <StatCard
          label="Energy sold"
          value={`${Math.round(totalKwh).toLocaleString()} kWh`}
          hint="Across all your bays"
        />
        <StatCard
          label="Best hour"
          value={peak && peak.yours > 0 ? `${String(peak.hour).padStart(2, "0")}:00` : "—"}
          hint={peak && peak.yours > 0 ? `${money(peak.yours)} earned in that hour` : undefined}
        />
      </div>

      {/* ── Earnings over time ──────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold text-slate-900 dark:text-ink">
          What your bays earned
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-ink-muted">
          Your share by day, with session count behind it. A day where sessions rose and earnings
          did not means shorter charges, not fewer drivers.
        </p>
        <div className={cn(cardShell, "p-5")}>
          <div className="h-56">
            {earnings.loading ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-ink-muted">
                Loading…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={earnings.data?.daily ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
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
                  <YAxis
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1a2332",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => new Date(String(d)).toLocaleDateString()}
                    formatter={(v: number, name) =>
                      name === "Your share" ? [money(v), name] : [v, name]
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="yours"
                    name="Your share"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="#10b981"
                    fillOpacity={0.14}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* ── When the bays earn ──────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold text-slate-900 dark:text-ink">
          When your bays earn
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-ink-muted">
          Earnings by hour of day. This is the number worth acting on: a site that only earns
          between 17:00 and 19:00 is a site that needs more bays at that hour, not more bays.
        </p>
        <div className={cn(cardShell, "p-5")}>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={earnings.data?.byHour ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" vertical={false} />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h: number) => `${String(h).padStart(2, "0")}`}
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1a2332",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(h) => `${String(h).padStart(2, "0")}:00 – ${String(h).padStart(2, "0")}:59`}
                  formatter={(v: number, name) => [name === "Your share" ? money(v) : v, name]}
                />
                <Bar dataKey="yours" name="Your share" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* ── The line items ──────────────────────────────────────────────── */}
      <section className="mt-8">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-ink">
            Every session, itemised
          </h2>
          {(earnings.data?.lines.length ?? 0) > 12 ? (
            <button
              type="button"
              onClick={() => setShowAllLines((v) => !v)}
              className="text-xs font-medium text-emerald-700 hover:underline dark:text-accent-glow"
            >
              {showAllLines
                ? "Show fewer"
                : `Show all ${earnings.data?.lines.length} lines`}
            </button>
          ) : null}
        </div>
        <p className="mb-3 text-sm text-slate-500 dark:text-ink-muted">
          The lines your total adds up from — which bay, when, how long, how much energy, what it
          earned. <strong>No driver is named here, at any level of detail.</strong> They are
          ChargeOps&apos; customers, not yours.
        </p>

        {(earnings.data?.lines.length ?? 0) === 0 ? (
          <div className={cn(cardShell, "p-8 text-center")}>
            <Receipt className="mx-auto h-8 w-8 text-slate-300 dark:text-ink-faint" />
            <p className="mt-3 text-sm text-slate-500 dark:text-ink-muted">
              No completed sessions in this period.
            </p>
          </div>
        ) : (
          <div className={cn(cardShell, "overflow-x-auto")}>
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">Ended</th>
                  <th className="px-4 py-3 font-medium">Site</th>
                  <th className="px-4 py-3 font-medium">Bay</th>
                  <th className="px-4 py-3 text-right font-medium">Duration</th>
                  <th className="px-4 py-3 text-right font-medium">Energy</th>
                  <th className="px-4 py-3 text-right font-medium">Rate</th>
                  <th className="px-4 py-3 text-right font-medium">Session value</th>
                  <th className="px-4 py-3 text-right font-medium">Your share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-white/5">
                {(showAllLines
                  ? earnings.data!.lines
                  : earnings.data!.lines.slice(0, 12)
                ).map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600 dark:text-ink-muted">
                      {new Date(l.endedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-slate-900 dark:text-ink">{l.station}</td>
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">
                        #{l.chargerId}
                      </span>
                      <span className="ml-1.5 text-xs text-slate-400 dark:text-ink-faint">
                        {l.chargerType}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{l.minutes} min</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{l.kwh.toFixed(1)} kWh</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-ink-muted">
                      ${l.rate.toFixed(4)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500 dark:text-ink-muted">
                      {money(l.gross)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-900 dark:text-ink">
                      {money(l.yours)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(earnings.data?.lines.length ?? 0) >= (earnings.data?.lineLimit ?? 200) ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-ink-faint">
            Showing the most recent {earnings.data?.lineLimit} sessions. A full period export is the
            next thing this page needs.
          </p>
        ) : null}
      </section>
    </div>
  );
}
