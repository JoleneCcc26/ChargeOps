// src/pages/Invoices.tsx — the PDFs the billing worker produced
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS PAGE EXISTS
// ═════════════════════════════════════════════════════════════════════════════
// The application has generated hundreds of invoices since the first session
// was settled, and until now there was no way to see one. The endpoint existed,
// the files were on disk, the invoice table held the pointers — and nothing in
// the interface listed them. A feature nobody can reach is indistinguishable
// from a feature that does not work.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS PAGE DEMONSTRATES
// ═════════════════════════════════════════════════════════════════════════════
// It is the visible end of the asynchronous pipeline, and worth understanding
// as such rather than as a list of receipts:
//
//   1. A session ends. The request returns 202 — accepted, not finished.
//   2. A worker settles the money in one transaction and enqueues a second job.
//   3. That job renders a PDF, writes it to object storage, and records only
//      the key, the amount and the session reference in MySQL.
//
// The row below therefore proves three separate things at once: the money
// settled, a file was produced, and the database is holding a pointer rather
// than a blob.
//
// Download links are minted per response and expire in fifteen minutes. They
// are not stored and not reusable later — the application hands out a
// short-lived capability instead of proxying the bytes, which is exactly what
// an S3 presigned URL does. Swapping the local adapter for S3 changes
// getSignedUrl and nothing that calls it.
import { useState } from "react";
import { Download, FileText, Search } from "lucide-react";
import { apiFetchPage, resolveFileUrl } from "../api/client";
import { useApi } from "../hooks/useApi";
import { cardShell, cn, inputShell } from "../lib/cn";
import { StatCard } from "../components/StatCard";
import { PageHeader } from "../components/PageHeader";

interface Invoice {
  id: number;
  number: string;
  session_id: number;
  user_id: number;
  payment_id: number | null;
  storage_key: string;
  amount: number;
  generated_at: string;
  user_name: string;
  user_email: string;
  station_name: string | null;
  kwh: number | null;
  session_ended_at: string | null;
  /** Signed and short-lived — see the note at the top of this file. */
  url: string;
}

function money(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function Invoices() {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const query = useApi(
    () => apiFetchPage<Invoice>("/invoices", { search: search || undefined, page, pageSize }),
    [search, page]
  );

  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = query.data?.totalPages ?? 1;

  // Value on this page only, and labelled as such. Summing 25 rows and calling
  // it a total is the mistake the dashboard tiles were built to avoid.
  const pageValue = rows.reduce((a, r) => a + Number(r.amount), 0);

  function commit(value: string) {
    setSearch(value.trim());
    setPage(1);
  }

  return (
    <div>
      <PageHeader subtitle="Every invoice the billing worker has rendered. The PDF lives in object storage; the database holds its key, amount and session. Download links are signed and expire after fifteen minutes." />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label={search ? "Matching invoices" : "Invoices issued"}
          value={total.toLocaleString()}
          hint={search ? `matching “${search}”` : "One per application-billed session"}
        />
        <StatCard label="On this page" value={money(pageValue)} hint={`${rows.length} of ${total}`} />
        <StatCard
          label="Storage"
          value="Object store"
          hint="Bytes never enter MySQL — only the key does"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") {
                setDraft("");
                commit("");
              }
            }}
            placeholder="Invoice number, driver, station or session id…"
            className={cn(inputShell, "w-full pl-9")}
          />
        </div>
        {draft !== search ? (
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-ink-faint">
            press enter
          </span>
        ) : null}
        {search ? (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              commit("");
            }}
            className="text-xs font-medium text-emerald-700 hover:underline dark:text-accent-glow"
          >
            Clear
          </button>
        ) : null}
      </div>

      {query.loading ? (
        <p className="text-sm text-slate-500 dark:text-ink-muted">Loading invoices…</p>
      ) : query.error ? (
        <div className="rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {query.error}
        </div>
      ) : rows.length === 0 ? (
        <div className={cn(cardShell, "p-8 text-center")}>
          <FileText className="mx-auto h-8 w-8 text-slate-300 dark:text-ink-faint" />
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-ink">
            {search ? "No invoices match that search" : "No invoices yet"}
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-ink-muted">
            {search
              ? "Try an invoice number, a driver's name, or a session id."
              : "Stop a running session from the Sessions page — the worker renders one a moment later."}
          </p>
        </div>
      ) : (
        <>
          <div className={cn(cardShell, "overflow-x-auto")}>
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">Invoice</th>
                  <th className="px-4 py-3 font-medium">Driver</th>
                  <th className="px-4 py-3 font-medium">Session</th>
                  <th className="px-4 py-3 text-right font-medium">Energy</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-right font-medium">PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-white/5">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-slate-900 dark:text-ink">{r.number}</p>
                      <p className="text-[11px] text-slate-500 dark:text-ink-faint">
                        {new Date(r.generated_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-slate-900 dark:text-ink">{r.user_name}</p>
                      <p className="truncate text-[11px] text-slate-500 dark:text-ink-muted">
                        {r.user_email}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-slate-700 dark:text-ink-muted">
                        {r.station_name ?? "—"}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-ink-faint">
                        session #{r.session_id}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.kwh == null ? "—" : `${Number(r.kwh).toFixed(1)} kWh`}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-900 dark:text-ink">
                      {money(r.amount)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={resolveFileUrl(r.url)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-emerald-500/40 hover:text-emerald-700 dark:border-white/10 dark:text-ink-muted dark:hover:text-accent-glow"
                      >
                        <Download className="h-3.5 w-3.5" /> Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 ? (
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-slate-500 dark:text-ink-muted">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className={cn(inputShell, "px-3 py-1.5 text-sm disabled:opacity-40")}
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className={cn(inputShell, "px-3 py-1.5 text-sm disabled:opacity-40")}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <p className="mt-4 max-w-3xl text-xs text-slate-500 dark:text-ink-faint">
        Rendering a PDF costs 30–60 ms of CPU, so it does not happen inside the request that ends a
        session — that would hold the driver on a spinner and let a burst of session-ends saturate
        the API. It is a second queued job, which also means it can fail and retry on its own
        without ever replaying the wallet debit that already committed.
      </p>
    </div>
  );
}
