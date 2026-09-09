// Repair known legacy inconsistencies without inventing successful payments.
//
// Default is a read-only dry run:
//   node scripts/repair-data.mjs
// Apply the repair after writing a local JSON snapshot:
//   node scripts/repair-data.mjs --apply
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import "../server/env.js";
import { energyDeliveredKwh, MAX_SESSION_KWH } from "../server/lib/charging.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_DIR = path.join(ROOT, "backups");
const APPLY = process.argv.includes("--apply");

const INVOICE_RECOVERY_KEYS = new Map([
  [2102, "invoices/2026/08/362724a3ce1dd0b3.pdf"],
  [2103, "invoices/2026/08/628ce90e010dedc8.pdf"],
  [2104, "invoices/2026/08/44fc03b5ac3e7fba.pdf"],
  [2105, "invoices/2026/08/3fbba9e473763dae.pdf"],
  [2106, "invoices/2026/08/d8242a7cef7cc909.pdf"],
  [2107, "invoices/2026/08/456edeb05c79f834.pdf"],
  [2108, "invoices/2026/08/62e7fc2eb23c66a2.pdf"],
  [2109, "invoices/2026/08/09296e371df53497.pdf"],
  [2110, "invoices/2026/08/817528158d157ae3.pdf"],
  [2111, "invoices/2026/08/4326d6222b979afa.pdf"],
]);

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

const storageRoot = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(ROOT, "server", ".storage");

function jsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function collect(conn) {
  const [stuckChargers] = await conn.query(`
    SELECT c.Charger_ID, c.Charger_Availability_Status
      FROM charger c
     WHERE c.Charger_Availability_Status = 'In Use'
       AND NOT EXISTS (
         SELECT 1 FROM charging_session cs
          WHERE cs.Charger_ID = c.Charger_ID
            AND cs.Session_Status = 'Active'
            AND cs.End_Time IS NULL
       )
     ORDER BY c.Charger_ID
  `);

  // Chargers parked 'Out of Service' with nothing explaining why.
  //
  // In this application a charger only goes out of service because a critical
  // fault opened a maintenance ticket, and it only comes back when a technician
  // resolves that ticket. A charger that is down with no open ticket is
  // orphaned state — nobody is working on it and nothing will ever bring it
  // back. Same class of inconsistency as an 'In Use' charger with no session,
  // and it accumulates for the same reason: simulated fault telemetry that no
  // human ever followed up on.
  const [orphanedOutOfService] = await conn.query(`
    SELECT c.Charger_ID, c.Charger_Availability_Status
      FROM charger c
     WHERE c.Charger_Availability_Status = 'Out of Service'
       AND NOT EXISTS (
         SELECT 1 FROM maintenance_log m
          WHERE m.Charger_ID = c.Charger_ID
            AND m.Status IN ('Reported','Assigned','In Progress')
       )
     ORDER BY c.Charger_ID
  `);

  // The mirror image of a stuck charger: a session is genuinely running, but
  // its charger is not marked in use, so the fleet view under-reports demand
  // and the stall looks bookable when a car is plugged into it.
  const [unmarkedBusyChargers] = await conn.query(`
    SELECT c.Charger_ID, c.Charger_Availability_Status
      FROM charger c
      JOIN charging_session cs
        ON cs.Charger_ID = c.Charger_ID
       AND cs.Session_Status = 'Active'
       AND cs.End_Time IS NULL
     WHERE c.Charger_Availability_Status NOT IN ('In Use', 'Out of Service')
     ORDER BY c.Charger_ID
  `);

  // Sessions billed for more energy than a car can physically accept.
  //
  // These predate the charging model in server/lib/charging.js, when energy was
  // estimated as a flat `power x hours`. A 350 kW stall left running for four
  // hours produced 618 kWh on one row — roughly eight car batteries — and the
  // driver was billed for all of it. The live code path is fixed; this repairs
  // the rows already written.
  const [impossibleEnergy] = await conn.query(`
    SELECT cs.Session_ID, cs.Energy_Consumed, cs.Total_Cost,
           c.Charger_Power_Capacity AS kw,
           TIMESTAMPDIFF(SECOND, cs.Start_Time, cs.End_Time) / 3600 AS hours
      FROM charging_session cs
      JOIN charger c ON c.Charger_ID = cs.Charger_ID
     WHERE cs.End_Time IS NOT NULL
       AND cs.Energy_Consumed > ?
     ORDER BY cs.Session_ID
  `, [MAX_SESSION_KWH]);

  const [staleSubscriptions] = await conn.query(`
    SELECT Subscription_ID, Status, Start_Date, End_Date
      FROM subscription
     WHERE Status <> 'Cancelled'
       AND Status <> CASE
         WHEN Start_Date > CURDATE() THEN 'Pending'
         WHEN End_Date < CURDATE() THEN 'Expired'
         ELSE 'Active'
       END
     ORDER BY Subscription_ID
  `);

  const [unpaidCompletedSessions] = await conn.query(`
    SELECT cs.Session_ID, cs.Session_Status,
           p.Payment_ID, p.Payment_Status, p.Payment_Method, p.Payment_Amount
      FROM charging_session cs
      JOIN payment p
        ON p.Session_ID = cs.Session_ID AND p.Payment_Type = 'Charging'
     WHERE cs.Session_Status = 'Completed'
       AND NOT EXISTS (
         SELECT 1 FROM payment ok
          WHERE ok.Session_ID = cs.Session_ID
            AND ok.Payment_Type = 'Charging'
            AND ok.Payment_Status = 'success'
       )
     ORDER BY cs.Session_ID
  `);

  const ids = [...INVOICE_RECOVERY_KEYS.keys()];
  const [missingInvoices] = await conn.query(`
    SELECT cs.Session_ID, cs.User_ID, cs.Total_Cost, cs.End_Time,
           p.Payment_ID, p.Created_Time
      FROM charging_session cs
      JOIN payment p
        ON p.Session_ID = cs.Session_ID
       AND p.Payment_Type = 'Charging'
       AND p.Payment_Status = 'success'
      LEFT JOIN invoice i ON i.Session_ID = cs.Session_ID
     WHERE cs.Session_ID IN (?) AND i.Invoice_ID IS NULL
     ORDER BY cs.Session_ID
  `, [ids]);

  return {
    stuckChargers,
    unmarkedBusyChargers,
    impossibleEnergy,
    orphanedOutOfService,
    staleSubscriptions,
    unpaidCompletedSessions,
    missingInvoices,
  };
}

