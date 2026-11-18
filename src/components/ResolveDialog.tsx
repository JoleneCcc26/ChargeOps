// src/components/ResolveDialog.tsx — closing a work order, with an optional
// repair photo. Used by the technician's job list and by the dispatch board,
// so a job resolved from either screen keeps its evidence.
import { useState } from "react";
import { AlertTriangle, Camera, X } from "lucide-react";
import { uploadAttachments } from "../api";
import { cn, inputShell } from "../lib/cn";
import { Modal } from "./Modal";

// ─────────────────────────────────────────────────────────────────────────────
// Resolving asks for notes, and the notes are the point
// ─────────────────────────────────────────────────────────────────────────────
// What was actually done is the only durable record of this repair. It is what
// the next technician reads on the history page six weeks from now, and it is
// the difference between "faulty connector" appearing four times and somebody
// noticing the connector keeps failing.
//
// A photo of the finished repair belongs with those notes. It used to go in
// through Field uploads, which only knew the station and charger, so the
// evidence never reached the work order it proves. Here the photo is uploaded
// with the work order id first, and the job is resolved only once the upload
// has been accepted: a failed upload leaves the job open rather than closing
// it without its evidence.
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // the limit the attachments API enforces
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** The fields the dialog reads; both the job list and the dispatch board have them. */
export interface ResolvableOrder {
  id: number | string;
  station_id: number | string;
  station_name: string;
  charger_id: number | string | null;
  issue_type: string;
}

export function ResolveDialog({
  order,
  busy,
  onClose,
  onSubmit,
}: {
  order: ResolvableOrder;
  busy: boolean;
  onClose: () => void;
  onSubmit: (notes: string) => void | Promise<void>;
}) {
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) {
      setError("Use a JPEG, PNG or WebP photo.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError("Photos can be at most 15 MB.");
      return;
    }
    setPhoto(file);
  }

  async function submit() {
    setError(null);
    if (photo) {
      setUploading(true);
      try {
        await uploadAttachments([photo], {
          maintenanceId: Number(order.id),
          stationId: Number(order.station_id),
          chargerId: order.charger_id == null ? undefined : Number(order.charger_id),
        });
      } catch (e) {
        setError(
          `The photo did not upload, so the job is still open: ${e instanceof Error ? e.message : "upload failed"}`
        );
        return;
      } finally {
        setUploading(false);
      }
    }
    await onSubmit(notes.trim());
  }

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
      <label className="mb-1 mt-3 block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">
        Repair photo (optional)
      </label>
      {photo ? (
        <div className={cn(inputShell, "flex w-full items-center justify-between gap-2 text-sm")}>
          <span className="inline-flex min-w-0 items-center gap-2">
            <Camera className="h-4 w-4 shrink-0 text-emerald-600 dark:text-accent-glow" />
            <span className="truncate text-slate-900 dark:text-ink">{photo.name}</span>
            <span className="shrink-0 text-xs text-slate-500 dark:text-ink-faint">
              {photo.size < 1024 * 1024
                ? `${Math.max(1, Math.round(photo.size / 1024))} KB`
                : `${(photo.size / 1024 / 1024).toFixed(1)} MB`}
            </span>
          </span>
          <button
            type="button"
            aria-label="Remove photo"
            onClick={() => setPhoto(null)}
            className="rounded p-1 text-slate-500 hover:bg-slate-500/10 dark:text-ink-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <label
          className={cn(
            inputShell,
            "flex w-full cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-ink-muted"
          )}
        >
          <Camera className="h-4 w-4 shrink-0" />
          Attach a photo of the finished repair
          <input
            type="file"
            accept={PHOTO_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      )}
      <p className="mt-1 text-xs text-slate-500 dark:text-ink-faint">
        Stored in object storage and kept with work order #{order.id}.
      </p>
      {error ? (
        <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cn(inputShell, "px-4 py-2 text-sm")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || uploading || notes.trim().length < 3}
          onClick={submit}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {uploading ? "Uploading photo…" : busy ? "Saving…" : "Mark resolved"}
        </button>
      </div>
    </Modal>
  );
}
