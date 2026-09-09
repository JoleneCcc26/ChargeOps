// server/workers/handlers/fileProcess.js
//
// ═════════════════════════════════════════════════════════════════════════════
// UNSTRUCTURED IN, STRUCTURED OUT
// ═════════════════════════════════════════════════════════════════════════════
// The upload route does as little as possible: write the bytes to object
// storage, insert an attachment row with Process_Status='pending', enqueue a
// job, return 202. The technician's phone is free in about 20 ms even if the
// upload was a 4 MB photo on a bad connection.
//
// Everything expensive happens here, out of the request path:
//
//   IMAGE     -> header parse for dimensions
//             -> EXIF for capture time + GPS
//             -> GPS matched against station coordinates, so the photo
//                self-reports which site it was taken at
//
//   DOCUMENT  -> text extracted from the PDF/TXT
//             -> keyword classifier assigns fault category + severity
//             -> regex pulls out the vendor error code and part numbers
//
// Then, if the attachment is not already tied to a maintenance ticket, we open
// one - so a technician photographing a broken connector has, without filling
// in a single form field, produced a categorised, severity-ranked,
// station-linked ticket in the operations manager's queue.
//
// That last sentence is the demo. It is also the answer to "what does this
// application actually do for the persona?".
import { pool } from "../../db.js";
import { getObject } from "../../adapters/storage.js";
import {
  imageDimensions,
  parseExif,
  extractText,
  classifyFaultText,
  nearestStation,
} from "../../lib/extract.js";
import * as cache from "../../adapters/cache.js";

/**
 * @param {{attachmentId:number}} payload
 */
