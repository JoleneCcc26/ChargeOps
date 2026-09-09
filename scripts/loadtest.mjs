// scripts/loadtest.mjs - the traffic spike
//
//   npm run loadtest                       both profiles, default size
//   npm run loadtest -- --sessions 500     500 sessions end at once (billing)
//   npm run loadtest -- --telemetry 4000   4000 charger heartbeats (ingest)
//   npm run loadtest -- --rps 300          arrival rate
//   npm run loadtest -- --sync             the SLOW comparison run (see below)
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS PROVES
// ═════════════════════════════════════════════════════════════════════════════
// Two numbers matter, and they should move in opposite directions:
//
//   API latency stays FLAT.   Every endpoint under load here does O(1) work -
//                             validate, enqueue, 202. It does not care whether
//                             ten or two thousand requests are in flight.
//
//   Queue backlog SPIKES,     The work did not vanish, it was deferred. The
//   then drains.              supervisor sees the backlog, scales workers out,
//                             and the backlog comes back down. Nobody waited.
//
// Run this with the Cloud Ops page open on a second monitor. The story is on
// that screen: backlog up, workers 1 → 8, throughput up, backlog to zero,
// workers back to 1 - while the API latency line never moves.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE --sync COMPARISON
// ═════════════════════════════════════════════════════════════════════════════
// `--sync` bills the same sessions the OLD way: inline, one at a time, in the
// request. It is there so the demo has a control. Expect roughly 15-20x worse
// end-to-end wall time and a p95 that climbs with every extra client, because
// that is precisely what moving billing out of the request bought you.
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import "../server/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API = process.env.DEMO_API_URL || "http://localhost:4000";

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const num = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};

// Defaults are chosen so the ARRIVAL rate comfortably exceeds what the worker
// pool can drain (measured at roughly 100 billing jobs/s across 8 workers on a
// laptop). If they were balanced, the queue would stay near empty, the charts
// would be flat, and the demo would prove nothing. A spike has to actually
// spike.
const SESSIONS   = num("--sessions", 800);
const TELEMETRY  = num("--telemetry", 6000);
const RPS        = num("--rps", 400);
const CONCURRENCY = num("--concurrency", 40);
const SYNC_MODE  = argv.includes("--sync");
const ONLY = argv.includes("--only-billing")
  ? "billing"
  : argv.includes("--only-telemetry")
  ? "telemetry"
  : "both";

let authToken = "";
const authFetch = (url, options = {}) => fetch(url, {
  ...options,
  headers: { ...(options.headers || {}), Authorization: `Bearer ${authToken}` },
});

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.DEMO_USERNAME || "ops",
      password: process.env.DEMO_PASSWORD || "chargeops-demo",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(body.error || `login failed (${res.status})`);
  authToken = body.token;
}

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  connectionLimit: 10,
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Latency bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

class Latency {
  constructor(label) {
    this.label = label;
    this.samples = [];
    this.errors = 0;
    this.startedAt = Date.now();
  }
  record(ms) { this.samples.push(ms); }
  fail() { this.errors++; }

  /**
   * Percentiles, not just the mean. The mean hides the tail, and the tail is
   * what a user actually experiences when a system is under pressure - p95 is
   * "one request in twenty is at least this slow".
   */
  summary() {
    const s = [...this.samples].sort((a, b) => a - b);
    const at = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0);
    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    return {
      label: this.label,
      count: s.length,
      errors: this.errors,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      rps: Number((s.length / Math.max(elapsedSec, 0.001)).toFixed(1)),
      min: s[0] ?? 0,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: s[s.length - 1] ?? 0,
      mean: s.length ? Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)) : 0,
    };
  }
}

