// server/routes/ops.js - live infrastructure telemetry for the Cloud Ops page
//
// Everything the operations dashboard needs to draw the running system:
// queue depth, worker count, throughput, latency, cache hit rate, dead letters.
//
// This route is what makes the architecture VISIBLE. A screenshot of a diagram
// proves you drew a queue; a chart of backlog rising, workers scaling out, and
// latency recovering proves you built one.
import { Router } from "express";
import os from "node:os";

import { pool } from "../db.js";
import { queueStats, deadLetters, redriveDeadLetters, purgeCompleted } from "../adapters/queue.js";
import { storageStats } from "../adapters/storage.js";
import * as cache from "../adapters/cache.js";
import { allowRoles, ROLES } from "../auth.js";

const router = Router();

// GET /api/ops/stats - polled once a second by the Cloud Ops page
router.get("/stats", async (_req, res, next) => {
  try {
    // A worker is "live" if it heartbeat within the last 6 seconds (heartbeat
    // interval is 2 s, so this tolerates two missed beats before we call it
    // dead). Same liveness logic as a load balancer health check.
    const [workers] = await pool.query(
      `SELECT Worker_ID AS id, Pid AS pid, Queues AS queues,
              Jobs_Processed AS processed, Jobs_Failed AS failed,
              Started_At AS started_at,
              TIMESTAMPDIFF(MICROSECOND, Last_Heartbeat, NOW(3)) / 1000 AS heartbeat_age_ms
         FROM worker_node
        WHERE Last_Heartbeat > NOW(3) - INTERVAL 6 SECOND
        ORDER BY Worker_ID`
    );

    const [queues, storage] = await Promise.all([queueStats(), storageStats()]);

    const [[dbRow]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM charger_telemetry) AS telemetry_rows,
              (SELECT COUNT(*) FROM attachment)        AS attachments,
              (SELECT COUNT(*) FROM invoice)           AS invoices,
              (SELECT COUNT(*) FROM charging_session WHERE Session_Status = 'Active') AS pending_sessions`
    );

    res.json({
      timestamp: new Date().toISOString(),
      queues,
      totals: {
        backlog:    queues.reduce((s, q) => s + q.backlog, 0),
        throughput: Number(queues.reduce((s, q) => s + q.throughputPerSec, 0).toFixed(1)),
        dead:       queues.reduce((s, q) => s + q.dead, 0),
        completed:  queues.reduce((s, q) => s + q.done, 0),
      },
      workers: {
        count: workers.length,
        totalProcessed: workers.reduce((s, w) => s + Number(w.processed), 0),
        totalFailed:    workers.reduce((s, w) => s + Number(w.failed), 0),
        nodes: workers.map((w) => ({
          id: w.id,
          pid: w.pid,
          queues: w.queues,
          processed: Number(w.processed),
          failed: Number(w.failed),
          heartbeatAgeMs: Math.round(Number(w.heartbeat_age_ms)),
        })),
      },
      cache: cache.cacheStats(),
      storage,
      data: {
        telemetryRows:   Number(dbRow.telemetry_rows)   || 0,
        attachments:     Number(dbRow.attachments)      || 0,
        invoices:        Number(dbRow.invoices)         || 0,
        pendingSessions: Number(dbRow.pending_sessions) || 0,
      },
      host: {
        // Load average is meaningless on Windows (always 0), so we send CPU
        // count and free memory too and let the UI pick what to show.
        cpus: os.cpus().length,
        freeMemMb: Math.round(os.freemem() / 1024 / 1024),
        uptimeSec: Math.round(process.uptime()),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/ops/dead-letters
router.get("/dead-letters", async (_req, res, next) => {
  try {
    const rows = await deadLetters(25);
    res.json(
      rows.map((r) => ({
        id: r.id,
        queue: r.queue,
        attempts: Number(r.attempts),
        // Only the first line of the stack: enough to identify the failure in a
        // table cell without dumping a hundred frames into the browser.
        error: String(r.error ?? "").split("\n")[0].slice(0, 300),
        payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload),
        failedAt: r.failed_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/ops/redrive - push dead letters back onto their queue
//
// The manual half of a dead-letter queue: an operator looks at why the jobs
// failed, fixes the cause, then replays them. Having this button is the reason
// a DLQ beats "log the error and drop the message".
router.post("/redrive", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  try {
    const moved = await redriveDeadLetters(req.body?.queue ?? null);
    res.json({ redriven: moved });
  } catch (err) {
    next(err);
  }
});

// POST /api/ops/purge - clear finished jobs so the next demo run starts clean
router.post("/purge", allowRoles(ROLES.OPS_MANAGER), async (_req, res, next) => {
  try {
    const removed = await purgeCompleted();
    cache.resetStats();
    res.json({ purged: removed });
  } catch (err) {
    next(err);
  }
});

// GET /api/ops/architecture - the local-to-cloud mapping, served as data
//
// Kept server-side on purpose: the ops page renders it straight onto the
// screen, so the same table that is on slide 2 is also live in the running
// app. Milestone 2 edits this list as services are actually migrated.
router.get("/architecture", (_req, res) => {
  res.json([
    { layer: "Front end",        local: "React 18 + Vite + Tailwind",      cloud: "S3 static site + CloudFront",         dimension: "-" },
    { layer: "Application",      local: "Node.js + Express",               cloud: "ECS Fargate behind an ALB",           dimension: "-" },
    { layer: "Relational store", local: "MySQL 9 (local service)",         cloud: "Amazon RDS for MySQL + read replica", dimension: "Relational" },
    { layer: "Object storage",   local: "Local disk, S3-shaped adapter",   cloud: "Amazon S3",                           dimension: "Unstructured files" },
    { layer: "Message queue",    local: "MySQL job_queue (SKIP LOCKED)",   cloud: "Amazon SQS + dead-letter queue",      dimension: "Async / spikes" },
    { layer: "Workers",          local: "Forked Node processes",           cloud: "AWS Lambda or ECS service",           dimension: "Async / spikes" },
    { layer: "Autoscaling",      local: "supervisor.js backlog policy",    cloud: "CloudWatch alarm + scaling policy",   dimension: "Async / spikes" },
    { layer: "Cache",            local: "In-process TTL map",              cloud: "ElastiCache for Redis",               dimension: "Relational" },
    { layer: "Image analysis",   local: "JPEG header + EXIF parser",       cloud: "Amazon Rekognition",                  dimension: "Unstructured files" },
    { layer: "Text extraction",  local: "zlib PDF stream parser",          cloud: "Amazon Textract",                     dimension: "Unstructured files" },
    { layer: "Classification",   local: "Weighted keyword classifier",     cloud: "Amazon Comprehend / Bedrock",         dimension: "Unstructured files" },
    { layer: "Signed downloads", local: "HMAC-signed /api/files URL",      cloud: "S3 presigned URL",                    dimension: "Unstructured files" },
    { layer: "Authentication",   local: "Signed bearer token + RBAC",      cloud: "Amazon Cognito / OIDC",              dimension: "Security" },
  ]);
});

export default router;
