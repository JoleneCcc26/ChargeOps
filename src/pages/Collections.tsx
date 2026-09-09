// src/pages/Collections.tsx — the debt, and what to do about it
//
// ═════════════════════════════════════════════════════════════════════════════
// A LIST THAT CANNOT BE ACTED ON IS A REPORT
// ═════════════════════════════════════════════════════════════════════════════
// This started as a table on the revenue page showing what each driver owed
// next to what their wallet held, and nothing else. Every fact needed to decide
// was on screen and the deciding happened somewhere else — which is the shape
// of a report, not of a queue somebody works.
//
// There are only two honest outcomes, and the wallet balance picks between
// them:
//
//   the balance covers it   take it. The money is there and it is owed.
//   the balance does not    you cannot collect what is not there. Wait for a
//                           top-up, or write it off and say why.
//
// So the page is split on exactly that line, because sorting a mixed list by
// age makes somebody re-derive the same test on every row.
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, HandCoins, Wallet, XCircle } from "lucide-react";
import { apiFetch, apiPost } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { cardShell, cn, inputShell } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";
import { Modal } from "./MyWork";

interface Debt {
  session_id: number;
  user_id: number;
  user_name: string;
  user_email: string;
  station_name: string;
  charger_id: number;
  ended_at: string;
  kwh: number;
  amount: number;
  attempts: number;
  daysOutstanding: number;
  walletBalance: number | null;
  coveredByWallet: boolean;
}

