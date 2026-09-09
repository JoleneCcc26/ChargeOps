export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Shared card shell for light / dark */
export const cardShell =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-white/5 dark:bg-surface-raised/80 dark:shadow-card";

export const inputShell =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-white/10 dark:bg-surface-raised dark:text-ink focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/40";
