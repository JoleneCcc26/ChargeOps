// server/workers/handlers/telemetry.js
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FIREHOSE - AND WHY BATCHING IS THE WHOLE LESSON
// ═════════════════════════════════════════════════════════════════════════════
// Every charger reports its state every few seconds. 500 chargers on a 10 s
// heartbeat is ~50 messages/second at rest, and a fleet-wide reconnect after a
// network blip delivers thousands at once.
//
// The naive design is `POST /telemetry` -> `INSERT INTO charger_telemetry`.
// It falls over for two separate reasons:
//
//   1. Every INSERT is its own transaction: its own network round trip, its own
//      fsync of the redo log, its own index maintenance. 2000 of those take
//      seconds, during which the connection pool is exhausted and every OTHER
//      query in the app - the operations manager's dashboard included - is
//      queued behind telemetry.
//   2. There is no shock absorber. Whatever rate the chargers send at is the
//      rate the database must sustain, right now. There is no way to say "peak
//      for 30 seconds, drain over the next two minutes".
//
// So the API does not write to the database at all. It validates, enqueues, and
// returns 202 in about a millisecond. This handler then claims FIFTY messages
// at a time (see BATCH_SIZE in worker.js) and writes them with ONE multi-row
// INSERT. Fifty round trips become one; fifty transactions become one.
//
// That is the "async / traffic-spike" dimension in a single file, and the load
// generator (scripts/loadtest.mjs) exists to make it visible on the dashboard.
//
// In the cloud this becomes API Gateway -> SQS -> Lambda, or Kinesis Data
// Firehose straight into S3/Timestream. The shape of the argument is identical.
import { pool } from "../../db.js";
import * as cache from "../../adapters/cache.js";

/**
 * Fault codes a charger can raise.
 *
 * Real chargers report a numbered fault over OCPP rather than prose, and the
 * code is what the operations manager triages on: it says whether this needs a
 * technician with a spare connector or one with a laptop.
 */
const FAULT_CODES = [
  "E-1180 CABLE_FAULT",
  "E-2077 OVER_TEMPERATURE",
  "E-4021 CONNECTOR_LOCK_FAILURE",
  "E-512 PAYMENT_TERMINAL_OFFLINE",
  "E-3310 GROUND_FAULT",
  "E-0904 COMMUNICATION_LOST",
];

/** Map an OCPP-ish status code onto the charger status the UI shows. */
const STATUS_MAP = {
  Available:   "Available",
  Preparing:   "Reserved",
  Charging:    "In Use",
  SuspendedEV: "In Use",
  Finishing:   "In Use",
  Reserved:    "Reserved",
  Unavailable: "Out of Service",
  Faulted:     "Out of Service",
};

/**
 * Handle a whole batch of heartbeats.
 *
 * Note the signature: this handler takes an ARRAY, unlike the other two. That
 * is the point - the worker hands it the entire claimed batch so the batching
 * win happens here.
 *
 * @param {Array<object>} payloads
 */