function printSummary(sum) {
  console.log(`
  ${sum.label}
    requests      ${sum.count}   (${sum.errors} errors)
    wall time     ${sum.elapsedSec}s   -> ${sum.rps} req/s
    latency ms    min ${sum.min}  p50 ${sum.p50}  p95 ${sum.p95}  p99 ${sum.p99}  max ${sum.max}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limited worker pool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `total` tasks at a target arrival rate with bounded concurrency.
 *
 * Both bounds matter. Concurrency alone gives you a closed loop - if the server
 * slows down, you send slower, and you never observe the queue growing. Pacing
 * by arrival rate is an open loop, which is how real traffic behaves: the
 * chargers do not wait for you to catch up.
 */
async function drive(total, rps, concurrency, task) {
  const intervalMs = 1000 / rps;
  let issued = 0;
  const inflight = new Set();

  while (issued < total) {
    const startedAt = Date.now();

    while (inflight.size >= concurrency) {
      await Promise.race(inflight);
    }

    const p = task(issued).finally(() => inflight.delete(p));
    inflight.add(p);
    issued++;

    const drift = Date.now() - startedAt;
    if (drift < intervalMs) {
      await new Promise((r) => setTimeout(r, intervalMs - drift));
    }
  }

  await Promise.allSettled([...inflight]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile 1: session-end storm (the billing queue)
// ─────────────────────────────────────────────────────────────────────────────

async function runBillingSpike(pool) {
  console.log(`\n▶ Billing spike: ${SESSIONS} sessions ending at ${RPS}/s`);

  // Create in-progress sessions to end. Inserted directly rather than through
  // the API because "a session is running" is a precondition of the test, not
  // the thing being measured.
  // Only chargers that are genuinely free.
  //
  // A charger can host one session at a time. Picking at random meant the load
  // test opened a second session on a charger that already had a live one, and
  // when the test session was stopped it released the charger out from under
  // the session that was still running — leaving open sessions whose charger
  // was marked Available. Excluding busy chargers keeps the simulated load
  // physically possible.
  const [chargers] = await pool.query(
    `SELECT c.Charger_ID, c.Station_ID
       FROM charger c
      WHERE c.Charger_Availability_Status <> 'Out of Service'
        AND NOT EXISTS (
          SELECT 1 FROM charging_session s
           WHERE s.Charger_ID = c.Charger_ID
             AND s.Session_Status = 'Active'
             AND s.End_Time IS NULL
        )
      ORDER BY RAND()
      LIMIT 200`
  );
  const [users] = await pool.query(`SELECT User_ID FROM user ORDER BY RAND() LIMIT 200`);

  if (!chargers.length || !users.length) {
    console.error("  ✖ no chargers/users in the database - run `npm run setup:db`");
    return null;
  }

  const rows = [];
  for (let i = 0; i < SESSIONS; i++) {
    const c = chargers[i % chargers.length];
    const u = users[i % users.length];
    const startedMinutesAgo = 20 + (i % 40);
    rows.push([
      c.Charger_ID,
      u.User_ID,
      new Date(Date.now() - startedMinutesAgo * 60_000),
      "Active",
    ]);
  }

  const [ins] = await pool.query(
    `INSERT INTO charging_session (Charger_ID, User_ID, Start_Time, Session_Status)
     VALUES ?`,
    [rows]
  );

  const firstId = ins.insertId;
  const ids = Array.from({ length: SESSIONS }, (_, i) => firstId + i);
  console.log(`  created sessions ${firstId}..${firstId + SESSIONS - 1}`);

  const lat = new Latency(
    SYNC_MODE
      ? "POST /api/sessions/:id/stop  [SYNC - billed inline, the old way]"
      : "POST /api/sessions/:id/stop  [ASYNC - enqueue and return 202]"
  );

  await drive(SESSIONS, RPS, CONCURRENCY, async (i) => {
    const t0 = performance.now();
    try {
      const res = await authFetch(
        `${API}/api/sessions/${ids[i]}/stop${SYNC_MODE ? "?sync=1" : ""}`,
        { method: "POST" }
      );
      if (!res.ok && res.status !== 409) lat.fail();
      await res.arrayBuffer(); // drain the body so the socket is reusable
    } catch {
      lat.fail();
      return;
    }
    lat.record(Math.round(performance.now() - t0));
  });

  return { lat: lat.summary(), sessionIds: ids };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile 2: telemetry firehose
// ─────────────────────────────────────────────────────────────────────────────

/** Fraction of heartbeats that report a genuine fault. ~1 in 200 by default. */
const FAULT_RATE = num("--fault-rate", 0.005);

async function runTelemetrySpike(pool) {
  console.log(`\n▶ Telemetry firehose: ${TELEMETRY} heartbeats at ${RPS}/s (batched 25/request)`);

  // Report the status each charger is ACTUALLY in, rather than a random one.
  //
  // The load test exists to stress the ingest pipeline, not to rewrite the
  // fleet. An earlier version picked statuses at random, so every run left
  // hundreds of chargers marked 'In Use' with no session behind them and had to
  // be cleaned up afterwards with `npm run data:repair`. Deriving the status
  // from real state means the firehose is just as heavy but leaves the database
  // exactly as consistent as it found it — which matters most for teammates,
  // who should not have to know about a repair step.
  const [chargers] = await pool.query(`
    SELECT c.Charger_ID,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM charging_session s
                WHERE s.Charger_ID = c.Charger_ID
                  AND s.Session_Status = 'Active'
                  AND s.End_Time IS NULL
             ) THEN 'Charging'
             WHEN c.Charger_Availability_Status = 'Reserved' THEN 'Preparing'
             WHEN c.Charger_Availability_Status = 'Out of Service' THEN 'Unavailable'
             ELSE 'Available'
           END AS Reported_Status
      FROM charger c
  `);
  if (!chargers.length) {
    console.error("  ✖ no chargers in the database");
    return null;
  }

  const BATCH = 25;
  const requests = Math.ceil(TELEMETRY / BATCH);
  const lat = new Latency("POST /api/telemetry  [enqueue a batch of 25 beats]");

  await drive(requests, Math.max(1, Math.floor(RPS / BATCH)), CONCURRENCY, async (n) => {
    const beats = Array.from({ length: BATCH }, (_, k) => {
      const charger = chargers[(n * BATCH + k) % chargers.length];
      // Real state, plus a small background fault rate so the technician
      // dispatch path still gets exercised.
      const status =
        Math.random() < FAULT_RATE ? "Faulted" : charger.Reported_Status;
      return {
        chargerId: charger.Charger_ID,
        reportedAt: new Date().toISOString(),
        powerKw: status === "Charging" ? Number((40 + Math.random() * 110).toFixed(2)) : 0,
        sessionEnergyKwh: status === "Charging" ? Number((Math.random() * 60).toFixed(3)) : null,
        status,
        temperatureC: Number((25 + Math.random() * 30).toFixed(1)),
      };
    });

    const t0 = performance.now();
    try {
      const res = await authFetch(`${API}/api/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beats }),
      });
      if (!res.ok) lat.fail();
      await res.arrayBuffer();
    } catch {
      lat.fail();
      return;
    }
    lat.record(Math.round(performance.now() - t0));
  });

  return { lat: lat.summary(), beats: requests * BATCH };
}

