// scripts/setup-db.mjs - one command to build the whole local database
//
//   npm run setup:db
//
// Idempotent: run it as often as you like. It creates what is missing and
// leaves what is already there alone, so a teammate can clone the repo, fill in
// server/.env, and be looking at a working app a minute later.
//
// Order matters:
//   00_base_schema.sql   the EDS 6343 relational model (tables + triggers)
//   00_base_data.sql     the seed data from the database project
//   01_cloud_schema.sql  queue / attachments / telemetry / invoices / workers
//   02_move_billing...   drop the billing triggers now owned by the worker
//   03_reporting_package procedures and views from the database project
//   04_daily_simulation MySQL Event -> queue -> application worker
//   + geocode stations so photo GPS tags can be matched to a site
//
// Credentials come from server/.env and are never printed.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import "../server/env.js";
import { energyDeliveredKwh, MAX_SESSION_KWH, typicalSessionMinutes } from "../server/lib/charging.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SQL_DIR = path.join(ROOT, "server", "sql");


const DB_NAME = process.env.DB_NAME || "ev";

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  // Our .sql files are scripts, not single statements.
  multipleStatements: true,
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

/**
 * Relative demand by hour of day, matching scripts/seed-activity.mjs.
 *
 * Two peaks, because that is how public charging behaves: a morning commute
 * bump and a larger evening one when people plug in after work. Overnight is
 * thin rather than zero — some drivers charge while they sleep.
 */
const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2,   // 00-05
  4, 7, 9, 8, 6, 5,   // 06-11
  6, 5, 5, 6, 8, 10,  // 12-17
  10, 9, 7, 5, 4, 3,  // 18-23
];
const HOUR_PICKER = HOUR_WEIGHTS.flatMap((w, hour) => Array(w).fill(hour));

/** How far back generated history reaches. */
const VOLUME_DAYS = 21;

