// src/pages/MyWork.tsx — the field technician's home screen
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A TECHNICIAN DOES NOT GET THE DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
// The first version of this application had one dashboard and hid the parts a
// technician was not allowed to see. That produced a screen answering the
// manager's question ("how is the network?") with holes in it, when the
// technician's question is entirely different: what am I doing next, and where.
//
// So this page is a job list, ordered the way the day is worked — critical
// first, then oldest — with the three actions that move a job forward and a
// link to the equipment history for the unit involved.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, History, MapPin, PlayCircle, Plus } from "lucide-react";
import { apiFetchPage, apiPost } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { cardShell, cn, inputShell } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";

interface WorkOrder {
  id: number;
  station_id: number;
  station_name: string;
  charger_id: number | null;
  issue_type: string;
  status: string;
  fault_code: string | null;
  severity: string | null;
  priority: string | null;
  reported_at: string | null;
  assigned_at: string | null;
  started_at: string | null;
  resolution_notes: string | null;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300",
  major: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  minor: "bg-slate-500/15 text-slate-600 ring-slate-500/25 dark:text-ink-muted",
};

const STATUS_STYLE: Record<string, string> = {
  Assigned: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  "In Progress": "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-accent-glow",
  Resolved: "bg-slate-500/15 text-slate-600 ring-slate-500/25 dark:text-ink-muted",
};

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        className ?? "bg-slate-500/15 text-slate-600 ring-slate-500/25 dark:text-ink-muted"
      )}
    >
      {children}
    </span>
  );
}

