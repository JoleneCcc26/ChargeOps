// src/pages/Approvals.tsx — decisions waiting on finance
//
// Split out of the revenue page, where it sat above a chart, a debt ledger and
// a reconciliation table. Those are three different jobs done at three
// different times: approvals are worked daily and are somebody waiting on you;
// collections is a weekly sweep; revenue is what you read before a meeting.
// Stacked together, the urgent one ends up below a chart.
//
// Approving is the moment money actually moves. Until then a request is inert,
// which is what makes it safe to leave this queue overnight.
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { apiFetchPage, apiPost } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { cardShell, cn, inputShell } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";
import { Modal } from "./MyWork";

interface BillingRequest {
  id: number;
  user_id: number;
  user_name: string;
  user_email: string;
  type: string;
  amount: number | null;
  plan_id: number | null;
  plan_name: string | null;
  session_id: number | null;
  status: string;
  reason: string | null;
  requested_at: string;
  requested_by: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  payment_id: number | null;
  wallet_balance: number | null;
}

const TYPE_LABEL: Record<string, string> = {
  "subscription.new": "New membership",
  "subscription.renew": "Membership renewal",
  "wallet.topup": "Wallet top-up",
  refund: "Refund",
};

function money(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function waited(iso: string): string {
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function Approvals() {
  const { user } = useAuth();
  const isFinance = user?.role === "finance";
  const [decision, setDecision] = useState<{ order: BillingRequest; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inbox = useApi(
    () => apiFetchPage<BillingRequest>("/billing/requests", { status: "Pending", pageSize: 100 }),
    []
  );
  const recent = useApi(() => apiFetchPage<BillingRequest>("/billing/requests", { pageSize: 30 }), []);

  const pending = inbox.data?.items ?? [];
  const decided = (recent.data?.items ?? []).filter((r) => r.status !== "Pending").slice(0, 10);
  const pendingValue = pending.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const oldestHours = pending.length
    ? Math.max(...pending.map((r) => (Date.now() - new Date(r.requested_at).getTime()) / 3600000))
    : 0;

  async function submit(notes: string) {
    if (!decision) return;
    setBusy(true);
    setError(null);
    try {
      // The amount is never sent from here. It is derived server-side from the
      // plan or the session, because a price posted by a browser is a price the
      // browser chose.
      await apiPost(
        `/billing/requests/${decision.order.id}/${decision.approve ? "approve" : "reject"}`,
        { notes }
      );
      setDecision(null);
      inbox.refetch();
      recent.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        subtitle={
          isFinance
            ? "Memberships, top-ups and refunds waiting on a decision. Approving writes a payment and activates the subscription in one transaction — half of that happening is the failure this design exists to prevent."
            : "The billing queue. Only finance can approve or reject: whoever asks for money to move and whoever authorises it must be different people."
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Awaiting decision"
          value={String(pending.length)}
          hint={`${money(pendingValue)} of value`}
        />
        <StatCard
          label="Oldest"
          value={oldestHours >= 1 ? `${Math.round(oldestHours)}h` : "—"}
          hint="Somebody is waiting on this"
          trend={oldestHours > 24 ? { text: "over a day", positive: false } : undefined}
        />
        <StatCard
          label="Decided recently"
          value={String(decided.length)}
          hint="Last ten, with the reason"
        />
      </div>

      {error ? (
        <div className="mb-4 rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {inbox.loading ? (
        <p className="text-sm text-slate-500 dark:text-ink-muted">Loading requests…</p>
      ) : pending.length === 0 ? (
        <div className={cn(cardShell, "p-8 text-center")}>
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-ink">Inbox clear</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-ink-muted">
            Nothing is waiting on a finance decision.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <article key={r.id} className={cn(cardShell, "p-4 sm:p-5")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-700 ring-1 ring-sky-500/30 dark:text-sky-300">
                      {TYPE_LABEL[r.type] ?? r.type}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 dark:text-ink-faint">
                      <Clock className="h-3 w-3" /> waited {waited(r.requested_at)}
                    </span>
                    <span className="text-xs text-slate-400 dark:text-ink-faint">#{r.id}</span>
                  </div>
                  <p className="font-medium text-slate-900 dark:text-ink">
                    {r.user_name}{" "}
                    <span className="font-normal text-slate-500 dark:text-ink-muted">
                      {r.user_email}
                    </span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-ink-muted">
                    <span className="font-medium text-slate-900 dark:text-ink">
                      {money(r.amount)}
                    </span>
                    {r.plan_name ? <span>{r.plan_name}</span> : null}
                    {r.session_id ? <span>Session #{r.session_id}</span> : null}
                    {r.wallet_balance != null ? <span>Wallet {money(r.wallet_balance)}</span> : null}
                    {r.requested_by ? <span>raised by {r.requested_by}</span> : null}
                  </p>
                  {r.reason ? (
                    <p className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700 dark:bg-white/5 dark:text-ink-muted">
                      {r.reason}
                    </p>
                  ) : null}
                </div>

                {isFinance ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDecision({ order: r, approve: false })}
                      className={cn(inputShell, "inline-flex items-center gap-1.5 py-1.5 text-xs")}
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => setDecision({ order: r, approve: true })}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {decided.length ? (
        <section className="mt-8">
          <h2 className="mb-1 font-display text-base font-semibold text-slate-900 dark:text-ink">
            Recent decisions
          </h2>
          <p className="mb-3 text-sm text-slate-500 dark:text-ink-muted">
            Who decided what, and why. Every approval moved money; every rejection carries the
            reason the driver can be told.
          </p>
          <div className={cn(cardShell, "divide-y divide-slate-200 dark:divide-white/5")}>
            {decided.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate text-slate-900 dark:text-ink">
                    {TYPE_LABEL[r.type] ?? r.type} · {r.user_name} · {money(r.amount)}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-ink-muted">
                    {r.status} by {r.reviewed_by ?? "—"}
                    {r.review_notes ? ` — ${r.review_notes}` : ""}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
                    r.status === "Approved"
                      ? "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-accent-glow"
                      : "bg-slate-500/15 text-slate-600 ring-slate-500/25 dark:text-ink-muted"
                  )}
                >
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {decision ? (
        <DecisionDialog
          request={decision.order}
          approve={decision.approve}
          busy={busy}
          onClose={() => setDecision(null)}
          onSubmit={submit}
        />
      ) : null}
    </div>
  );
}

function DecisionDialog({
  request,
  approve,
  busy,
  onClose,
  onSubmit,
}: {
  request: BillingRequest;
  approve: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  return (
    <Modal title={`${approve ? "Approve" : "Reject"} request #${request.id}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600 dark:text-ink-muted">
        {TYPE_LABEL[request.type] ?? request.type} for {request.user_name} — {money(request.amount)}
        {request.plan_name ? ` · ${request.plan_name}` : ""}
      </p>

      {approve ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Approving writes a payment and activates the subscription in one transaction. The amount
            is recalculated on the server from the plan — it is not taken from this screen.
          </span>
        </div>
      ) : null}

      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
        {approve ? "Notes (optional)" : "Reason (required)"}
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder={approve ? "Verified against the driver's email request." : "Duplicate of #482."}
        className={cn(inputShell, "w-full")}
      />

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cn(inputShell, "px-4 py-2 text-sm")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || (!approve && notes.trim().length < 3)}
          onClick={() => onSubmit(notes.trim())}
          className={cn(
            "rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50",
            approve ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"
          )}
        >
          {busy ? "Saving…" : approve ? "Approve and charge" : "Reject"}
        </button>
      </div>
    </Modal>
  );
}
