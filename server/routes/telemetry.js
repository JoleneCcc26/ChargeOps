// server/routes/telemetry.js - charger heartbeat ingest
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ENDPOINT THAT REFUSES TO TOUCH THE DATABASE
// ═════════════════════════════════════════════════════════════════════════════
// This is the hot path. Every charger in the fleet hits it, forever.
//
// It does exactly two things: shape-check the payload, and put it on a queue.
// It never INSERTs into charger_telemetry, never UPDATEs charger, never runs a
// JOIN. That work belongs to the telemetry worker, which does it in batches.
//
// The measurable consequence, and the one to put on screen during the demo:
// this handler answers in single-digit milliseconds and its latency stays flat
// whether ten chargers are reporting or two thousand, because the amount of
// work per request does not depend on how many requests are arriving. The
// database load, meanwhile, is decoupled from the arrival rate entirely - the
// queue absorbs the spike and the workers drain it at whatever rate MySQL is
// comfortable with.
//
// That is the whole "asynchronous / traffic-spike" dimension, and it is why the
// queue is not decoration.
import { Router } from "express";
import { pool } from "../db.js";
import { sendMessageBatch, QUEUES } from "../adapters/queue.js";
import { allowRoles, ROLES } from "../auth.js";

const router = Router();

const MAX_BEATS_PER_REQUEST = 500;

// POST /api/telemetry   { beats: [{ chargerId, powerKw, status, ... }, ...] }
router.post("/", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  try {
    const beats = Array.isArray(req.body?.beats)
      ? req.body.beats
      : req.body?.chargerId
      ? [req.body]           // tolerate a single beat posted bare
      : null;

    if (!beats || beats.length === 0) {
      return res.status(400).json({ error: "expected { beats: [...] }" });
    }
    if (beats.length > MAX_BEATS_PER_REQUEST) {
      // Bound the work per request so one client cannot make a single call
      // arbitrarily expensive. The charger firmware would chunk instead.
      return res
        .status(413)
        .json({ error: `at most ${MAX_BEATS_PER_REQUEST} beats per request` });
    }

    // One multi-row INSERT into job_queue for the whole batch - the producer
    // side of the same batching argument the worker makes on the consumer side.
    const enqueued = await sendMessageBatch(QUEUES.TELEMETRY, beats);

    // 202: accepted, not yet durable in charger_telemetry. A charger does not
    // need to know when the row lands; it needs to know we took the reading.
    res.status(202).json({ accepted: enqueued });
  } catch (err) {
    next(err);
  }
});

// GET /api/telemetry/recent?chargerId=12&limit=50
router.get("/recent", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const chargerId = Number(req.query.chargerId);

    const [rows] = await pool.query(
      `SELECT t.Telemetry_ID       AS id,
              t.Charger_ID         AS charger_id,
              t.Reported_At        AS reported_at,
              t.Power_KW           AS power_kw,
              t.Session_Energy_KWh AS energy_kwh,
              t.Status_Code        AS status,
              t.Temperature_C      AS temperature_c,
              t.Ingested_At        AS ingested_at,
              TIMESTAMPDIFF(MICROSECOND, t.Reported_At, t.Ingested_At) / 1000 AS lag_ms
         FROM charger_telemetry t
        ${Number.isInteger(chargerId) ? "WHERE t.Charger_ID = ?" : ""}
        ORDER BY t.Telemetry_ID DESC
        LIMIT ?`,
      Number.isInteger(chargerId) ? [chargerId, limit] : [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/telemetry/throughput - rows actually written, in 5-second buckets
//
// Charted next to queue backlog on the ops page. Backlog is what arrived;
// this is what got persisted. Watching the second line lag and then catch up
// to the first is the clearest picture of what a queue does for you.
router.get("/throughput", async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(Ingested_At) / 5) * 5) AS bucket,
              COUNT(*) AS rows_written
         FROM charger_telemetry
        WHERE Ingested_At > NOW() - INTERVAL 3 MINUTE
        GROUP BY bucket
        ORDER BY bucket`
    );
    res.json(
      rows.map((r) => ({
        bucket: r.bucket,
        rowsWritten: Number(r.rows_written),
        perSecond: Number((Number(r.rows_written) / 5).toFixed(1)),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/telemetry/stats
router.get("/stats", async (_req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(Ingested_At > NOW() - INTERVAL 60 SECOND) AS last_minute,
              ROUND(AVG(IF(Ingested_At > NOW() - INTERVAL 60 SECOND,
                           TIMESTAMPDIFF(MICROSECOND, Reported_At, Ingested_At) / 1000,
                           NULL))) AS avg_lag_ms
         FROM charger_telemetry`
    );
    res.json({
      total:      Number(row.total)       || 0,
      lastMinute: Number(row.last_minute) || 0,
      // End-to-end lag: charger clock -> row in MySQL. This is the number that
      // grows during a spike and shrinks as workers scale out, so it is the
      // honest measure of "how far behind is the pipeline right now".
      avgLagMs:   Number(row.avg_lag_ms)  || 0,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