/** "3h ago" reads faster in the field than a timestamp. */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function MyWork() {
  const { user } = useAuth();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<WorkOrder | null>(null);
  const [reporting, setReporting] = useState(false);

  // The API already restricts a technician to their own queue — see the
  // row-level filter in server/routes/maintenance.js. Nothing here re-filters,
  // because a second filter in the browser would only be a comment on the first.
  const queue = useApi(() => apiFetchPage<WorkOrder>("/maintenance", { pageSize: 200 }), []);
  const orders = useMemo(() => queue.data?.items ?? [], [queue.data]);

  const open = useMemo(
    () =>
      orders
        .filter((o) => o.status === "Assigned" || o.status === "In Progress")
        .sort((a, b) => {
          // Critical work first; within a severity, whatever has waited longest.
          const rank = (o: WorkOrder) => (o.severity === "critical" ? 0 : o.severity === "major" ? 1 : 2);
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return new Date(a.reported_at ?? 0).getTime() - new Date(b.reported_at ?? 0).getTime();
        }),
    [orders]
  );
  const done = useMemo(
    () =>
      orders
        .filter((o) => o.status === "Resolved")
        .sort((a, b) => new Date(b.reported_at ?? 0).getTime() - new Date(a.reported_at ?? 0).getTime())
        .slice(0, 10),
    [orders]
  );

  async function act(id: number, path: string, body?: unknown) {
    setBusy(id);
    setError(null);
    try {
      await apiPost(`/maintenance/${id}/${path}`, body);
      queue.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const criticalCount = open.filter((o) => o.severity === "critical").length;
  const inProgress = open.filter((o) => o.status === "In Progress").length;

  return (
    <div>
      <PageHeader
        subtitle={`Jobs assigned to ${user?.displayName ?? "you"}. Start a job when you arrive on site, and resolve it when the charger is back in service — resolving is what returns the stall to rotation.`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Open jobs" value={String(open.length)} hint="Assigned or in progress" />
        <StatCard
          label="Critical"
          value={String(criticalCount)}
          hint="Do these first"
          trend={criticalCount ? { text: "needs attention", positive: false } : undefined}
        />
        <StatCard label="In progress" value={String(inProgress)} hint="You are on site" />
      </div>

      {error ? (
        <div className="mb-4 rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-ink">My queue</h2>
        <button
          type="button"
          onClick={() => setReporting(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          <Plus className="h-4 w-4" /> Report a fault
        </button>
      </div>

      {queue.loading ? (
        <p className="text-sm text-slate-500 dark:text-ink-muted">Loading your queue…</p>
      ) : open.length === 0 ? (
        <div className={cn(cardShell, "p-8 text-center")}>
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-ink">Nothing assigned to you</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-ink-muted">
            New work appears here as soon as a manager dispatches it.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {open.map((o) => (
            <article key={o.id} className={cn(cardShell, "p-4 sm:p-5")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge className={STATUS_STYLE[o.status]}>{o.status}</Badge>
                    {o.severity ? (
                      <Badge className={SEVERITY_STYLE[o.severity]}>{o.severity}</Badge>
                    ) : null}
                    {o.fault_code ? <Badge>{o.fault_code}</Badge> : null}
                    <span className="text-xs text-slate-400 dark:text-ink-faint">#{o.id}</span>
                  </div>
                  <p className="font-medium text-slate-900 dark:text-ink">{o.issue_type}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-ink-muted">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {o.station_name}
                    </span>
                    {o.charger_id ? <span>Charger #{o.charger_id}</span> : null}
                    <span>Reported {ago(o.reported_at)}</span>
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {/* The single most useful thing before opening a panel: has
                      this unit failed this way before? */}
                  {o.charger_id ? (
                    <Link
                      to={`/chargers/${o.charger_id}/history`}
                      className={cn(inputShell, "inline-flex items-center gap-1.5 py-1.5 text-xs")}
                    >
                      <History className="h-3.5 w-3.5" /> History
                    </Link>
                  ) : null}
                  {/* One button per job, because there is only ever one next
                      step. Showing Resolve on an Assigned job invited skipping
                      Start, which the API now refuses and which produced
                      zero-length repairs when it did not. */}
                  {o.status === "Assigned" ? (
                    <button
                      type="button"
                      disabled={busy === o.id}
                      onClick={() => act(o.id, "start")}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      <PlayCircle className="h-3.5 w-3.5" /> Start
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === o.id}
                      onClick={() => setResolving(o)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Resolve
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {done.length ? (
        <section className="mt-8">
          <h2 className="mb-3 font-display text-base font-semibold text-slate-900 dark:text-ink">
            Recently completed
          </h2>
          <div className={cn(cardShell, "divide-y divide-slate-200 dark:divide-white/5")}>
            {done.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-slate-900 dark:text-ink">{o.issue_type}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-ink-muted">
                    {o.station_name}
                    {o.charger_id ? ` · Charger #${o.charger_id}` : ""}
                  </p>
                </div>
                <span className="text-xs text-slate-400 dark:text-ink-faint">{ago(o.reported_at)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {resolving ? (
        <ResolveDialog
          order={resolving}
          busy={busy === resolving.id}
          onClose={() => setResolving(null)}
          onSubmit={async (notes) => {
            await act(resolving.id, "resolve", { notes });
            setResolving(null);
          }}
        />
      ) : null}

      {reporting ? (
        <ReportDialog
          onClose={() => setReporting(false)}
          onDone={() => {
            setReporting(false);
            queue.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolving asks for notes, and the notes are the point
// ─────────────────────────────────────────────────────────────────────────────
// What was actually done is the only durable record of this repair. It is what
// the next technician reads on the history page six weeks from now, and it is
// the difference between "faulty connector" appearing four times and somebody
// noticing the connector keeps failing.
function ResolveDialog({
  order,
  busy,
  onClose,
  onSubmit,
}: {
  order: WorkOrder;
  busy: boolean;
  onClose: () => void;
  onSubmit: (notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  return (
    <Modal title={`Resolve #${order.id}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600 dark:text-ink-muted">
        {order.issue_type} — {order.station_name}
        {order.charger_id ? ` · Charger #${order.charger_id}` : ""}
      </p>
      <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Resolving returns this charger to service. Only do it once the stall works.</span>
      </div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
        What did you do?
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={4}
        placeholder="Replaced connector latch; retested at 120 kW."
        className={cn(inputShell, "w-full")}
      />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cn(inputShell, "px-4 py-2 text-sm")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || notes.trim().length < 3}
          onClick={() => onSubmit(notes.trim())}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Mark resolved"}
        </button>
      </div>
    </Modal>
  );
}

/** A technician finding a second fault while on site raises it here. */
function ReportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [chargerId, setChargerId] = useState("");
  const [issue, setIssue] = useState("");
  const [severity, setSeverity] = useState("major");
  const [faultCode, setFaultCode] = useState("");
  // null = follow the severity default; a boolean = the engineer decided.
  const [pullBay, setPullBay] = useState<boolean | null>(null);
  const takeOutOfService = pullBay ?? severity === "critical";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/maintenance", {
        chargerId: Number(chargerId),
        issue,
        severity,
        faultCode: faultCode || undefined,
        takeOutOfService,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Report a fault" onClose={onClose}>
      {error ? (
        <p className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
            Charger ID
          </label>
          <input
            value={chargerId}
            onChange={(e) => setChargerId(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="234"
            className={cn(inputShell, "w-full")}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
            What is wrong?
          </label>
          <input
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            placeholder="Connector will not latch"
            className={cn(inputShell, "w-full")}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
              Severity
            </label>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={cn(inputShell, "w-full")}>
              <option value="critical">critical</option>
              <option value="major">major</option>
              <option value="minor">minor</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
              Fault code (optional)
            </label>
            <input
              value={faultCode}
              onChange={(e) => setFaultCode(e.target.value)}
              placeholder="CONNECTOR_LOCK"
              className={cn(inputShell, "w-full")}
            />
          </div>
        </div>

        {/* The engineer is the one standing in front of the unit, so they get
            the same switch the dispatcher has — and a better claim to it. */}
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
                ? "No driver will be routed here until it is resolved."
                : "The bay stays live and keeps taking drivers."}
            </span>
          </span>
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cn(inputShell, "px-4 py-2 text-sm")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !chargerId || issue.trim().length < 5}
          onClick={submit}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Submit report"}
        </button>
      </div>
    </Modal>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div
        className={cn(
          cardShell,
          "relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto p-5 shadow-xl"
        )}
      >
        <h3 className="mb-3 font-display text-lg font-semibold text-slate-900 dark:text-ink">{title}</h3>
        {children}
      </div>
    </div>
  );
}
