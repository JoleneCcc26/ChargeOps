// server/routes/attachments.js - technician file intake
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ACCEPT-AND-DEFER PATTERN
// ═════════════════════════════════════════════════════════════════════════════
// POST /api/attachments does four cheap things and nothing else:
//
//   1. validate the upload (type, size)
//   2. write the bytes to object storage
//   3. INSERT one attachment row with Process_Status='pending'
//   4. enqueue a "files" job and return 202 Accepted
//
// Parsing EXIF, extracting PDF text, classifying the fault, matching GPS to a
// station and opening a maintenance ticket all happen later, in a worker.
//
// Why this matters for the persona: a technician is standing in a parking
// garage on one bar of LTE. Their phone should be free the moment the bytes
// land, not thirty seconds later when a classifier finishes. And on the server
// side, ten technicians uploading at once cost ten file writes - not ten
// concurrent CPU-bound extraction jobs fighting over the same event loop.
//
// 202 Accepted (not 200 OK) is the honest status code: "I have taken
// responsibility for this, it is not finished yet, here is where to look".
// The response carries the attachment id so the UI can poll for the result -
// which is exactly what the Uploads page does.
import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";

import { pool } from "../db.js";
import { allowRoles, ROLES } from "../auth.js";
import { putObject, deleteObject, buildKey, getSignedUrl } from "../adapters/storage.js";
import { sendMessageTx, QUEUES } from "../adapters/queue.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Upload handling
// ─────────────────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB - a generous phone photo

const ALLOWED = {
  "image/jpeg": "image",
  "image/png":  "image",
  "image/webp": "image",
  "application/pdf": "document",
  "text/plain":      "document",
  "text/csv":        "document",
  "text/markdown":   "document",
};

