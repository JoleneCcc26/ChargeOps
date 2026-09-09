// scripts/seed-activity.mjs - make the database look like a network that is running
//
//   npm run seed:activity          apply
//   npm run seed:activity -- --dry report what would change, touch nothing
//
// ═════════════════════════════════════════════════════════════════════════════
// THE PROBLEM
// ═════════════════════════════════════════════════════════════════════════════
// A charging network is never idle. At any moment some chargers are mid-session,
// yesterday looked much like today, and demand rises and falls with commuting
// hours. A database that does not look like that is immediately unconvincing:
// open the Chargers page, filter to "In Use", and if the answer is zero the
// whole platform reads as a set of empty tables.
//
// Two things produced exactly that:
//
//   1. Nothing was ever left running. The load generator opens sessions and
//      closes every one of them, so the moment it finishes there are no open
//      sessions and therefore no charger is in use.
//
//   2. History arrived in lumps. Thousands of sessions were written within one
//      or two clock hours, because that is when the load test ran — not because
//      that is when people charge. Any chart over time shows two spikes and
//      nothing else.
//
// A load generator is a performance tool; it was never meant to double as the
// business history. This script is what produces the operating picture.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT DOES
// ═════════════════════════════════════════════════════════════════════════════
//   A. Spreads recent bulk-written sessions back across the past few weeks,
//      following a realistic daily demand curve, and moves their payments with
//      them so the money still lines up with the session.
//
//   B. Opens a live front: a realistic share of chargers are put mid-session
//      with genuinely open session rows, staggered over the last two hours.
//      These are real Active sessions, so the operations manager can stop one
//      on camera and watch billing run.
//
// Everything is derived from row identifiers rather than randomness, so every
// teammate's database looks the same and a demo recorded twice shows the same
// numbers.
import mysql from "mysql2/promise";
import "../server/env.js";
import {
  typicalSessionMinutes,
  maxPlausibleSessionMinutes,
} from "../server/lib/charging.js";

const DRY = process.argv.includes("--dry");
const argNum = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};

/** Share of usable chargers that should be mid-session right now. */
const LIVE_FRACTION = argNum("--live-fraction", 0.18);

/** How far back bulk history is spread. */
const HISTORY_DAYS = argNum("--history-days", 21);

/**
 * Relative demand by hour of day.
 *
 * Two peaks, because that is how public charging behaves: a morning commute
 * bump and a much larger evening one when people plug in after work. Overnight
 * is not zero — some drivers charge while they sleep — just thin.
 */
const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, // 00-05
  4, 7, 9, 8, 6, 5, // 06-11
  6, 5, 5, 6, 8, 10, // 12-17
  10, 9, 7, 5, 4, 3, // 18-23
];

const HOUR_PICKER = HOUR_WEIGHTS.flatMap((w, hour) => Array(w).fill(hour));

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