export async function handleTelemetry(payloads) {
  const shaped = payloads.filter(isValidBeat);
  if (shaped.length === 0) return { written: 0, rejected: payloads.length };

  // Keep the high-volume history table free of a foreign-key hot path, but do
  // the equivalent referential check once for the entire claimed batch.
  const chargerIds = [...new Set(shaped.map((b) => Number(b.chargerId)))];
  const [knownRows] = await pool.query(
    `SELECT Charger_ID FROM charger WHERE Charger_ID IN (?)`,
    [chargerIds]
  );
  const knownIds = new Set(knownRows.map((row) => Number(row.Charger_ID)));
  const beats = shaped.filter((beat) => knownIds.has(Number(beat.chargerId)));
  if (beats.length === 0) return { written: 0, rejected: payloads.length };

  // ── 1. One multi-row INSERT for the append-only history ───────────────────
  // mysql2 expands a nested array into `VALUES (?,?,?),(?,?,?),...` for us.
  const rows = beats.map((b) => [
    Number(b.chargerId),
    new Date(b.reportedAt ?? Date.now()),
    Number(b.powerKw ?? 0),
    b.sessionEnergyKwh != null ? Number(b.sessionEnergyKwh) : null,
    String(b.status ?? "Available").slice(0, 30),
    b.temperatureC != null ? Number(b.temperatureC) : null,
  ]);

  await pool.query(
    `INSERT INTO charger_telemetry
       (Charger_ID, Reported_At, Power_KW, Session_Energy_KWh, Status_Code, Temperature_C)
     VALUES ?`,
    [rows]
  );

  // ── 2. Collapse to the latest state per charger ───────────────────────────
  // A batch often holds several beats for the same charger. Only the newest one
  // should touch the charger row, so we reduce first and issue at most one
  // UPDATE per distinct charger instead of one per beat.
  const latest = new Map();
  for (const b of beats) {
    const id = Number(b.chargerId);
    const at = new Date(b.reportedAt ?? Date.now()).getTime();
    const prev = latest.get(id);
    if (!prev || at > prev.at) latest.set(id, { at, status: b.status });
  }

  // Group chargers by target status so N chargers become at most 4 UPDATEs
  // (one per distinct status) rather than N.
  const byStatus = new Map();
  for (const [chargerId, { status }] of latest) {
    const mapped = STATUS_MAP[status];
    if (!mapped) continue;
    if (!byStatus.has(mapped)) byStatus.set(mapped, []);
    byStatus.get(mapped).push(chargerId);
  }

  for (const [status, ids] of byStatus) {
    await pool.query(
      // Skip chargers a human has taken out of service - a heartbeat should not
      // silently put a charger that a technician disabled back into rotation.
      `UPDATE charger
          SET Charger_Availability_Status = ?
        WHERE Charger_ID IN (?)
          AND Charger_Availability_Status <> 'Out of Service'`,
      [status, ids]
    );
  }

  // A "Faulted" beat is the exception: it MUST be able to take a charger down.
  const faulted = [...latest.entries()]
    .filter(([, v]) => v.status === "Faulted" || v.status === "Unavailable")
    .map(([id]) => id);

  let workOrdersOpened = 0;
  if (faulted.length > 0) {
    // A real charger reports a numbered fault; the operations manager triages
    // by that code long before anyone drives to the site.
    const faultCode = FAULT_CODES[
      (faulted[0] + new Date().getUTCHours()) % FAULT_CODES.length
    ];
    await pool.query(
      `UPDATE charger SET Charger_Availability_Status = 'Out of Service'
        WHERE Charger_ID IN (?)`,
      [faulted]
    );

    // ── Raise a report for every charger we just took down ──────────────────
    //
    // Deliberately UNASSIGNED. A fault detected by equipment does not know who
    // should fix it — that is a dispatch decision, made by the operations
    // manager who can see the whole queue and who is free.
    //
    // Pre-assigning a technician here (which this used to do, purely because
    // the column was NOT NULL) skipped the single most important action in the
    // application. Every work order arrived already solved, the manager had
    // nothing to decide, and the maintenance screen became a table to read
    // rather than a queue to work.
    //
    // The NOT EXISTS guard keeps it idempotent: a charger that beats Faulted
    // fifty times in a row raises one report, not fifty.
    const [opened] = await pool.query(
      `INSERT INTO maintenance_log
         (Charger_ID, Station_ID, Technician_ID, Issue_Reported, Resolved_Time,
          Status, Reported_At, Reported_By, Report_Source, Fault_Code, Severity, Priority)
       SELECT c.Charger_ID,
              c.Station_ID,
              NULL,
              CONCAT('Charger reported fault code ', ?, ' and stopped serving customers.'),
              NULL,
              'Reported',
              NOW(),
              'charger-telemetry',
              'telemetry',
              ?,
              'critical',
              'high'
         FROM charger c
        WHERE c.Charger_ID IN (?)
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_log m
             WHERE m.Charger_ID = c.Charger_ID
               AND m.Status IN ('Reported', 'Assigned', 'In Progress')
          )`,
      [faultCode, faultCode, faulted]
    );
    workOrdersOpened = opened.affectedRows;
    if (workOrdersOpened > 0) cache.invalidate("maintenance:");
  }

  // Availability just changed, so anything derived from it is stale.
  cache.invalidate("chargers:");
  cache.invalidate("dashboard:");

  return {
    written: rows.length,
    rejected: payloads.length - beats.length,
    chargersTouched: latest.size,
    faulted: faulted.length,
    workOrdersOpened,
  };
}

/**
 * Reject malformed beats instead of failing the batch.
 *
 * A single bad message must not dead-letter the 49 good ones it happened to be
 * claimed with. Because charger_telemetry has no foreign key (deliberately -
 * see the schema comments), shape validation happens here and one batched
 * lookup in handleTelemetry performs the referential check.
 */
function isValidBeat(b) {
  if (!b || typeof b !== "object") return false;
  const id = Number(b.chargerId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const power = Number(b.powerKw ?? 0);
  if (!Number.isFinite(power) || power < 0 || power > 1000) return false;
  return true;
}
