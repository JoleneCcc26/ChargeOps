// server/workers/supervisor.js - autoscaling worker pool
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE IS THE AUTOSCALER
// ═════════════════════════════════════════════════════════════════════════════
// It runs the loop every cloud autoscaler runs:
//
//     read a metric  ->  compare to a target  ->  add or remove capacity
//                     ->  wait out a cooldown  ->  repeat
//
// Our metric is queue backlog (ready + inflight jobs). Our capacity unit is a
// `worker.js` child process. Swap those two nouns and you have described:
//
//   * ECS service autoscaling on an SQS `ApproximateNumberOfMessagesVisible`
//     CloudWatch alarm - literally this algorithm, with tasks instead of
//     child processes
//   * Lambda's built-in scaling on SQS - same signal, AWS runs the loop for you
//   * Kubernetes HPA with a custom/external metric - same loop, different words
//
// Backlog-per-worker is the right signal, and it is worth being able to say why:
// CPU is a lagging, indirect proxy (a worker blocked on a database write is
// idle but the queue is still growing), while backlog is the actual thing the
// operations manager cares about - "how far behind are we?". Scaling on the
// work you have not done yet beats scaling on how warm the machine feels.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT TO SAY WHILE THIS RUNS IN THE DEMO
// ═════════════════════════════════════════════════════════════════════════════
//   1. Steady state: 1 worker, backlog 0.
//   2. Fire the load generator: backlog jumps to ~2000, latency climbs.
//   3. Scale-up fires within ~2 s - watch the worker count climb 1 -> 8 and the
//      throughput line follow it.
//   4. Backlog drains; after the cooldown, workers scale back to 1.
//   5. Point out that the API never got slower: it was returning 202 the whole
//      time, because it does no work itself.
//
// Usage:
//   node server/workers/supervisor.js                    # autoscale 1..8
//   node server/workers/supervisor.js --min 2 --max 12
//   node server/workers/supervisor.js --fixed 1          # no autoscaling
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../env.js";

import { pool } from "../db.js";
import { totalBacklog, reclaimExpired, queueStats, sendMessageTx, QUEUES } from "../adapters/queue.js";
import { ensureBucket } from "../adapters/storage.js";
import {
  typicalSessionMinutes,
  maxPlausibleSessionMinutes,
} from "../lib/charging.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.js");

// ─────────────────────────────────────────────────────────────────────────────
// Scaling policy
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argNum = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const FIXED = args.includes("--fixed") ? argNum("--fixed", 1) : null;
const MIN_WORKERS = FIXED ?? argNum("--min", 1);
const MAX_WORKERS = FIXED ?? argNum("--max", 8);

/**
 * Target backlog per worker. Above this we are behind and add capacity.
 *
 * Tuning it is the same trade-off as any autoscaler: too low and you thrash
 * (spawning processes for a backlog of three), too high and the queue drains
 * slowly because you waited too long to react.
 */
const TARGET_BACKLOG_PER_WORKER = argNum("--target", 25);

const EVAL_INTERVAL_MS = 2_000;

/**
 * Scale-down cooldown. Scaling UP should be fast (you are already behind);
 * scaling DOWN should be slow, because killing a worker the instant the queue
 * empties means you pay the startup cost again on the next burst. Real
 * autoscalers are asymmetric for exactly this reason.
 */
const SCALE_DOWN_COOLDOWN_MS = 15_000;

const RECLAIM_INTERVAL_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Pool management
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<number, {child: import("node:child_process").ChildProcess, id: string}>} */
const workers = new Map();
let nextWorkerNumber = 1;
let lastScaleDownAt = 0;
let shuttingDown = false;

function spawnWorker() {
  const id = `w${nextWorkerNumber++}`;
  const child = fork(WORKER_PATH, ["--id", id], { stdio: "inherit" });

  workers.set(child.pid, { child, id });

  child.on("exit", (code, signal) => {
    workers.delete(child.pid);
    // An unexpected exit while we still want capacity means the process
    // crashed. Replace it - this is what makes the pool self-healing, and it is
    // the same behaviour an ECS service or a Kubernetes Deployment gives you.
    if (!shuttingDown && code !== 0 && signal !== "SIGTERM") {
      console.warn(`[supervisor] worker ${id} died (code ${code}); replacing`);
      setTimeout(() => {
        if (!shuttingDown && workers.size < MIN_WORKERS) spawnWorker();
      }, 500);
    }
  });

  return id;
}

