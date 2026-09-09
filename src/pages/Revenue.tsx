// src/pages/Revenue.tsx — the money picture, and nothing to do on it
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS PAGE IS NOT
// ═════════════════════════════════════════════════════════════════════════════
// It used to be everything finance touches: an approval queue, a revenue chart,
// a debt ledger and a reconciliation table on one scroll. That is a filing
// cabinet, not a page. Three different jobs done at three different times, and
// stacking them meant the urgent one — somebody waiting on an approval — sat
// below a chart.
//
// The work moved to /approvals and /collections. What is left here is the
// reading: where the money comes from, what is held rather than earned, and
// whether the pipeline that produced it added up. Those are the questions you
// answer before a meeting, not the ones you answer on a Tuesday morning.
//
// The two queues are still surfaced at the top, as counts with a way through,
// because "is anything waiting on me?" is a fair thing to ask from here.
import { Link } from "react-router-dom";
import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ArrowRight, CheckCircle2, HandCoins, Inbox } from "lucide-react";
import { apiFetch } from "../api/client";
import { useApi } from "../hooks/useApi";
import { cardShell, cn } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";

interface Summary {
  inbox: { pending: number; pendingValue: number; oldestHours: number };
  revenue: { today: number; last30Days: number; subscription30d: number; charging30d: number };
  deposits: { last30Days: number; heldNow: number };
  uncollected: { sessions: number; value: number };
}

interface TrendDay {
  date: string;
  charging: number;
  membership: number;
  deposits: number;
  chargingCount: number;
  revenue: number;
}

interface ReconciliationDay {
  date: string;
  sessions: number;
  sessionValue: number;
  payments: number;
  invoices: number;
  invoiceable: number;
  unbilled: number;
  missingInvoices: number;
  balanced: boolean;
}