async function validateRecoveryObjects(rows) {
  const missing = [];
  for (const row of rows) {
    const key = INVOICE_RECOVERY_KEYS.get(Number(row.Session_ID));
    if (!key) {
      missing.push(`no storage mapping for session ${row.Session_ID}`);
      continue;
    }
    try {
      await fs.access(path.join(storageRoot, ...key.split("/")));
    } catch {
      missing.push(`${key} is absent`);
    }
  }
  if (missing.length) throw new Error(`invoice recovery preflight failed: ${missing.join("; ")}`);
}

async function verify(conn) {
  const [[checks]] = await conn.query(`
    SELECT
      (SELECT COUNT(*) FROM wallet WHERE Wallet_Balance < 0) AS negative_wallets,
      (SELECT COUNT(*) FROM charging_session
        WHERE End_Time IS NOT NULL AND Energy_Consumed > 68) AS impossible_energy_sessions,
      (SELECT COUNT(*)
         FROM charger c
        WHERE c.Charger_Availability_Status = 'In Use'
          AND NOT EXISTS (
            SELECT 1 FROM charging_session cs
             WHERE cs.Charger_ID = c.Charger_ID
               AND cs.Session_Status = 'Active' AND cs.End_Time IS NULL
          )) AS stuck_chargers,
      (SELECT COUNT(*)
         FROM charger c
         JOIN charging_session cs
           ON cs.Charger_ID = c.Charger_ID
          AND cs.Session_Status = 'Active' AND cs.End_Time IS NULL
        WHERE c.Charger_Availability_Status NOT IN ('In Use', 'Out of Service')
       ) AS unmarked_busy_chargers,
      (SELECT COUNT(*)
         FROM charger c
        WHERE c.Charger_Availability_Status = 'Out of Service'
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_log m
             WHERE m.Charger_ID = c.Charger_ID
               AND m.Status IN ('Reported','Assigned','In Progress')
          )) AS orphaned_out_of_service,
      (SELECT COUNT(*)
         FROM subscription s
        WHERE s.Status <> 'Cancelled'
          AND s.Status <> CASE
            WHEN s.Start_Date > CURDATE() THEN 'Pending'
            WHEN s.End_Date < CURDATE() THEN 'Expired'
            ELSE 'Active'
          END) AS stale_subscriptions,
      (SELECT COUNT(*)
         FROM charging_session cs
        WHERE cs.Session_Status = 'Completed'
          AND EXISTS (
            SELECT 1 FROM payment p
             WHERE p.Session_ID = cs.Session_ID AND p.Payment_Type = 'Charging'
          )
          AND NOT EXISTS (
            SELECT 1 FROM payment ok
             WHERE ok.Session_ID = cs.Session_ID
               AND ok.Payment_Type = 'Charging'
               AND ok.Payment_Status = 'success'
          )) AS completed_without_successful_payment,
      (SELECT COUNT(*)
         FROM invoice i
        WHERE i.Session_ID BETWEEN 2102 AND 2111) AS recovered_invoice_rows
  `);
  return Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, Number(v)]));
}

