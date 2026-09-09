// Manage and manually run the MySQL Event-backed daily platform simulator.
//
//   node scripts/simulator.mjs run [--date YYYY-MM-DD]
//   node scripts/simulator.mjs status
//   node scripts/simulator.mjs enable
//   node scripts/simulator.mjs disable
import mysql from "mysql2/promise";
import "../server/env.js";

const command = process.argv[2] || "status";
const args = process.argv.slice(3);

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The day before today, in the server's own timezone. */
function previousLocalDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`invalid date ${JSON.stringify(value)}; expected YYYY-MM-DD`);
  }
}

async function showStatus(conn) {
  const [[event]] = await conn.query(`
    SELECT EVENT_NAME AS name, STATUS AS status, STARTS AS starts,
           LAST_EXECUTED AS last_executed, INTERVAL_VALUE AS every_value,
           INTERVAL_FIELD AS every_unit
      FROM information_schema.EVENTS
     WHERE EVENT_SCHEMA = DATABASE()
       AND EVENT_NAME = 'evt_chargeops_daily_simulation'
  `);
  const [runs] = await conn.query(`
    SELECT Run_ID AS run_id, Run_Date AS run_date, Status AS status, Source AS source,
           Session_Count AS sessions, Situation_Count AS situations,
           Resolved_Count AS resolved, Job_ID AS job_id,
           Started_At AS started_at, Completed_At AS completed_at
      FROM simulation_run
     ORDER BY Run_Date DESC
     LIMIT 10
  `);
  console.log("Event:", event ?? "not installed; run npm run setup:db");
  console.table(runs);
}

async function runDay(conn) {
  // Yesterday by default, matching the MySQL event.
  //
  // Simulating "today" at two in the afternoon means inventing the evening,
  // and a day that has not finished cannot be summarised. The event has always
  // run for the previous day; the manual command defaulting to today was the
  // odd one out, and it was the one people actually run.
  const date = argValue("--date") || previousLocalDate();
  assertDate(date);
  await conn.query(`CALL sp_enqueue_daily_simulation(?, 'manual')`, [date]);
  const [[run]] = await conn.query(`
    SELECT Run_ID, Run_Date, Status, Job_ID, Session_Count, Situation_Count, Resolved_Count
      FROM simulation_run WHERE Run_Date = ?
  `, [date]);
  if (!run) throw new Error(`simulation run for ${date} was not created`);

  if (run.Status === "completed") {
    console.log(`Simulation ${date} was already completed; no duplicate data was created.`);
    console.table([run]);
    return;
  }

  console.log(`Enqueued simulation ${date} as job ${run.Job_ID}. Waiting for a worker...`);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const [[latest]] = await conn.query(`
      SELECT sr.Run_ID, sr.Run_Date, sr.Status, sr.Job_ID,
             sr.Session_Count, sr.Situation_Count, sr.Resolved_Count,
             jq.Status AS Job_Status, jq.Last_Error
        FROM simulation_run sr
        LEFT JOIN job_queue jq ON jq.Job_ID = sr.Job_ID
       WHERE sr.Run_ID = ?
    `, [run.Run_ID]);
    if (latest.Status === "completed") {
      console.log("Simulation completed. Billing and invoice child jobs will drain asynchronously.");
      console.table([latest]);
      return;
    }
    if (latest.Job_Status === "dead") {
      throw new Error(`simulation job dead-lettered: ${latest.Last_Error || "unknown error"}`);
    }
  }
  console.log("The run is still queued. Start the worker with `npm run dev:workers`, then check `npm run simulate:status`.");
}

async function main() {
  const conn = await mysql.createConnection(config);
  try {
    if (command === "run") {
      await runDay(conn);
    } else if (command === "status") {
      await showStatus(conn);
    } else if (command === "enable") {
      await conn.query(`SET GLOBAL event_scheduler = ON`);
      await conn.query(`ALTER EVENT evt_chargeops_daily_simulation ENABLE`);
      console.log("Daily simulator enabled.");
      await showStatus(conn);
    } else if (command === "disable") {
      await conn.query(`ALTER EVENT evt_chargeops_daily_simulation DISABLE`);
      console.log("Daily simulator disabled. Existing generated data is unchanged.");
      await showStatus(conn);
    } else {
      throw new Error(`unknown command ${JSON.stringify(command)}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Simulator command failed: ${err.message}`);
  process.exitCode = 1;
});
