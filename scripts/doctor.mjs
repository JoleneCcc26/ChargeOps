// scripts/doctor.mjs — one command that checks everything
//
//   npm run doctor              full check against the running app
//   npm run doctor -- --db-only skip the HTTP checks (no server needed)
//   npm run doctor -- --quiet   only print failures
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═════════════════════════════════════════════════════════════════════════════
// Problems in this project were being found one at a time, by eye, on whichever
// screen somebody happened to open: a tile counting a page instead of a filter,
// a session that had been charging for five hours, a completed session dated in
// the future. Each was easy to fix and impossible to find reliably, because
// nothing stated what "correct" meant.
//
// This file states it. Every rule below is an INVARIANT — something that must be
// true of the system no matter what has been run against it. Together they are
// the definition of a healthy deployment, and they run in about two seconds.
//
// Run it before packaging the project for anyone else. If it passes on your
// machine and on theirs, the two installations agree.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT DOES NOT DO
// ═════════════════════════════════════════════════════════════════════════════
// It does not repair anything. A checker that quietly fixes what it finds hides
// the fact that something produced the problem in the first place. Failures name
// the rule and the count; `npm run data:repair` is the separate, deliberate,
// snapshot-taking tool for correcting them.
import mysql from "mysql2/promise";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "../server/env.js";
import { MAX_SESSION_KWH } from "../server/lib/charging.js";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "server");

const argv = process.argv.slice(2);
const DB_ONLY = argv.includes("--db-only");
const QUIET = argv.includes("--quiet");

const API = process.env.DEMO_API_URL || "http://localhost:4000";

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

let passed = 0;
const failures = [];
const warnings = [];

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

function section(name) {
  if (!QUIET) console.log(`\n${DIM}── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}${OFF}`);
}

/** Assert an invariant. `detail` explains what a failure means, for whoever reads it. */
function check(ok, label, detail = "") {
  if (ok) {
    passed++;
    if (!QUIET) console.log(`  ${GREEN}✓${OFF} ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  ${RED}✗${OFF} ${label}${detail ? `\n      ${DIM}${detail}${OFF}` : ""}`);
  }
}

