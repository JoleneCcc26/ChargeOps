// Daily deterministic traffic generator. The same date always produces the
// same pseudo-random choices, while simulation_run makes the write idempotent.
import { pool } from "../../db.js";
import { sendMessageTx, QUEUES } from "../../adapters/queue.js";
import { energyDeliveredKwh } from "../../lib/charging.js";
import * as cache from "../../adapters/cache.js";

const INCIDENTS = [
  { category: "connector", severity: "major", code: "E-401", text: "Connector latch intermittently fails to lock" },
  { category: "cable", severity: "minor", code: "W-118", text: "Cable holster sensor reports repeated disconnects" },
  { category: "screen", severity: "minor", code: "D-204", text: "Touchscreen response latency is above normal" },
  { category: "payment_terminal", severity: "major", code: "E-512", text: "Contactless payment terminal declines test taps" },
  { category: "network", severity: "critical", code: "N-903", text: "OCPP heartbeat timed out during handshake" },
  { category: "power", severity: "critical", code: "P-701", text: "Output power dropped below the safe delivery threshold" },
];

const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (items, random) => items[Math.floor(random() * items.length)];
const randomInt = (min, max, random) => min + Math.floor(random() * (max - min + 1));

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function mysqlDateTime(date, secondsFromMidnight) {
  const seconds = Math.max(0, Math.min(86399, secondsFromMidnight));
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${date} ${hh}:${mm}:${ss}`;
}

/**
 * The last second of `date` that has actually happened yet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DAY IS SHORTENED RATHER THAN THE TIMESTAMPS SQUASHED
 * ─────────────────────────────────────────────────────────────────────────────
 * The scheduled event simulates YESTERDAY, so every second it draws is safely
 * in the past. Running the simulator by hand for TODAY is different: a day is
 * twenty-four hours long whatever time it is, so a session drawn for 20:00 and
 * generated at 18:00 is stamped two hours into the future. Nothing crashes —
 * the row is simply a lie, and it propagates into the payment that settles it
 * and the telemetry that goes with it.
 *
 * The obvious fix, clipping each timestamp at "now" as it is written, is wrong:
 * a session whose start and end both exceed the ceiling collapses to zero
 * length and violates `End_Time > Start_Time`. It also quietly rewrites
 * durations, so the simulated day stops meaning anything.
 *
 * Shortening the WINDOW instead keeps every session the length it was drawn to
 * be. Simulating a partial day simply produces a partial day, which is the
 * honest answer.
 */
function lastSecondOf(date) {
  const now = new Date();
  const today =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getDate()).padStart(2, "0")}`;
  if (date !== today) return 86399; // a day already over: all of it is fair game
  return Math.max(0, now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() - 120);
}