function killOneWorker() {
  const entry = workers.values().next().value;
  if (!entry) return null;
  // SIGTERM, not SIGKILL: worker.js catches it, finishes the job it is holding,
  // deregisters, and exits cleanly. Any job still in flight would be redelivered
  // after its visibility timeout anyway, but draining is tidier and means no
  // job is processed twice just because we scaled in.
  entry.child.kill("SIGTERM");
  return entry.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// The control loop
// ─────────────────────────────────────────────────────────────────────────────

async function evaluate() {
  if (shuttingDown) return;

  const backlog = await totalBacklog();
  const current = workers.size;
  const desired = Math.min(
    MAX_WORKERS,
    Math.max(MIN_WORKERS, Math.ceil(backlog / TARGET_BACKLOG_PER_WORKER) || MIN_WORKERS)
  );

  if (desired > current) {
    // Scale out immediately, but at most a few at a time so a single huge
    // burst does not fork eight processes in one tick and stall the machine.
    const add = Math.min(desired - current, 3);
    for (let i = 0; i < add; i++) spawnWorker();
    console.log(
      `[supervisor] SCALE UP   ${current} -> ${workers.size}  (backlog ${backlog})`
    );
    return;
  }

  if (desired < current && Date.now() - lastScaleDownAt > SCALE_DOWN_COOLDOWN_MS) {
    const id = killOneWorker(); // one at a time - gentle scale-in
    lastScaleDownAt = Date.now();
    console.log(
      `[supervisor] SCALE DOWN ${current} -> ${current - 1}  (backlog ${backlog}, drained ${id})`
    );
  }
}

/**
 * Housekeeping the cloud would do for us:
 *   - return jobs whose visibility timeout expired (SQS does this server-side)
 *   - delete registry rows for workers that died without deregistering
 */
async function housekeeping() {
  if (shuttingDown) return;
  try {
    const reclaimed = await reclaimExpired();
    if (reclaimed > 0) {
      console.log(`[supervisor] reclaimed ${reclaimed} job(s) from dead workers`);
    }
    await pool.query(
      `DELETE FROM worker_node WHERE Last_Heartbeat < NOW(3) - INTERVAL 15 SECOND`
    );
    await reapStaleSessions();
    await rollSubscriptionStatus();
    await enforceRetention();
  } catch (err) {
    console.error("[supervisor] housekeeping error:", err.message);
  }
}

/**
 * Move subscriptions into the state their dates say they are in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A ONE-OFF FIX
 * ─────────────────────────────────────────────────────────────────────────────
 * A subscription's status is a claim about today, and nothing in this system
 * was making that claim true after the day it was written. Setup stamped every
 * row correctly and then the calendar moved on: two days later, 22 rows still
 * said Active with an end date in the past.
 *
 * Repairing them by hand would have made the checker green and left the cause
 * in place, so the same 22 would come back every couple of days. A membership
 * expires because time passes, and something has to notice — in production that
 * is a scheduled job, and here it is the loop that already notices the other
 * things time does to this database: sessions that outran any plausible charge,
 * telemetry old enough to age out.
 *
 * Cancelled is left alone. That is a decision somebody made, not a fact about
 * the date, and no clock should overturn it.
 */
async function rollSubscriptionStatus() {
  const [res] = await pool.query(
    `UPDATE subscription
        SET Status = CASE
              WHEN Start_Date > CURDATE() THEN 'Pending'
              WHEN End_Date   < CURDATE() THEN 'Expired'
              ELSE 'Active'
            END
      WHERE Status <> 'Cancelled'
        AND Status <> CASE
              WHEN Start_Date > CURDATE() THEN 'Pending'
              WHEN End_Date   < CURDATE() THEN 'Expired'
              ELSE 'Active'
            END`
  );
  if (res.affectedRows > 0) {
    console.log(
      `[supervisor] rolled ${res.affectedRows} subscription(s) into the state their dates imply`
    );
  }
}

/**
 * Age out data nobody will read again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A DEPLOYMENT NEEDS THIS
 * ─────────────────────────────────────────────────────────────────────────────
 * Two tables grow forever if left alone, and both grow fastest exactly when the
 * platform is working properly:
 *
 *   job_queue          every completed job stays as a 'done' row. At demo
 *                      traffic that is ~16k rows a day, and it was already the
 *                      largest table in the database — entirely history of work
 *                      that finished successfully.
 *
 *   charger_telemetry  a heartbeat per charger per interval, ~170k rows a day.
 *                      Useful for "what is the fleet doing now" and for a few
 *                      days of trend; nobody queries an individual heartbeat
 *                      from six weeks ago.
 *
 * Unbounded growth is not a disk-space problem first, it is a performance
 * problem: every index gets deeper, the buffer pool fills with rows no query
 * wants, and the queries that matter get slower. Retention is what keeps a
 * long-running deployment fast.
 *
 * Deliberately NOT pruned:
 *   - 'dead' jobs. They failed every retry and a human still needs to look.
 *   - anything financial. Sessions, payments and invoices are business records;
 *     they get archived in a real system, never silently deleted.
 */
const JOB_RETENTION_HOURS = Number(process.env.JOB_RETENTION_HOURS) || 24;
const TELEMETRY_RETENTION_DAYS = Number(process.env.TELEMETRY_RETENTION_DAYS) || 14;

let lastRetentionAt = 0;

async function enforceRetention() {
  // Hourly is plenty; running it every housekeeping tick would be a large
  // DELETE scan every ten seconds for no benefit.
  if (Date.now() - lastRetentionAt < 60 * 60 * 1000) return;
  lastRetentionAt = Date.now();

  // Delete in bounded batches. One unbounded DELETE across hundreds of
  // thousands of rows holds locks long enough to stall the writes this is
  // meant to protect.
  const [jobs] = await pool.query(
    `DELETE FROM job_queue
      WHERE Status = 'done'
        AND Finished_At < NOW() - INTERVAL ? HOUR
      LIMIT 20000`,
    [JOB_RETENTION_HOURS]
  );

  const [beats] = await pool.query(
    `DELETE FROM charger_telemetry
      WHERE Reported_At < NOW() - INTERVAL ? DAY
      LIMIT 50000`,
    [TELEMETRY_RETENTION_DAYS]
  );

  if (jobs.affectedRows || beats.affectedRows) {
    console.log(
      `[supervisor] retention: pruned ${jobs.affectedRows} finished job(s) ` +
        `and ${beats.affectedRows} telemetry row(s)`
    );
  }
}

/**
 * Close charging sessions that have outrun any plausible charge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REAL PLATFORM NEEDS THIS
 * ─────────────────────────────────────────────────────────────────────────────
 * A session ends when the charger reports that the driver unplugged. Sometimes
 * that report never arrives: the charger loses connectivity mid-session, is
 * power-cycled by site staff, or crashes. The session row then stays open
 * forever — the stall shows as occupied so no other driver is sent to it, and
 * the customer is never billed for the energy they took.
 *
 * Locally the same thing happens for a duller reason: the machine gets switched
 * off. Nothing accrues while it is off — a session is two timestamps, not a
 * running meter — but the open rows keep their original start time. Come back
 * after a weekend and the interface reports cars that have been fast-charging
 * for sixty hours.
 *
 * So the platform closes them itself, on a timeout derived from what a session
 * on that particular charger could physically take. They go through the
 * ORDINARY billing path — set End_Time, queue a billing job — so energy is
 * computed, money is taken and an invoice is produced exactly as for a driver
 * who unplugged normally. A recovered session is a billed session, not a
 * discarded one.
 *
 * The end time is recorded as a plausible session length rather than "now",
 * because the alternative is billing somebody for the sixty hours their charger
 * spent offline.
 */
async function reapStaleSessions() {
  const [candidates] = await pool.query(
    `SELECT cs.Session_ID, cs.Charger_ID,
            c.Charger_Power_Capacity AS kw,
            TIMESTAMPDIFF(MINUTE, cs.Start_Time, NOW()) AS elapsed_minutes
       FROM charging_session cs
       JOIN charger c ON c.Charger_ID = cs.Charger_ID
      WHERE cs.Session_Status = 'Active' AND cs.End_Time IS NULL`
  );

  const stale = candidates.filter(
    (r) => Number(r.elapsed_minutes) > maxPlausibleSessionMinutes(r.kw)
  );
  if (stale.length === 0) return;

  // ── One transaction per session, and all three writes inside it ──────────
  //
  // This used to end every session, then enqueue every billing job, then
  // release the chargers in one batch at the end. Three separate writes with
  // no transaction around them, which is the same shape as the bug the
  // transactional outbox exists to prevent — and the reason the ordinary stop
  // endpoint does exactly this and this code did not.
  //
  // Two things went wrong there. A failure between the UPDATE and the enqueue
  // left a session that had ended and would never be billed: energy delivered,
  // nobody charged, and nothing anywhere recording that it happened. And the
  // batch release at the end used a charger list captured before any of the
  // writes, so a charger that a real driver had plugged into in the meantime
  // was marked Available while a session was running on it.
  //
  // Doing one session at a time is slower and correct. This runs on a timer
  // against a handful of rows; there is nothing here worth trading correctness
  // for.
  let reaped = 0;
  for (const row of stale) {
    const minutes = typicalSessionMinutes(row.kw, 0.5);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // The WHERE clause is the guard: whichever gets there first wins, so a
      // driver stopping this session through the API at the same moment leaves
      // this UPDATE affecting no rows, and the whole transaction becomes a
      // no-op rather than a double billing.
      const [res] = await conn.query(
        `UPDATE charging_session
            SET End_Time = DATE_ADD(Start_Time, INTERVAL ? MINUTE)
          WHERE Session_ID = ? AND Session_Status = 'Active' AND End_Time IS NULL`,
        [minutes, row.Session_ID]
      );
      if (res.affectedRows !== 1) {
        await conn.rollback();
        continue;
      }

      // Enqueued in the SAME transaction as the state change. Either the
      // session ended and the bill is queued, or neither happened.
      await sendMessageTx(conn, QUEUES.BILLING, { sessionId: row.Session_ID });

      // Release the stall only if THIS session is the one occupying it.
      await conn.query(
        `UPDATE charger c
            SET c.Charger_Availability_Status = 'Available'
          WHERE c.Charger_ID = ?
            AND c.Charger_Availability_Status = 'In Use'
            AND NOT EXISTS (
              SELECT 1 FROM charging_session s
               WHERE s.Charger_ID = c.Charger_ID
                 AND s.Session_Status = 'Active' AND s.End_Time IS NULL
            )`,
        [row.Charger_ID]
      );

      await conn.commit();
      reaped += 1;
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error(`[supervisor] could not reap session ${row.Session_ID}:`, err.message);
    } finally {
      conn.release();
    }
  }

  if (reaped > 0) {
    console.log(
      `[supervisor] reaped ${reaped} stale session(s) — ended and queued for billing`
    );
  }
}