function money(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function Collections() {
  const { user } = useAuth();
  const isFinance = user?.role === "finance";
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [writingOff, setWritingOff] = useState<Debt | null>(null);

  const debts = useApi(() => apiFetch<Debt[]>("/billing/uncollected", { limit: 200 }), []);
  const rows = useMemo(() => debts.data ?? [], [debts.data]);

  const collectable = useMemo(() => rows.filter((d) => d.coveredByWallet), [rows]);
  const stuck = useMemo(() => rows.filter((d) => !d.coveredByWallet), [rows]);

  const sum = (list: Debt[]) => list.reduce((a, d) => a + d.amount, 0);

  async function retry(d: Debt) {
    setBusy(d.session_id);
    setError(null);
    setNote(null);
    try {
      const res = await apiPost<{ collected: number; balanceAfter: number }>(
        `/billing/uncollected/${d.session_id}/retry`
      );
      setNote(
        `Collected ${money(res.collected)} from ${d.user_name}. Balance now ${money(res.balanceAfter)}.`
      );
      debts.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not collect");
    } finally {
      setBusy(null);
    }
  }

  async function writeOff(d: Debt, reason: string) {
    setBusy(d.session_id);
    setError(null);
    setNote(null);
    try {
      await apiPost(`/billing/uncollected/${d.session_id}/write-off`, { reason });
      setNote(`Wrote off ${money(d.amount)} for ${d.user_name}.`);
      setWritingOff(null);
      debts.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not write off");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader subtitle="Sessions where the energy was delivered and every payment attempt failed. That is a declined card, not a data fault — which makes it finance's work rather than engineering's." />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Outstanding"
          value={money(sum(rows))}
          hint={`${rows.length} session${rows.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Collectable now"
          value={money(sum(collectable))}
          hint={`${collectable.length} where the wallet covers it`}
          trend={collectable.length ? { text: "one click each" } : undefined}
        />
        <StatCard
          label="Cannot be collected"
          value={money(sum(stuck))}
          hint={`${stuck.length} with too little balance`}
          trend={stuck.length ? { text: "wait, or write off", positive: false } : undefined}
        />
      </div>

      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}
      {note ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-500/20 dark:text-accent-glow">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          {note}
        </div>
      ) : null}

      {debts.loading ? (
        <p className="text-sm text-slate-500 dark:text-ink-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className={cn(cardShell, "p-8 text-center")}>
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-ink">Nothing outstanding</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-ink-muted">
            Every settled session has been paid for.
          </p>
        </div>
      ) : (
        <>
          <DebtTable
            title="The balance covers it"
            blurb="The money is in their wallet and the energy was delivered. Collecting it debits the wallet and settles the session in one transaction."
            rows={collectable}
            tone="collectable"
            isFinance={isFinance}
            busy={busy}
            onRetry={retry}
            onWriteOff={setWritingOff}
          />

          <DebtTable
            title="The balance does not cover it"
            blurb="You cannot take money that is not there. These wait for the driver to top up — or get written off, which forgives the money on the record rather than leaving a receivable nobody expects to collect."
            rows={stuck}
            tone="stuck"
            isFinance={isFinance}
            busy={busy}
            onRetry={retry}
            onWriteOff={setWritingOff}
          />
        </>
      )}

      {writingOff ? (
        <WriteOffDialog
          debt={writingOff}
          busy={busy === writingOff.session_id}
          onClose={() => setWritingOff(null)}
          onSubmit={(reason) => writeOff(writingOff, reason)}
        />
      ) : null}
    </div>
  );
}

function DebtTable({
  title,
  blurb,
  rows,
  tone,
  isFinance,
  busy,
  onRetry,
  onWriteOff,
}: {
  title: string;
  blurb: string;
  rows: Debt[];
  tone: "collectable" | "stuck";
  isFinance: boolean;
  busy: number | null;
  onRetry: (d: Debt) => void;
  onWriteOff: (d: Debt) => void;
}) {
  if (rows.length === 0) return null;
  const total = rows.reduce((a, d) => a + d.amount, 0);

  return (
    <section className="mb-8">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-ink">
          {title} · {rows.length}
        </h2>
        <span className="font-display text-sm font-semibold tabular-nums text-slate-700 dark:text-ink">
          {money(total)}
        </span>
      </div>
      <p className="mb-3 max-w-3xl text-sm text-slate-500 dark:text-ink-muted">{blurb}</p>

      <div className={cn(cardShell, "overflow-x-auto")}>
        <table className="w-full min-w-[780px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
            <tr>
              <th className="px-4 py-3 font-medium">Driver</th>
              <th className="px-4 py-3 font-medium">Session</th>
              <th className="px-4 py-3 text-right font-medium">Owed</th>
              <th className="px-4 py-3 text-right font-medium">Wallet</th>
              <th className="px-4 py-3 text-right font-medium">Age</th>
              <th className="px-4 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-white/5">
            {rows.slice(0, 40).map((d) => (
              <tr key={d.session_id}>
                <td className="px-4 py-3">
                  <p className="text-slate-900 dark:text-ink">{d.user_name}</p>
                  <p className="text-xs text-slate-500 dark:text-ink-muted">{d.user_email}</p>
                </td>
                <td className="px-4 py-3">
                  <p className="text-slate-700 dark:text-ink-muted">{d.station_name}</p>
                  <p className="text-xs text-slate-500 dark:text-ink-faint">
                    #{d.session_id} · bay {d.charger_id} · {Number(d.kwh).toFixed(1)} kWh ·{" "}
                    {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                  </p>
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-900 dark:text-ink">
                  {money(d.amount)}
                </td>
                <td className="px-4 py-3 text-right">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ring-1",
                      tone === "collectable"
                        ? "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-accent-glow"
                        : "bg-slate-500/15 text-slate-600 ring-slate-500/25 dark:text-ink-muted"
                    )}
                  >
                    <Wallet className="h-3 w-3" />
                    {d.walletBalance == null ? "none" : money(d.walletBalance)}
                  </span>
                  {tone === "stuck" && d.walletBalance != null ? (
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-ink-faint">
                      short {money(d.amount - d.walletBalance)}
                    </p>
                  ) : null}
                </td>
                <td
                  className={cn(
                    "px-4 py-3 text-right tabular-nums",
                    d.daysOutstanding > 90 ? "font-medium text-rose-600 dark:text-rose-400" : ""
                  )}
                >
                  {d.daysOutstanding}d
                </td>
                <td className="px-4 py-3 text-right">
                  {/* Only finance acts. A manager reading the same page gets
                      the context and no buttons — the API refuses them anyway,
                      and a button that always fails is worse than none. */}
                  {isFinance ? (
                    <div className="flex justify-end gap-2">
                      {tone === "collectable" ? (
                        <button
                          type="button"
                          disabled={busy === d.session_id}
                          onClick={() => onRetry(d)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          <HandCoins className="h-3.5 w-3.5" />
                          {busy === d.session_id ? "Collecting…" : "Collect"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy === d.session_id}
                        onClick={() => onWriteOff(d)}
                        className={cn(inputShell, "inline-flex items-center gap-1.5 py-1 text-xs")}
                      >
                        <XCircle className="h-3.5 w-3.5" /> Write off
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400 dark:text-ink-faint">finance only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 40 ? (
          <p className="border-t border-slate-200 px-4 py-2.5 text-xs text-slate-500 dark:border-white/5 dark:text-ink-faint">
            Showing the 40 oldest of {rows.length}.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Writing off asks for a reason, and the reason is the point.
 *
 * Forgiving money should be as traceable as approving a refund. The note goes
 * into the audit log against whoever decided it, so "why is this receivable
 * gone?" has an answer six months from now.
 */
function WriteOffDialog({
  debt,
  busy,
  onClose,
  onSubmit,
}: {
  debt: Debt;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const tiny = debt.amount < 5;

  return (
    <Modal title={`Write off ${money(debt.amount)}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600 dark:text-ink-muted">
        {debt.user_name} · session #{debt.session_id} · {debt.daysOutstanding} days outstanding
      </p>

      <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          This forgives the money. The session keeps its history and the write-off is recorded
          against your name — it is not a deletion.
          {tiny ? " At this amount, chasing it costs more than it is worth." : ""}
        </span>
      </div>

      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
        Why?
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder={
          tiny
            ? "Below the cost of collection."
            : "Card closed; driver unreachable after three attempts."
        }
        className={cn(inputShell, "w-full")}
      />

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cn(inputShell, "px-4 py-2 text-sm")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || reason.trim().length < 3}
          onClick={() => onSubmit(reason.trim())}
          className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Write it off"}
        </button>
      </div>
    </Modal>
  );
}
