import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { cn, inputShell } from "../lib/cn";

export type SortDir = "asc" | "desc" | null;

export type ColumnDef<T> = {
  id: string;
  header: string;
  sortable?: boolean;
  headerClassName?: string;
  cellClassName?: string;
  cell: (row: T) => React.ReactNode;
  getSortValue?: (row: T) => string | number | null | undefined;
};

type Props<T> = {
  columns: ColumnDef<T>[];
  data: T[];
  rowKey: (row: T) => string;
  searchPlaceholder?: string;
  /** Filter rows by search query (lowercase, trimmed) */
  globalFilter?: (row: T, queryLower: string) => boolean;
  defaultPageSize?: number;
  pageSizeOptions?: number[];
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  getRowClassName?: (row: T) => string;
  /** Optional title row above toolbar */
  title?: string;
  description?: string;
  /** Controlled server-side pagination. Data must contain only the current page. */
  serverPagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
  };
  /** Controlled server-side search. */
  serverSearch?: {
    value: string;
    onChange: (value: string) => void;
  };
};

function defaultGlobalFilter<T extends object>(row: T, q: string): boolean {
  return Object.values(row).some((v) =>
    String(v ?? "")
      .toLowerCase()
      .includes(q)
  );
}

export function DataTable<T extends object>({
  columns,
  data,
  rowKey,
  searchPlaceholder = "Search…",
  globalFilter = defaultGlobalFilter,
  defaultPageSize = 10,
  pageSizeOptions = [5, 10, 25, 50],
  emptyMessage = "No rows to display.",
  onRowClick,
  getRowClassName,
  title,
  description,
  serverPagination,
  serverSearch,
}: Props<T>) {
  const [query, setQuery] = useState("");
  const [sortColumnId, setSortColumnId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const searchValue = serverSearch?.value ?? query;
  const q = searchValue.trim().toLowerCase();

  // What the user has typed but not yet submitted, for server-side search.
  // Separate from the committed value so keystrokes do not trigger requests.
  const [draft, setDraft] = useState(serverSearch?.value ?? "");
  const committed = serverSearch?.value;

  // Re-sync when the committed value changes from outside — a page resetting
  // filters, or a route change. Skipped while the user is mid-edit, so their
  // typing is never yanked out from under them.
  const lastCommitted = useRef(committed);
  useEffect(() => {
    if (committed !== lastCommitted.current) {
      lastCommitted.current = committed;
      setDraft(committed ?? "");
    }
  }, [committed]);

  const filtered = useMemo(() => {
    if (serverSearch || !q) return data;
    return data.filter((row) => globalFilter(row, q));
  }, [data, q, globalFilter, serverSearch]);

  const sorted = useMemo(() => {
    if (!sortColumnId || !sortDir) return filtered;
    const col = columns.find((c) => c.id === sortColumnId);
    if (!col?.getSortValue) return filtered;
    return [...filtered].sort((a, b) => {
      const va = col.getSortValue!(a);
      const vb = col.getSortValue!(b);
      const na = va === null || va === undefined ? "" : va;
      const nb = vb === null || vb === undefined ? "" : vb;
      if (typeof na === "number" && typeof nb === "number") {
        return sortDir === "asc" ? na - nb : nb - na;
      }
      const sa = String(na).toLowerCase();
      const sb = String(nb).toLowerCase();
      const cmp = sa.localeCompare(sb, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortColumnId, sortDir, columns]);

  const effectivePageSize = serverPagination?.pageSize ?? pageSize;
  const total = serverPagination?.total ?? sorted.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / effectivePageSize);

  const requestedPage = serverPagination ? serverPagination.page - 1 : page;
  const safePage = totalPages === 0 ? 0 : Math.min(requestedPage, totalPages - 1);
  const pageSlice = useMemo(() => {
    if (totalPages === 0) return [];
    if (serverPagination) return sorted;
    const start = safePage * effectivePageSize;
    return sorted.slice(start, start + effectivePageSize);
  }, [sorted, safePage, effectivePageSize, totalPages, serverPagination]);

  const startIdx = total === 0 ? 0 : safePage * effectivePageSize + 1;
  const endIdx = Math.min(total, safePage * effectivePageSize + pageSlice.length);

  const onHeaderClick = (col: ColumnDef<T>) => {
    // Sorting a single fetched page would look like a global sort while being
    // factually wrong. Remote tables keep the API's stable order until a
    // server-side sort contract is added.
    if (serverPagination || !col.sortable || !col.getSortValue) return;
    if (sortColumnId === col.id) {
      if (sortDir === "asc") setSortDir("desc");
      else if (sortDir === "desc") {
        setSortDir(null);
        setSortColumnId(null);
      } else setSortDir("asc");
    } else {
      setSortColumnId(col.id);
      setSortDir("asc");
    }
    setPage(0);
  };

  const SortIcon = ({ col }: { col: ColumnDef<T> }) => {
    if (serverPagination || !col.sortable) return null;
    if (sortColumnId !== col.id)
      return <ArrowDownUp className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />;
    if (sortDir === "asc")
      return (
        <ArrowUp className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-accent-glow" aria-hidden />
      );
    if (sortDir === "desc")
      return (
        <ArrowDown className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-accent-glow" aria-hidden />
      );
    return <ArrowDownUp className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />;
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-white/5 dark:bg-surface-raised/80 dark:shadow-card"
      )}
    >
      {(title || description) && (
        <div className="border-b border-slate-200 px-4 py-3 dark:border-white/5 sm:px-5">
          {title ? (
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="mt-0.5 text-xs text-slate-600 dark:text-ink-muted">{description}</p>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-3 border-b border-slate-200 p-3 dark:border-white/5 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-3">
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-ink-faint"
            aria-hidden
          />
          <input
            type="search"
            value={serverSearch ? draft : searchValue}
            onChange={(e) => {
              const next = e.target.value;
              if (!serverSearch) {
                // Client-side filtering is free: it re-filters an array that is
                // already in memory, so filtering as you type is fine here.
                setQuery(next);
                setPage(0);
                return;
              }
              // Server-side search costs an HTTP round trip and a database
              // query. Doing that per keystroke fires a request for every
              // letter, and the results flicker as earlier responses land after
              // later ones. Hold the text locally and let the user say when
              // they are done.
              //
              // Clearing the box is the one exception: emptying a search should
              // restore the full list straight away, because nobody expects to
              // press Enter to undo a filter.
              setDraft(next);
              if (next === "") serverSearch.onChange("");
            }}
            onKeyDown={(e) => {
              if (!serverSearch) return;
              if (e.key === "Enter") {
                e.preventDefault();
                serverSearch.onChange(draft.trim());
              } else if (e.key === "Escape") {
                setDraft("");
                serverSearch.onChange("");
              }
            }}
            // Commit on blur as well, so clicking away after typing does what
            // the user plainly meant instead of silently discarding it.
            onBlur={() => {
              if (serverSearch && draft.trim() !== serverSearch.value) {
                serverSearch.onChange(draft.trim());
              }
            }}
            placeholder={searchPlaceholder}
            className={cn(inputShell, "w-full pl-9", serverSearch && "pr-[6.5rem]")}
            aria-label="Search table"
          />
          {/* Says that the search is deferred, and highlights when what has
              been typed is not yet what the table is showing. */}
          {serverSearch ? (
            <span
              className={cn(
                "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                draft.trim() !== serverSearch.value
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-accent-glow"
                  : "text-slate-400 dark:text-ink-faint"
              )}
            >
              {draft.trim() !== serverSearch.value ? "press enter" : "enter to search"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wider text-slate-500 dark:border-white/5 dark:text-ink-faint">
              {columns.map((col) => (
                <th
                  key={col.id}
                  scope="col"
                  className={cn(
                    "px-3 py-3 font-medium sm:px-4",
                    !serverPagination && col.sortable && col.getSortValue && "cursor-pointer select-none hover:text-slate-800 dark:hover:text-ink",
                    col.headerClassName
                  )}
                  onClick={() => onHeaderClick(col)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onHeaderClick(col);
                    }
                  }}
                  tabIndex={!serverPagination && col.sortable && col.getSortValue ? 0 : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    <SortIcon col={col} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/5">
            {pageSlice.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-10 text-center text-slate-600 dark:text-ink-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageSlice.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={cn(
                    "hover:bg-slate-50 dark:hover:bg-white/[0.02]",
                    onRowClick && "cursor-pointer",
                    getRowClassName?.(row)
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((col) => (
                    <td key={col.id} className={cn("px-3 py-3 sm:px-4", col.cellClassName)}>
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-200 px-3 py-3 dark:border-white/5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <p className="text-xs text-slate-600 dark:text-ink-muted">
          {total === 0
            ? "0 results"
            : `Showing ${startIdx}–${endIdx} of ${total}`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-ink-muted">
            Rows
            <select
              value={effectivePageSize}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (serverPagination) serverPagination.onPageSizeChange(next);
                else {
                  setPageSize(next);
                  setPage(0);
                }
              }}
              className={cn(inputShell, "py-1.5")}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={cn(
                inputShell,
                "p-2 disabled:opacity-40"
              )}
              disabled={safePage <= 0 || totalPages === 0}
              onClick={() => serverPagination ? serverPagination.onPageChange(safePage) : setPage(Math.max(0, safePage - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[5.5rem] text-center text-xs text-slate-600 dark:text-ink-muted">
              {totalPages > 0 ? `${safePage + 1} / ${totalPages}` : "—"}
            </span>
            <button
              type="button"
              className={cn(inputShell, "p-2 disabled:opacity-40")}
              disabled={totalPages === 0 || safePage >= totalPages - 1}
              onClick={() => serverPagination ? serverPagination.onPageChange(safePage + 2) : setPage(Math.min(totalPages - 1, safePage + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