function money(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function Revenue() {
  const summary = useApi(() => apiFetch<Summary>("/billing/summary"), []);
  const trend = useApi(() => apiFetch<TrendDay[]>("/billing/revenue-trend", { days: 30 }), []);
  const reconciliation = useApi(
    () => apiFetch<ReconciliationDay[]>("/billing/reconciliation", { days: 14 }),
    []
  );

  const s = summary.data;
  const unbalanced = (reconciliation.data ?? []).filter((d) => !d.balanced);

  return (
    <div>
      <PageHeader subtitle="Where the money came from, what is held rather than earned, and whether the billing pipeline added up. The queues that need working are on Approvals and Collections." />

      {/* ── What is waiting, with a way through ──────────────────────────── */}
      {s && (s.inbox.pending > 0 || s.uncollected.sessions > 0) ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          {s.inbox.pending > 0 ? (
            <Link
              to="/approvals"
              className={cn(
                cardShell,
                "flex items-center gap-3 p-4 transition-colors hover:border-emerald-500/40"
              )}
            >
              <Inbox className="h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" />
              <span className="flex-1 text-sm">
                <span className="block font-medium text-slate-900 dark:text-ink">
                  {s.inbox.pending} request{s.inbox.pending === 1 ? "" : "s"} awaiting a decision
                </span>
                <span className="text-slate-500 dark:text-ink-muted">
                  {money(s.inbox.pendingValue)}
                  {s.inbox.oldestHours > 24 ? ` · oldest waiting ${s.inbox.oldestHours}h` : ""}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
            </Link>
          ) : null}

          {s.uncollected.sessions > 0 ? (
            <Link
              to="/collections"
              className={cn(
                cardShell,
                "flex items-center gap-3 p-4 transition-colors hover:border-emerald-500/40"
              )}
            >
              <HandCoins className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="flex-1 text-sm">
                <span className="block font-medium text-slate-900 dark:text-ink">
                  {money(s.uncollected.value)} uncollected
                </span>
                <span className="text-slate-500 dark:text-ink-muted">
                  {s.uncollected.sessions} session{s.uncollected.sessions === 1 ? "" : "s"} charged
                  but not paid
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* ── The numbers ──────────────────────────────────────────────────── */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue today" value={money(s?.revenue.today)} hint="Energy and memberships" />
        <StatCard
          label="Last 30 days"
          value={money(s?.revenue.last30Days)}
          hint={
            s
              ? `${money(s.revenue.charging30d)} energy · ${money(s.revenue.subscription30d)} memberships`
              : undefined
          }
        />
        <StatCard
          label="Held in wallets"
          value={money(s?.deposits.heldNow)}
          hint="Customer deposits — not revenue"
        />
        <StatCard
          label="Uncollected"
          value={money(s?.uncollected.value)}
          hint={s ? `${s.uncollected.sessions} sessions` : undefined}
          trend={s && s.uncollected.sessions > 0 ? { text: "debt to chase", positive: false } : undefined}
        />
      </div>

      {/* ── Where it comes from ──────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-1 font-display text-base font-semibold text-slate-900 dark:text-ink">
          Revenue by source · last 30 days
        </h2>
        <p className="mb-3 max-w-3xl text-sm text-slate-500 dark:text-ink-muted">
          Split rather than totalled, because the two move for different reasons: energy sales
          follow traffic, memberships bill monthly per driver. Deposits are drawn alongside in grey
          and never summed in — a top-up is money held on the driver&apos;s behalf, and counting it
          as revenue bills the same $50 twice.
        </p>
        <div className={cn(cardShell, "p-5")}>
          <div className="h-64">
            {trend.loading ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-ink-muted">
                Loading…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend.data ?? []} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
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
                    tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1a2332",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => new Date(String(d)).toLocaleDateString()}
                    formatter={(v: number, name) => [money(v), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                  <Area
                    type="monotone"
                    dataKey="charging"
                    name="Energy"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="#10b981"
                    fillOpacity={0.14}
                  />
                  <Bar dataKey="membership" name="Memberships" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                  <Bar
                    dataKey="deposits"
                    name="Deposits (not revenue)"
                    fill="#94a3b8"
                    radius={[3, 3, 0, 0]}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* ── Does it add up? ──────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-1 font-display text-base font-semibold text-slate-900 dark:text-ink">
          Reconciliation · last 14 days
        </h2>
        <p className="mb-3 max-w-3xl text-sm text-slate-500 dark:text-ink-muted">
          Every settled session should produce exactly one successful payment and one invoice. Where
          the three counts disagree, the pipeline dropped a step — and a driver charged without
          being billed.
        </p>

        {unbalanced.length === 0 && !reconciliation.loading ? (
          <div
            className={cn(
              cardShell,
              "flex items-center gap-2 p-4 text-sm text-slate-700 dark:text-ink-muted"
            )}
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            Sessions, payments and invoices agree on every one of the last 14 days.
          </div>
        ) : (
          <div className={cn(cardShell, "overflow-x-auto")}>
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 text-right font-medium">Sessions</th>
                  <th className="px-4 py-3 text-right font-medium">Value</th>
                  <th className="px-4 py-3 text-right font-medium">Payments</th>
                  <th className="px-4 py-3 text-right font-medium">Invoices</th>
                  <th className="px-4 py-3 text-right font-medium">Unbilled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-white/5">
                {(reconciliation.data ?? []).map((d) => (
                  <tr key={d.date} className={d.balanced ? "" : "bg-amber-500/5"}>
                    <td className="px-4 py-2.5 text-slate-900 dark:text-ink">
                      {new Date(d.date).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{d.sessions}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(d.sessionValue)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{d.payments}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {/* Seeded history predates the invoice table, so a day
                          with nothing invoiceable shows a dash rather than a
                          zero that reads as a failure. */}
                      {d.invoiceable ? `${d.invoices} / ${d.invoiceable}` : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right tabular-nums",
                        d.unbilled ? "font-medium text-amber-700 dark:text-amber-300" : ""
                      )}
                    >
                      {d.unbilled || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