/**
 * memoryStorage, deliberately: the bytes are going to object storage, so
 * writing them to a local temp file first would be an extra write and an extra
 * cleanup path. It is safe here only because MAX_UPLOAD_BYTES is small and
 * bounded - a service accepting multi-GB video would stream to disk (or, in the
 * cloud, skip the API entirely and have the browser PUT straight to a presigned
 * S3 URL, which is the standard pattern once files get big).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error(`unsupported file type: ${file.mimetype}`));
  },
});

// POST /api/attachments   (multipart: files[] + stationId/chargerId/technicianId)
router.post("/", allowRoles(ROLES.OPS_MANAGER, ROLES.TECHNICIAN), upload.array("files", 5), async (req, res, next) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: "no files uploaded" });
    }

    const stationId    = intOrNull(req.body.stationId);
    const chargerId    = intOrNull(req.body.chargerId);
    const technicianId = intOrNull(req.body.technicianId);
    const maintenanceId = intOrNull(req.body.maintenanceId);

    const accepted = [];

    for (const file of req.files) {
      const kind = ALLOWED[file.mimetype] ?? "other";
      const key = buildKey(kind === "image" ? "maintenance/photos" : "maintenance/reports",
                           file.originalname);

      // ── bytes -> object storage ─────────────────────────────────────────
      const stored = await putObject(key, file.buffer, file.mimetype);

      // ── pointer + metadata -> MySQL ─────────────────────────────────────
      const conn = await pool.getConnection();
      let result;
      let jobId;
      try {
        await conn.beginTransaction();
        [result] = await conn.query(
          `INSERT INTO attachment
             (Maintenance_ID, Station_ID, Charger_ID, Technician_ID,
              Storage_Key, Original_Name, Content_Type, Size_Bytes, Checksum_SHA256,
              Kind, Process_Status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            maintenanceId, stationId, chargerId, technicianId,
            key,
            file.originalname.slice(0, 255),
            file.mimetype,
            stored.size,
            stored.checksumSha256,
            kind,
          ]
        );

        // Metadata and queue publication commit together. If either fails the
        // database rolls back, and the compensating delete below removes bytes.
        jobId = await sendMessageTx(conn, QUEUES.FILES, { attachmentId: result.insertId });
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        await deleteObject(key).catch(() => {});
        throw err;
      } finally {
        conn.release();
      }

      accepted.push({
        attachmentId: result.insertId,
        jobId,
        key,
        name: file.originalname,
        kind,
        sizeBytes: stored.size,
        processStatus: "pending",
      });
    }

    res.status(202).json({
      accepted,
      message: "Files stored. Extraction is running asynchronously.",
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading back
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/attachments?status=done&category=cable&limit=50
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    if (req.query.status)   { conditions.push("a.Process_Status = ?"); params.push(req.query.status); }
    if (req.query.category) { conditions.push("a.Fault_Category = ?"); params.push(req.query.category); }
    if (req.query.severity) { conditions.push("a.Severity = ?");       params.push(req.query.severity); }
    if (req.query.kind)     { conditions.push("a.Kind = ?");           params.push(req.query.kind); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Number(req.query.limit) || 60, 200);

    const [rows] = await pool.query(
      `SELECT a.Attachment_ID   AS id,
              a.Original_Name   AS name,
              a.Storage_Key     AS storage_key,
              a.Content_Type    AS content_type,
              a.Size_Bytes      AS size_bytes,
              a.Kind            AS kind,
              a.Process_Status  AS process_status,
              a.Process_Error   AS process_error,
              a.Fault_Category  AS fault_category,
              a.Severity        AS severity,
              a.Error_Code      AS error_code,
              a.Summary         AS summary,
              a.Word_Count      AS word_count,
              a.Image_Width     AS image_width,
              a.Image_Height    AS image_height,
              a.Captured_At     AS captured_at,
              a.Gps_Lat         AS gps_lat,
              a.Gps_Lng         AS gps_lng,
              a.Match_Distance_M AS match_distance_m,
              a.Maintenance_ID  AS maintenance_id,
              a.Charger_ID      AS charger_id,
              a.Uploaded_At     AS uploaded_at,
              a.Processed_At    AS processed_at,
              a.Extracted       AS extracted,
              s.Station_Name    AS station_name,
              ms.Station_Name   AS matched_station_name,
              TIMESTAMPDIFF(MICROSECOND, a.Uploaded_At, a.Processed_At) / 1000 AS process_ms
         FROM attachment a
         LEFT JOIN station s  ON s.Station_ID  = a.Station_ID
         LEFT JOIN station ms ON ms.Station_ID = a.Matched_Station_ID
         ${where}
         ORDER BY a.Attachment_ID DESC
         LIMIT ?`,
      [...params, limit]
    );

    // The signed URL is minted per response and expires in 15 minutes, so it is
    // never stored anywhere and a leaked screenshot of the API output goes
    // stale on its own.
    res.json(
      rows.map((r) => ({
        ...r,
        url: getSignedUrl(r.storage_key, 900),
        extracted: typeof r.extracted === "string" ? safeJson(r.extracted) : r.extracted,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/attachments/stats - tiles on the Uploads page
router.get("/stats", async (_req, res, next) => {
  try {
    const [[counts]] = await pool.query(
      `SELECT COUNT(*)                                AS total,
              SUM(Process_Status = 'pending')         AS pending,
              SUM(Process_Status = 'processing')      AS processing,
              SUM(Process_Status = 'done')            AS done,
              SUM(Process_Status = 'failed')          AS failed,
              SUM(Kind = 'image')                     AS images,
              SUM(Kind = 'document')                  AS documents,
              COALESCE(SUM(Size_Bytes), 0)            AS total_bytes,
              ROUND(AVG(TIMESTAMPDIFF(MICROSECOND, Uploaded_At, Processed_At) / 1000)) AS avg_process_ms
         FROM attachment`
    );

    const [byCategory] = await pool.query(
      `SELECT Fault_Category AS category, Severity AS severity, COUNT(*) AS count
         FROM attachment
        WHERE Fault_Category IS NOT NULL
        GROUP BY Fault_Category, Severity
        ORDER BY count DESC`
    );

    res.json({
      total:      Number(counts.total)      || 0,
      pending:    Number(counts.pending)    || 0,
      processing: Number(counts.processing) || 0,
      done:       Number(counts.done)       || 0,
      failed:     Number(counts.failed)     || 0,
      images:     Number(counts.images)     || 0,
      documents:  Number(counts.documents)  || 0,
      totalBytes: Number(counts.total_bytes) || 0,
      avgProcessMs: Number(counts.avg_process_ms) || 0,
      byCategory: byCategory.map((r) => ({
        category: r.category,
        severity: r.severity,
        count: Number(r.count),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/attachments/:id/reprocess - re-run extraction on one file
router.post("/:id/reprocess", allowRoles(ROLES.OPS_MANAGER, ROLES.TECHNICIAN), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid attachment id" });
    await conn.beginTransaction();
    const [updated] = await conn.query(
      `UPDATE attachment SET Process_Status = 'pending', Process_Error = NULL
        WHERE Attachment_ID = ?`,
      [id]
    );
    if (updated.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "attachment not found" });
    }
    const jobId = await sendMessageTx(conn, QUEUES.FILES, { attachmentId: id });
    await conn.commit();
    res.status(202).json({ attachmentId: id, jobId });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

function intOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Unused; kept so upload keys stay unique if buildKey is ever changed. */
export const randomKeySuffix = () => crypto.randomBytes(4).toString("hex");

export default router;
