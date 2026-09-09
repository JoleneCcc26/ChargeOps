// scripts/live-traffic.mjs — keep the platform alive the way real drivers would
//
//   npm run traffic                      run until stopped
//   npm run traffic -- --scale 0.5       half the demand
//   npm run traffic -- --tick 30         act every 30 seconds
//   npm run traffic -- --once            do one tick and exit (for cron)
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═════════════════════════════════════════════════════════════════════════════
// Deploying the application to a server that runs continuously does not, on its
// own, give you a platform that looks alive. Everything the system does is a
// REACTION to something a driver or a charger did, and in a demo deployment
// there are neither. Left running:
//
//   * the stale-session reaper closes the seeded live sessions within hours and
//     nothing opens new ones, so the fleet settles at zero chargers in use;
//   * the daily simulator writes sessions that already have an end time, so it
//     produces history, never anything in progress;
//   * no charger sends heartbeats, so telemetry ages and the ingest lag on the
//     operations page climbs forever.
//
// The system is behaving correctly in all three cases. It simply has nothing to
// respond to. This process supplies the demand: it starts sessions, lets them
// run their natural length, stops them, and heartbeats the fleet — through the
// ordinary HTTP API, exactly as a real charger would.
//
// That last point is what makes it worth running rather than writing rows
// directly: every session it creates goes through authentication, the same
// validation, the same queue and the same billing worker as a real one. Nothing
// here is a special case, so nothing here can hide a bug in the real path.
//
// ═════════════════════════════════════════════════════════════════════════════
// LOAD TEST vs TRAFFIC SIMULATOR
// ═════════════════════════════════════════════════════════════════════════════
// They look similar and answer opposite questions.
//
//   npm run loadtest   a burst, as hard as possible, to see where it bends.
//                      Runs for a minute. Deliberately unrealistic.
//
//   npm run traffic    an ordinary day, forever, at human pace. Roughly one
//                      action every few seconds. Deliberately boring.
//
// Use the load test to prove the architecture scales; run this one so there is
// something to look at when nobody is testing.
import mysql from "mysql2/promise";
import "../server/env.js";
import { typicalSessionMinutes } from "../server/lib/charging.js";

const API = process.env.DEMO_API_URL || "http://localhost:4000";

const argv = process.argv.slice(2);
const num = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const ONCE = argv.includes("--once");

/** Seconds between ticks. */
const TICK_SECONDS = num("--tick", 20);

/**
 * Peak share of the fleet charging simultaneously, at the busiest hour.
 *
 * A real urban network peaks somewhere around a quarter of its stalls occupied;
 * much higher and drivers start queueing, much lower and the operator is losing
 * money on idle hardware.
 */
const PEAK_UTILISATION = num("--scale", 0.25);

/**
 * Demand by hour of day — the same curve the history uses, so a chart of the
 * last three weeks and a chart of today have the same shape.
 */
const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, // 00-05
  4, 7, 9, 8, 6, 5, // 06-11
  6, 5, 5, 6, 8, 10, // 12-17
  10, 9, 7, 5, 4, 3, // 18-23
];
const PEAK_WEIGHT = Math.max(...HOUR_WEIGHTS);

/** How many chargers report in each tick. */
const HEARTBEAT_BATCH = num("--heartbeats", 40);

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  connectionLimit: 5,
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

let token = "";
const api = (path, options = {}) =>
  fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
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
  token = body.token;
}

const ts = () => new Date().toTimeString().slice(0, 8);

// ─────────────────────────────────────────────────────────────────────────────

/** How many sessions should be running right now, given the time of day. */
function targetConcurrent(usableChargers) {
  const weight = HOUR_WEIGHTS[new Date().getHours()];
  return Math.max(1, Math.round(usableChargers * PEAK_UTILISATION * (weight / PEAK_WEIGHT)));
}

/**
 * Stop sessions that have run their natural length.
 *
 * This is the normal way a session ends — the driver unplugs — as opposed to
 * the supervisor's reaper, which is the safety net for sessions that were never
 * closed at all. If this process is doing its job the reaper should have
 * nothing to do.
 */
async function stopFinishedSessions(pool) {
  const [running] = await pool.query(
    `SELECT cs.Session_ID, cs.Charger_ID,
            c.Charger_Power_Capacity AS kw,
            TIMESTAMPDIFF(MINUTE, cs.Start_Time, NOW()) AS elapsed_minutes
       FROM charging_session cs
       JOIN charger c ON c.Charger_ID = cs.Charger_ID
      WHERE cs.Session_Status = 'Active' AND cs.End_Time IS NULL`
  );

  let stopped = 0;
  for (const row of running) {
    // Each session gets its own target length, derived from the charger and
    // varied by session id, so they do not all finish on the same tick.
    const planned = typicalSessionMinutes(row.kw, ((row.Session_ID * 37) % 100) / 100);
    if (Number(row.elapsed_minutes) < planned) continue;

    const res = await api(`/api/sessions/${row.Session_ID}/stop`, { method: "POST" });
    if (res.ok) stopped++;
  }
  return { running: running.length, stopped };
}