const log = (msg) => console.log(`  ${msg}`);

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const conn = await mysql.createConnection(config);
  try {
    console.log(`\nChargeOps activity shaping${DRY ? "  (dry run)" : ""}\n`);

    const spread = await spreadBulkHistory(conn);
    const recent = await ensureRecentHistory(conn);
    await reconcileChargerState(conn);
    const live = await openLiveFront(conn);

    console.log(`\n${DRY ? "Would apply" : "Applied"}:`);
    log(`history  : ${spread.moved + recent.moved} session(s) placed across ${HISTORY_DAYS} days`);
    log(`live     : ${live.opened} session(s) opened, ${live.alreadyOpen} already running`);

    if (!DRY) {
      const [[now]] = await conn.query(
        `SELECT (SELECT COUNT(*) FROM charger WHERE Charger_Availability_Status = 'In Use') AS in_use,
                (SELECT COUNT(*) FROM charging_session
                  WHERE Session_Status = 'Active' AND End_Time IS NULL) AS open_sessions,
                (SELECT COUNT(DISTINCT DATE(Start_Time)) FROM charging_session
                  WHERE Start_Time > NOW() - INTERVAL ${HISTORY_DAYS} DAY) AS active_days`
      );
      console.log(`\nOperating picture now:`);
      log(`chargers in use     : ${now.in_use}`);
      log(`sessions in progress: ${now.open_sessions}`);
      log(`days with activity  : ${now.active_days}`);
    }
    console.log();
  } finally {
    await conn.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Spread bulk-written history over a believable calendar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find hours holding an implausible number of session starts and redistribute
 * them.
 *
 * The threshold matters: a busy network really does start a few dozen sessions
 * in an hour, so only genuinely bulk hours are touched. Anything written by the
 * daily simulator or by hand is well under the limit and is left alone.
 */
async function spreadBulkHistory(conn) {
  const BULK_HOUR_THRESHOLD = argNum("--bulk-threshold", 120);

  const [lumps] = await conn.query(
    `SELECT DATE_FORMAT(Start_Time, '%Y-%m-%d %H') AS bucket, COUNT(*) AS n
       FROM charging_session
      WHERE Start_Time > NOW() - INTERVAL 60 DAY
      GROUP BY bucket
     HAVING n > ?
      ORDER BY bucket`,
    [BULK_HOUR_THRESHOLD]
  );

  if (lumps.length === 0) {
    log("history  : no bulk-written hours found, nothing to spread");
    return { moved: 0 };
  }

  log(
    `history  : ${lumps.length} hour(s) hold more than ${BULK_HOUR_THRESHOLD} session starts ` +
      `(${lumps.reduce((s, l) => s + Number(l.n), 0)} sessions)`
  );

  const [rows] = await conn.query(
    `SELECT Session_ID, Start_Time, End_Time
       FROM charging_session
      WHERE Start_Time > NOW() - INTERVAL 60 DAY
        AND DATE_FORMAT(Start_Time, '%Y-%m-%d %H') IN (?)
        AND End_Time IS NOT NULL
      ORDER BY Session_ID`,
    [lumps.map((l) => l.bucket)]
  );

  if (DRY) return { moved: rows.length };

  return { moved: await redistribute(conn, rows) };
}

/**
 * Move a batch of completed sessions onto the recent calendar, following the
 * daily demand curve, and carry their payment and invoice timestamps along.
 *
 * Placement is derived from the session id, so the same session always lands on
 * the same day and hour and a demo recorded twice shows the same figures.
 */
async function redistribute(conn, rows) {
  let moved = 0;
  for (const row of rows) {
    const id = Number(row.Session_ID);

    // Deterministic placement: the same session always lands on the same day
    // and hour, so re-running this does not reshuffle a demo.
    let daysAgo = id % HISTORY_DAYS;
    const hour = HOUR_PICKER[(id * 7) % HOUR_PICKER.length];
    const minute = (id * 13) % 60;

    // Preserve how long the session actually lasted; only move when it started.
    const durationMs = Math.max(
      5 * 60_000,
      new Date(row.End_Time).getTime() - new Date(row.Start_Time).getTime()
    );
    const durationMinutes = Math.round(durationMs / 60_000);

    // Today is only partly over, so a completed session placed on day zero has
    // to FINISH before now — not merely start before now. Checking the start
    // alone still dated the end of a long session in the future, and a
    // completed session that has not finished yet is the kind of detail a
    // reviewer spots immediately.
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (daysAgo === 0 && hour * 60 + minute + durationMinutes > nowMinutes - 5) {
      daysAgo = 1;
    }

    await conn.query(
      `UPDATE charging_session
          SET Start_Time = TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL ? DAY), MAKETIME(?, ?, 0)),
              End_Time   = DATE_ADD(
                             TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL ? DAY), MAKETIME(?, ?, 0)),
                             INTERVAL ? MINUTE)
        WHERE Session_ID = ?`,
      [daysAgo, hour, minute, daysAgo, hour, minute, durationMinutes, id]
    );

    // Move the money with the session. A payment timestamped days away from the
    // session it settles would break every revenue-over-time report and would
    // be the first thing a reviewer noticed.
    await conn.query(
      `UPDATE payment p
          JOIN charging_session cs ON cs.Session_ID = p.Session_ID
           SET p.Created_Time = DATE_ADD(cs.End_Time, INTERVAL 1 MINUTE)
         WHERE p.Session_ID = ?`,
      [id]
    );
    await conn.query(
      `UPDATE invoice i
          JOIN charging_session cs ON cs.Session_ID = i.Session_ID
           SET i.Generated_At = DATE_ADD(cs.End_Time, INTERVAL 2 MINUTE)
         WHERE i.Session_ID = ?`,
      [id]
    );
    moved++;
  }
  return moved;
}

/**
 * Make sure the recent weeks actually contain sessions.
 *
 * The seed data describes a fixed window that is now months in the past, so a
 * freshly built database has thousands of completed sessions and none of them
 * inside the range any chart looks at. Every "last 30 days" view is empty, and
 * the platform reads as though it has never been used — which is exactly what a
 * teammate sees on their first run, before they have generated any traffic.
 *
 * Rather than invent sessions, the most recent slice of the existing history is
 * moved forward onto the last few weeks. The rows, their payments and their
 * invoices are genuine; only when they happened changes.
 */
async function ensureRecentHistory(conn) {
  const MIN_PER_DAY = argNum("--min-per-day", 40);
  const wanted = MIN_PER_DAY * HISTORY_DAYS;

  const [[recent]] = await conn.query(
    `SELECT COUNT(*) AS n FROM charging_session
      WHERE End_Time IS NOT NULL
        AND Start_Time > NOW() - INTERVAL ? DAY`,
    [HISTORY_DAYS]
  );

  const shortfall = wanted - Number(recent.n);
  if (shortfall <= 0) {
    log(`recent   : ${recent.n} completed session(s) in the last ${HISTORY_DAYS} days — enough`);
    return { moved: 0 };
  }

  const [rows] = await conn.query(
    `SELECT Session_ID, Start_Time, End_Time
       FROM charging_session
      WHERE End_Time IS NOT NULL
        AND Start_Time <= NOW() - INTERVAL ? DAY
      ORDER BY Start_Time DESC
      LIMIT ?`,
    [HISTORY_DAYS, shortfall]
  );

  if (rows.length === 0) {
    log(`recent   : no older sessions available to pull forward`);
    return { moved: 0 };
  }

  log(
    `recent   : only ${recent.n} session(s) in the last ${HISTORY_DAYS} days — ` +
      `pulling ${rows.length} forward from the archive`
  );
  if (DRY) return { moved: rows.length };

  return { moved: await redistribute(conn, rows) };
}

/**
 * Release chargers that are marked busy with nothing running on them.
 *
 * The seeded fleet arrives with hundreds of chargers already set to 'In Use'
 * even though no session references them, so a fresh database reports 676 of
 * 859 stalls occupied and 119 free. Reconciling first means the live front this
 * script then opens is the ONLY thing marking chargers busy, and the fleet view
 * agrees with the session table from the very first run.
 */
async function reconcileChargerState(conn) {
  if (DRY) {
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM charger c
        WHERE c.Charger_Availability_Status = 'In Use'
          AND NOT EXISTS (
            SELECT 1 FROM charging_session s
             WHERE s.Charger_ID = c.Charger_ID
               AND s.Session_Status = 'Active' AND s.End_Time IS NULL
          )`
    );
    log(`fleet    : ${n} charger(s) marked busy with no session`);
    return n;
  }

  const [res] = await conn.query(
    `UPDATE charger c
        SET c.Charger_Availability_Status = 'Available'
      WHERE c.Charger_Availability_Status = 'In Use'
        AND NOT EXISTS (
          SELECT 1 FROM charging_session s
           WHERE s.Charger_ID = c.Charger_ID
             AND s.Session_Status = 'Active' AND s.End_Time IS NULL
        )`
  );
  if (res.affectedRows > 0) {
    log(`fleet    : released ${res.affectedRows} charger(s) marked busy with no session`);
  }
  return res.affectedRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Put a realistic share of the fleet mid-session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open genuine sessions on idle chargers so the network has a live front.
 *
 * These are real rows: Session_Status 'Active', End_Time NULL, charger marked
 * 'In Use'. Nothing is faked for display, which means the operations manager
 * can stop one of them during the demo and watch the billing pipeline run for
 * real.
 *
 * Start times are staggered across the last two hours so the sessions did not
 * all begin at the same second, and chargers are picked across as many stations
 * as possible rather than filling one site.
 */
async function openLiveFront(conn) {
  // --reset-live clears the synthetic live front before rebuilding it. Only
  // sessions that never started billing are removed: End_Time is null, so no
  // payment or invoice can exist for them and nothing financial is touched.
  if (process.argv.includes("--reset-live") && !DRY) {
    const [cleared] = await conn.query(
      `DELETE FROM charging_session
        WHERE Session_Status = 'Active' AND End_Time IS NULL`
    );
    await conn.query(
      `UPDATE charger SET Charger_Availability_Status = 'Available'
        WHERE Charger_Availability_Status = 'In Use'`
    );
    log(`live     : reset — removed ${cleared.affectedRows} unbilled in-progress session(s)`);
  }

  // ── Retire sessions that have outrun any plausible charge ─────────────────
  //
  // A live session with nothing to end it just keeps ageing. Left alone
  // overnight the demo shows cars that have been fast-charging for nine hours,
  // which is both impossible and the first thing anyone notices.
  //
  // These are ended through the real pipeline rather than quietly patched: set
  // End_Time, enqueue a billing job, and let the worker compute energy, take
  // the money and produce an invoice exactly as it would for a driver who
  // unplugged. The demo data is therefore produced by the same code path the
  // demo is about.
  const [stale] = await conn.query(
    `SELECT cs.Session_ID, cs.Charger_ID, c.Charger_Power_Capacity AS kw,
            TIMESTAMPDIFF(MINUTE, cs.Start_Time, NOW()) AS elapsed_minutes
       FROM charging_session cs
       JOIN charger c ON c.Charger_ID = cs.Charger_ID
      WHERE cs.Session_Status = 'Active' AND cs.End_Time IS NULL`
  );

  const overrun = stale.filter(
    (r) => Number(r.elapsed_minutes) > maxPlausibleSessionMinutes(r.kw)
  );

  if (overrun.length > 0 && !DRY) {
    for (const row of overrun) {
      // End it where a real session would have ended, not "now" — otherwise the
      // recorded duration keeps the impossible length we are correcting.
      const minutes = typicalSessionMinutes(row.kw, 0.5);
      await conn.query(
        `UPDATE charging_session
            SET End_Time = DATE_ADD(Start_Time, INTERVAL ? MINUTE)
          WHERE Session_ID = ?`,
        [minutes, row.Session_ID]
      );
      await conn.query(
        `INSERT INTO job_queue (Queue_Name, Payload) VALUES ('billing', CAST(? AS JSON))`,
        [JSON.stringify({ sessionId: row.Session_ID })]
      );
    }
    await conn.query(
      `UPDATE charger SET Charger_Availability_Status = 'Available'
        WHERE Charger_ID IN (?) AND Charger_Availability_Status = 'In Use'`,
      [overrun.map((r) => r.Charger_ID)]
    );
    log(`live     : retired ${overrun.length} over-long session(s) into the billing queue`);
  } else if (overrun.length > 0) {
    log(`live     : ${overrun.length} session(s) have outrun a plausible charge`);
  }

  const [[state]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM charging_session
              WHERE Session_Status = 'Active' AND End_Time IS NULL) AS open_sessions,
            (SELECT COUNT(*) FROM charger
              WHERE Charger_Availability_Status <> 'Out of Service') AS usable`
  );

  const alreadyOpen = Number(state.open_sessions);
  const target = Math.round(Number(state.usable) * LIVE_FRACTION);

  if (alreadyOpen >= target) {
    log(`live     : ${alreadyOpen} session(s) already in progress, target ${target} — leaving alone`);
    return { opened: 0, alreadyOpen };
  }

  const need = target - alreadyOpen;

  // Spread the live sessions across BOTH dimensions that matter: stations and
  // charger types.
  //
  // Ranking within (station, type) and then taking all the rank-1 rows first
  // gives one busy charger of each type at every site before any site gets a
  // second. Ranking by station alone put every live session on a DC fast
  // charger — the lowest id at each site — leaving the Level 2 half of the
  // fleet permanently idle, which no real network looks like.
  const [candidates] = await conn.query(
    `SELECT Charger_ID, Station_ID, Charger_Type, Charger_Power_Capacity FROM (
       SELECT c.Charger_ID, c.Station_ID, c.Charger_Type, c.Charger_Power_Capacity,
              ROW_NUMBER() OVER (
                PARTITION BY c.Station_ID, c.Charger_Type ORDER BY c.Charger_ID
              ) AS rn
         FROM charger c
        WHERE c.Charger_Availability_Status = 'Available'
          AND NOT EXISTS (
            SELECT 1 FROM charging_session s
             WHERE s.Charger_ID = c.Charger_ID
               AND s.Session_Status = 'Active' AND s.End_Time IS NULL
          )
     ) ranked
     ORDER BY rn, Charger_ID
     LIMIT ?`,
    [need]
  );

  const [drivers] = await conn.query(`SELECT User_ID FROM user ORDER BY User_ID`);
  if (candidates.length === 0 || drivers.length === 0) {
    log("live     : no idle chargers or no drivers available");
    return { opened: 0, alreadyOpen };
  }

  log(
    `live     : ${alreadyOpen} in progress, opening ${candidates.length} more ` +
      `(target ${target} of ${state.usable} usable chargers)`
  );
  if (DRY) return { opened: candidates.length, alreadyOpen };

  const rows = candidates.map((c, i) => {
    // How far through its session this charger should already be.
    //
    // Scaled to what a session on THIS charger actually takes, so a 350 kW
    // stall is a few minutes in and a 7 kW workplace charger can be hours in.
    // Using one flat range put every charger — fast or slow — at the same
    // elapsed time, which is how DC fast sessions ended up "charging" for four
    // hours at 200 kW.
    const full = typicalSessionMinutes(c.Charger_Power_Capacity, ((c.Charger_ID * 37) % 100) / 100);
    const progress = 0.05 + (((c.Charger_ID * 11) % 80) / 100); // 5%–85% through
    const elapsedMinutes = Math.max(1, Math.round(full * progress));

    // Offset by seconds as well as minutes.
    //
    // Every session in this batch is built from the same Date.now(), so two
    // chargers that land on the same elapsed minute would be stamped with the
    // identical second — and the sessions list shows a block of rows sharing
    // one timestamp, which reads as a bulk insert rather than as cars that
    // arrived separately.
    const secondsOffset = (c.Charger_ID * 17) % 60;

    return [
      c.Charger_ID,
      drivers[(c.Charger_ID * 7 + i) % drivers.length].User_ID,
      new Date(Date.now() - elapsedMinutes * 60_000 - secondsOffset * 1000),
      "Active",
    ];
  });

  await conn.query(
    `INSERT INTO charging_session (Charger_ID, User_ID, Start_Time, Session_Status)
     VALUES ?`,
    [rows]
  );

  await conn.query(
    `UPDATE charger SET Charger_Availability_Status = 'In Use' WHERE Charger_ID IN (?)`,
    [candidates.map((c) => c.Charger_ID)]
  );

  return { opened: candidates.length, alreadyOpen };
}

main().catch((err) => {
  console.error("\n✖ activity shaping failed:", err.message);
  process.exit(1);
});
