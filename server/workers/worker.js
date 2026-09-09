// server/workers/worker.js - one worker process
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A WORKER IS
// ─────────────────────────────────────────────────────────────────────────────
// A worker is a plain Node process with no HTTP server. It loops forever:
//
//     claim a batch of jobs  ->  run the handler  ->  acknowledge or fail
//
// That is the entire job. It shares the codebase and the database with the API
// server but runs as a SEPARATE process, and that separation is the point: the
// API can be busy while the workers are idle, or vice versa, and you scale
// whichever one is actually the bottleneck.
//
// Run several of these at once (server/workers/supervisor.js does exactly that)
// and they cooperate automatically, because the queue's SELECT ... FOR UPDATE
// SKIP LOCKED guarantees no two workers ever get the same job.
//
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL -> CLOUD
// ─────────────────────────────────────────────────────────────────────────────
// This file maps onto whichever compute service you pick in Milestone 2:
//   * AWS Lambda        - the poll loop disappears; SQS invokes handle() for you
//   * ECS/Fargate       - this file runs unchanged as the container entrypoint
//   * EC2 + systemd     - this file runs unchanged, supervised by systemd
// The handlers in ./handlers/ do not change in any of those cases.
//
// Usage:
//   node server/workers/worker.js                       # all queues
//   node server/workers/worker.js --queues billing       # just one
import "../env.js";
import os from "node:os";
import process from "node:process";

import { pool } from "../db.js";
import {
  QUEUES,
  NODE_ID,
  receiveMessages,
  deleteMessage,
  failMessage,
} from "../adapters/queue.js";
import { ensureBucket } from "../adapters/storage.js";

import { handleBilling } from "./handlers/billing.js";
import { handleFile } from "./handlers/fileProcess.js";
import { handleTelemetry } from "./handlers/telemetry.js";
import { handleSimulation } from "./handlers/simulation.js";


// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Which handler runs which queue. */
const HANDLERS = {
  [QUEUES.BILLING]:   handleBilling,
  [QUEUES.FILES]:     handleFile,
  [QUEUES.TELEMETRY]: handleTelemetry,
  [QUEUES.SIMULATION]: handleSimulation,
};

/**
 * How many jobs to claim per poll, per queue.
 *
 * Telemetry gets a big batch because its handler writes all of them in one
 * multi-row INSERT - claiming 50 and writing them together costs roughly the
 * same as claiming 1. Billing gets a small batch because each job does real
 * per-row work (money, PDF) and a long batch would hold the visibility lock
 * on jobs that could have gone to an idle worker instead.
 */
const BATCH_SIZE = {
  [QUEUES.BILLING]:   4,
  [QUEUES.FILES]:     2,
  [QUEUES.TELEMETRY]: 50,
  [QUEUES.SIMULATION]: 1,
};

const IDLE_MIN_MS = 200;    // fastest poll when there is work
const IDLE_MAX_MS = 2_000;  // slowest poll when everything is quiet
const HEARTBEAT_MS = 2_000;

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const queues = argValue("--queues", Object.values(QUEUES).join(",")).split(",").map((q) => q.trim());
const workerId = argValue("--id", NODE_ID);

// ─────────────────────────────────────────────────────────────────────────────
// Worker registry - lets the ops dashboard draw the live worker count
// ─────────────────────────────────────────────────────────────────────────────

let jobsProcessed = 0;
let jobsFailed = 0;
let running = true;

async function register() {
  await pool.query(
    `INSERT INTO worker_node (Worker_ID, Hostname, Pid, Queues, Started_At, Last_Heartbeat, Status)
     VALUES (?, ?, ?, ?, NOW(), NOW(3), 'running')
     ON DUPLICATE KEY UPDATE Last_Heartbeat = NOW(3), Status = 'running'`,
    [workerId, os.hostname(), process.pid, queues.join(",")]
  );
}