export async function handleFile(payload) {
  const attachmentId = Number(payload?.attachmentId);
  if (!Number.isInteger(attachmentId)) {
    throw new Error(`files: invalid payload ${JSON.stringify(payload)}`);
  }

  // ── Claim the attachment ──────────────────────────────────────────────────
  // The UPDATE ... WHERE Process_Status IN ('pending','failed') is a compare-
  // and-swap: only one worker's UPDATE can match, so a redelivered job that
  // arrives while the first is still running affects zero rows and exits. Same
  // idempotency problem as billing, solved with one statement instead of a
  // transaction because there is no money involved.
  const [claim] = await pool.query(
    `UPDATE attachment
        SET Process_Status = 'processing', Process_Error = NULL
      WHERE Attachment_ID = ? AND Process_Status IN ('pending','failed')`,
    [attachmentId]
  );
  if (claim.affectedRows === 0) {
    return { skipped: true, reason: "already processed or in flight" };
  }

  const [[att]] = await pool.query(
    `SELECT Attachment_ID, Storage_Key, Original_Name, Content_Type, Kind,
            Maintenance_ID, Station_ID, Charger_ID, Technician_ID
       FROM attachment WHERE Attachment_ID = ?`,
    [attachmentId]
  );
  if (!att) throw new Error(`files: attachment ${attachmentId} not found`);

  try {
    const { body } = await getObject(att.Storage_Key);

    const result =
      att.Kind === "image"
        ? await processImage(body)
        : processDocument(body, att.Content_Type, att.Original_Name);

    // ── Persist the structured fields ───────────────────────────────────────
    await pool.query(
      `UPDATE attachment
          SET Process_Status     = 'done',
              Processed_At       = NOW(3),
              Extracted          = CAST(? AS JSON),
              Fault_Category     = ?,
              Severity           = ?,
              Error_Code         = ?,
              Summary            = ?,
              Word_Count         = ?,
              Image_Width        = ?,
              Image_Height       = ?,
              Captured_At        = ?,
              Gps_Lat            = ?,
              Gps_Lng            = ?,
              Matched_Station_ID = ?,
              Match_Distance_M   = ?,
              Station_ID         = COALESCE(Station_ID, ?)
        WHERE Attachment_ID = ?`,
      [
        JSON.stringify(result.extracted),
        result.faultCategory ?? null,
        result.severity ?? null,
        result.errorCode ?? null,
        result.summary ?? null,
        result.wordCount ?? null,
        result.imageWidth ?? null,
        result.imageHeight ?? null,
        result.capturedAt ?? null,
        result.gpsLat ?? null,
        result.gpsLng ?? null,
        result.matchedStationId ?? null,
        result.matchDistanceM ?? null,
        result.matchedStationId ?? null,
        attachmentId,
      ]
    );

    // ── Open or enrich the maintenance ticket ───────────────────────────────
    const maintenanceId = await linkMaintenance(att, result);

    cache.invalidate("maintenance:");
    cache.invalidate("attachments:");

    return {
      attachmentId,
      kind: att.Kind,
      faultCategory: result.faultCategory,
      severity: result.severity,
      matchedStationId: result.matchedStationId,
      maintenanceId,
    };
  } catch (err) {
    // Record why it failed so the UI can show it, then rethrow so the queue
    // handles retry/dead-lettering. Setting the status back to 'failed' also
    // re-arms the compare-and-swap above, so a retry can claim it again.
    await pool.query(
      `UPDATE attachment
          SET Process_Status = 'failed', Process_Error = ?
        WHERE Attachment_ID = ?`,
      [String(err.message).slice(0, 1000), attachmentId]
    );
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Image pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function processImage(buf) {
  const dims = imageDimensions(buf);
  const exif = parseExif(buf);

  let matched = null;
  if (exif.gpsLat != null && exif.gpsLng != null) {
    // Only stations that actually have coordinates can be matched. In a real
    // deployment this list would be cached or narrowed by a bounding box; at a
    // few hundred stations a full scan is far cheaper than the round trip.
    const [stations] = await pool.query(
      `SELECT Station_ID AS id, Station_Name AS name,
              Station_Lat AS lat, Station_Lng AS lng
         FROM station
        WHERE Station_Lat IS NOT NULL AND Station_Lng IS NOT NULL`
    );
    matched = nearestStation(exif.gpsLat, exif.gpsLng, stations);
  }

  return {
    extracted: {
      type: "image",
      format: dims.format,
      dimensions: dims.width ? `${dims.width}x${dims.height}` : null,
      exif,
      geoMatch: matched,
      // Named so the Milestone 2 diff is obvious: this key is where
      // Rekognition's DetectLabels response will land.
      labels: null,
      analyzer: "local-header-and-exif-parser",
    },
    imageWidth: dims.width,
    imageHeight: dims.height,
    capturedAt: exif.capturedAt ?? null,
    gpsLat: exif.gpsLat ?? null,
    gpsLng: exif.gpsLng ?? null,
    matchedStationId: matched?.stationId ?? null,
    matchDistanceM: matched?.distanceM ?? null,
    // A photo on its own tells us where and when, not what is broken. The
    // accompanying report supplies the category; leaving these null is honest.
    faultCategory: null,
    severity: null,
    errorCode: null,
    summary: matched
      ? `Photo taken ${matched.distanceM} m from ${matched.stationName}.`
      : "Photo with no GPS tag.",
    wordCount: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Document pipeline
// ─────────────────────────────────────────────────────────────────────────────

function processDocument(buf, contentType, filename) {
  const text = extractText(buf, contentType, filename);
  const c = classifyFaultText(text);

  return {
    extracted: {
      type: "document",
      characters: text.length,
      // Keep a bounded excerpt for the UI. Storing the whole document text in a
      // JSON column would put the blob back in MySQL, which is the exact thing
      // the storage adapter exists to avoid.
      excerpt: text.slice(0, 1200),
      classification: {
        scores: c.scores,
        matchedTerms: c.matched,
        confidence: c.confidence,
      },
      partNumbers: c.partNumbers,
      analyzer: "local-keyword-classifier",
    },
    faultCategory: c.faultCategory,
    severity: c.severity,
    errorCode: c.errorCode,
    summary: c.summary,
    wordCount: c.wordCount,
    imageWidth: null,
    imageHeight: null,
    capturedAt: null,
    gpsLat: null,
    gpsLng: null,
    matchedStationId: null,
    matchDistanceM: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticketing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach the file to a maintenance ticket, opening one if needed.
 *
 * A photo alone does not open a ticket (we would have no idea what is wrong);
 * a classified report does. When the report arrives after the photo, the photo
 * is swept into the same ticket if it points at the same charger.
 */
async function linkMaintenance(att, result) {
  if (att.Maintenance_ID) return att.Maintenance_ID;
  if (!result.faultCategory || result.faultCategory === "unknown") return null;

  const chargerId = att.Charger_ID;
  // The station can always be derived from the charger, and when a technician
  // uploads against a charger id that is the only thing they supply. Requiring
  // the caller to send both meant an upload naming the exact broken unit
  // silently raised no ticket — the one case where the platform had the most
  // information was the case it did the least with.
  let stationId = att.Station_ID ?? result.matchedStationId;
  if (!stationId && chargerId) {
    const [[row]] = await pool.query(
      "SELECT Station_ID FROM charger WHERE Charger_ID = ?",
      [chargerId]
    );
    stationId = row?.Station_ID ?? null;
  }
  if (!chargerId || !stationId) return null;

  // Reuse the open ticket for this charger if there is one, so five photos of
  // the same fault do not become five tickets.
  const [[open]] = await pool.query(
    `SELECT Maintenance_ID FROM maintenance_log
      WHERE Charger_ID = ? AND Status IN ('Reported','Assigned','In Progress')
      ORDER BY Maintenance_ID DESC LIMIT 1`,
    [chargerId]
  );

  let maintenanceId = open?.Maintenance_ID ?? null;

  if (!maintenanceId) {
    // Raised UNASSIGNED, exactly like a fault a charger reports about itself.
    //
    // This used to choose a technician here, purely because Technician_ID was
    // NOT NULL and the row could not be written without one. That constraint is
    // gone, and with it the reason to guess: who attends is a dispatch decision
    // made by the operations manager, who can see the whole queue, everybody's
    // workload and how far each technician is from the site. A worker parsing a
    // photograph knows none of those things.
    const issue =
      `[${result.severity}] ${result.faultCategory}` +
      (result.errorCode ? ` (${result.errorCode})` : "") +
      (result.summary ? ` - ${result.summary}` : "");

    const [res] = await pool.query(
      `INSERT INTO maintenance_log
         (Charger_ID, Station_ID, Technician_ID, Issue_Reported, Resolved_Time, Status,
          Reported_At, Reported_By, Report_Source, Fault_Code, Severity, Priority)
       VALUES (?, ?, NULL, ?, NULL, 'Reported', NOW(), ?, 'field_report', ?, ?, ?)`,
      [
        chargerId,
        stationId,
        issue.slice(0, 1000),
        att.Technician_ID ? `tech${att.Technician_ID}` : "field-upload",
        // The classifier now always supplies a code for a known category, and
        // this path only runs for known categories — but the column stays
        // non-null here rather than relying on that, because the doctor script
        // asserts every work order has a code and a silent null would fail a
        // release rather than a test.
        result.errorCode ?? `CAT-${String(result.faultCategory).toUpperCase()}`,
        result.severity ?? "major",
        result.severity === "critical" ? "high" : "normal",
      ]
    );
    maintenanceId = res.insertId;

    // A charger with a critical fault should stop taking customers immediately.
    if (result.severity === "critical") {
      await pool.query(
        `UPDATE charger SET Charger_Availability_Status = 'Out of Service'
          WHERE Charger_ID = ?`,
        [chargerId]
      );
      cache.invalidate("chargers:");
    }
  }

  await pool.query(
    `UPDATE attachment SET Maintenance_ID = ? WHERE Attachment_ID = ?`,
    [maintenanceId, att.Attachment_ID]
  );

  // Sweep in any earlier un-ticketed files for the same charger (the photo that
  // arrived a minute before the report).
  await pool.query(
    `UPDATE attachment
        SET Maintenance_ID = ?
      WHERE Maintenance_ID IS NULL
        AND Charger_ID = ?
        AND Uploaded_At > NOW() - INTERVAL 1 HOUR`,
    [maintenanceId, chargerId]
  );

  return maintenanceId;
}
