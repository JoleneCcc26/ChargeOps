// src/components/Modal.tsx — the dialog frame shared by the work-order and
// approval screens. It lived in MyWork.tsx until the resolve dialog moved out.
import { cardShell, cn } from "../lib/cn";

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