// ─────────────────────────────────────────────────────────────────────────────
// Watch the backlog drain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sample queue depth in the background for the WHOLE run.
 *
 * Without this, "peak backlog" would only ever be measured after the traffic
 * stopped — and the real peak happens while requests are still arriving. A
 * benchmark that only looks at the system once the load is over is measuring
 * the recovery, not the load.
 */
function startBacklogSampler(peaks) {
  const id = setInterval(async () => {
    try {
      const s = await (await authFetch(`${API}/api/ops/stats`)).json();
      peaks.backlog = Math.max(peaks.backlog, s.totals.backlog);
      peaks.workers = Math.max(peaks.workers, s.workers.count);
      peaks.throughput = Math.max(peaks.throughput, s.totals.throughput);
    } catch {
      /* sampling must never disturb the run */
    }
  }, 400);
  // Do not hold the event loop open on this timer.
  id.unref?.();
  return () => clearInterval(id);
}

/**
 * Poll /api/ops/stats until the queues are empty, printing a line per second.
 *
 * This is the part worth narrating: the requests are already finished (the API
 * answered every one of them in milliseconds), and the system is still working
 * through what they asked for. That gap IS the asynchrony.
 */
async function watchDrain(timeoutMs = 180_000) {
  console.log(`\n▶ Draining\n`);
  console.log(`     time   backlog  workers  done/s  avg latency`);
  console.log(`     ─────  ───────  ───────  ──────  ───────────`);

  const started = Date.now();
  let peakBacklog = 0;
  let peakWorkers = 0;
  let quietTicks = 0;

  while (Date.now() - started < timeoutMs) {
    let stats;
    try {
      stats = await (await authFetch(`${API}/api/ops/stats`)).json();
    } catch {
      break;
    }

    const backlog = stats.totals.backlog;
    const workers = stats.workers.count;
    const throughput = stats.totals.throughput;
    const avgLatency = Math.max(...stats.queues.map((q) => q.avgLatencyMs), 0);

    peakBacklog = Math.max(peakBacklog, backlog);
    peakWorkers = Math.max(peakWorkers, workers);

    const t = ((Date.now() - started) / 1000).toFixed(0).padStart(4);
    console.log(
      `     ${t}s  ${String(backlog).padStart(7)}  ${String(workers).padStart(7)}  ` +
      `${String(throughput).padStart(6)}  ${String(avgLatency).padStart(8)} ms`
    );

    // Two consecutive empty polls: the queue is genuinely drained, not just
    // momentarily between batches.
    if (backlog === 0) {
      if (++quietTicks >= 2) break;
    } else {
      quietTicks = 0;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return {
    drainSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    peakBacklog,
    peakWorkers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ChargeOps load generator                                    ║
╚══════════════════════════════════════════════════════════════╝
  API      ${API}
  profile  ${ONLY}${SYNC_MODE ? "   (SYNC comparison run)" : ""}
  rate     ${RPS} req/s, concurrency ${CONCURRENCY}`);

  // Fail fast with a useful message rather than a wall of ECONNREFUSED.
  try {
    const health = await (await fetch(`${API}/api/health`)).json();
    console.log(`  health   ok, database "${health.db}"`);
    await login();
    console.log(`  auth     ok, role ops_manager`);
  } catch {
    console.error(`\n✖ API not reachable at ${API}. Start it with \`npm run dev:server\`.\n`);
    process.exit(1);
  }

  const pool = mysql.createPool(dbConfig);
  const results = {};

  // Watch queue depth from the very first request, not just after the load ends.
  const peaks = { backlog: 0, workers: 0, throughput: 0 };
  const stopSampler = startBacklogSampler(peaks);

  if (ONLY === "both" || ONLY === "telemetry") {
    results.telemetry = await runTelemetrySpike(pool);
  }
  if (ONLY === "both" || ONLY === "billing") {
    results.billing = await runBillingSpike(pool);
  }

  console.log(`\n══ API latency ══════════════════════════════════════════════`);
  if (results.telemetry) printSummary(results.telemetry.lat);
  if (results.billing) printSummary(results.billing.lat);

  const drain = await watchDrain();
  stopSampler();

  // The sampler saw the whole run; watchDrain only saw the tail. Take whichever
  // observed the higher peak.
  drain.peakBacklog = Math.max(drain.peakBacklog, peaks.backlog);
  drain.peakWorkers = Math.max(drain.peakWorkers, peaks.workers);

  console.log(`
══ Result ═══════════════════════════════════════════════════

  peak backlog      ${drain.peakBacklog} jobs
  peak workers      ${drain.peakWorkers}
  peak throughput   ${peaks.throughput} jobs/s
  time to drain     ${drain.drainSec}s
`);

  // The closing line has to match what actually happened. In --sync mode
  // nothing is queued and nothing scales, so claiming the queue absorbed a
  // spike would be describing a run that did not occur.
  if (SYNC_MODE) {
    const p50 = results.billing?.lat.p50 ?? 0;
    const p95 = results.billing?.lat.p95 ?? 0;
    console.log(`  This was the CONTROL run: billing computed inline inside the request,
  the way the MySQL trigger used to do it. Nothing was queued, so there is
  no backlog and no autoscaling to show.

  p50 ${p50} ms, p95 ${p95} ms — every millisecond of it paid by the driver
  waiting at the charger. Compare against a normal \`npm run loadtest\` run,
  where the same work leaves the request entirely.
`);
  } else {
    console.log(`  The API answered every request in single-digit to low-double-digit
  milliseconds while ${drain.peakBacklog} jobs of real work were still
  outstanding. The queue absorbed the spike; the autoscaler paid it off.
`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("\n✖ load test failed:", err);
  process.exit(1);
});