const log  = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n▶ ${msg}`);

async function main() {
  console.log(`\nChargeOps database setup`);
  console.log(`  target: ${config.user}@${config.host}:${config.port}/${DB_NAME}\n`);

  let conn;
  try {
    conn = await mysql.createConnection(config);
  } catch (err) {
    console.error(`\n✖ Could not connect to MySQL: ${err.code} ${err.message}`);
    console.error(`  Check server/.env — DB_HOST, DB_PORT, DB_USER, DB_PASS.`);
    console.error(`  Make sure the MySQL service is running.\n`);
    process.exit(1);
  }

  // ── Database ──────────────────────────────────────────────────────────────
  step(`Database "${DB_NAME}"`);
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${DB_NAME}\``);
  log(`ready`);

  // ── Base relational model (only if it isn't there yet) ────────────────────
  step("Base schema (EDS 6343 relational model)");
  if (await tableExists(conn, "station")) {
    log("already present — skipped");
  } else {
    // The original script starts with CREATE DATABASE EV1 / USE EV1. Strip
    // those so the model lands in whatever DB_NAME points at instead of always
    // creating EV1.
    const sql = (await read("00_base_schema.sql"))
      .replace(/^\s*CREATE\s+DATABASE[^;]*;/gim, "")
      .replace(/^\s*USE\s+\w+\s*;/gim, "");
    await runScript(conn, sql, "00_base_schema.sql");
    log("tables + triggers created");
  }

  // ── Seed data ─────────────────────────────────────────────────────────────
  step("Seed data");
  const [[{ n: stationCount }]] = await conn.query("SELECT COUNT(*) AS n FROM station");
  if (stationCount > 0) {
    log(`already loaded (${stationCount} stations) — skipped`);
  } else {
    await runScript(conn, await read("00_base_data.sql"), "00_base_data.sql");
    const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM charging_session");
    log(`loaded (${n} charging sessions)`);
  }

  // ── Cloud tables ──────────────────────────────────────────────────────────
  step("Cloud schema (queue, attachments, telemetry, invoices, workers)");
  await runScript(conn, await read("01_cloud_schema.sql"), "01_cloud_schema.sql");
  for (const t of ["job_queue", "attachment", "invoice", "charger_telemetry", "worker_node", "audit_log", "simulation_run", "billing_request"]) {
    log(`${(await tableExists(conn, t)) ? "✓" : "✗"} ${t}`);
  }

  // ── Writing off a debt needs a state to write it into ─────────────────────
  //
  // The base schema allows success / failed / pending. A debt finance has
  // decided to forgive is none of those: `failed` means the attempt bounced
  // and belongs in the collections queue, so leaving it there would put the
  // same session back in front of somebody every week forever.
  //
  // Migrated rather than edited into 00_base_schema.sql, so the relational
  // model the course project submitted stays exactly as it was and every
  // change this platform needs is visible as a step in this script.
  const [[payStatus]] = await conn.query(
    `SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_payment_status'`
  );
  if (payStatus && !/written_off/i.test(payStatus.c)) {
    await conn.query(`ALTER TABLE payment DROP CHECK chk_payment_status`);
    await conn.query(
      `ALTER TABLE payment ADD CONSTRAINT chk_payment_status
         CHECK (Payment_Status IN ('success', 'failed', 'pending', 'written_off'))`
    );
    log("payment status now allows written_off (a forgiven debt, not a failed attempt)");
  }

  step("Cloud data-integrity constraints");
  await ensureUniqueIndex(conn, "payment", "uq_payment_session", "Session_ID");
  await ensureUniqueIndex(conn, "invoice", "uq_invoice_session", "Session_ID");
  await ensureForeignKey(conn, "attachment", "fk_attachment_maintenance", "Maintenance_ID", "maintenance_log", "Maintenance_ID");
  await ensureForeignKey(conn, "attachment", "fk_attachment_station", "Station_ID", "station", "Station_ID");
  await ensureForeignKey(conn, "attachment", "fk_attachment_charger", "Charger_ID", "charger", "Charger_ID");
  await ensureForeignKey(conn, "attachment", "fk_attachment_technician", "Technician_ID", "technician", "Technician_ID");
  await ensureForeignKey(conn, "attachment", "fk_attachment_matched_station", "Matched_Station_ID", "station", "Station_ID");
  await ensureForeignKey(conn, "invoice", "fk_invoice_session", "Session_ID", "charging_session", "Session_ID");
  await ensureForeignKey(conn, "invoice", "fk_invoice_user", "User_ID", "user", "User_ID");
  await ensureForeignKey(conn, "invoice", "fk_invoice_payment", "Payment_ID", "payment", "Payment_ID");
  log("unique indexes and metadata foreign keys ready");

  // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
  // so a column whose TYPE changed after someone already ran setup needs an
  // explicit ALTER. MODIFY COLUMN is idempotent — re-applying the same type is
  // a no-op — which keeps this safe to run on every setup.
  await conn.query(
    `ALTER TABLE attachment
       MODIFY COLUMN Uploaded_At  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       MODIFY COLUMN Processed_At DATETIME(3) NULL`
  );
  log(`✓ attachment timestamps at millisecond precision`);

  // ── Station coordinates ───────────────────────────────────────────────────
  // MySQL has no "ADD COLUMN IF NOT EXISTS", so check information_schema first
  // rather than swallowing a duplicate-column error.
  // ── Who the companies actually are ────────────────────────────────────────
  step("Site hosts");
  const renamedCompanies = await renameCompaniesToSiteHosts(conn);
  for (const line of renamedCompanies) log(line);

  step("Station coordinates (for photo GPS matching)");
  for (const col of ["Station_Lat", "Station_Lng"]) {
    if (!(await columnExists(conn, "station", col))) {
      await conn.query(`ALTER TABLE station ADD COLUMN ${col} DECIMAL(9,6) NULL`);
      log(`added station.${col}`);
    }
  }
  const geocoded = await geocodeStations(conn);
  log(`${geocoded} station(s) geocoded`);

  // Technicians need coordinates for the same reason stations do: dispatch is a
  // geographic decision. Without them the only way to rank candidates is
  // workload, and the manager is free to send a Texas technician to a New York
  // charger without the interface saying a word about it.
  for (const col of ["Technician_Lat", "Technician_Lng"]) {
    if (!(await columnExists(conn, "technician", col))) {
      await conn.query(`ALTER TABLE technician ADD COLUMN ${col} DECIMAL(9,6) NULL`);
    }
  }
  const techGeocoded = await geocodeTechnicians(conn);
  log(`${techGeocoded} technician(s) geocoded`);

  // ── Keep memberships alive relative to today ──────────────────────────────
  step("Membership subscriptions (rebased to today)");
  const rebased = await rebaseSubscriptions(conn);
  if (rebased.skipped) {
    log(`${rebased.active} active of ${rebased.total} — healthy, left alone`);
  } else {
    log(`rebased ${rebased.updated} subscription(s)`);
    log(`now: ${rebased.active} active · ${rebased.expired} expired · ${rebased.pending} pending`);
  }

  // ── Move the membership PAYMENTS with the subscriptions ───────────────────
  //
  // Rebasing the subscriptions and leaving their payments behind produced a
  // finance page where the membership line was flat zero for thirty days while
  // 334 memberships were active. Every revenue-over-time view then said the
  // business earns nothing from memberships, which is a different and much
  // worse claim than "memberships are a small share".
  //
  // A membership bills monthly, so each payment lands on the subscription's
  // start day-of-month, repeated forward. Spreading them across the window
  // rather than stacking them on one date is what makes the daily chart
  // legible — real billing runs are staggered across the month anyway.
  const [movedPayments] = await conn.query(
    `UPDATE payment p
       JOIN (
         SELECT s.User_ID, MIN(s.Start_Date) AS started
           FROM subscription s GROUP BY s.User_ID
       ) sub ON sub.User_ID = p.User_ID
        SET p.Created_Time = DATE_ADD(
              CURDATE() - INTERVAL (p.Payment_ID % 30) DAY,
              INTERVAL (p.Payment_ID % 86400) SECOND)
      WHERE p.Payment_Type = 'Subscription'
        AND p.Created_Time < CURDATE() - INTERVAL 30 DAY`
  );
  if (movedPayments.affectedRows) {
    log(`rebased ${movedPayments.affectedRows} membership payment(s) into the last 30 days`);
  }

  // ── Session status: 'Pending' → 'Active' ──────────────────────────────────
  step("Session status naming");
  const renamed = await renameSessionStatus(conn);
  for (const line of renamed) log(line);

  // ── Move billing out of triggers ──────────────────────────────────────────
  step("Billing: triggers → async worker");
  const before = await triggerNames(conn);
  await runScript(conn, await read("02_move_billing_out_of_triggers.sql"), "02_...sql");
  const after = await triggerNames(conn);
  const dropped = before.filter((t) => !after.includes(t));
  if (dropped.length) {
    log(`dropped ${dropped.length} billing trigger(s): ${dropped.join(", ")}`);
    log(`logic now lives in server/workers/handlers/billing.js`);
  } else {
    log("already migrated — no billing triggers present");
  }
  log(`kept ${after.length} data-integrity trigger(s): ${after.join(", ") || "none"}`);

  // ── Daily simulator schedule ─────────────────────────────────────────────
  // ── Make the data look like a running network ─────────────────────────────
  // Without this the tables are correct but lifeless: no charger is mid-session,
  // so the fleet reads as an idle car park rather than an operating business.
  //
  // MUST run after the billing triggers are dropped. On a fresh database those
  // triggers are still armed, and trg_charging_session_before_insert stamps new
  // rows with the old 'Pending' status — which the renamed CHECK constraint now
  // rejects. Ordering this before the migration made setup fail on exactly the
  // case that matters most: a teammate's first run.
  // ── Trade volume ──────────────────────────────────────────────────────────
  //
  // After the trigger drop, and that ordering is forced rather than chosen.
  // The seed's billing triggers write back to charging_session when a payment
  // changes, so settling 34,000 payments while they are still attached fails
  // with "can't update table ... already used by statement which invoked this
  // trigger". Which is a fair summary of why the billing logic was moved into
  // a worker in the first place.
  step("Charging history volume");
  const volume = await buildSessionVolume(conn, { days: VOLUME_DAYS, hourPicker: HOUR_PICKER });
  for (const line of volume) log(line);

  // ── Remember where the seeded data ends ───────────────────────────────────
  // Recorded once, after all seed-shaped history exists and before the
  // application has produced anything of its own. Everything at or below this
  // id is seed data — including the volume generated above, which is history
  // the course seed was too thin to supply, not something this platform did.
  // Everything above it was created by the running application, and only that
  // is held to rules like "every settled session has a PDF invoice".
  await recordSeedWatermark(conn);

  // ── Work orders: from a log table to a dispatch workflow ──────────────────
  step("Work order workflow");
  const wf = await upgradeWorkOrders(conn);
  for (const line of wf) log(line);

  // ── Clean up what the seed data itself gets wrong ─────────────────────────
  step("Seed data consistency");
  const cleaned = await fixSeedInconsistencies(conn);
  for (const line of cleaned) log(line);

  // ── Give every role's home screen something real to show ─────────────
  step("Work order history and pending decisions");
  const shaped = await shapeWorkOrderHistory(conn);
  for (const line of shaped) log(line);

  step("Operating activity");
  const activity = await shapeActivity();
  for (const line of activity) log(line);


  step("Daily simulator (MySQL Event -> simulation queue)");
  await runScript(conn, await read("04_daily_simulation.sql"), "04_daily_simulation.sql");
  const [[simEvent]] = await conn.query(
    `SELECT STATUS AS status, STARTS AS starts, INTERVAL_VALUE AS interval_value,
            INTERVAL_FIELD AS interval_field
       FROM information_schema.EVENTS
      WHERE EVENT_SCHEMA = ? AND EVENT_NAME = 'evt_chargeops_daily_simulation'`,
    [DB_NAME]
  );
  log(simEvent
    ? `✓ evt_chargeops_daily_simulation ${simEvent.status} (every ${simEvent.interval_value} ${simEvent.interval_field})`
    : "✗ evt_chargeops_daily_simulation missing");

  // ── Analytical queries (regression check) ─────────────────────────────────
  // This file is the 16 analytical queries and the reporting view from the
  // database project. Running them here is not busywork - it proves the
  // relational layer still answers every question it used to after the cloud
  // schema was layered on and the billing triggers were removed.
  step("Analytical queries from the database project (regression check)");
  try {
    const { executed } = await runScript(
      conn,
      await read("03_reporting_package.sql"),
      "03_reporting_package.sql"
    );
    log(`${executed} statement(s) ran clean — relational layer intact`);
  } catch (err) {
    // Not fatal: the application does not depend on these. But it IS worth
    // shouting about, because it means a query that used to work no longer does.
    log(`⚠ FAILED: ${err.sqlMessage ?? err.message}`);
    log(`  the app still works, but check server/sql/03_reporting_package.sql`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  step("Summary");
  const tables = [
    "company", "user", "station", "charger", "charging_session", "payment",
    "maintenance_log", "technician", "attachment", "invoice",
    "charger_telemetry", "job_queue", "audit_log", "simulation_run",
  ];
  for (const t of tables) {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    log(`${t.padEnd(20)} ${String(n).padStart(7)} rows`);
  }

  await conn.end();

  console.log(`
✔ Database ready.

  Next:
    npm run seed:demo     generate sample technician photos + reports
    npm run dev:all       API + workers + web UI
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const read = (file) => fs.readFile(path.join(SQL_DIR, file), "utf8");

/**
 * Run a .sql file.
 *
 * mysql2's multipleStatements splits on `;`, which breaks any script that
 * defines a trigger or procedure - the `;` inside the BEGIN...END body ends the
 * statement early. That is why the original files use `DELIMITER $$`, a
 * mysql-client feature the protocol itself knows nothing about. So we
 * pre-process: split the file on DELIMITER directives, and send each
 * routine-defining chunk as its own single statement.
 */
async function runScript(conn, sql, label) {
  let executed = 0;
  const chunks = splitOnDelimiters(sql);
  for (const { statements } of chunks) {
    for (const stmt of statements) {
      // Each statement arrives with the comment block that preceded it still
      // attached, because we split on ";" and comments live between statements.
      // Strip leading comment-only lines so the "is this statement empty?"
      // check below looks at actual SQL. (Interior comment lines are left
      // alone — MySQL is perfectly happy with them.)
      const body = stripLeadingComments(stmt);
      if (!body) continue;
      try {
        await conn.query(body);
        executed++;
      } catch (err) {
        // Re-running setup is expected, so anything meaning "already there" is
        // not an error worth stopping for.
        const benign = [
          "ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME",
          "ER_TRG_ALREADY_EXISTS", "ER_SP_ALREADY_EXISTS", "ER_DUP_ENTRY",
        ];
        if (benign.includes(err.code)) continue;
        console.error(`\n✖ ${label}: ${err.code} ${err.sqlMessage ?? err.message}`);
        console.error(`  statement: ${body.slice(0, 200)}...\n`);
        throw err;
      }
    }
  }
  return { executed };
}

/**
 * Drop blank lines and `--` / `#` comment lines from the front of a statement,
 * returning "" if nothing but comments remain.
 *
 * Only leading lines are touched. Stripping comments everywhere would risk
 * mangling a string literal in the seed data that happens to contain "--".
 */
function stripLeadingComments(stmt) {
  let s = stmt;
  let m;
  while ((m = s.match(/^[ \t]*(?:--[^\n]*|#[^\n]*)?(?:\r?\n)/)) !== null) {
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/** Split a script into chunks honouring `DELIMITER $$` blocks. */
function splitOnDelimiters(sql) {
  const out = [];
  let delimiter = ";";
  let buffer = "";

  for (const line of sql.split(/\r?\n/)) {
    const m = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (m) {
      if (buffer.trim()) out.push({ statements: splitBy(buffer, delimiter) });
      buffer = "";
      delimiter = m[1];
      continue;
    }
    buffer += line + "\n";
  }
  if (buffer.trim()) out.push({ statements: splitBy(buffer, delimiter) });
  return out;
}

function splitBy(text, delimiter) {
  if (delimiter === ";") {
    // Naive `;` splitting is safe for our data files (no semicolons inside the
    // string literals) but would not be for arbitrary SQL.
    return text.split(/;\s*(?:\r?\n|$)/);
  }
  return text.split(delimiter);
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [DB_NAME, table]
  );
  return rows.length > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB_NAME, table, column]
  );
  return rows.length > 0;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB_NAME, table, index]
  );
  return rows.length > 0;
}

async function foreignKeyExists(conn, table, constraint) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [DB_NAME, table, constraint]
  );
  return rows.length > 0;
}

async function ensureUniqueIndex(conn, table, name, column) {
  if (await indexExists(conn, table, name)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${name}\` (\`${column}\`)`);
}

async function ensureForeignKey(conn, table, name, column, parentTable, parentColumn) {
  if (await foreignKeyExists(conn, table, name)) return;
  await conn.query(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\`
       FOREIGN KEY (\`${column}\`) REFERENCES \`${parentTable}\` (\`${parentColumn}\`)`
  );
}

async function triggerNames(conn) {
  const [rows] = await conn.query(
    `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?`,
    [DB_NAME]
  );
  return rows.map((r) => r.name);
}

/**
 * Give every station a coordinate.
 *
 * A real system would call a geocoding API on the postal address. We use city
 * centroids plus a small deterministic offset derived from the station id, so
 * stations in the same city land a few blocks apart instead of stacking on one
 * pin - and so the result is the same on every machine, which matters when the
 * demo depends on a photo matching a specific station.
 */
// Covers every city present in the seed data, so no station falls through to a
// state centroid. That matters: a state centroid would drop a Long Beach
// station in the middle of California, and the photo-to-station match would
// then be confidently wrong rather than absent.
const CITY_COORDS = {
  // AZ
  "Phoenix":        [33.4484, -112.0740],
  "Tempe":          [33.4255, -111.9400],
  // CA
  "Los Angeles":    [34.0522, -118.2437],
  "Long Beach":     [33.7701, -118.1937],
  "Pasadena":       [34.1478, -118.1445],
  "Santa Monica":   [34.0195, -118.4912],
  "San Diego":      [32.7157, -117.1611],
  "San Francisco":  [37.7749, -122.4194],
  "San Jose":       [37.3382, -121.8863],
  // CO
  "Denver":         [39.7392, -104.9903],
  // DC / VA / NJ
  "Washington":     [38.9072,  -77.0369],
  "Arlington":      [38.8816,  -77.0910],
  "Jersey City":    [40.7178,  -74.0431],
  // FL
  "Miami":          [25.7617,  -80.1918],
  "Miami Beach":    [25.7907,  -80.1300],
  "Orlando":        [28.5383,  -81.3792],
  // GA / IL / MI / MN
  "Atlanta":        [33.7490,  -84.3880],
  "Chicago":        [41.8781,  -87.6298],
  "Detroit":        [42.3314,  -83.0458],
  "Minneapolis":    [44.9778,  -93.2650],
  // MA
  "Boston":         [42.3601,  -71.0589],
  "Cambridge":      [42.3736,  -71.1097],
  // NY / PA
  "New York":       [40.7128,  -74.0060],
  "Brooklyn":       [40.6782,  -73.9442],
  "Philadelphia":   [39.9526,  -75.1652],
  // OR / WA
  "Portland":       [45.5152, -122.6784],
  "Seattle":        [47.6062, -122.3321],
  "Bellevue":       [47.6101, -122.2015],
  // TX
  "Austin":         [30.2672,  -97.7431],
  "Round Rock":     [30.5083,  -97.6789],
  "Houston":        [29.7604,  -95.3698],
  "Sugar Land":     [29.6197,  -95.6349],
  "Dallas":         [32.7767,  -96.7970],
  "Fort Worth":     [32.7555,  -97.3308],
  "Frisco":         [33.1507,  -96.8236],
  "Irving":         [32.8140,  -96.9489],
  "Plano":          [33.0198,  -96.6989],
  "San Antonio":    [29.4241,  -98.4936],
  "El Paso":        [31.7619, -106.4850],
  // UT / NV / TN / NC
  "Salt Lake City": [40.7608, -111.8910],
  "Las Vegas":      [36.1699, -115.1398],
  "Nashville":      [36.1627,  -86.7816],
  "Charlotte":      [35.2271,  -80.8431],
};

/**
 * State centroids, used only if a city is genuinely unknown. Deliberately a
 * last resort — the script warns when it falls back here, because a station
 * pinned to the middle of Texas will match photos it has nothing to do with.
 */
const STATE_COORDS = {
  TX: [31.0, -100.0], CA: [36.7, -119.4], CO: [39.0, -105.5], AZ: [34.0, -111.0],
  WA: [47.4, -120.5], OR: [43.8, -120.5], NV: [38.8, -116.4], GA: [32.9,  -83.6],
  FL: [27.8,  -81.7], IL: [40.0,  -89.0], NY: [42.9,  -75.5], MA: [42.4,  -71.4],
  PA: [40.9,  -77.8], TN: [35.7,  -86.7], NC: [35.6,  -79.8], UT: [39.3, -111.7],
  MN: [46.3,  -94.3], MI: [44.3,  -85.6], NJ: [40.2,  -74.7], VA: [37.5,  -78.8],
  DC: [38.9,  -77.0],
};

/**
 * Give each technician the coordinates of their home city.
 *
 * Uses the same lookup table as the stations, so a technician in Seattle and a
 * station in Seattle land on the same point and the distance between them is
 * zero rather than merely "same state".
 */
async function geocodeTechnicians(conn) {
  const [rows] = await conn.query(
    `SELECT Technician_ID, Technician_City, Technician_State
       FROM technician
      WHERE Technician_Lat IS NULL OR Technician_Lng IS NULL`
  );

  let updated = 0;
  const unknown = [];
  for (const t of rows) {
    const base =
      CITY_COORDS[t.Technician_City] ??
      STATE_COORDS[String(t.Technician_State).toUpperCase()];
    if (!base) {
      unknown.push(`${t.Technician_City}, ${t.Technician_State}`);
      continue;
    }
    // Spread technicians around their city centre so several in one city do not
    // all sit on the identical point.
    const jitter = ((t.Technician_ID * 37) % 100) / 100 - 0.5;
    await conn.query(
      `UPDATE technician SET Technician_Lat = ?, Technician_Lng = ? WHERE Technician_ID = ?`,
      [base[0] + jitter * 0.08, base[1] + jitter * 0.08, t.Technician_ID]
    );
    updated++;
  }
  if (unknown.length) {
    log(`⚠ ${new Set(unknown).size} technician city/state pair(s) not in the lookup table`);
  }
  return updated;
}

async function geocodeStations(conn) {
  const [stations] = await conn.query(
    `SELECT Station_ID, Station_City, Station_State
       FROM station
      WHERE Station_Lat IS NULL OR Station_Lng IS NULL`
  );

  let updated = 0;
  const fellBack = [];
  const unknown = [];

  for (const s of stations) {
    let base = CITY_COORDS[s.Station_City];
    if (!base) {
      base = STATE_COORDS[String(s.Station_State).toUpperCase()];
      if (base) fellBack.push(`${s.Station_City}, ${s.Station_State}`);
    }
    if (!base) {
      unknown.push(`${s.Station_City}, ${s.Station_State}`);
      continue;
    }

    // Deterministic scatter: roughly +/- 5 km, derived from the id so the same
    // station always lands on the same spot.
    const jitterLat = ((s.Station_ID * 37) % 100 - 50) / 1000;
    const jitterLng = ((s.Station_ID * 53) % 100 - 50) / 1000;

    await conn.query(
      `UPDATE station SET Station_Lat = ?, Station_Lng = ? WHERE Station_ID = ?`,
      [
        Number((base[0] + jitterLat).toFixed(6)),
        Number((base[1] + jitterLng).toFixed(6)),
        s.Station_ID,
      ]
    );
    updated++;
  }

  // Say so loudly rather than leaving a silently-wrong pin on the map.
  if (fellBack.length) {
    log(`⚠ ${fellBack.length} station(s) used a STATE centroid, not a city:`);
    for (const c of [...new Set(fellBack)]) log(`    ${c} — add it to CITY_COORDS`);
  }
  if (unknown.length) {
    log(`⚠ ${unknown.length} station(s) could not be geocoded at all:`);
    for (const c of [...new Set(unknown)]) log(`    ${c}`);
    log(`  photos taken there will not match a station.`);
  }

  return updated;
}

/**
 * Re-anchor membership subscriptions to the current date.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 * The seed data was authored for a fixed window (December 2025 to April 2026).
 * Wall-clock time keeps moving, the seed dates do not, so every membership in
 * the database eventually lapses. Once that happens the billing worker's
 * membership-discount branch stops being reachable at all: there is no active
 * subscription for any driver, so every session is billed at full price and a
 * whole feature quietly disappears from the demo.
 *
 * It is not enough to fix the dates by hand once, either. Teammates clone the
 * repository on different days, and the project is demonstrated weeks after it
 * is written. The data has to re-anchor itself whenever setup runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT PRODUCES
 * ─────────────────────────────────────────────────────────────────────────────
 * MEMBERSHIP prices are monthly, so each subscription becomes a 30-day term.
 * Rather than making every membership active — which would look synthetic and
 * would leave nothing to demonstrate the Expired and Pending states — the mix
 * is deliberately realistic:
 *
 *     ~70%  active   started in the last 30 days
 *     ~20%  expired  lapsed weeks ago and not renewed
 *     ~10%  pending  starts in the next fortnight
 *
 * Placement is derived from Subscription_ID rather than randomness, so every
 * machine that runs setup gets the same distribution and a demo recorded twice
 * shows the same numbers.
 *
 * Cancelled subscriptions are left untouched: cancellation is a decision a
 * customer made, not a date that drifted.
 */
async function rebaseSubscriptions(conn) {
  const [[counts]] = await conn.query(
    `SELECT COUNT(*) AS total,
            SUM(Status = 'Active')    AS active,
            SUM(Status <> 'Cancelled') AS renewable
       FROM subscription`
  );
  const total = Number(counts.total) || 0;
  const renewable = Number(counts.renewable) || 0;
  const activeNow = Number(counts.active) || 0;
  if (total === 0) return { skipped: true, total: 0, active: 0 };

  // Only rebase when memberships have actually gone stale. A database that is
  // already healthy is left alone, so re-running setup does not reshuffle
  // subscriptions underneath a demo that is already recorded.
  if (renewable > 0 && activeNow / renewable >= 0.25) {
    return { skipped: true, total, active: activeNow };
  }

  const [rows] = await conn.query(
    `SELECT Subscription_ID FROM subscription
      WHERE Status <> 'Cancelled' ORDER BY Subscription_ID`
  );

  let updated = 0;
  let active = 0;
  let expired = 0;
  let pending = 0;

  for (const { Subscription_ID: id } of rows) {
    // Deterministic bucket: same id always lands in the same state.
    const bucket = id % 10;
    let startOffsetDays;
    let status;

    if (bucket < 7) {
      // Active: started somewhere in the last 29 days, so it is mid-term.
      startOffsetDays = -(1 + ((id * 3) % 29));
      status = "Active";
      active++;
    } else if (bucket < 9) {
      // Expired: a term that ended between roughly 1 and 5 months ago.
      startOffsetDays = -(60 + ((id * 7) % 100));
      status = "Expired";
      expired++;
    } else {
      // Pending: signed up, starts within the next fortnight.
      startOffsetDays = 1 + ((id * 5) % 14);
      status = "Pending";
      pending++;
    }

    await conn.query(
      `UPDATE subscription
          SET Start_Date = DATE_ADD(CURDATE(), INTERVAL ? DAY),
              End_Date   = DATE_ADD(DATE_ADD(CURDATE(), INTERVAL ? DAY), INTERVAL 30 DAY),
              Status     = ?
        WHERE Subscription_ID = ?`,
      [startOffsetDays, startOffsetDays, status, id]
    );
    updated++;
  }

  return { skipped: false, total, updated, active, expired, pending };
}

/**
 * Repair inconsistencies that ship inside the seed data itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS BELONGS IN SETUP
 * ─────────────────────────────────────────────────────────────────────────────
 * `npm run data:repair` fixes these too, but it is an operator tool that
 * somebody has to remember to run. A teammate who clones the repository and
 * follows the README would never run it, and would be looking at a database
 * that contradicts itself from the first minute. Anything the seeded data gets
 * wrong should be corrected while the database is being built, not left as
 * homework.
 *
 * Both problems below are in the original course seed data, not in anything the
 * application did.
 */
async function fixSeedInconsistencies(conn) {
  const out = [];

  // ── Sessions billed for more energy than a battery can hold ───────────────
  // The seed rows carry pre-computed Energy_Consumed values, some of which
  // exceed any real pack. Recompute from the charging model and scale the cost
  // by the same factor, which preserves whatever rate applied to that session.
  // Two independent ceilings, and the seed data violates both.
  //
  //   the battery   — no session can deliver more than a pack can hold
  //   the charger   — no session can deliver more than power x time
  //
  // Only capping at the battery left 318 sessions where a 9.6 kW charger had
  // supposedly delivered 17 kWh in 74 minutes. Energy and duration in the seed
  // file were generated independently of each other, so they have to be
  // reconciled against the equipment, not just against a global maximum.
  const [overCap] = await conn.query(
    `SELECT cs.Session_ID, cs.Energy_Consumed, cs.Total_Cost,
            c.Charger_Power_Capacity AS kw,
            TIMESTAMPDIFF(SECOND, cs.Start_Time, cs.End_Time) / 3600 AS hours
       FROM charging_session cs
       JOIN charger c ON c.Charger_ID = cs.Charger_ID
      WHERE cs.End_Time IS NOT NULL
        AND cs.Energy_Consumed IS NOT NULL
        AND TIMESTAMPDIFF(SECOND, cs.Start_Time, cs.End_Time) > 60
        AND (
          cs.Energy_Consumed > ?
          OR cs.Energy_Consumed >
             c.Charger_Power_Capacity * (TIMESTAMPDIFF(SECOND, cs.Start_Time, cs.End_Time) / 3600)
        )`,
    [MAX_SESSION_KWH]
  );

  for (const row of overCap) {
    const corrected = energyDeliveredKwh(row.kw, Number(row.hours) || 0);
    const oldEnergy = Number(row.Energy_Consumed);
    if (!(oldEnergy > 0) || !(corrected > 0)) continue;
    const factor = corrected / oldEnergy;
    const newCost = Number((Number(row.Total_Cost ?? 0) * factor).toFixed(2));

    await conn.query(
      `UPDATE charging_session SET Energy_Consumed = ?, Total_Cost = ? WHERE Session_ID = ?`,
      [corrected, newCost, row.Session_ID]
    );
    await conn.query(
      `UPDATE payment SET Payment_Amount = ? WHERE Session_ID = ? AND Payment_Type = 'Charging'`,
      [newCost, row.Session_ID]
    );
  }
  if (overCap.length) {
    out.push(`re-costed ${overCap.length} session(s) billed above the ${MAX_SESSION_KWH} kWh battery limit`);
  }

  // ── Chargers out of service with nothing explaining why ───────────────────
  // The seed fleet marks chargers broken without raising a work order, so they
  // are invisible to the dispatch queue and can never be brought back. Opening
  // the missing ticket preserves the intent (these really are faulty) and
  // restores the rule the rest of the platform relies on: a charger is down
  // because a work order is open, and resolving it puts the charger back.
  // Technician_ID is NULL, and that is the whole correction.
  //
  // This query used to pick the nearest engineer and write them onto a row it
  // also marked 'Reported'. That made sense when it was written: Technician_ID
  // was NOT NULL, so every row had to name somebody, and 'Open' said nothing
  // about whether they had been told.
  //
  // The dispatch lifecycle changed what the column means. 'Reported' now says
  // exactly one thing — nobody has been assigned yet — so a name in that column
  // is a contradiction, and the interface showed it plainly: the same work order
  // appeared under "Awaiting dispatch · nobody is working on these" and, three
  // inches lower, under "Assigned to Valerie Moore".
  //
  // Choosing the engineer is the manager's job, made on the dispatch board with
  // the whole queue, everybody's workload and the distance to site in front of
  // them. Guessing it here and then hiding the guess behind a status that
  // denies it is worse than leaving it open.
  const [tickets] = await conn.query(
    `INSERT INTO maintenance_log
       (Charger_ID, Station_ID, Technician_ID, Issue_Reported, Resolved_Time, Status,
        Reported_At, Reported_By, Report_Source, Fault_Code, Severity, Priority)
     SELECT c.Charger_ID,
            c.Station_ID,
            NULL,
            'Charger reported out of service during commissioning. Awaiting on-site diagnosis.',
            NULL,
            'Reported',
            -- Spread over the last few days rather than stamped with one
            -- timestamp, so "oldest waiting" on the dispatch board means
            -- something and the queue does not look bulk-inserted.
            NOW() - INTERVAL (30 + (c.Charger_ID % 4000)) MINUTE,
            'commissioning',
            'inspection',
            'E-0001',
            'major',
            'normal'
       FROM charger c
      WHERE c.Charger_Availability_Status = 'Out of Service'
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_log m
           WHERE m.Charger_ID = c.Charger_ID
             AND m.Status IN ('Reported','Assigned','In Progress')
        )`
  );
  // A payment cannot settle a session that has not happened yet.
  //
  // 55 rows in the course seed carry a payment timestamped a month BEFORE the
  // session it pays for. That was invisible until now only because the activity
  // step used to drag those sessions into the recent window and move their
  // payments with them; once there is enough real history to make that
  // unnecessary, the original defect surfaces.
  //
  // Realigning the payment rather than the session is the conservative half:
  // the session's own start and end are internally consistent and are what the
  // energy figure was computed from, so the money is what moves.
  const [misdated] = await conn.query(
    `UPDATE payment p
       JOIN charging_session cs ON cs.Session_ID = p.Session_ID
        SET p.Created_Time = DATE_ADD(cs.End_Time, INTERVAL 1 MINUTE)
      WHERE cs.End_Time IS NOT NULL
        AND p.Created_Time < cs.Start_Time`
  );
  if (misdated.affectedRows) {
    out.push(`re-dated ${misdated.affectedRows} payment(s) that predated the session they settle`);
  }

  if (tickets.affectedRows) {
    out.push(`opened ${tickets.affectedRows} work order(s) for chargers that were down with no ticket`);
  }

  if (out.length === 0) out.push("nothing to correct");
  return out;
}

/**
 * Rename the in-progress charging session state from 'Pending' to 'Active'.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * In the inherited schema a session that is CURRENTLY DELIVERING POWER is
 * stored as 'Pending'. That word means "waiting", and a reader reasonably
 * assumes it describes a session that has not started — queued behind
 * something, awaiting approval, not yet begun. It is in fact the opposite: the
 * car is plugged in and charging right now.
 *
 * The confusion is not academic. On the sessions screen these rows show 0 kWh
 * and $0.00, because energy and cost are not known until the session ends. A
 * row labelled "Pending" with no energy and no cost reads as a session that
 * never happened, when it is the most active thing in the system.
 *
 * 'Active' says what is true. The lifecycle now reads:
 *
 *     Active  ──▶ Completed     (driver unplugs, billing worker settles it)
 *             └─▶ Cancelled     (abandoned or voided)
 *
 * Note this is the CHARGING_SESSION status only. SUBSCRIPTION also has a
 * 'Pending' state and that one is correct — a subscription whose start date is
 * in the future genuinely has not begun — so it is deliberately left alone.
 *
 * Idempotent: it inspects the CHECK constraint first and does nothing once the
 * rename has been applied.
 */
async function renameSessionStatus(conn) {
  const [[check]] = await conn.query(
    `SELECT CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = 'chk_session_status'`,
    [DB_NAME]
  );

  if (check && /Active/i.test(check.clause)) {
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM charging_session WHERE Session_Status = 'Active'`
    );
    return [`already renamed — ${n} session(s) currently Active`];
  }

  const out = [];

  // The constraint has to go first: while it still lists only
  // ('Pending','Completed','Cancelled'), writing 'Active' would be rejected.
  if (check) {
    await conn.query(`ALTER TABLE charging_session DROP CHECK chk_session_status`);
    out.push("dropped old chk_session_status");
  }

  const [res] = await conn.query(
    `UPDATE charging_session SET Session_Status = 'Active' WHERE Session_Status = 'Pending'`
  );
  out.push(`renamed ${res.affectedRows} in-progress session(s): Pending → Active`);

  await conn.query(
    `ALTER TABLE charging_session
       ADD CONSTRAINT chk_session_status
       CHECK (Session_Status IN ('Active', 'Completed', 'Cancelled'))`
  );
  out.push("constraint now allows Active / Completed / Cancelled");
  out.push("(subscription.Status keeps its own 'Pending' — that one is correct)");

  return out;
}

/**
 * Run the activity shaper as a child step of setup.
 *
 * Kept as its own script rather than inlined here because it also needs to be
 * runnable on its own: a load test writes thousands of sessions into whatever
 * hour it happened to run in, and re-running `npm run seed:activity` afterwards
 * restores a believable picture without rebuilding the database.
 */
async function shapeActivity() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  // Line splitting uses String.fromCharCode(10) rather than an escape so this
  // block survives being edited by tooling that rewrites escape sequences.
  const LF = String.fromCharCode(10);
  try {
    const { stdout } = await run(
      process.execPath,
      [path.join(ROOT, "scripts", "seed-activity.mjs")],
      { cwd: ROOT }
    );
    return stdout
      .split(LF)
      .map((l) => l.trim())
      .filter((l) =>
        /^(history|live|chargers in use|sessions in progress|days with activity)/.test(l)
      );
  } catch (err) {
    return [`skipped (${String(err.message).split(LF)[0]})`];
  }
}

/**
 * Store the highest seeded row ids, so later checks can tell seeded history
 * apart from data the application produced.
 *
 * Written only once. Re-running setup must not move the watermark, or rows the
 * application created since would be reclassified as seed data.
 */
async function recordSeedWatermark(conn) {
  const [[existing]] = await conn.query(
    `SELECT Meta_Value AS v FROM app_meta WHERE Meta_Key = 'seed_max_session_id'`
  );
  if (existing) return;

  const [[sess]] = await conn.query(`SELECT IFNULL(MAX(Session_ID),0) AS v FROM charging_session`);
  const [[pay]]  = await conn.query(`SELECT IFNULL(MAX(Payment_ID),0) AS v FROM payment`);

  await conn.query(
    `INSERT INTO app_meta (Meta_Key, Meta_Value) VALUES ('seed_max_session_id', ?), ('seed_max_payment_id', ?)
       ON DUPLICATE KEY UPDATE Meta_Value = VALUES(Meta_Value)`,
    [String(sess.v), String(pay.v)]
  );
  log(`seed watermark recorded: sessions ≤ ${sess.v}, payments ≤ ${pay.v}`);
}

/**
 * Turn maintenance_log from a record of what happened into a work-order
 * workflow the operations team actually drives.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 * Technician_ID was NOT NULL, so a work order could not exist without already
 * being assigned to somebody. That single constraint removed the central action
 * of the whole application: a fault is reported, a manager looks at it, and a
 * manager decides who goes. With no unassigned state there is no dispatch queue
 * and no dispatch decision — the screen can only ever be a table of rows that
 * arrived pre-solved.
 *
 * The table also recorded no time of report, no source and no fault code, so
 * "what came in today, from where, and how bad is it" was unanswerable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIFECYCLE NOW
 * ─────────────────────────────────────────────────────────────────────────────
 *   Reported    raised by telemetry, a technician, or a manager. NO technician.
 *      │        This is the operations manager's inbox.
 *      ├──▶ Rejected      manager judged it not a real fault
 *      ▼
 *   Assigned    manager dispatched a specific technician
 *      ▼
 *   In Progress technician is on site
 *      ▼
 *   Resolved    fixed; the charger returns to service
 *
 * Existing rows are mapped rather than discarded: an old 'Open' row with a
 * technician becomes Assigned, one without becomes Reported.
 */
async function upgradeWorkOrders(conn) {
  const out = [];

  const columns = [
    ["Reported_At", "DATETIME NULL"],
    ["Reported_By", "VARCHAR(64) NULL"],
    ["Report_Source", "VARCHAR(20) NULL"],
    ["Fault_Code", "VARCHAR(40) NULL"],
    ["Severity", "VARCHAR(20) NULL"],
    ["Priority", "VARCHAR(20) NULL"],
    ["Assigned_At", "DATETIME NULL"],
    ["Assigned_By", "VARCHAR(64) NULL"],
    ["Started_At", "DATETIME NULL"],
    ["Resolution_Notes", "TEXT NULL"],
  ];
  const added = [];
  for (const [name, type] of columns) {
    if (!(await columnExists(conn, "maintenance_log", name))) {
      await conn.query(`ALTER TABLE maintenance_log ADD COLUMN ${name} ${type}`);
      added.push(name);
    }
  }
  if (added.length) out.push(`added ${added.length} workflow column(s)`);

  // The change that makes dispatch possible at all.
  const [[tech]] = await conn.query(
    `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='maintenance_log'
        AND COLUMN_NAME='Technician_ID'`
  );
  if (tech && tech.n === "NO") {
    // The seed data has a foreign key on this column; MODIFY keeps it.
    await conn.query(`ALTER TABLE maintenance_log MODIFY COLUMN Technician_ID INT NULL`);
    out.push("Technician_ID is now nullable — work orders can be unassigned");
  }

  // Backfill provenance for rows that predate these columns.
  const [backfill] = await conn.query(
    `UPDATE maintenance_log
        SET Reported_At   = COALESCE(Reported_At, COALESCE(Resolved_Time, NOW())),
            Reported_By   = COALESCE(Reported_By, 'seed'),
            Report_Source = COALESCE(Report_Source, 'inspection'),
            Severity      = COALESCE(Severity, 'major'),
            Priority      = COALESCE(Priority, 'normal'),
            Assigned_At   = COALESCE(Assigned_At, CASE WHEN Technician_ID IS NOT NULL THEN Reported_At END)
      WHERE Reported_At IS NULL OR Reported_By IS NULL OR Severity IS NULL`
  );
  if (backfill.affectedRows) out.push(`backfilled provenance on ${backfill.affectedRows} historical work order(s)`);

  // ── One open work order per charger, enforced by the database ────────────
  //
  // The API already checked for an existing open work order before inserting.
  // A check is not a constraint: between the SELECT and the INSERT there is a
  // gap, and ten concurrent reports of the same dead charger walked straight
  // through it — two rows created, both critical, both open on the same unit.
  //
  // MySQL has no partial indexes, but it does have generated columns, and a
  // unique index ignores NULLs. So the column carries the charger id only
  // while the work order is open and NULL once it is closed: every open row
  // competes for one slot per charger, and any number of closed rows coexist.
  //
  // This is the difference between "we try not to" and "it cannot happen".
  if (!(await columnExists(conn, "maintenance_log", "Open_Charger_ID"))) {
    // Existing duplicates have to go first or the index will not build. The
    // oldest open work order for each charger is the real one — it is the
    // report people have been working from — so the later ones are rejected
    // rather than deleted. Losing the audit trail to add a constraint would be
    // a poor trade.
    const [dupes] = await conn.query(
      `UPDATE maintenance_log m
         JOIN (
           SELECT Charger_ID, MIN(Maintenance_ID) AS keep_id
             FROM maintenance_log
            WHERE Status IN ('Reported','Assigned','In Progress')
            GROUP BY Charger_ID
           HAVING COUNT(*) > 1
         ) d ON d.Charger_ID = m.Charger_ID
          SET m.Status = 'Rejected',
              m.Resolution_Notes = CONCAT_WS(' ', m.Resolution_Notes,
                '[auto] duplicate of work order ', d.keep_id)
        WHERE m.Status IN ('Reported','Assigned','In Progress')
          AND m.Maintenance_ID <> d.keep_id`
    );
    if (dupes.affectedRows) {
      out.push(`closed ${dupes.affectedRows} duplicate open work order(s) before indexing`);
    }

    await conn.query(
      `ALTER TABLE maintenance_log
         ADD COLUMN Open_Charger_ID INT
           GENERATED ALWAYS AS (
             CASE WHEN Status IN ('Reported','Assigned','In Progress')
                  THEN Charger_ID END
           ) STORED,
         ADD UNIQUE KEY uq_open_work_order_per_charger (Open_Charger_ID)`
    );
    out.push("one open work order per charger is now a database constraint");
  }

  // Map the old three states onto the new lifecycle.
  const [[chk]] = await conn.query(
    `SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_maintenance_status'`
  );
  if (!chk || !/Reported/i.test(chk.c)) {
    if (chk) await conn.query(`ALTER TABLE maintenance_log DROP CHECK chk_maintenance_status`);

    const [toReported] = await conn.query(
      `UPDATE maintenance_log SET Status='Reported' WHERE Status='Open' AND Technician_ID IS NULL`
    );
    const [toAssigned] = await conn.query(
      `UPDATE maintenance_log SET Status='Assigned' WHERE Status='Open' AND Technician_ID IS NOT NULL`
    );

    await conn.query(
      `ALTER TABLE maintenance_log ADD CONSTRAINT chk_maintenance_status
         CHECK (Status IN ('Reported','Assigned','In Progress','Resolved','Rejected'))`
    );
    out.push(
      `lifecycle migrated: ${toReported.affectedRows} → Reported, ${toAssigned.affectedRows} → Assigned`
    );
  }

  if (out.length === 0) out.push("already up to date");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// shapeWorkOrderHistory — make the operational screens mean something
// ─────────────────────────────────────────────────────────────────────────────
//
// The seed data was written for a database assignment, where a maintenance row
// only had to exist. Three of the five role home screens read it as an
// operational record, and as imported it says nothing:
//
//   • Every resolved work order has Reported_At equal to Resolved_Time, so
//     mean time to repair is exactly zero. A repair that took no time did not
//     happen.
//   • 1,788 of 1,793 rows carry no fault code, so "what is breaking" is one bar
//     labelled `unspecified` — true, and useless. Codes are what let a cluster
//     across many sites be recognised as one firmware bug rather than nine
//     unrelated visits.
//   • Nothing sits in the `Reported` state, so the dispatch queue a manager
//     signs in to work is empty on a fresh install.
//   • No billing request is pending, so finance signs in to an empty inbox.
//
// Everything below is derived arithmetically from Maintenance_ID and the
// existing issue text — never from a random number. Two teammates running setup
// on two machines must land on identical data, which a random seed would
// quietly break, and which is the whole reason the doctor script can assert
// exact counts.
//
// Each part is guarded so re-running setup does not compound its own effect.
async function shapeWorkOrderHistory(conn) {
  const out = [];

  // ── Rebase the history onto today ──────────────────────────────────
  //
  // The seed writes maintenance history against fixed calendar dates, and those
  // dates are now months in the past. Sessions were already rebased onto today
  // by the activity step; maintenance was not, which left a six-month hole
  // immediately behind "now".
  //
  // Every operational figure on the manager dashboard is windowed — mean time
  // to repair over 30 days, fault codes and problem sites over 90 — so a
  // history that stops six months ago makes all of them read as empty on a
  // fresh install. Not wrong, exactly: the database really does say nothing has
  // broken since March. It is simply the wrong question answered correctly.
  //
  // So the whole history is slid forward as one block, which preserves the
  // relative spacing between every report and its repair. The newest one lands
  // yesterday rather than today, because a work order resolved in the future is
  // the kind of thing the doctor script exists to catch.
  const [[bulk]] = await conn.query(
    `SELECT MAX(Resolved_Time) AS newest FROM maintenance_log WHERE Reported_By = 'seed' AND Status = 'Resolved'`
  );
  if (bulk.newest) {
    const [[{ gap }]] = await conn.query(
      `SELECT DATEDIFF(CURDATE(), DATE(?)) - 1 AS gap`, [bulk.newest]
    );
    // A few days of drift is what you get from running setup twice in a week
    // and is not worth shifting for; a month means the seed has gone stale.
    if (Number(gap) > 30) {
      const [moved] = await conn.query(
        `UPDATE maintenance_log
            SET Resolved_Time = Resolved_Time + INTERVAL ? DAY,
                Reported_At   = Reported_At   + INTERVAL ? DAY,
                Assigned_At   = Assigned_At   + INTERVAL ? DAY,
                Started_At    = Started_At    + INTERVAL ? DAY
          -- Only closed history moves. An OPEN work order describes now, not
          -- the past: sliding its report date forward would put a job that is
          -- currently on somebody's list five months into the future.
          WHERE Reported_By = 'seed' AND Status = 'Resolved'`,
        [gap, gap, gap, gap]
      );
      out.push(`rebased ${moved.affectedRows} historical work order(s) forward by ${gap} days`);
    }
  }

  // ── Fault codes, derived from the issue text ────────────────────────────
  //
  // The seed writes nine fixed phrases, so this mapping is exact rather than a
  // guess. Severity travels with the code: a split cable is critical, a noisy
  // fan is not, and treating them alike is what makes a queue impossible to
  // work through in a sensible order.
  const CODES = [
    ["Power module temperature%",         "E-2210", "major"],
    ["Charging cable insulation%",        "E-1180", "critical"],
    ["Output power lower%",               "E-2044", "major"],
    ["Touchscreen becomes unresponsive%", "E-3301", "minor"],
    ["Connector latch not engaging%",     "E-4021", "critical"],
    ["Cooling fan noise%",                "E-2115", "minor"],
    ["Card reader intermittently%",       "E-0512", "major"],
    ["Network communication drops%",      "E-0904", "major"],
    ["Routine preventive maintenance%",   "PM-001", "minor"],
    ["Charger reported out of service%",  "E-0001", "major"],
  ];
  let coded = 0;
  for (const [pattern, code, severity] of CODES) {
    const [r] = await conn.query(
      `UPDATE maintenance_log
          SET Fault_Code = ?, Severity = ?
        WHERE Issue_Reported LIKE ?
          AND (Fault_Code IS NULL OR Fault_Code = '')`,
      [code, severity, pattern]
    );
    coded += r.affectedRows;
  }

  // A handful of rows created by hand carry "E-4021 CONNECTOR_LOCK_FAILURE" —
  // a code and a description crammed into one column. Grouping by that produces
  // one bucket per phrasing, which is exactly what a code exists to prevent, so
  // keep the code and drop the prose. The description is already in
  // Issue_Reported.
  const [split] = await conn.query(
    `UPDATE maintenance_log
        SET Fault_Code = SUBSTRING_INDEX(Fault_Code, ' ', 1)
      WHERE Fault_Code LIKE '% %'`
  );
  // Anything the nine phrases did not match gets the honest label rather than a
  // NULL. See the note in POST /api/maintenance: "no diagnostic code at all" is
  // a countable fact, and NULL is not.
  const [uncoded] = await conn.query(
    `UPDATE maintenance_log SET Fault_Code = 'UNCODED'
      WHERE Fault_Code IS NULL OR Fault_Code = ''`
  );
  if (coded || split.affectedRows || uncoded.affectedRows) {
    out.push(
      `fault codes: ${coded} classified, ${split.affectedRows} normalised, ` +
        `${uncoded.affectedRows} marked UNCODED`
    );
  }

  // ── Repair durations ────────────────────────────────────────────────────
  //
  // Reported_At is moved BACK from Resolved_Time rather than the resolution
  // being pushed forward, so the history keeps the dates it already had and
  // only gains a duration. How long depends on severity, because that is what a
  // real response policy looks like: a critical fault gets somebody the same
  // day, a noisy fan waits for the next scheduled visit.
  //
  // The spread comes from Maintenance_ID, so it is identical on every machine.
  const [durations] = await conn.query(
    `UPDATE maintenance_log
        SET Reported_At = Resolved_Time - INTERVAL (
              CASE Severity
                WHEN 'critical' THEN 2  + (Maintenance_ID % 7)
                WHEN 'minor'    THEN 24 + (Maintenance_ID % 72)
                ELSE                 6  + (Maintenance_ID % 30)
              END
            ) HOUR
      WHERE Status = 'Resolved'
        AND Resolved_Time IS NOT NULL
        AND Reported_At = Resolved_Time`
  );
  if (durations.affectedRows) {
    out.push(`gave ${durations.affectedRows} closed work order(s) a plausible repair duration`);
  }

  // ── An inbox for the dispatcher ─────────────────────────────────────────
  //
  // Every work order arrived pre-assigned, which is the state AFTER a manager
  // has done their job. Returning a third of them to `Reported` gives the
  // dispatch board something to dispatch, and gives the manager dashboard a
  // queue depth that is not zero.
  //
  // Guarded on the queue being empty, so re-running setup against a database
  // somebody has been working in does not unassign a technician mid-job.
  const [[{ waiting }]] = await conn.query(
    `SELECT COUNT(*) AS waiting FROM maintenance_log WHERE Status = 'Reported'`
  );
  if (waiting === 0) {
    const [freed] = await conn.query(
      `UPDATE maintenance_log
          SET Status = 'Reported',
              Technician_ID = NULL,
              Assigned_At = NULL,
              Assigned_By = NULL,
              Reported_At = NOW() - INTERVAL (25 + (Maintenance_ID % 600)) MINUTE
        WHERE Status = 'Assigned'
          AND Maintenance_ID % 3 = 0`
    );
    if (freed.affectedRows) {
      out.push(`${freed.affectedRows} work order(s) returned to the dispatch queue`);
    }
  } else {
    out.push(`dispatch queue already holds ${waiting} item(s) — left alone`);
  }

  // ── An inbox for finance ────────────────────────────────────────────────
  //
  // Four requests, one of each kind the approval flow understands, so the queue
  // exercises every branch: a membership that activates a subscription, a
  // renewal, a wallet credit, and a refund tied to a session that really exists
  // and really belongs to that driver — the API checks both, and rightly.
  const [[{ pending }]] = await conn.query(
    `SELECT COUNT(*) AS pending FROM billing_request WHERE Status = 'Pending'`
  );
  if (pending === 0) {
    // Drivers chosen by position rather than by hard-coded id, so this still
    // works if the seed's user ids ever change.
    const [drivers] = await conn.query(`SELECT User_ID FROM user ORDER BY User_ID LIMIT 4`);
    const [[refundable]] = await conn.query(
      `SELECT Session_ID, User_ID, Total_Cost
         FROM charging_session
        WHERE Session_Status = 'Completed' AND Total_Cost > 5
        ORDER BY Session_ID DESC LIMIT 1`
    );
    const [plans] = await conn.query(`SELECT Plan_ID, Monthly_Price FROM membership ORDER BY Plan_ID`);
    const planFor = (id) => plans.find((p) => Number(p.Plan_ID) === id);

    // [userId, type, amount, planId, sessionId, reason, hoursWaited]
    const requests = [];
    if (drivers[0] && planFor(3)) {
      requests.push([drivers[0].User_ID, "subscription.new", planFor(3).Monthly_Price, 3, null,
        "Called the support line asking to move onto the Diamond plan.", 30]);
    }
    if (drivers[1] && planFor(2)) {
      requests.push([drivers[1].User_ID, "subscription.renew", planFor(2).Monthly_Price, 2, null,
        "Renewal for a plan that lapsed while their card was being replaced.", 8]);
    }
    if (drivers[2]) {
      requests.push([drivers[2].User_ID, "wallet.topup", 50.0, null, null,
        "Fleet driver topping up ahead of a long route.", 3]);
    }
    if (refundable) {
      requests.push([refundable.User_ID, "refund", refundable.Total_Cost, null, refundable.Session_ID,
        "Charger cut out partway through; driver billed for energy they never received.", 1]);
    }

    for (const [userId, type, amount, planId, sessionId, reason, hoursAgo] of requests) {
      await conn.query(
        `INSERT INTO billing_request
           (User_ID, Request_Type, Amount, Plan_ID, Session_ID, Status, Reason,
            Requested_At, Requested_By)
         VALUES (?, ?, ?, ?, ?, 'Pending', ?, NOW() - INTERVAL ? HOUR, 'ops')`,
        [userId, type, amount, planId, sessionId, reason, hoursAgo]
      );
    }
    if (requests.length) out.push(`${requests.length} request(s) waiting on a finance decision`);
  } else {
    out.push(`finance inbox already holds ${pending} item(s) — left alone`);
  }

  if (out.length === 0) out.push("already up to date");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSessionVolume — give the network a plausible amount of trade
// ─────────────────────────────────────────────────────────────────────────────
//
// The course seed carries about a thousand charging sessions. That was ample
// for a database assignment, where the questions are about joins. It is two
// orders of magnitude short of what 859 bays actually do, and the shortfall is
// not cosmetic — it silently breaks every figure derived from a RATE rather
// than a count:
//
//   • Utilisation came out at 0.1% for every site, because each bay was busy
//     2.5 minutes a day against a 1,440-minute day. Every row rounded to the
//     same number and the site-performance table compared nothing.
//   • Charging revenue came out BELOW membership revenue, which is backwards
//     for a charging network by roughly an order of magnitude. Memberships are
//     billed monthly per driver and did not depend on session volume; energy
//     sales did.
//
// Neither is fixable by presentation. A percentage of a number that is sixty
// times too small is an honest report of the wrong world.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS ALL ARITHMETIC
// ─────────────────────────────────────────────────────────────────────────────
// Every value below is derived from the charger id, the day offset and the
// session index — a hash, never Math.random(). Two teammates running setup on
// two machines have to land on identical data, because the doctor script
// asserts exact counts and because "it works differently on mine" is the one
// thing a shared demo cannot survive.
//
// The physics comes from server/lib/charging.js, the same module the API and
// the workers use, so a generated session cannot claim an energy figure the
// live path would reject.
const TARGET_SESSIONS_PER_BAY_PER_DAY = 2.4;

/** Deterministic 32-bit hash. Same inputs, same output, on every machine. */
function hash(...parts) {
  let h = 2166136261;
  for (const part of parts) {
    let x = Number(part) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= (x & 0xff);
      h = Math.imul(h, 16777619) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

/** A hash mapped into [0, 1). */
const unit = (...parts) => hash(...parts) / 4294967296;

async function buildSessionVolume(conn, { days, hourPicker }) {
  const [[fleet]] = await conn.query(`SELECT COUNT(*) AS bays FROM charger`);
  const bays = Number(fleet.bays) || 0;
  if (bays === 0) return ["no chargers — nothing to generate"];

  // Only top up. Re-running setup must not double the history, and a database
  // somebody has been working in keeps whatever it has.
  // The window here has to match the one the generator writes into, and that
  // is measured from MIDNIGHT, not from now.
  //
  // Counting with `NOW() - INTERVAL 21 DAY` excluded the oldest generated day
  // by a few hours, so the count came in just under the threshold and a second
  // `npm run setup:db` generated the whole 34,000 again — 70,000 sessions, and
  // half of them above the seed watermark where the invoice rule applies.
  // Re-running setup has to be a no-op, and an off-by-a-few-hours window is
  // exactly how it stops being one.
  const [[have]] = await conn.query(
    `SELECT COUNT(*) AS n FROM charging_session
      WHERE Session_Status = 'Completed' AND Start_Time > CURDATE() - INTERVAL ? DAY`,
    [days]
  );
  const target = Math.round(bays * days * TARGET_SESSIONS_PER_BAY_PER_DAY);
  if (Number(have.n) >= target * 0.8) {
    return [`${have.n} recent session(s) already — target ${target}, leaving alone`];
  }

  const [chargers] = await conn.query(
    `SELECT Charger_ID AS id, Charger_Power_Capacity AS kw, Charging_Rate_Per_kWh AS rate
       FROM charger ORDER BY Charger_ID`
  );
  const [drivers] = await conn.query(`SELECT User_ID AS id FROM user ORDER BY User_ID`);
  if (drivers.length === 0) return ["no drivers — nothing to generate"];

  const midnightToday = new Date();
  midnightToday.setHours(0, 0, 0, 0);
  const now = Date.now();

  const sessions = [];

  for (const charger of chargers) {
    const kw = Number(charger.kw) || 50;
    const rate = Number(charger.rate) || 0.35;
    const typical = typicalSessionMinutes(kw, 0.5);

    for (let dayOffset = days; dayOffset >= 1; dayOffset--) {
      // How many cars this bay saw that day. Weekends are quieter on a network
      // weighted toward commuting, and a bay that is popular stays popular —
      // both come out of the hash rather than being averaged away.
      const dayStart = new Date(midnightToday.getTime() - dayOffset * 86400000);
      const weekend = dayStart.getDay() === 0 || dayStart.getDay() === 6;
      const popularity = 0.55 + unit(charger.id, 7) * 0.9;      // site character
      const dayFactor = (weekend ? 0.62 : 1) * (0.8 + unit(charger.id, dayOffset) * 0.45);

      const expected = TARGET_SESSIONS_PER_BAY_PER_DAY * popularity * dayFactor;
      const whole = Math.floor(expected);
      // The fractional part becomes a chance of one more, so a bay averaging
      // 2.4 sessions gets 2 on some days and 3 on others rather than 2.4 every
      // day, which would show up as an implausibly flat daily curve.
      const count = whole + (unit(charger.id, dayOffset, 3) < expected - whole ? 1 : 0);
      if (count === 0) continue;

      // Draw arrival times from the demand curve, then walk forward so two
      // sessions on one bay can never overlap — a physical impossibility the
      // doctor would otherwise have to catch after the fact.
      const arrivals = [];
      for (let k = 0; k < count; k++) {
        const hour = hourPicker[hash(charger.id, dayOffset, k) % hourPicker.length];
        const minute = hash(charger.id, dayOffset, k, 11) % 60;
        const second = hash(charger.id, dayOffset, k, 13) % 60;
        arrivals.push(hour * 3600 + minute * 60 + second);
      }
      arrivals.sort((a, b) => a - b);

      let freeFrom = 0;
      for (let k = 0; k < arrivals.length; k++) {
        const startSec = Math.max(arrivals[k], freeFrom);
        // A session that would run past midnight is dropped rather than
        // truncated: a clipped duration is a wrong energy figure, and the day
        // is allowed to be quieter.
        const minutes = Math.max(
          8,
          Math.round(typical * (0.55 + unit(charger.id, dayOffset, k, 17) * 0.95))
        );
        const endSec = startSec + minutes * 60;
        if (endSec >= 86400) break;
        freeFrom = endSec + 300; // five minutes to unplug and pull away

        const startMs = dayStart.getTime() + startSec * 1000;
        const endMs = dayStart.getTime() + endSec * 1000;
        if (endMs > now) break; // never invent the future

        // Energy from the shared physics module, so a generated session cannot
        // claim something the live billing path would refuse.
        const kwh = Number(energyDeliveredKwh(kw, minutes / 60).toFixed(2));
        const cost = Number((kwh * rate).toFixed(2));
        if (kwh <= 0 || cost <= 0) continue;

        sessions.push([
          charger.id,
          drivers[hash(charger.id, dayOffset, k, 23) % drivers.length].id,
          new Date(startMs),
          new Date(endMs),
          kwh,
          rate,
          cost,
          "Completed",
        ]);
      }
    }
  }

  if (sessions.length === 0) return ["nothing to generate"];

  // Batched, because a single INSERT with 40,000 tuples exceeds
  // max_allowed_packet on a default MySQL install — which is the sort of thing
  // that works on the machine it was written on and fails on a teammate's.
  const BATCH = 1000;
  for (let i = 0; i < sessions.length; i += BATCH) {
    await conn.query(
      `INSERT INTO charging_session
         (Charger_ID, User_ID, Start_Time, End_Time, Energy_Consumed,
          Session_Rate_Per_kWh, Total_Cost, Session_Status)
       VALUES ?`,
      [sessions.slice(i, i + BATCH)]
    );
  }

  // ── Settle them ─────────────────────────────────────────────────────────
  //
  // Two paths, because at this point in setup the seed's original billing
  // triggers are still attached — they are dropped a few steps later. So a
  // payment row may already exist, created by the trigger and left `pending`
  // because the trigger that finalised it fires on UPDATE and these sessions
  // were inserted already complete.
  //
  // Getting this wrong is quiet and expensive: the sessions appear, utilisation
  // looks right, and charging revenue stays flat because 34,000 payments are
  // sitting in a state nothing counts.
  const [inserted] = await conn.query(
    `INSERT INTO payment (Session_ID, User_ID, Payment_Amount, Payment_Type,
                          Payment_Status, Created_Time)
     SELECT cs.Session_ID, cs.User_ID, cs.Total_Cost, 'Charging', 'success',
            DATE_ADD(cs.End_Time, INTERVAL 1 MINUTE)
       FROM charging_session cs
      WHERE cs.Session_Status = 'Completed'
        AND cs.Total_Cost > 0
        AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.Session_ID = cs.Session_ID)`
  );

  // A card declines now and then, and finance exists partly to chase what that
  // leaves behind. About one in seventy, chosen by session id so it is the same
  // seventy on every machine — enough for the uncollected tile to have
  // something real in it without making the network look broken.
  const [settled] = await conn.query(
    `UPDATE payment p
       JOIN charging_session cs ON cs.Session_ID = p.Session_ID
        SET p.Payment_Status = IF(p.Session_ID % 71 = 0, 'failed', 'success'),
            p.Payment_Amount = cs.Total_Cost,
            p.Created_Time   = DATE_ADD(cs.End_Time, INTERVAL 1 MINUTE)
      WHERE p.Payment_Type = 'Charging'
        AND p.Payment_Status = 'pending'
        AND cs.Session_Status = 'Completed'`
  );
  const paid = { affectedRows: inserted.affectedRows + settled.affectedRows };

  const perBayPerDay = (sessions.length / bays / days).toFixed(2);
  return [
    `generated ${sessions.length.toLocaleString()} session(s) across ${days} days ` +
      `(${perBayPerDay} per bay per day)`,
    `settled ${paid.affectedRows.toLocaleString()} of them into payments`,
  ];
}

/**
 * Rename the six companies from charging operators to property owners.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ORIGINAL NAMES BROKE THE STORY
 * ─────────────────────────────────────────────────────────────────────────────
 * The course seed named them ChargePoint America, Electrify Route, Tesla
 * Supercharge Network, Blink Mobility Power and EVgo Nationwide — five real,
 * mutually competing charge point operators. Recognisable brands, chosen to
 * make the data read as EV-ish, and harmless in a schema exercise about joins.
 *
 * They stop being harmless the moment the application does anything. This
 * platform shows one operations manager every site's revenue, dispatches one
 * technician pool across all of them, and lets that manager take any charger
 * out of service. No such platform can exist across Tesla and EVgo. Somebody
 * reading the demo notices within a minute, and what they conclude is that the
 * permission model is nonsense — when the permission model is the one part
 * that was right.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE COMPANY COLUMN ACTUALLY MEANS
 * ─────────────────────────────────────────────────────────────────────────────
 * ChargeOps is the charge point operator. It owns all 859 chargers. The chargers
 * stand in somebody else's car park, and that somebody — a mall, a hotel group,
 * a hospital, an airport — is the site host. They provide the land and take a
 * share of what the bays earn.
 *
 * That is the standard commercial arrangement in this industry, and it is what
 * every rule already in the code was written for:
 *
 *   a host sees their own sites          because they are the landlord
 *   a host never sees a driver           because drivers are ChargeOps' customers
 *   ChargeOps disables any charger       because ChargeOps owns the hardware
 *   one technician pool serves all       because they are ChargeOps' employees
 *   the host is paid a revenue share     because that is the lease term
 *
 * Nothing below this line changes except six strings. The model was right; the
 * names were describing a different one.
 *
 * Names are matched to where each company's sites actually are — a Pacific
 * Northwest retail group does not own a site in Miami.
 */
async function renameCompaniesToSiteHosts(conn) {
  const HOSTS = [
    [1, "Cascade Retail Group",        "Shopping centres across the Pacific Northwest and Midwest",
        "leasing@cascaderetail.com | +1-206-555-1001"],
    [2, "Harborview Hotels",           "Hotels in California, Florida, Michigan and Oregon",
        "facilities@harborviewhotels.com | +1-415-555-2044"],
    [3, "Sunbelt Medical Centers",     "Hospital campuses in California and Georgia",
        "estates@sunbeltmedical.org | +1-323-555-3300"],
    [4, "Metro Transit Authority",     "Park-and-ride lots in New York, New Jersey, Arizona and California",
        "property@metrotransit.gov | +1-212-555-4412"],
    [5, "Lone Star Logistics Parks",   "Distribution parks in Texas, Colorado, Utah and Pennsylvania",
        "sites@lonestarlogistics.com | +1-214-555-5520"],
    [6, "Greenway Office Campuses",    "Office parks in Texas, Massachusetts, Virginia and DC",
        "realestate@greenwaycampuses.com | +1-512-555-6102"],
  ];

  // Guarded on one of the old names, so a database whose companies have already
  // been renamed — or renamed again by hand — is left alone.
  const [[stale]] = await conn.query(
    `SELECT COUNT(*) AS n FROM company
      WHERE Company_Name IN ('ChargePoint America','Electrify Route',
                             'Tesla Supercharge Network','Blink Mobility Power',
                             'EVgo Nationwide','GreenGrid Energy')`
  );
  if (Number(stale.n) === 0) return ["already named as site hosts"];

  const hasDescription = await columnExists(conn, "company", "Company_Description");
  if (!hasDescription) {
    await conn.query(`ALTER TABLE company ADD COLUMN Company_Description VARCHAR(255) NULL`);
  }

  for (const [id, name, description, contact] of HOSTS) {
    await conn.query(
      `UPDATE company
          SET Company_Name = ?, Company_Description = ?, Company_Contact_Info = ?
        WHERE Company_ID = ?`,
      [name, description, contact, id]
    );
  }
  return [`renamed ${HOSTS.length} companies to the property owners that host the chargers`];
}


main().catch((err) => {
  console.error("\n✖ setup failed:", err.message);
  process.exit(1);
});
