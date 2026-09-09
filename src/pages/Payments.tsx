import {useMemo, useState} from "react";
import {
  Bar, BarChart, CartesianGrid, Cell,
  Legend, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { useApi }     from "../hooks/useApi";
import { fetchPaymentAnalytics, fetchPaymentFilterOptions, fetchPaymentsPage, type Payment } from "../api/index";
import { cardShell, cn, inputShell } from "../lib/cn";

const TT = { backgroundColor: "#1a2332", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", fontSize: "12px", color: "#e2e8f0" };

// Higher-contrast palette (vivid + dark-mode readable). Keyed case-insensitively.
const PIE_PALETTE = ["#f59e0b", "#3b82f6", "#ef4444", "#10b981", "#a855f7", "#ec4899"];
const PIE_COLORS: Record<string, string> = {
  charging:     "#3b82f6",
  subscription: "#10b981",
  "wallet top-up": "#a855f7",
};
function colorFor(name: string, idx: number): string {
  return PIE_COLORS[name.trim().toLowerCase()] ?? PIE_PALETTE[idx % PIE_PALETTE.length];
}

// Case-insensitive trimmed compare
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const TYPE_CLS: Record<string, string> = {
  charging:       "bg-sky-500/20     text-sky-700 dark:text-sky-300     ring-sky-500/40",
  subscription:   "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40",
  "wallet top-up": "bg-violet-500/20  text-violet-700 dark:text-violet-200  ring-violet-500/40",
};
const STATUS_CLS: Record<string, string> = {
  success:   "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40",
  completed: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-emerald-500/40",
  pending:   "bg-amber-500/20   text-amber-700 dark:text-amber-200   ring-amber-500/40",
  failed:    "bg-rose-500/20    text-rose-700 dark:text-rose-300    ring-rose-500/40",
};

function TypeBadge({ type }: { type: string }) {
  const cls = TYPE_CLS[norm(type)] ?? "bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-slate-400/40";
  return <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", cls)}>{type}</span>;
}
function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_CLS[norm(status)] ?? "bg-slate-500/20 text-slate-700 dark:text-slate-300 ring-slate-400/40";
  return <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", cls)}>{status}</span>;
}
function Loading() {
  return <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-ink-muted">Loading…</div>;
}
function Err({ msg }: { msg: string }) {
  return <div className="flex h-40 items-center justify-center text-sm text-rose-400">{msg}</div>;
}

export function Payments() {
  const [filterType,   setFilterType]   = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterMethod, setFilterMethod] = useState("all");
  // The time window sits with the other filters rather than only on the chart,
  // because it applies to both. A breakdown over all time above a table showing
  // this week is two different claims on one screen.
  const [days, setDays] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  // `search` is committed by the search box on Enter (or blur), not on every
  // keystroke, so it already changes rarely. Deferring it further only made
  // the value lag behind what the user submitted.

  const payments = useApi(
    () => fetchPaymentsPage({
      type: filterType !== "all" ? filterType : undefined,
      status: filterStatus !== "all" ? filterStatus : undefined,
      method: filterMethod !== "all" ? filterMethod : undefined,
      search: search || undefined,
      days: days !== "all" ? Number(days) : undefined,
      page,
      pageSize,
    }),
    [filterType, filterStatus, filterMethod, search, days, page, pageSize]
  );
  const filterOptions = useApi(fetchPaymentFilterOptions, []);
  const analytics = useApi(
    () => fetchPaymentAnalytics({
      type: filterType !== "all" ? filterType : undefined,
      status: filterStatus !== "all" ? filterStatus : undefined,
      method: filterMethod !== "all" ? filterMethod : undefined,
      search: search || undefined,
      days: days !== "all" ? Number(days) : undefined,
    }),
    [filterType, filterStatus, filterMethod, search, days]
  );

  const rows = payments.data?.items ?? [];
  const filtered = rows;

  const pieData = useMemo(() => {
    return (analytics.data?.typeBreakdown ?? [])
      .map((r) => ({ name: r.type, value: Number(r.total ?? 0) }))
      .filter((d) => d.value > 0);
  }, [analytics.data]);

  const barData = useMemo(() => {
    return (analytics.data?.monthly ?? [])
      .map((r) => ({ month: r.month, revenue: Number(r.revenue ?? 0) }))
      .filter((d) => !!d.month && d.revenue > 0);
  }, [analytics.data]);

  const typeOptions = filterOptions.data?.types ?? [];
  const statusOptions = filterOptions.data?.statuses ?? [];
  const methodOptions = filterOptions.data?.methods ?? [];

  const columns: ColumnDef<Payment>[] = useMemo(() => [
    {
      id: "id", header: "Payment ID", sortable: true,
      getSortValue: (p) => String(p.id),
      cell: (p) => <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">{p.id}</span>,
    },
    {
      id: "user_name", header: "User", sortable: true,
      getSortValue: (p) => p.user_name,
      cell: (p) => <span className="font-medium">{p.user_name}</span>,
    },
    {
      id: "type", header: "Payment Type", sortable: true,
      getSortValue: (p) => p.type,
      cell: (p) => <TypeBadge type={p.type} />,
    },
    {
      id: "amount", header: "Amount", sortable: true,
      headerClassName: "text-right", cellClassName: "text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400",
      getSortValue: (p) => Number(p.amount),
      cell: (p) => `$${Number(p.amount ?? 0).toFixed(2)}`,
    },
    {
      id: "method", header: "Payment Method", sortable: true,
      getSortValue: (p) => p.method,
      cell: (p) => <span className="text-slate-600 dark:text-ink-muted">{p.method}</span>,
    },
    {
      id: "status", header: "Status", sortable: true,
      getSortValue: (p) => p.status,
      cell: (p) => <StatusBadge status={p.status} />,
    },
    {
      id: "session_id", header: "Session ID", sortable: true,
      getSortValue: (p) => String(p.session_id ?? ""),
      cell: (p) => (
        <span className="font-mono text-xs text-slate-500 dark:text-ink-faint">
          {p.session_id ?? "—"}
        </span>
      ),
    },
    {
      id: "created_at", header: "Created Time", sortable: true,
      getSortValue: (p) => p.created_at ?? "",
      cell: (p) => (
        <span className="tabular-nums text-xs text-slate-600 dark:text-ink-muted">
          {p.created_at ? new Date(p.created_at).toLocaleString() : "—"}
        </span>
      ),
    },
  ], []);

  return (
    <div>
      <PageHeader subtitle="Transactions from MySQL payment table — joined with user, session, and subscription." />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Payment Type</label>
          <select value={filterType} onChange={(e) => { setFilterType(e.target.value); setPage(1); }} className={inputShell}>
            <option value="all">All types</option>
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Status</label>
          <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }} className={inputShell}>
            <option value="all">All statuses</option>
            {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Method</label>
          <select value={filterMethod} onChange={(e) => { setFilterMethod(e.target.value); setPage(1); }} className={inputShell}>
            <option value="all">All methods</option>
            {methodOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-ink-faint">Period</label>
          <select value={days} onChange={(e) => { setDays(e.target.value); setPage(1); }} className={inputShell}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
            <option value="all">All time</option>
          </select>
        </div>
        {payments.loading ? null : (
          <p className="text-xs text-slate-500 dark:text-ink-faint">{rows.length} on this page · {payments.data?.total ?? rows.length} total payments</p>
        )}
      </div>

      {/* Charts */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {/* Revenue by Payment Type */}
        <div className={cn(cardShell, "p-4 sm:p-5")}>
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">Revenue by Payment Type</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-ink-muted">
            Successful payments ·{" "}
            {days === "all"
              ? "all time"
              : days === "365"
                ? "last 12 months"
                : `last ${days} days`}
            {filterType !== "all" || filterStatus !== "all" || filterMethod !== "all" || search
              ? " · matching the filters below"
              : ""}
          </p>
          <div className="mt-2 h-64 min-h-[220px] w-full sm:h-72">
            {analytics.loading ? <Loading /> : analytics.error ? <Err msg={analytics.error} /> : pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    label={({ name, value, percent }) =>
                      `${name}: $${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} (${Math.round((percent ?? 0) * 100)}%)`
                    }
                    labelLine={{ stroke: "#94a3b8", strokeWidth: 1 }}
                  >
                    {pieData.map((e, i) => (
                      <Cell key={e.name} fill={colorFor(e.name, i)} stroke="rgba(15,20,25,0.9)" strokeWidth={1} />
                    ))}
                  </Pie>
                  <Legend
                    wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }}
                    formatter={(v) => <span className="text-slate-700 dark:text-slate-200">{v}</span>}
                  />
                  <Tooltip
                    contentStyle={TT}
                    formatter={(v: number, name) => [`$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, name]}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-ink-muted">No completed payments to chart.</div>
            )}
          </div>
        </div>

        {/* Monthly Revenue Trend */}
        <div className={cn(cardShell, "p-4 sm:p-5")}>
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">Monthly Revenue Trend</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-ink-muted">Completed Payment_Amount · grouped by Created_Time month</p>
          <div className="mt-4 h-64 min-h-[220px] w-full sm:h-72">
            {analytics.loading ? <Loading /> : analytics.error ? <Err msg={analytics.error} /> : barData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 16, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    angle={-24}
                    textAnchor="end"
                    height={52}
                  />
                  <YAxis
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  />
                  <Tooltip
                    contentStyle={TT}
                    formatter={(v: number) => [`$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, "Revenue"]}
                  />
                  <Bar
                    dataKey="revenue"
                    fill="#3b82f6"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={48}
                    label={{
                      position: "top",
                      fill: "#cbd5e1",
                      fontSize: 11,
                      formatter: (v: number) =>
                        `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-ink-muted">No completed payments to chart.</div>
            )}
          </div>
        </div>
      </div>

      {/* Payments Table */}
      {payments.loading ? <Loading /> : payments.error ? <Err msg={payments.error} /> : (
        <DataTable
          title="Payment History"
          description="From MySQL payment table — joined with user."
          columns={columns}
          data={filtered}
          rowKey={(p) => String(p.id)}
          searchPlaceholder="Search user, type, method, status…"
          globalFilter={(p, q) =>
            [String(p.id), p.user_name, p.type, p.method, p.status, p.created_at ?? ""]
              .join(" ").toLowerCase().includes(q)
          }
          serverSearch={{ value: search, onChange: (value) => { setSearch(value); setPage(1); } }}
          serverPagination={{
            page,
            pageSize,
            total: payments.data?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: (value) => { setPageSize(value); setPage(1); },
          }}
          defaultPageSize={25}
          pageSizeOptions={[10, 25, 50, 100]}
          emptyMessage="No payments match the selected filters."
        />
      )}
    </div>
  );
}