async function logStatus() {
  if (shuttingDown) return;
  try {
    const stats = await queueStats();
    const busy = stats.filter((s) => s.backlog > 0 || s.throughputPerSec > 0);
    if (busy.length === 0) return;
    const line = busy
      .map((s) => `${s.queue}: backlog=${s.backlog} ${s.throughputPerSec}/s p_avg=${s.avgLatencyMs}ms`)
      .join("  |  ");
    console.log(`[supervisor] workers=${workers.size}  ${line}`);
  } catch {
    /* status logging must never take the supervisor down */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await ensureBucket();

  // Start clean: rows from a previous run that was killed with Ctrl-C would
  // otherwise inflate the worker count on the dashboard.
  await pool.query(`DELETE FROM worker_node`);

  console.log(
    FIXED
      ? `[supervisor] fixed pool of ${FIXED} worker(s) - autoscaling disabled`
      : `[supervisor] autoscaling ${MIN_WORKERS}..${MAX_WORKERS} workers ` +
        `(target ${TARGET_BACKLOG_PER_WORKER} backlog/worker)`
  );

  for (let i = 0; i < MIN_WORKERS; i++) spawnWorker();

  if (!FIXED) setInterval(() => evaluate().catch(console.error), EVAL_INTERVAL_MS);
  setInterval(() => housekeeping().catch(console.error), RECLAIM_INTERVAL_MS);
  setInterval(() => logStatus().catch(() => {}), 3_000);
}

async function shutdown(signal) {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log(`\n[supervisor] ${signal} - draining ${workers.size} worker(s)...`);

  for (const { child } of workers.values()) child.kill("SIGTERM");

  // Give workers a moment to finish and deregister, then leave regardless.
  const deadline = Date.now() + 8_000;
  while (workers.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const { child } of workers.values()) child.kill("SIGKILL");

  await pool.query(`DELETE FROM worker_node`).catch(() => {});
  await pool.end().catch(() => {});
  console.log("[supervisor] stopped");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[supervisor] fatal:", err);
  process.exit(1);
});
