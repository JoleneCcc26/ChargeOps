import { cn } from "../lib/cn";

export function StatCard({
  label,
  value,
  hint,
  trend,
}: {
  label: string;
  value: string;
  hint?: string;
  trend?: { text: string; positive?: boolean };
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 bg-white p-5 shadow-sm backdrop-blur-sm dark:border-white/5 dark:bg-surface-raised/80 dark:shadow-card"
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
        {label}
      </p>
      <p className="mt-2 font-display text-2xl font-semibold tabular-nums text-slate-900 dark:text-ink">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-slate-600 dark:text-ink-muted">{hint}</p>
      ) : null}
      {trend ? (
        <p
          className={
            trend.positive === false
              ? "mt-2 text-xs text-rose-600 dark:text-rose-400/90"
              : "mt-2 text-xs text-emerald-600 dark:text-accent-glow/90"
          }
        >
          {trend.text}
        </p>
      ) : null}
    </div>
  );
}