async function heartbeat() {
  await pool.query(
    `UPDATE worker_node
        SET Last_Heartbeat = NOW(3), Jobs_Processed = ?, Jobs_Failed = ?
      WHERE Worker_ID = ?`,
    [jobsProcessed, jobsFailed, workerId]
  );
}

async function deregister() {
  // Delete rather than mark stopped: the ops view counts rows, and a stale
  // "stopped" row would still need filtering out. A worker that is killed
  // without running this is reaped by the supervisor's stale-worker sweep.
  await pool.query(`DELETE FROM worker_node WHERE Worker_ID = ?`, [workerId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The poll loop
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One pass over every queue this worker serves.
 * @returns {Promise<number>} how many jobs were handled this pass
 */
async function pollOnce() {
  let handled = 0;

  for (const queue of queues) {
    const handler = HANDLERS[queue];
    if (!handler) continue;

    const messages = await receiveMessages(queue, BATCH_SIZE[queue] ?? 5, { owner: workerId });
    if (messages.length === 0) continue;

    // Telemetry's handler takes the whole batch at once so it can do a single
    // multi-row INSERT. The others are per-job.
    if (queue === QUEUES.TELEMETRY) {
      try {
        await handler(messages.map((m) => m.payload));
        await Promise.all(messages.map((m) => deleteMessage(m.jobId)));
        jobsProcessed += messages.length;
        handled += messages.length;
      } catch (err) {
        console.error(`[worker ${workerId}] batch ${queue} failed:`, err.message);
        await Promise.all(messages.map((m) => failMessage(m.jobId, err, m.receiveCount)));
        jobsFailed += messages.length;
      }
      continue;
    }

    for (const msg of messages) {
      try {
        await handler(msg.payload, msg);
        await deleteMessage(msg.jobId);
        jobsProcessed++;
        handled++;
      } catch (err) {
        // One poisoned job must never stop the worker. Report it, let the
        // queue decide retry-vs-dead-letter, and move on to the next job.
        const dead = msg.receiveCount >= 3;
        console.error(
          `[worker ${workerId}] job ${msg.jobId} (${queue}) attempt ${msg.receiveCount} failed` +
            `${dead ? " - DEAD LETTER" : " - will retry"}: ${err.message}`
        );
        await failMessage(msg.jobId, err, msg.receiveCount);
        jobsFailed++;
      }
    }
  }

  return handled;
}

async function main() {
  await ensureBucket();
  await register();

  console.log(
    `[worker ${workerId}] started (pid ${process.pid}) serving queues: ${queues.join(", ")}`
  );

  const hb = setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_MS);

  // Adaptive backoff: poll hard while there is work, ease off when idle.
  // Without this, an idle worker would hammer MySQL with a SELECT every few
  // milliseconds and the "idle" cost of scaling out would be real. This is the
  // local equivalent of SQS long polling.
  let idleDelay = IDLE_MIN_MS;

  while (running) {
    try {
      const handled = await pollOnce();
      idleDelay = handled > 0 ? IDLE_MIN_MS : Math.min(idleDelay * 2, IDLE_MAX_MS);
    } catch (err) {
      console.error(`[worker ${workerId}] poll error:`, err.message);
      idleDelay = IDLE_MAX_MS;
    }
    await sleep(idleDelay);
  }

  clearInterval(hb);
  await deregister();
  await pool.end();
  console.log(`[worker ${workerId}] stopped (processed ${jobsProcessed}, failed ${jobsFailed})`);
}

/**
 * Graceful shutdown. When the supervisor scales down it sends SIGTERM; we stop
 * taking new work, let the in-flight job finish, then deregister. A job that is
 * killed mid-flight is not lost either - its visibility timeout expires and
 * another worker picks it up.
 */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!running) process.exit(0); // second Ctrl-C: leave now
    console.log(`[worker ${workerId}] ${sig} received, finishing current batch...`);
    running = false;
  });
}

main().catch((err) => {
  console.error(`[worker ${workerId}] fatal:`, err);
  process.exit(1);
});