async function main() {
  const conn = await mysql.createConnection(config);
  try {
    const before = await collect(conn);
    await validateRecoveryObjects(before.missingInvoices);
    const recoveryIds = [...INVOICE_RECOVERY_KEYS.keys()];
    const [[recoveryTarget]] = await conn.query(`
      SELECT COUNT(*) AS n
        FROM charging_session cs
       WHERE cs.Session_ID IN (?)
         AND EXISTS (
           SELECT 1 FROM payment p
            WHERE p.Session_ID = cs.Session_ID
              AND p.Payment_Type = 'Charging'
              AND p.Payment_Status = 'success'
         )
    `, [recoveryIds]);
    const expectedRecoveredInvoices = Number(recoveryTarget.n);

    const counts = Object.fromEntries(
      Object.entries(before).map(([key, rows]) => [key, rows.length])
    );

    // Split what this script FIXES from what it merely REPORTS.
    //
    // Unpaid completed sessions are a business exception, not a data defect: a
    // driver took energy and their payment failed. Listing them beside genuine
    // inconsistencies invited the obvious "so repair it" — and repairing it
    // meant cancelling sessions that really happened. They belong in the
    // operations manager's collections queue, not in a cleanup script.
    const { unpaidCompletedSessions, ...repairable } = counts;
    console.log("ChargeOps data repair preflight:", repairable);
    if (unpaidCompletedSessions > 0) {
      console.log(
        `
For information (not repaired): ${unpaidCompletedSessions} completed session(s) ` +
          `whose payment failed — uncollected revenue, left for the operations team.`
      );
    }

    if (!APPLY) {
      console.log("Dry run only. Use `npm run data:repair` to write a backup and apply.");
      return;
    }

    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = path.join(BACKUP_DIR, `data-repair-${stamp}.json`);
    const snapshot = {
      createdAt: new Date().toISOString(),
      database: config.database,
      reason: "Repair legacy charger, subscription, session-payment, and invoice inconsistencies",
      expectedRecoveredInvoices,
      before,
    };
    await fs.writeFile(backupPath, JSON.stringify(snapshot, jsonValue, 2), "utf8");

    await conn.beginTransaction();
    try {
      const [subscriptions] = await conn.query(`
        UPDATE subscription
           SET Status = CASE
             WHEN Start_Date > CURDATE() THEN 'Pending'
             WHEN End_Date < CURDATE() THEN 'Expired'
             ELSE 'Active'
           END
         WHERE Status <> 'Cancelled'
           AND Status <> CASE
             WHEN Start_Date > CURDATE() THEN 'Pending'
             WHEN End_Date < CURDATE() THEN 'Expired'
             ELSE 'Active'
           END
      `);

      const [chargers] = await conn.query(`
        UPDATE charger c
           SET c.Charger_Availability_Status = 'Available'
         WHERE c.Charger_Availability_Status = 'In Use'
           AND NOT EXISTS (
             SELECT 1 FROM charging_session cs
              WHERE cs.Charger_ID = c.Charger_ID
                AND cs.Session_Status = 'Active'
                AND cs.End_Time IS NULL
           )
      `);

      // Re-cost sessions that were billed for impossible energy.
      //
      // The cost is scaled by the same factor as the energy rather than
      // recomputed from scratch, which preserves whatever rate and membership
      // discount actually applied to that session. The matching payment row is
      // moved with it, because a payment that disagrees with its session is a
      // worse problem than the one being fixed.
      let energyRepaired = 0;
      for (const row of before.impossibleEnergy) {
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
          `UPDATE payment SET Payment_Amount = ?
            WHERE Session_ID = ? AND Payment_Type = 'Charging'`,
          [newCost, row.Session_ID]
        );
        await conn.query(
          `UPDATE invoice SET Amount = ? WHERE Session_ID = ?`,
          [newCost, row.Session_ID]
        );
        energyRepaired++;
      }

      // Mark chargers busy when a session is genuinely running on them.
      const [markedBusy] = await conn.query(`
        UPDATE charger c
          JOIN charging_session cs
            ON cs.Charger_ID = c.Charger_ID
           AND cs.Session_Status = 'Active'
           AND cs.End_Time IS NULL
           SET c.Charger_Availability_Status = 'In Use'
         WHERE c.Charger_Availability_Status NOT IN ('In Use', 'Out of Service')
      `);

      // Bring back chargers that are down with no open work order. Chargers
      // that DO have an open ticket stay out of service — a technician is
      // supposed to resolve those through the maintenance workflow, and
      // clearing them here would erase the very thing the demo shows off.
      const [recoveredChargers] = await conn.query(`
        UPDATE charger c
           SET c.Charger_Availability_Status = 'Available'
         WHERE c.Charger_Availability_Status = 'Out of Service'
           AND NOT EXISTS (
             SELECT 1 FROM maintenance_log m
              WHERE m.Charger_ID = c.Charger_ID
                AND m.Status IN ('Reported','Assigned','In Progress')
           )
      `);

      const [payments] = await conn.query(`
        UPDATE payment p
        JOIN charging_session cs ON cs.Session_ID = p.Session_ID
           SET p.Payment_Status = 'failed'
         WHERE p.Payment_Type = 'Charging'
           AND p.Payment_Status = 'pending'
           AND cs.Session_Status = 'Completed'
           AND p.Created_Time < NOW() - INTERVAL 1 DAY
      `);

      // A completed session whose payment failed is NOT corrupt data, and this
      // script used to cancel those sessions. That was wrong: cancelling says
      // the charging never happened, when what actually happened is that a
      // driver took energy and the payment did not go through. That is a
      // customer who owes money — an ordinary business exception every charging
      // network has, and something the operations manager should be able to see
      // and chase, not something a maintenance script should erase.
      //
      // They are reported by `npm run data:audit` as unpaid revenue and left
      // alone here.

      let invoicesInserted = 0;
      for (const row of before.missingInvoices) {
        const sessionId = Number(row.Session_ID);
        const storageKey = INVOICE_RECOVERY_KEYS.get(sessionId);
        const invoiceNumber = `INV-${new Date(row.End_Time).getFullYear()}-${String(sessionId).padStart(6, "0")}`;
        const [invoice] = await conn.query(`
          INSERT INTO invoice
            (Invoice_Number, Session_ID, User_ID, Payment_ID, Storage_Key, Amount, Generated_At)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE Session_ID = VALUES(Session_ID)
        `, [
          invoiceNumber,
          sessionId,
          row.User_ID,
          row.Payment_ID,
          storageKey,
          row.Total_Cost,
          row.Created_Time ?? row.End_Time,
        ]);
        invoicesInserted += invoice.affectedRows === 1 ? 1 : 0;
      }

      const details = {
        subscriptionsUpdated: subscriptions.affectedRows,
        chargersReleased: chargers.affectedRows,
        chargersMarkedBusy: markedBusy.affectedRows,
        sessionsRecosted: energyRepaired,
        chargersRecoveredFromOutOfService: recoveredChargers.affectedRows,
        stalePaymentsFailed: payments.affectedRows,
        invoicesRecovered: invoicesInserted,
        backupFile: path.basename(backupPath),
      };
      await conn.query(`
        INSERT INTO audit_log
          (Actor_Username, Actor_Role, Action, Entity_Type, Entity_ID, Details)
        VALUES ('data-repair-script', 'system', 'data.repaired', 'database', ?, CAST(? AS JSON))
      `, [config.database, JSON.stringify(details)]);

      const after = await verify(conn);
      const expected = {
        negative_wallets: 0,
        impossible_energy_sessions: 0,
        stuck_chargers: 0,
        unmarked_busy_chargers: 0,
        orphaned_out_of_service: 0,
        stale_subscriptions: 0,
        recovered_invoice_rows: expectedRecoveredInvoices,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (after[key] !== value) {
          throw new Error(`post-repair check ${key}: expected ${value}, got ${after[key]}`);
        }
      }

      await conn.commit();
      console.log("Repair committed:", details);
      console.log("Validation:", after);
      console.log(`Rollback snapshot: ${backupPath}`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Data repair failed: ${err.message}`);
  process.exitCode = 1;
});
