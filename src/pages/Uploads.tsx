// src/pages/Uploads.tsx — technician file intake
//
// The persona's actual workflow, and the clearest demo of the unstructured-file
// dimension. Drop a fault photo and a service report; the API answers 202 in
// milliseconds; the rows appear as "pending"; a second or two later they fill
// in with a fault category, a severity, an error code, extracted part numbers,
// and — for photos with a GPS tag — the station the picture was taken at.
//
// Nothing on this page waits for the extraction. That is the point: the upload
// request and the extraction are decoupled, and you can watch the gap.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2, Clock, FileText, Image as ImageIcon, Loader2, MapPin,
  RefreshCw, Upload, XCircle,
} from "lucide-react";

import {
  fetchAttachments, fetchAttachmentStats, uploadAttachments, reprocessAttachment,
  fetchStations, fetchChargers,
  type Attachment, type AttachmentStats, type Station, type Charger,
} from "../api";
import { resolveFileUrl } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { cn, cardShell, inputShell } from "../lib/cn";

export function Uploads() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [stats, setStats] = useState<AttachmentStats | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [chargers, setChargers] = useState<Charger[]>([]);

  const [stationId, setStationId] = useState<string>("");
  const [chargerId, setChargerId] = useState<string>("");

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [selected, setSelected] = useState<Attachment | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [rows, s] = await Promise.all([fetchAttachments({ limit: 60 }), fetchAttachmentStats()]);
    setAttachments(rows);
    setStats(s);
    return rows;
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    fetchStations().then(setStations).catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!stationId) { setChargers([]); setChargerId(""); return; }
    fetchChargers({ stationId }).then(setChargers).catch(() => setChargers([]));
    setChargerId("");
  }, [stationId]);

  // Poll while anything is still being processed, then stop.
  //
  // This is the honest way to render an async result: the client asked for work
  // to happen and now watches for it to land. In Milestone 2 the same UI would
  // be driven by a WebSocket push instead of a poll, but the shape of the
  // interaction — request accepted now, result later — does not change.
  const pendingCount = attachments.filter(
    (a) => a.process_status === "pending" || a.process_status === "processing"
  ).length;

  useEffect(() => {
    if (pendingCount === 0) return;
    const id = setInterval(() => { refresh().catch(() => {}); }, 900);
    return () => clearInterval(id);
  }, [pendingCount, refresh]);

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    setUploading(true);
    setMessage(null);
    try {
      const res = await uploadAttachments(list, {
        stationId: stationId ? Number(stationId) : undefined,
        chargerId: chargerId ? Number(chargerId) : undefined,
      });
      setMessage({
        kind: "ok",
        text: `202 Accepted — ${res.accepted.length} file(s) stored and queued for extraction.`,
      });
      await refresh();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "upload failed" });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader subtitle="Field technicians upload fault photos and service reports. Files go to object storage; a worker extracts EXIF, GPS, text, fault category and severity, then opens or updates the maintenance ticket — all after the request has already returned." />

      {/* ── Stat tiles ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <MiniStat label="Files" value={String(stats?.total ?? 0)} hint={`${stats?.images ?? 0} photos · ${stats?.documents ?? 0} docs`} />
        <MiniStat label="Processed" value={String(stats?.done ?? 0)} hint="extraction complete" tone="ok" />
        <MiniStat label="In queue" value={String((stats?.pending ?? 0) + (stats?.processing ?? 0))} hint="awaiting a worker" tone={pendingCount > 0 ? "busy" : undefined} />
        <MiniStat label="Failed" value={String(stats?.failed ?? 0)} hint="see error below" tone={(stats?.failed ?? 0) > 0 ? "err" : undefined} />
        {/* End-to-end async latency: queue wait + extraction, not extraction
            alone. That is the honest number — it is what a technician actually
            experiences, and it is the one that falls when workers scale out. */}
        <MiniStat label="Upload → done" value={`${stats?.avgProcessMs ?? 0} ms`} hint="queued + processed" />
      </div>

      {/* ── Drop zone ───────────────────────────────────────────────────── */}
      <div className={cn(cardShell, "p-4 sm:p-5")}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-ink-faint">
              Station (optional — a geotagged photo finds its own)
            </span>
            <select value={stationId} onChange={(e) => setStationId(e.target.value)} className={cn(inputShell, "w-full")}>
              <option value="">— not specified —</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.city_name}, {s.state}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-ink-faint">
              Charger (needed to auto-open a maintenance ticket)
            </span>
            <select value={chargerId} onChange={(e) => setChargerId(e.target.value)} disabled={!stationId} className={cn(inputShell, "w-full disabled:opacity-50")}>
              <option value="">— not specified —</option>
              {chargers.map((c) => (
                <option key={c.id} value={c.id}>#{c.id} — {c.charger_type} ({c.max_kw} kW)</option>
              ))}
            </select>
          </label>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInput.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
            dragging
              ? "border-emerald-500 bg-emerald-500/10"
              : "border-slate-300 hover:border-emerald-500/50 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/[0.02]"
          )}
        >
          {uploading ? (
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
          ) : (
            <Upload className="h-8 w-8 text-slate-400 dark:text-ink-faint" />
          )}
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-ink">
            {uploading ? "Uploading…" : "Drop fault photos and service reports here"}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-ink-faint">
            JPEG · PNG · PDF · TXT · CSV — up to 15 MB each. Generate samples with <code>npm run seed:demo</code>.
          </p>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,text/csv"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>

        {message ? (
          <p className={cn(
            "mt-3 flex items-center gap-2 text-xs",
            message.kind === "ok" ? "text-emerald-600 dark:text-accent-glow" : "text-rose-600 dark:text-rose-400"
          )}>
            {message.kind === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {message.text}
          </p>
        ) : null}
      </div>

      {/* ── Fault category breakdown ────────────────────────────────────── */}
      {stats?.byCategory.length ? (
        <div className={cn(cardShell, "p-4 sm:p-5")}>
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-ink">
            Faults classified from report text
          </h2>
          <p className="mb-3 mt-0.5 text-xs text-slate-600 dark:text-ink-muted">
            Categories and severities the worker derived — none of this was typed into a form.
          </p>
          <div className="flex flex-wrap gap-2">
            {stats.byCategory.map((c) => (
              <span key={`${c.category}-${c.severity}`} className={cn("rounded-lg px-2.5 py-1.5 text-xs font-medium", severityTone(c.severity))}>
                {c.category} · {c.severity} · {c.count}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Gallery ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {attachments.map((a) => (
          <AttachmentCard
            key={a.id}
            a={a}
            onOpen={() => setSelected(a)}
            onReprocess={async () => { await reprocessAttachment(a.id); await refresh(); }}
          />
        ))}
      </div>

      {attachments.length === 0 ? (
        <div className={cn(cardShell, "px-4 py-12 text-center")}>
          <p className="text-sm text-slate-600 dark:text-ink-muted">
            Nothing uploaded yet. Run <code>npm run seed:demo</code> to generate sample photos and
            reports, then drag them in above.
          </p>
        </div>
      ) : null}

      {selected ? <DetailDrawer a={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function AttachmentCard({
  a, onOpen, onReprocess,
}: {
  a: Attachment; onOpen: () => void; onReprocess: () => void;
}) {
  const busy = a.process_status === "pending" || a.process_status === "processing";

  return (
    <div className={cn(cardShell, "overflow-hidden")}>
      {/* Preview */}
      <button type="button" onClick={onOpen} className="block w-full text-left">
        {a.kind === "image" ? (
          <img
            src={resolveFileUrl(a.url)}
            alt={a.name}
            className="h-40 w-full bg-slate-100 object-cover dark:bg-surface-muted"
            loading="lazy"
          />
        ) : (
          <div className="flex h-40 items-center justify-center bg-slate-100 dark:bg-surface-muted">
            <FileText className="h-10 w-10 text-slate-400 dark:text-ink-faint" />
          </div>
        )}
      </button>

      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900 dark:text-ink">{a.name}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-ink-faint">
              {a.kind === "image" ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
              {formatBytes(a.size_bytes)}
              {a.image_width ? ` · ${a.image_width}×${a.image_height}` : ""}
              {a.word_count ? ` · ${a.word_count} words` : ""}
            </p>
          </div>
          <StatusPill status={a.process_status} />
        </div>

        {/* The derived fields — the whole point of the page */}
        {busy ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for a worker…
          </p>
        ) : a.process_status === "failed" ? (
          <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{a.process_error}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {a.fault_category ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", severityTone(a.severity))}>
                  {a.severity}
                </span>
                <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-ink-muted">
                  {a.fault_category}
                </span>
                {a.error_code ? (
                  <span className="rounded bg-slate-500/10 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:text-ink-muted">
                    {a.error_code}
                  </span>
                ) : null}
              </div>
            ) : null}

            {a.matched_station_name ? (
              <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-accent-glow">
                <MapPin className="h-3 w-3 shrink-0" />
                GPS matched {a.matched_station_name} ({a.match_distance_m} m)
              </p>
            ) : null}

            {a.summary ? (
              <p className="line-clamp-2 text-xs text-slate-600 dark:text-ink-muted">{a.summary}</p>
            ) : null}

            <div className="flex items-center gap-3 pt-1 text-[11px] text-slate-500 dark:text-ink-faint">
              {a.process_ms != null ? (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {Math.round(a.process_ms)} ms
                </span>
              ) : null}
              {a.maintenance_id ? <span>ticket #{a.maintenance_id}</span> : null}
              <button
                type="button"
                onClick={onReprocess}
                className="ml-auto flex items-center gap-1 hover:text-slate-800 dark:hover:text-ink"
                title="Re-run extraction on this file"
              >
                <RefreshCw className="h-3 w-3" />
                reprocess
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailDrawer({ a, onClose }: { a: Attachment; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl dark:bg-surface-raised sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-base font-semibold text-slate-900 dark:text-ink">{a.name}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-ink-faint">{a.storage_key}</p>
          </div>
          <button type="button" onClick={onClose} className={cn(inputShell, "shrink-0 p-2")} aria-label="Close">
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {a.kind === "image" ? (
          <img src={resolveFileUrl(a.url)} alt={a.name} className="mb-4 w-full rounded-xl" />
        ) : (
          <a
            href={resolveFileUrl(a.url)}
            target="_blank"
            rel="noreferrer"
            className={cn(inputShell, "mb-4 flex items-center justify-center gap-2 px-4 py-3 text-sm")}
          >
            <FileText className="h-4 w-4" />
            Open the document (signed URL, expires in 15 minutes)
          </a>
        )}

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-ink-faint">
          Structured fields written to MySQL
        </h3>
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {([
            ["Fault category", a.fault_category],
            ["Severity", a.severity],
            ["Error code", a.error_code],
            ["Matched station", a.matched_station_name],
            ["Match distance", a.match_distance_m != null ? `${a.match_distance_m} m` : null],
            ["Captured at", a.captured_at],
            ["GPS", a.gps_lat != null ? `${a.gps_lat}, ${a.gps_lng}` : null],
            ["Dimensions", a.image_width ? `${a.image_width} × ${a.image_height}` : null],
            ["Word count", a.word_count],
            ["Maintenance ticket", a.maintenance_id ? `#${a.maintenance_id}` : null],
            ["Extraction time", a.process_ms != null ? `${Math.round(a.process_ms)} ms` : null],
          ] as [string, unknown][])
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 border-b border-slate-100 py-1 dark:border-white/5">
                <dt className="text-slate-500 dark:text-ink-faint">{k}</dt>
                <dd className="text-right font-medium text-slate-900 dark:text-ink">{String(v)}</dd>
              </div>
            ))}
        </dl>

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-ink-faint">
          Raw extraction result (ATTACHMENT.Extracted, JSON column)
        </h3>
        <pre className="max-h-72 overflow-auto rounded-lg bg-slate-100 p-3 text-[11px] leading-relaxed text-slate-800 dark:bg-black/30 dark:text-ink-muted">
          {JSON.stringify(a.extracted, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Attachment["process_status"] }) {
  const map = {
    pending:    { label: "queued",     cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
    processing: { label: "processing", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
    done:       { label: "done",       cls: "bg-emerald-500/15 text-emerald-700 dark:text-accent-glow" },
    failed:     { label: "failed",     cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  }[status];
  return <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium", map.cls)}>{map.label}</span>;
}

function MiniStat({
  label, value, hint, tone,
}: {
  label: string; value: string; hint: string; tone?: "ok" | "busy" | "err";
}) {
  const toneCls =
    tone === "ok" ? "text-emerald-600 dark:text-accent-glow"
    : tone === "busy" ? "text-amber-600 dark:text-amber-400"
    : tone === "err" ? "text-rose-600 dark:text-rose-400"
    : "text-slate-900 dark:text-ink";
  return (
    <div className={cn(cardShell, "p-4")}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:text-ink-faint">{label}</p>
      <p className={cn("mt-1.5 font-display text-2xl font-semibold tabular-nums", toneCls)}>{value}</p>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-ink-faint">{hint}</p>
    </div>
  );
}

function severityTone(severity: string | null) {
  if (severity === "critical") return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  if (severity === "major") return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  if (severity === "minor") return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  return "bg-slate-500/15 text-slate-700 dark:text-ink-muted";
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