/** Start enough new sessions to meet demand for this hour. */
async function startNewSessions(pool, deficit) {
  if (deficit <= 0) return 0;

  // Ramp toward the target instead of jumping to it.
  //
  // A quarter of the deficit per tick sounds gentle until the deficit is large:
  // starting from an empty fleet it opened thirty-three sessions inside one
  // minute, three of them stamped with the same second. Real arrivals do not
  // work that way, and a reviewer notices immediately — the sessions list shows
  // a wall of identical timestamps.
  //
  // Both bounds matter. The fraction keeps the approach smooth; the hard cap
  // keeps any single tick to a believable number of cars pulling in at once.
  const MAX_ARRIVALS_PER_TICK = num("--max-arrivals", 6);
  const toStart = Math.max(1, Math.min(Math.ceil(deficit / 8), MAX_ARRIVALS_PER_TICK));

  const [chargers] = await pool.query(
    `SELECT c.Charger_ID
       FROM charger c
      WHERE c.Charger_Availability_Status = 'Available'
        AND NOT EXISTS (
          SELECT 1 FROM charging_session s
           WHERE s.Charger_ID = c.Charger_ID
             AND s.Session_Status = 'Active' AND s.End_Time IS NULL
        )
      ORDER BY RAND()
      LIMIT ?`,
    [toStart]
  );
  if (chargers.length === 0) return 0;

  const [drivers] = await pool.query(`SELECT User_ID FROM user ORDER BY RAND() LIMIT ?`, [
    chargers.length,
  ]);

  let started = 0;
  for (let i = 0; i < chargers.length && i < drivers.length; i++) {
    const res = await api("/api/sessions/start", {
      method: "POST",
      body: JSON.stringify({
        chargerId: chargers[i].Charger_ID,
        userId: drivers[i].User_ID,
      }),
    });
    // Space arrivals out inside the tick. Without this every session opened on
    // the same pass shares one timestamp, which reads as a batch import rather
    // than as cars arriving.
    if (i < chargers.length - 1) {
      await new Promise((r) => setTimeout(r, 700 + Math.random() * 1800));
    }
    // A 409 means somebody claimed the stall first. That is the endpoint's
    // concurrency guard working, not an error worth reporting.
    if (res.ok) started++;
  }
  return started;
}

/**
 * Heartbeat a slice of the fleet.
 *
 * Chargers report continuously in reality, which is what keeps the ingest
 * pipeline — and the lag figure on the operations page — meaningful. Each beat
 * reports the charger's actual state so telemetry stays consistent with the
 * session data rather than fighting it.
 */
async function sendHeartbeats(pool) {
  const [chargers] = await pool.query(
    `SELECT c.Charger_ID, c.Charger_Power_Capacity AS kw,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM charging_session s
                 WHERE s.Charger_ID = c.Charger_ID
                   AND s.Session_Status = 'Active' AND s.End_Time IS NULL
              ) THEN 'Charging'
              WHEN c.Charger_Availability_Status = 'Out of Service' THEN 'Unavailable'
              WHEN c.Charger_Availability_Status = 'Reserved' THEN 'Preparing'
              ELSE 'Available'
            END AS status
       FROM charger c
      ORDER BY RAND()
      LIMIT ?`,
    [HEARTBEAT_BATCH]
  );
  if (chargers.length === 0) return 0;

  const beats = chargers.map((c) => ({
    chargerId: c.Charger_ID,
    reportedAt: new Date().toISOString(),
    powerKw: c.status === "Charging" ? Number((Number(c.kw) * 0.45).toFixed(2)) : 0,
    status: c.status,
    temperatureC: Number((22 + Math.random() * 18).toFixed(1)),
  }));

  const res = await api("/api/telemetry", {
    method: "POST",
    body: JSON.stringify({ beats }),
  });
  return res.ok ? beats.length : 0;
}

// ─────────────────────────────────────────────────────────────────────────────

async function tick(pool) {
  const [[fleet]] = await pool.query(
    `SELECT COUNT(*) AS usable FROM charger
      WHERE Charger_Availability_Status <> 'Out of Service'`
  );

  const { running, stopped } = await stopFinishedSessions(pool);
  const target = targetConcurrent(Number(fleet.usable));
  const started = await startNewSessions(pool, target - (running - stopped));
  const beats = await sendHeartbeats(pool);

  const now = running - stopped + started;
  console.log(
    `[${ts()}] target ${String(target).padStart(3)} · running ${String(now).padStart(3)} · ` +
      `+${started} started · -${stopped} finished · ${beats} heartbeats`
  );
}

async function main() {
  console.log(`\nChargeOps live traffic → ${API}`);
  console.log(
    `  peak utilisation ${(PEAK_UTILISATION * 100).toFixed(0)}% · tick ${TICK_SECONDS}s` +
      `${ONCE ? " · single tick" : ""}\n`
  );

  // Wait for the API rather than dying on it.
  //
  // This process is started at the same instant as the server it talks to, so
  // the first login almost always loses that race. Exiting there would leave a
  // demo that looks alive only when the three processes happen to start in the
  // right order, which is the kind of flakiness that gets blamed on the
  // machine rather than on the code.
  for (let attempt = 1; ; attempt++) {
    try {
      await login();
      break;
    } catch (err) {
      if (attempt >= 30) {
        console.error(`  giving up waiting for ${API}: ${err.message}`);
        process.exit(1);
      }
      if (attempt === 1) console.log(`  waiting for the API at ${API}…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const pool = mysql.createPool(dbConfig);

  // Re-authenticate periodically: tokens expire, and a process meant to run for
  // weeks cannot depend on the one it got at startup.
  const relogin = setInterval(() => login().catch(() => {}), 60 * 60 * 1000);
  relogin.unref?.();

  let stopping = false;
  const shutdown = () => {
    stopping = true;
    console.log("\n  stopping — sessions already running are left open for the reaper\n");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  do {
    try {
      await tick(pool);
    } catch (err) {
      // A traffic generator must never exit because the API blinked. Report and
      // keep going; the next tick will catch up.
      console.error(`[${ts()}] tick failed: ${err.message}`);
      await login().catch(() => {});
    }
    if (ONCE || stopping) break;
    await new Promise((r) => setTimeout(r, TICK_SECONDS * 1000));
  } while (!stopping);

  await pool.end();
}

main().catch((err) => {
  console.error("\n✖ live traffic failed:", err.message);
  process.exit(1);
});