/** Something suspicious but not necessarily wrong. Does not fail the run. */
function warn(condition, label, detail = "") {
  if (!condition) return;
  warnings.push({ label, detail });
  console.log(`  ${YELLOW}!${OFF} ${label}${detail ? `\n      ${DIM}${detail}${OFF}` : ""}`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nChargeOps doctor  ${DIM}${dbConfig.user}@${dbConfig.host}/${dbConfig.database}${OFF}`);

  const conn = await mysql.createConnection(dbConfig);
  const n = async (sql, params = []) =>
    Number(Object.values((await conn.query(sql, params))[0][0] ?? { v: 0 })[0]);

  try {
    await schemaChecks(conn, n);
    await referentialChecks(n);
    await stateMachineChecks(n);
    await assignmentChecks(n);
    await physicalChecks(n);
    await financialChecks(n);
    await temporalChecks(n);
    await livenessChecks(n);
    await roleReadinessChecks(n);
    await accessControlChecks();
    if (!DB_ONLY) await apiChecks(conn);
  } finally {
    await conn.end();
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(62)}`);
  if (failures.length === 0) {
    console.log(`${GREEN}✔ ${passed} checks passed${OFF}${warnings.length ? `, ${YELLOW}${warnings.length} warning(s)${OFF}` : ""}\n`);
  } else {
    console.log(`${RED}✖ ${failures.length} of ${passed + failures.length} checks failed${OFF}\n`);
    for (const f of failures) console.log(`  ${RED}•${OFF} ${f.label}`);
    console.log(`\n  Most of these are repairable: ${DIM}npm run data:audit${OFF} then ${DIM}npm run data:repair${OFF}\n`);
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Schema — is the database the shape the code expects?
// ─────────────────────────────────────────────────────────────────────────────

async function schemaChecks(conn, n) {
  section("Schema");

  const required = [
    "company", "user", "membership", "technician", "station", "wallet",
    "subscription", "charger", "charging_session", "payment", "maintenance_log",
    "job_queue", "attachment", "invoice", "charger_telemetry", "worker_node",
    "audit_log", "simulation_run", "billing_request", "app_meta",
  ];
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  );
  const present = new Set(tables.map((r) => r.t.toLowerCase()));
  const missing = required.filter((t) => !present.has(t));
  check(missing.length === 0, `all ${required.length} tables present`, `missing: ${missing.join(", ")}`);

  // The session status rename must have been applied, or the app writes values
  // the constraint rejects.
  const [[chk]] = await conn.query(
    `SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_session_status'`
  );
  check(
    Boolean(chk) && /Active/i.test(chk.c) && !/Pending/i.test(chk.c),
    "session status constraint allows Active, not Pending",
    "run npm run setup:db — the Pending→Active migration has not been applied"
  );

  check(
    await columnExists(conn, "station", "Station_Lat"),
    "station coordinates column exists",
    "photo GPS matching cannot work without it"
  );

  // Billing must not still be running inside the database.
  const [triggers] = await conn.query(
    `SELECT TRIGGER_NAME AS t, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()`
  );
  const billingTriggers = triggers.filter(
    (r) => /INSERT\s+INTO\s+`?payment/i.test(r.body) && !/Wallet Top-Up/i.test(r.body)
  );
  check(
    billingTriggers.length === 0,
    "no trigger writes payments (billing lives in the worker)",
    `still armed: ${billingTriggers.map((r) => r.t).join(", ")}`
  );

  check(
    await n(`SELECT COUNT(*) v FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment'
                AND INDEX_NAME='uq_payment_session'`) > 0,
    "unique index prevents duplicate payments per session"
  );
}

async function columnExists(conn, table, column) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [table, column]
  );
  return Number(row.n) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Referential integrity — no row points at something that is not there
// ─────────────────────────────────────────────────────────────────────────────

async function referentialChecks(n) {
  section("Referential integrity");

  const orphans = [
    ["sessions with a missing charger", `SELECT COUNT(*) v FROM charging_session cs LEFT JOIN charger c ON c.Charger_ID=cs.Charger_ID WHERE c.Charger_ID IS NULL`],
    ["sessions with a missing driver", `SELECT COUNT(*) v FROM charging_session cs LEFT JOIN user u ON u.User_ID=cs.User_ID WHERE u.User_ID IS NULL`],
    ["chargers with a missing station", `SELECT COUNT(*) v FROM charger c LEFT JOIN station s ON s.Station_ID=c.Station_ID WHERE s.Station_ID IS NULL`],
    ["work orders with a missing charger", `SELECT COUNT(*) v FROM maintenance_log m LEFT JOIN charger c ON c.Charger_ID=m.Charger_ID WHERE c.Charger_ID IS NULL`],
    // An unassigned work order has a NULL technician ON PURPOSE — that is the
    // dispatch queue. Only a non-null id pointing at nobody is an orphan.
    ["work orders pointing at a technician who does not exist",
     `SELECT COUNT(*) v FROM maintenance_log m
       WHERE m.Technician_ID IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM technician t WHERE t.Technician_ID = m.Technician_ID)`],
    ["technicians with no coordinates", `SELECT COUNT(*) v FROM technician WHERE Technician_Lat IS NULL`],
    ["payments with a missing session", `SELECT COUNT(*) v FROM payment p WHERE p.Session_ID IS NOT NULL AND NOT EXISTS(SELECT 1 FROM charging_session cs WHERE cs.Session_ID=p.Session_ID)`],
    ["invoices with a missing session", `SELECT COUNT(*) v FROM invoice i LEFT JOIN charging_session cs ON cs.Session_ID=i.Session_ID WHERE cs.Session_ID IS NULL`],
    ["telemetry for a missing charger", `SELECT COUNT(*) v FROM charger_telemetry t LEFT JOIN charger c ON c.Charger_ID=t.Charger_ID WHERE c.Charger_ID IS NULL`],
    ["drivers with no wallet", `SELECT COUNT(*) v FROM user u LEFT JOIN wallet w ON w.User_ID=u.User_ID WHERE w.Wallet_ID IS NULL`],
    ["stations with no coordinates", `SELECT COUNT(*) v FROM station WHERE Station_Lat IS NULL OR Station_Lng IS NULL`],
  ];
  for (const [label, sql] of orphans) {
    const count = await n(sql);
    check(count === 0, label.replace(/^/, "no "), `${count} row(s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. State machine — charger, session and work order must agree
// ─────────────────────────────────────────────────────────────────────────────

async function stateMachineChecks(n) {
  section("Operational state");

  check(
    (await n(`SELECT COUNT(*) v FROM charger c WHERE c.Charger_Availability_Status='In Use'
               AND NOT EXISTS(SELECT 1 FROM charging_session s WHERE s.Charger_ID=c.Charger_ID
                              AND s.Session_Status='Active' AND s.End_Time IS NULL)`)) === 0,
    "every in-use charger has a session running on it",
    "a stall shows occupied with nobody charging — drivers are turned away from a free bay"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM charger c
               JOIN charging_session cs ON cs.Charger_ID=c.Charger_ID
                AND cs.Session_Status='Active' AND cs.End_Time IS NULL
              WHERE c.Charger_Availability_Status NOT IN ('In Use','Out of Service')`)) === 0,
    "every running session has its charger marked busy",
    "the fleet view under-reports demand and the stall looks bookable"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM charger c WHERE c.Charger_Availability_Status='Out of Service'
               AND NOT EXISTS(SELECT 1 FROM maintenance_log m WHERE m.Charger_ID=c.Charger_ID
                              AND m.Status IN ('Reported','Assigned','In Progress'))`)) === 0,
    "every out-of-service charger has an open work order",
    "a charger is down with nobody assigned — it can never come back"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM charging_session
               WHERE Session_Status='Active' AND End_Time IS NOT NULL`)) === 0,
    "no session is Active with an end time already set"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM charging_session
               WHERE Session_Status='Completed' AND End_Time IS NULL`)) === 0,
    "no session is Completed without an end time"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM maintenance_log
               WHERE Status='Resolved' AND Resolved_Time IS NULL`)) === 0,
    "every resolved work order has a resolution time"
  );

  // Dispatch is a geographic decision, so a wildly distant assignment is worth
  // surfacing. A warning rather than a failure: sending somebody far is
  // occasionally the right call (a specialist, a spare part nobody else has),
  // it just should never happen by accident.
  const farDispatch = await n(
    `SELECT COUNT(*) v
       FROM maintenance_log m
       JOIN technician t ON t.Technician_ID = m.Technician_ID
       JOIN station s    ON s.Station_ID    = m.Station_ID
      WHERE m.Status IN ('Assigned','In Progress')
        AND t.Technician_Lat IS NOT NULL AND s.Station_Lat IS NOT NULL
        AND 6371 * ACOS(LEAST(1.0,
              COS(RADIANS(s.Station_Lat)) * COS(RADIANS(t.Technician_Lat)) *
              COS(RADIANS(t.Technician_Lng) - RADIANS(s.Station_Lng)) +
              SIN(RADIANS(s.Station_Lat)) * SIN(RADIANS(t.Technician_Lat))
            )) > 500`
  );
  warn(farDispatch > 0,
    `${farDispatch} work order(s) assigned to a technician over 500 km away`,
    "dispatch ranks by distance, so this was either deliberate or seeded data");

  check(
    (await n(`SELECT COUNT(*) v FROM subscription
               WHERE Status <> 'Cancelled' AND Status <> CASE
                 WHEN Start_Date > CURDATE() THEN 'Pending'
                 WHEN End_Date   < CURDATE() THEN 'Expired'
                 ELSE 'Active' END`)) === 0,
    "every subscription status matches its date range"
  );

  // One charger, one session.
  check(
    (await n(`SELECT COUNT(*) v FROM (
                SELECT Charger_ID FROM charging_session
                 WHERE Session_Status='Active' AND End_Time IS NULL
                 GROUP BY Charger_ID HAVING COUNT(*) > 1) x`)) === 0,
    "no charger has two sessions running at once"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Physics — could this actually have happened?
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Work-order status and assignee have to agree
// ─────────────────────────────────────────────────────────────────────────────
//
// These are one invariant stated twice, and it went unchecked because each
// column looked fine on its own. Nothing was NULL that should not be, no
// foreign key dangled, every status was in the allowed set — and the dispatch
// board still showed one work order under "Awaiting dispatch · nobody is
// working on these" and, three inches lower, "Assigned to Valerie Moore".
//
// The status column carries a claim about the assignee column. A checker that
// only ever looks at one column at a time cannot see that kind of lie.
async function assignmentChecks(n) {
  section("Work-order assignment");

  const unassignedButNamed = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Status = 'Reported' AND Technician_ID IS NOT NULL`
  );
  check(
    unassignedButNamed === 0,
    "no work order is awaiting dispatch with a technician already on it",
    `${unassignedButNamed} row(s) say Reported and name an engineer — the dispatch board ` +
      `will show the same job as both unassigned and assigned`
  );

  const assignedButNobody = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Status IN ('Assigned','In Progress') AND Technician_ID IS NULL`
  );
  check(
    assignedButNobody === 0,
    "no work order is assigned to nobody",
    `${assignedButNobody} row(s) claim to be assigned or in progress with no engineer`
  );

  const startedWithoutAssignment = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Started_At IS NOT NULL AND Assigned_At IS NULL`
  );
  check(
    startedWithoutAssignment === 0,
    "no work order was started before it was dispatched",
    `${startedWithoutAssignment} row(s) have a start time and no assignment time`
  );

  const openWithoutReportTime = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Status IN ('Reported','Assigned','In Progress') AND Reported_At IS NULL`
  );
  check(
    openWithoutReportTime === 0,
    "every open work order records when it was raised",
    `${openWithoutReportTime} row(s) have no report time, so the dispatch board cannot age them`
  );
}

async function physicalChecks(n) {
  section("Physical plausibility");

  check(
    (await n(`SELECT COUNT(*) v FROM charging_session WHERE Energy_Consumed > ?`, [MAX_SESSION_KWH])) === 0,
    `no session delivered more than ${MAX_SESSION_KWH} kWh (a car battery)`,
    "energy was computed as power × hours with no cap — the customer was over-billed"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM charging_session WHERE Energy_Consumed < 0 OR Total_Cost < 0`)) === 0,
    "no session has negative energy or cost"
  );

  // A session cannot have drawn more power than the charger can deliver.
  check(
    (await n(`SELECT COUNT(*) v FROM charging_session cs JOIN charger c ON c.Charger_ID=cs.Charger_ID
               WHERE cs.End_Time IS NOT NULL AND cs.Energy_Consumed IS NOT NULL
                 AND TIMESTAMPDIFF(SECOND, cs.Start_Time, cs.End_Time) > 60
                 AND cs.Energy_Consumed >
                     c.Charger_Power_Capacity * (TIMESTAMPDIFF(SECOND, cs.Start_Time, cs.End_Time)/3600) * 1.05`)) === 0,
    "no session drew more energy than its charger could physically deliver"
  );

  warn(
    (await n(`SELECT COUNT(*) v FROM charging_session
               WHERE Session_Status='Active' AND End_Time IS NULL
                 AND TIMESTAMPDIFF(HOUR, Start_Time, NOW()) > 12`)) > 0,
    "sessions have been running for over 12 hours",
    "the supervisor's stale-session reaper should close these — is the worker pool running?"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM charger WHERE Charger_Power_Capacity <= 0 OR Charging_Rate_Per_kWh <= 0`)) === 0,
    "every charger has a positive power rating and price"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Money — the part a customer would notice
// ─────────────────────────────────────────────────────────────────────────────

async function financialChecks(n) {
  section("Financial integrity");

  check((await n(`SELECT COUNT(*) v FROM wallet WHERE Wallet_Balance < 0`)) === 0,
    "no wallet is overdrawn");

  check(
    (await n(`SELECT COUNT(*) v FROM (SELECT Session_ID FROM payment
               WHERE Session_ID IS NOT NULL GROUP BY Session_ID HAVING COUNT(*)>1) x`)) === 0,
    "no session was billed twice",
    "the billing worker's idempotency guard is not holding"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM (SELECT Session_ID FROM invoice
               GROUP BY Session_ID HAVING COUNT(*)>1) x`)) === 0,
    "no session has two invoices"
  );

  // A payment must agree with the session it settles.
  check(
    (await n(`SELECT COUNT(*) v FROM payment p JOIN charging_session cs ON cs.Session_ID=p.Session_ID
               WHERE p.Payment_Type='Charging' AND p.Payment_Status='success'
                 AND cs.Total_Cost IS NOT NULL
                 AND ABS(p.Payment_Amount - cs.Total_Cost) > 0.01`)) === 0,
    "every successful charging payment matches its session total",
    "the amount taken from the customer differs from the amount the session says"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM invoice i JOIN payment p ON p.Payment_ID=i.Payment_ID
               WHERE ABS(i.Amount - p.Payment_Amount) > 0.01`)) === 0,
    "every invoice matches the payment it documents"
  );

  check(
    (await n(`SELECT COUNT(*) v FROM payment WHERE Payment_Amount < 0`)) === 0,
    "no payment has a negative amount"
  );

  // Every session the APPLICATION settled must have an invoice.
  //
  // Scoped by the seed watermark rather than by date. Seeded history predates
  // the invoice table and can never satisfy this; dating the check instead of
  // sourcing it flagged 43 seeded sessions that had merely been moved into the
  // recent window, which is a false alarm that trains people to ignore the
  // checker.
  const seedMax = await n(
    `SELECT IFNULL(MAX(CAST(Meta_Value AS UNSIGNED)), 0) v FROM app_meta
      WHERE Meta_Key = 'seed_max_session_id'`
  ).catch(() => 0);

  check(
    (await n(`SELECT COUNT(*) v FROM charging_session cs
               WHERE cs.Session_ID > ?
                 AND cs.Session_Status='Completed'
                 AND EXISTS(SELECT 1 FROM payment p WHERE p.Session_ID=cs.Session_ID AND p.Payment_Status='success')
                 AND NOT EXISTS(SELECT 1 FROM invoice i WHERE i.Session_ID=cs.Session_ID)`, [seedMax])) === 0,
    `every application-billed session has an invoice (seeded rows ≤ ${seedMax} exempt)`,
    "the invoice job is failing — check the dead-letter queue on Cloud ops"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Time — nothing happens before it starts, or after now
// ─────────────────────────────────────────────────────────────────────────────

async function temporalChecks(n) {
  section("Temporal coherence");

  check((await n(`SELECT COUNT(*) v FROM charging_session WHERE Start_Time > NOW()`)) === 0,
    "no session starts in the future");

  check((await n(`SELECT COUNT(*) v FROM charging_session WHERE End_Time > NOW()`)) === 0,
    "no session ends in the future",
    "a completed session that has not finished yet");

  check((await n(`SELECT COUNT(*) v FROM charging_session
                   WHERE End_Time IS NOT NULL AND End_Time < Start_Time`)) === 0,
    "no session ends before it starts");

  check((await n(`SELECT COUNT(*) v FROM payment p JOIN charging_session cs ON cs.Session_ID=p.Session_ID
                   WHERE p.Created_Time < cs.Start_Time`)) === 0,
    "no payment predates the session it settles");

  check((await n(`SELECT COUNT(*) v FROM maintenance_log
                   WHERE Resolved_Time IS NOT NULL AND Resolved_Time > NOW()`)) === 0,
    "no work order was resolved in the future");

  check((await n(`SELECT COUNT(*) v FROM charger_telemetry WHERE Reported_At > NOW() + INTERVAL 1 MINUTE`)) === 0,
    "no telemetry is timestamped in the future");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Liveness — does this look like a network that is running?
// ─────────────────────────────────────────────────────────────────────────────

async function livenessChecks(n) {
  section("Operating picture");

  const active = await n(`SELECT COUNT(*) v FROM charging_session WHERE Session_Status='Active' AND End_Time IS NULL`);
  check(active > 0, `${active} session(s) currently charging`,
    "no charger is in use — run npm run seed:activity");

  const recentDays = await n(`SELECT COUNT(DISTINCT DATE(Start_Time)) v FROM charging_session
                               WHERE Start_Time > NOW() - INTERVAL 21 DAY`);
  check(recentDays >= 14, `${recentDays} of the last 21 days have activity`,
    "charts over the recent window will be mostly empty");

  const activeSubs = await n(`SELECT COUNT(*) v FROM subscription WHERE Status='Active'`);
  check(activeSubs > 0, `${activeSubs} active membership(s)`,
    "no driver holds a membership, so the discount path is never exercised");

  const openWork = await n(`SELECT COUNT(*) v FROM maintenance_log WHERE Status IN ('Reported','Assigned','In Progress')`);
  check(openWork > 0, `${openWork} open work order(s)`,
    "the technician queue is empty — nothing to demonstrate dispatch with");

  // Distinct timestamps: a block of sessions sharing one second reads as a bulk
  // insert, not as cars arriving.
  const [distinct, total] = [
    await n(`SELECT COUNT(DISTINCT Start_Time) v FROM charging_session WHERE Session_Status='Active'`),
    Math.max(1, active),
  ];
  check(distinct / total > 0.8,
    `active sessions have distinct start times (${distinct}/${total})`,
    "many sessions share one timestamp — they look bulk-inserted rather than arrived");

  warn(
    (await n(`SELECT COUNT(*) v FROM job_queue WHERE Status='dead'`)) > 0,
    "there are dead-lettered jobs",
    "npm run doctor cannot tell you why — open Cloud ops and read the errors");

  const staleTelemetry = await n(`SELECT IFNULL(TIMESTAMPDIFF(MINUTE, MAX(Reported_At), NOW()), 99999) v FROM charger_telemetry`);
  warn(staleTelemetry > 60,
    `newest telemetry is ${staleTelemetry === 99999 ? "absent" : staleTelemetry + " minutes"} old`,
    "expected when nothing is generating traffic; run npm run traffic for a live deployment");
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. API — does the running application agree with the database?
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 8. Role readiness — does every role have something to do?
// ─────────────────────────────────────────────────────────────────────────────
//
// These are not correctness invariants; nothing here is *wrong* if it fails.
// They are demo-readiness invariants, and they exist because the failure mode
// they catch is invisible from the database side and obvious from the browser:
// a teammate runs setup, signs in as finance, and sees an empty inbox.
//
// Every one of them was a real empty screen on a fresh install before the
// history-shaping step in setup-db.mjs was written.
async function roleReadinessChecks(n) {
  section("Role readiness");

  const waiting = await n(`SELECT COUNT(*) v FROM maintenance_log WHERE Status='Reported'`);
  check(
    waiting > 0,
    `dispatch queue has ${waiting} work order(s) waiting`,
    "the manager signs in to an empty dispatch board — re-run npm run setup:db"
  );

  const pending = await n(`SELECT COUNT(*) v FROM billing_request WHERE Status='Pending'`);
  check(
    pending > 0,
    `finance inbox has ${pending} request(s) awaiting a decision`,
    "the finance role signs in to an empty queue and has nothing to approve"
  );

  const assignedToDemoTech = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Status IN ('Assigned','In Progress') AND Technician_ID IS NOT NULL`
  );
  check(
    assignedToDemoTech > 0,
    `${assignedToDemoTech} work order(s) are assigned to a technician`,
    "every technician login shows an empty job list"
  );

  // Mean time to repair is the manager's headline number and it is computed
  // over resolutions in the last 30 days. A history that stops before that
  // window renders it as a dash.
  const recentlyResolved = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Status='Resolved' AND Resolved_Time > NOW() - INTERVAL 30 DAY`
  );
  check(
    recentlyResolved > 0,
    `${recentlyResolved} repair(s) closed in the last 30 days — MTTR is computable`,
    "maintenance history has gone stale; the rebase step in setup-db should have moved it forward"
  );

  // A repair that took zero time did not happen. The seed set Reported_At equal
  // to Resolved_Time on every row, which made MTTR exactly zero across a
  // thousand work orders.
  const instant = await n(
    `SELECT COUNT(*) v FROM maintenance_log
      WHERE Status='Resolved' AND Reported_At IS NOT NULL AND Reported_At = Resolved_Time`
  );
  check(
    instant === 0,
    "no work order was resolved in the same instant it was reported",
    `${instant} row(s) report a zero-length repair, which flattens mean time to repair`
  );

  // Codes are what let one firmware bug across forty sites be seen as one
  // thing. Prose cannot be grouped.
  const uncoded = await n(
    `SELECT COUNT(*) v FROM maintenance_log WHERE Fault_Code IS NULL OR Fault_Code = ''`
  );
  const totalOrders = await n(`SELECT COUNT(*) v FROM maintenance_log`);
  check(
    uncoded === 0,
    `every work order carries a fault code (${totalOrders} rows)`,
    `${uncoded} row(s) have none, so the fault-code panel reads "unspecified"`
  );

  const distinctCodes = await n(
    `SELECT COUNT(DISTINCT Fault_Code) v FROM maintenance_log WHERE Fault_Code IS NOT NULL`
  );
  check(
    distinctCodes >= 5,
    `${distinctCodes} distinct fault code(s) in use`,
    "one code for everything is the same as no code at all"
  );

  const hostSites = await n(
    `SELECT COUNT(*) v FROM station WHERE Company_ID = (
       SELECT Company_ID FROM station GROUP BY Company_ID ORDER BY COUNT(*) DESC LIMIT 1)`
  );
  check(
    hostSites > 0,
    `the busiest company owns ${hostSites} site(s) — the site-host view has rows`,
    "a site host would sign in to an empty estate"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Access control — is every router actually guarded?
// ─────────────────────────────────────────────────────────────────────────────
//
// This one reads source rather than data, and it exists because of a specific
// bug: /api/dashboard was mounted with no role guard, so a field technician
// could read network revenue. Nothing failed. No error appeared anywhere. The
// route simply answered everybody.
//
// A missing guard is invisible by construction — the symptom is a request that
// SUCCEEDS when it should not — so the only way to catch it is to assert that
// the guard is present, not to test that it works.
async function accessControlChecks() {
  section("Access control");

  const appSource = readFileSync(join(SERVER_DIR, "app.js"), "utf8");

  // Every router file under server/routes must be mounted with allowRoles.
  // Anything auth-exempt has to be named here deliberately, which is the point:
  // exempting a route becomes a decision somebody wrote down rather than an
  // omission nobody noticed.
  const PUBLIC_BY_DESIGN = new Set(["auth", "health", "files"]);

  const routers = readdirSync(join(SERVER_DIR, "routes"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""))
    .filter((name) => !PUBLIC_BY_DESIGN.has(name));

  // Each app.use(...) statement, whole, however many lines it spans. Splitting
  // on the call and taking up to the terminating semicolon handles the
  // multi-line mounts, which a bracket-counting regex does not: allowRoles()
  // puts a closing parenthesis in the middle of every one of them.
  const mounts = appSource
    .split("app.use(")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(";")));

  const unguarded = [];
  for (const name of routers) {
    const mount = mounts.find((m) => new RegExp(`\\b${name}Router\\b`).test(m));
    if (!mount) unguarded.push(`${name} (never mounted)`);
    else if (!/allowRoles/.test(mount)) unguarded.push(`${name} (no allowRoles)`);
  }

  check(
    unguarded.length === 0,
    `all ${routers.length} protected router(s) are mounted behind allowRoles`,
    `unguarded: ${unguarded.join(", ")} — any signed-in role can reach these`
  );

  // The front end decides what to draw; the server decides what is allowed. If
  // the browser is the only thing enforcing a rule, the rule does not exist —
  // so this asserts the nav table is complete, not that it is sufficient.
  const accessSource = readFileSync(join(SERVER_DIR, "..", "src", "lib", "access.ts"), "utf8");
  const navEntries = [...accessSource.matchAll(/\{\s*to:\s*"[^"]+",[^}]*\}/g)].map((m) => m[0]);
  const withoutRoles = navEntries.filter((entry) => !/roles:/.test(entry));
  check(
    navEntries.length > 0 && withoutRoles.length === 0,
    `all ${navEntries.length} navigation entries name the roles that may see them`,
    `${withoutRoles.length} entry/entries have no roles list and default to visible for everybody`
  );

  // ── Every aggregate dashboard route reports the whole network ───────────
  //
  // A site host may reach /api/dashboard, because one route there is theirs.
  // The router-level guard cannot tell the two apart, so each route carries
  // its own. A new endpoint added without it is visible to hosts by default,
  // which is how /recent-sessions came to hand a host the names of drivers at
  // a competitor's sites.
  const dashSource = readFileSync(join(SERVER_DIR, "routes", "dashboard.js"), "utf8");
  const TENANT_SCOPED_ROUTES = new Set(["/site-performance", "/host-earnings"]);
  const dashRoutes = [...dashSource.matchAll(/router\.get\("([^"]+)"\s*,\s*([A-Za-z]+)?/g)];
  const unscopedDash = dashRoutes
    .filter(([, path, next]) => !TENANT_SCOPED_ROUTES.has(path) && next !== "networkWideOnly")
    .map(([, path]) => path);
  check(
    dashRoutes.length > 0 && unscopedDash.length === 0,
    `all ${dashRoutes.length - TENANT_SCOPED_ROUTES.size} network-wide dashboard route(s) are closed to tenant accounts`,
    `unguarded: ${unscopedDash.join(", ")} — a site host can read the whole network there`
  );

  // ── Detail routes have to check the owning company themselves ───────────
  //
  // Filtering a list is the visible half of tenancy and the easy half to
  // remember. GET /api/stations/:id never passes through that filter, and it
  // answered every id to anyone for weeks, because nothing in the interface
  // ever revealed it.
  for (const file of ["stations.js", "chargers.js"]) {
    const src = readFileSync(join(SERVER_DIR, "routes", file), "utf8");
    const byIdRoutes = (src.match(/router\.get\("\/:id[^"]*"/g) || []).length;
    const guards = (src.match(/denyForeignTenant/g) || []).length;
    check(
      byIdRoutes > 0 && guards >= byIdRoutes,
      `${file}: all ${byIdRoutes} detail route(s) check the owning company`,
      `${byIdRoutes} route(s) but only ${guards} tenancy check(s) — an id typed by hand bypasses the list filter`
    );
  }
}

async function apiChecks(conn) {
  section("API consistency");

  // ── Sign in, and tell the truth about why it failed ─────────────────────
  //
  // This reported "API not reachable" for anything that was not a token,
  // which is the one explanation that sends somebody to check whether the
  // server is running. The usual cause on a laptop is the opposite: the server
  // is running fine and the login rate limiter (ten a minute per IP) has been
  // used up by the browser, the simulated fleet and the smoke test, all
  // arriving from 127.0.0.1.
  //
  // So a 429 is waited out rather than reported as an outage, and anything
  // else names the status code it actually got.
  let token;
  let failure = "no response";
  for (let attempt = 1; attempt <= 3 && !token; attempt++) {
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: process.env.DEMO_USERNAME || "ops",
          password: process.env.DEMO_PASSWORD || "chargeops-demo",
        }),
      });

      if (res.status === 429) {
        const reset = Number(res.headers.get("RateLimit-Reset")) || 0;
        const waitMs = Math.min(65_000, Math.max(2_000, reset ? reset * 1000 - Date.now() + 1_000 : 15_000));
        failure = "rate limited";
        if (!QUIET) console.log(`  ${DIM}… login rate limited, waiting ${Math.round(waitMs / 1000)}s${OFF}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const body = await res.json().catch(() => ({}));
      token = body.token;
      if (!token) failure = `HTTP ${res.status}${body.error ? ` — ${body.error}` : ""}`;
    } catch (err) {
      failure = `cannot connect (${err.message})`;
      break;
    }
  }

  if (!token) {
    warn(true, `API checks skipped — ${failure}`,
      `start it with npm run dev:all, or run npm run doctor -- --db-only`);
    return;
  }

  const get = (path) => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  // Summary tiles must count the FILTER, not the page. This is the bug that
  // appeared independently on three different screens.
  for (const [label, path] of [
    ["chargers", "/api/chargers?page=1&pageSize=25"],
    ["sessions", "/api/sessions?page=1&pageSize=25&days=30"],
    ["work orders", "/api/maintenance?page=1&pageSize=25"],
  ]) {
    const res = await get(path);
    const total = Number(res.headers.get("x-total-count"));
    const raw = res.headers.get("x-status-counts");
    const counts = raw ? Object.values(JSON.parse(raw)).reduce((a, b) => a + Number(b), 0) : null;
    check(
      counts !== null && counts === total,
      `${label}: status breakdown covers the whole filter (${counts} = ${total})`,
      "the summary tiles are counting one page while the total counts the filter"
    );
  }

  // The dashboard must agree with the table it summarises.
  const [[dbCharger]] = await conn.query(
    `SELECT COUNT(*) AS n FROM charger WHERE Charger_Availability_Status='In Use'`
  );
  const avail = await (await get("/api/dashboard/charger-availability")).json();
  const apiInUse = Number(avail.find((r) => r.status === "In Use")?.count ?? 0);
  check(apiInUse === Number(dbCharger.n),
    `dashboard in-use count matches the database (${apiInUse})`);

  // Running sessions must report an estimate rather than a misleading zero.
  const live = await (await get("/api/sessions?status=Active&pageSize=5&days=30")).json();
  const rows = Array.isArray(live) ? live : live.rows ?? [];
  if (rows.length) {
    check(rows.every((r) => r.kwh == null && r.estimated_kwh > 0),
      "running sessions report a live estimate, not a settled zero");
  }

  // Anonymous access must be refused.
  check((await fetch(`${API}/api/chargers`)).status === 401,
    "protected endpoints reject anonymous requests");

  // ── The tenant boundary, exercised rather than inspected ────────────────
  //
  // The static checks above prove the guards are written. This proves they
  // work: sign in as the site host and ask for a station that is not theirs.
  // A 200 here is a data leak, and it is worth one real request to know.
  try {
    const hostLogin = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: process.env.AUTH_HOST_USERNAME || "host",
        password: process.env.AUTH_HOST_PASSWORD || "chargeops-demo",
      }),
    });
    if (hostLogin.ok) {
      const { token } = await hostLogin.json();
      const auth = { Authorization: `Bearer ${token}` };

      const [[foreign]] = await conn.query(
        `SELECT s.Station_ID AS sid, c.Charger_ID AS cid
           FROM station s JOIN charger c ON c.Station_ID = s.Station_ID
          WHERE s.Company_ID <> (SELECT Company_ID FROM station
                                  GROUP BY Company_ID ORDER BY COUNT(*) DESC LIMIT 1)
          LIMIT 1`
      );

      const probes = [
        [`/api/stations/${foreign.sid}`, "another company's station"],
        [`/api/chargers/${foreign.cid}`, "another company's charger"],
        [`/api/chargers/${foreign.cid}/history`, "another company's repair history"],
        ["/api/dashboard/kpis", "network-wide totals"],
        ["/api/dashboard/recent-sessions?limit=1", "driver names across the network"],
        ["/api/maintenance/technicians", "the engineer directory"],
      ];

      const leaked = [];
      for (const [path, what] of probes) {
        const res = await fetch(`${API}${path}`, { headers: auth });
        if (res.ok) leaked.push(what);
      }

      check(
        leaked.length === 0,
        `site host is refused all ${probes.length} cross-tenant probe(s)`,
        `LEAKED: ${leaked.join("; ")}`
      );
    }
  } catch {
    warn(true, "tenant isolation probe skipped", "the host demo account could not sign in");
  }

  check((await (await fetch(`${API}/api/health`)).json()).status === "ok",
    "health endpoint reports a working database");
}

main().catch((err) => {
  console.error(`\n${RED}✖ doctor failed to run:${OFF} ${err.message}\n`);
  process.exit(1);
});