/** @param {{type?:string, runId?:number, runDate?:string}} payload */
export async function handleSimulation(payload) {
  if (payload?.type !== "simulation.daily") {
    throw new Error(`simulation: unsupported payload ${JSON.stringify(payload)}`);
  }
  const runId = Number(payload.runId);
  const runDate = String(payload.runDate ?? "");
  if (!Number.isInteger(runId) || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw new Error(`simulation: invalid payload ${JSON.stringify(payload)}`);
  }

  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    const [[run]] = await conn.query(
      `SELECT * FROM simulation_run WHERE Run_ID = ? AND Run_Date = ? FOR UPDATE`,
      [runId, runDate]
    );
    if (!run) throw new Error(`simulation: run ${runId}/${runDate} not found`);
    if (run.Status === "completed") {
      await conn.commit();
      return { skipped: true, reason: "date already simulated", runId, runDate };
    }

    await conn.query(
      `UPDATE simulation_run
          SET Status = 'processing', Started_At = COALESCE(Started_At, NOW(3)), Error_Message = NULL
        WHERE Run_ID = ?`,
      [runId]
    );

    const random = mulberry32(Number(run.Seed_Value));
    const minSessions = clampInt(process.env.SIMULATION_MIN_SESSIONS, 12, 1, 100);
    const maxSessions = clampInt(process.env.SIMULATION_MAX_SESSIONS, 24, minSessions, 150);
    const minSituations = clampInt(process.env.SIMULATION_MIN_SITUATIONS, 1, 0, 20);
    const maxSituations = clampInt(process.env.SIMULATION_MAX_SITUATIONS, 3, minSituations, 30);

    const [users] = await conn.query(`SELECT User_ID FROM user ORDER BY User_ID`);
    const [chargers] = await conn.query(`
      SELECT c.Charger_ID, c.Charger_Power_Capacity, c.Charging_Rate_Per_kWh,
             c.Station_ID, s.Station_Name, s.Station_State
        FROM charger c
        JOIN station s ON s.Station_ID = c.Station_ID
       WHERE c.Charger_Availability_Status = 'Available'
         AND s.Station_Status = 'Open'
         AND NOT EXISTS (
           SELECT 1 FROM maintenance_log m
            WHERE m.Charger_ID = c.Charger_ID AND m.Status IN ('Reported','Assigned','In Progress')
         )
       ORDER BY c.Charger_ID
    `);
    const [technicians] = await conn.query(`
      SELECT Technician_ID, Technician_State FROM technician ORDER BY Technician_ID
    `);
    if (users.length === 0 || chargers.length === 0 || technicians.length === 0) {
      throw new Error("simulation: users, eligible chargers, and technicians are required");
    }

    // Resolve a small number of older simulated incidents so the fleet does
    // not drift toward every charger being permanently out of service.
    const resolveTarget = randomInt(0, 2, random);
    const [resolvable] = await conn.query(`
      SELECT Maintenance_ID, Charger_ID
        FROM maintenance_log
       WHERE Status IN ('Reported','Assigned','In Progress')
         AND Issue_Reported LIKE '[SIMULATED %'
       ORDER BY Maintenance_ID
       LIMIT ?
       FOR UPDATE
    `, [resolveTarget]);
    for (const ticket of resolvable) {
      await conn.query(`
        UPDATE maintenance_log
           SET Status = 'Resolved', Resolved_Time = ?
         WHERE Maintenance_ID = ?
      `, [mysqlDateTime(runDate, randomInt(8 * 3600, 20 * 3600, random)), ticket.Maintenance_ID]);
      await conn.query(`
        UPDATE charger c
           SET c.Charger_Availability_Status = 'Available'
         WHERE c.Charger_ID = ?
           AND c.Charger_Availability_Status = 'Out of Service'
           AND NOT EXISTS (
             SELECT 1 FROM maintenance_log m
              WHERE m.Charger_ID = c.Charger_ID AND m.Status IN ('Reported','Assigned','In Progress')
           )
      `, [ticket.Charger_ID]);
    }

    // Use distinct chargers for the daily completed sessions. This prevents
    // impossible overlaps without needing a complex interval allocator.
    // How much of this day exists to simulate. Before ~06:00 there is not
    // enough of it for a charging session to fit, so the day is left for the
    // scheduled run that will cover it properly tomorrow.
    const dayEnd = lastSecondOf(runDate);
    const sessionTarget =
      dayEnd < 6 * 3600
        ? 0
        : Math.min(randomInt(minSessions, maxSessions, random), chargers.length);
    const sessionChargers = shuffled(chargers, random).slice(0, sessionTarget);
    for (const charger of sessionChargers) {
      const user = pick(users, random);
      // Sessions run between 05:00 and 21:00, and never past the moment this
      // day reached. `dayEnd` is 23:50 for a finished day and "a couple of
      // minutes ago" for one still in progress.
      const durationSeconds = randomInt(20 * 60, 150 * 60, random);
      const latestStart = Math.max(5 * 3600, Math.min(21 * 3600, dayEnd - durationSeconds));
      const startSecond = randomInt(5 * 3600, latestStart, random);
      const endSecond = Math.min(startSecond + durationSeconds, Math.min(23 * 3600 + 50 * 60, dayEnd));
      const startTime = mysqlDateTime(runDate, startSecond);
      const endTime = mysqlDateTime(runDate, Math.max(startSecond + 60, endSecond));

      const [insert] = await conn.query(`
        INSERT INTO charging_session
          (Charger_ID, User_ID, Start_Time, End_Time, Energy_Consumed,
           Session_Rate_Per_kWh, Total_Cost, Session_Status)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, 'Active')
      `, [
        charger.Charger_ID,
        user.User_ID,
        startTime,
        endTime,
        charger.Charging_Rate_Per_kWh,
      ]);

      const sessionId = insert.insertId;
      await sendMessageTx(conn, QUEUES.BILLING, { sessionId, endTime });

      const hours = (Math.max(startSecond + 60, endSecond) - startSecond) / 3600;
      // Uses the shared charging model, not a flat power x hours product, so
      // the telemetry the simulator emits agrees with what the billing worker
      // will compute for the same session.
      const estimatedEnergy = energyDeliveredKwh(charger.Charger_Power_Capacity, hours);
      await sendMessageTx(conn, QUEUES.TELEMETRY, {
        chargerId: charger.Charger_ID,
        reportedAt: startTime,
        powerKw: Number((Number(charger.Charger_Power_Capacity) * 0.82).toFixed(2)),
        sessionEnergyKwh: 0,
        status: "Charging",
        temperatureC: Number((25 + random() * 13).toFixed(1)),
      });
      await sendMessageTx(conn, QUEUES.TELEMETRY, {
        chargerId: charger.Charger_ID,
        reportedAt: endTime,
        powerKw: 0,
        sessionEnergyKwh: estimatedEnergy,
        status: "Available",
        temperatureC: Number((24 + random() * 8).toFixed(1)),
      });
    }

    // Operational situations are maintenance incidents. State-matched
    // technician assignment keeps the generated rows realistic.
    const situationTarget = Math.min(
      randomInt(minSituations, maxSituations, random),
      chargers.length
    );
    const situationChargers = shuffled(chargers, random).slice(0, situationTarget);
    for (const charger of situationChargers) {
      const incident = pick(INCIDENTS, random);
      const localTechs = technicians.filter(
        (tech) => tech.Technician_State === charger.Station_State
      );
      const technician = pick(localTechs.length ? localTechs : technicians, random);

      // ── The status a simulated fault starts in ────────────────────────────
      //
      // This wrote "Open" until the work-order lifecycle replaced that state
      // with Reported / Assigned / In Progress / Resolved / Rejected. The
      // migration renamed the states everywhere a human would look — the
      // routes, the pages, the seed — and missed the one writer that only runs
      // once a day. Every simulation since has failed its CHECK constraint,
      // retried three times and dead-lettered, silently, because nobody was
      // watching a job that fires at 3am.
      //
      // Most reports arrive with nobody assigned; that is what the dispatch
      // board is for. A minority arrive already assigned, standing in for a
      // fault a technician found while on site.
      const roll = random();
      const status = roll < 0.62 ? "Reported" : roll < 0.85 ? "Assigned" : "In Progress";
      const assigned = status !== "Reported";

      const issue =
        `[SIMULATED ${runDate}] [${incident.severity}] ${incident.category} (${incident.code}) - ` +
        `${incident.text}. Station: ${charger.Station_Name}; generated by the daily platform simulator.`;

      // The dispatch workflow columns are filled in too. Writing only the old
      // six columns produced rows with no fault code and no severity, which the
      // manager dashboard groups by and the doctor script now asserts on.
      await conn.query(`
        INSERT INTO maintenance_log
          (Charger_ID, Station_ID, Technician_ID, Issue_Reported, Resolved_Time, Status,
           Reported_At, Reported_By, Report_Source, Fault_Code, Severity, Priority,
           Assigned_At, Assigned_By, Started_At)
        VALUES (?, ?, ?, ?, NULL, ?, NOW(), 'simulator', 'remote_alarm', ?, ?, ?, ?, ?, ?)
      `, [
        charger.Charger_ID,
        charger.Station_ID,
        assigned ? technician.Technician_ID : null,
        issue,
        status,
        incident.code,
        incident.severity,
        incident.severity === "critical" ? "high" : "normal",
        assigned ? new Date() : null,
        assigned ? "simulator" : null,
        status === "In Progress" ? new Date() : null,
      ]);

      if (incident.severity === "critical" || incident.severity === "major") {
        await conn.query(`
          UPDATE charger SET Charger_Availability_Status = 'Out of Service'
           WHERE Charger_ID = ?
        `, [charger.Charger_ID]);
      }
    }

    await conn.query(`
      UPDATE simulation_run
         SET Status = 'completed', Session_Count = ?, Situation_Count = ?,
             Resolved_Count = ?, Completed_At = NOW(3), Error_Message = NULL
       WHERE Run_ID = ?
    `, [sessionTarget, situationTarget, resolvable.length, runId]);

    await conn.query(`
      INSERT INTO audit_log
        (Actor_Username, Actor_Role, Action, Entity_Type, Entity_ID, Details)
      VALUES ('daily-simulator', 'system', 'simulation.completed', 'simulation_run', ?,
              JSON_OBJECT('runDate', ?, 'sessions', ?, 'situations', ?, 'resolved', ?))
    `, [String(runId), runDate, sessionTarget, situationTarget, resolvable.length]);

    await conn.commit();
    result = {
      runId,
      runDate,
      sessions: sessionTarget,
      situations: situationTarget,
      resolved: resolvable.length,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});

    // Record the failure OUTSIDE the transaction that just rolled back.
    //
    // Without this the run row stays at 'processing' forever while the job
    // dead-letters, so the two halves of the system disagree about what
    // happened and neither one says why. That is exactly how a broken daily
    // simulation went unnoticed: the job queue knew, the simulation_run table
    // said "in progress", and nobody reads the job queue.
    //
    // Best-effort by design — if the database is what failed, there is nowhere
    // left to write, and masking the original error with a second one would
    // only make the real cause harder to find.
    await pool
      .query(
        `UPDATE simulation_run
            SET Status = 'failed', Error_Message = ?, Completed_At = NOW(3)
          WHERE Run_ID = ? AND Status <> 'completed'`,
        [String(err.message).slice(0, 500), runId]
      )
      .catch(() => {});

    throw err;
  } finally {
    conn.release();
  }

  cache.invalidate("dashboard:");
  cache.invalidate("chargers:");
  return result;
}
