export function PageHeader({ subtitle }: { subtitle?: string }) {
  if (!subtitle) return null;
  return (
    <header className="mb-6 sm:mb-8">
      <p className="max-w-2xl text-sm text-slate-600 dark:text-ink-muted">{subtitle}</p>
    </header>
  );
}
