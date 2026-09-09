// server/routes/sessions.js
import { Router } from "express";
import { pool } from "../db.js";
import { sendMessageBatch, sendMessageTx, QUEUES } from "../adapters/queue.js";
// Imported only for the ?sync=1 comparison path below - normally this module is
// reached through a worker, never through an HTTP request.
import { handleBilling } from "../workers/handlers/billing.js";
import * as cache from "../adapters/cache.js";
import { energyDeliveredKwh } from "../lib/charging.js";
import { allowRoles, ROLES } from "../auth.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";

const router = Router();

// GET /api/sessions?days=30&status=Completed
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    const days = Number(req.query.days);
    if (days && days > 0) {
      conditions.push("cs.Start_Time >= DATE_SUB(NOW(), INTERVAL ? DAY)");
      params.push(days);
    }
    // Scope conditions exclude the status filter, so the status breakdown can
    // be computed over the same window the user is looking at without being
    // collapsed to whichever status they picked.
    const scopeConditions = [...conditions];
    const scopeParams = [...params];

    if (req.query.status) {
      conditions.push("cs.Session_Status = ?");
      params.push(req.query.status);
    }
    if (req.query.search) {
      const clause =
        "(CONCAT(u.User_FName, ' ', u.User_LName) LIKE ? OR st.Station_Name LIKE ? OR CAST(cs.Session_ID AS CHAR) LIKE ?)";
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      conditions.push(clause);
      params.push(q, q, q);
      scopeConditions.push(clause);
      scopeParams.push(q, q, q);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const pagination = paginationFrom(req.query, { defaultPageSize: 250, maxPageSize: 1000 });
    const from = `
       FROM charging_session cs
       JOIN user u     ON u.User_ID     = cs.User_ID
       JOIN charger c  ON c.Charger_ID  = cs.Charger_ID
       JOIN station st ON st.Station_ID = c.Station_ID`;

    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${where}`, params);

    const [rows] = await pool.query(
      `SELECT cs.Session_ID  AS id,
              cs.User_ID     AS user_id,
              CONCAT(u.User_FName, ' ', u.User_LName) AS user_name,
              c.Station_ID   AS station_id,
              st.Station_Name AS station_name,
              cs.Charger_ID  AS charger_id,
              cs.Start_Time  AS started_at,
              cs.End_Time    AS ended_at,
              cs.Energy_Consumed AS kwh,
              cs.Total_Cost      AS cost_usd,
              cs.Session_Status  AS status,
              -- Carried so a running session can be costed live. A settled
              -- session already has its own rate stored on the row; an active
              -- one has to fall back to the charger's current price.
              c.Charger_Power_Capacity AS charger_kw,
              COALESCE(cs.Session_Rate_Per_kWh, c.Charging_Rate_Per_kWh) AS rate_per_kwh
       ${from}
       ${where}
       -- Newest first for history; OLDEST first when looking at what is
       -- running now.
       --
       -- Those are opposite questions. For settled sessions "what happened
       -- recently" is the useful order. For live ones it is the worst possible
       -- order: at this fleet's arrival rate a page holds about two minutes of
       -- arrivals, so newest-first fills the whole first screen with cars that
       -- plugged in seconds ago — every row reading 0 kWh and $0.00, which
       -- looks like a broken page rather than a busy network.
       --
       -- Oldest-first puts the sessions closest to finishing at the top, which
       -- is also the operational question: which stalls are about to free up.
       ORDER BY cs.Start_Time ${req.query.status === "Active" ? "ASC" : "DESC"}
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    const scopeWhere = scopeConditions.length ? `WHERE ${scopeConditions.join(" AND ")}` : "";
    const [breakdown] = await pool.query(
      `SELECT cs.Session_Status AS status, COUNT(*) AS count ${from} ${scopeWhere}
        GROUP BY cs.Session_Status`,
      scopeParams
    );

    setPaginationHeaders(res, pagination, Number(countRow.total));
    res.setHeader(
      "X-Status-Counts",
      JSON.stringify(Object.fromEntries(breakdown.map((r) => [r.status, Number(r.count)])))
    );
    res.json(rows.map(withLiveEstimate));
  } catch (err) {
    next(err);
  }
});

/**
 * Attach a running energy and cost estimate to a session that is still charging.
 *
 * A session in progress has no Energy_Consumed and no Total_Cost, because both
 * are only settled when the driver unplugs and the billing worker runs. Showing
 * a blank there is accurate but unhelpful: everything needed to estimate the
 * bill is already known — the charger's power and price, and how long the car
 * has been plugged in — which is exactly what the display on a real charger
 * shows you while it works.
 *
 * These are clearly marked `estimated`. The authoritative figures are the ones
 * the billing worker writes from the meter reading; this is what the number
 * looks like on the way there.
 */
function withLiveEstimate(row) {
  const running = row.status === "Active" && row.ended_at == null;
  if (!running) return stripInternals(row);

  const hours = Math.max(0, (Date.now() - new Date(row.started_at).getTime()) / 3_600_000);
  const kwh = energyDeliveredKwh(row.charger_kw, hours);
  const rate = Number(row.rate_per_kwh) || 0;

  return stripInternals({
    ...row,
    estimated: true,
    elapsed_minutes: Math.round(hours * 60),
    estimated_kwh: kwh,
    // Gross of any membership discount, which the billing worker applies when
    // it settles. Quoting the discount live would mean re-deriving the driver's
    // plan on every row of every page.
    estimated_cost_usd: Number((kwh * rate).toFixed(2)),
  });
}

/** Drop the columns that exist only to feed the estimate. */
function stripInternals({ charger_kw, rate_per_kwh, ...rest }) {
  return rest;
}

// GET /api/sessions/count-by-day?days=30
router.get("/count-by-day", async (req, res, next) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
  try {
    const [rows] = await pool.query(
      `SELECT DATE(Start_Time) AS date, COUNT(*) AS count
       FROM charging_session
       WHERE Start_Time >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY DATE(Start_Time)
       ORDER BY date ASC`,
      [days]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WRITE PATH - where the billing trigger used to fire
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/sessions/start   { chargerId, userId }
//
// Starting a session is the counterpart to stopping one, and it is deliberately
// SYNCHRONOUS. Nothing here can be deferred: the driver is standing at the
// charger and needs to know within a second whether the stall is theirs.
//
// It is also cheap — one INSERT and one guarded UPDATE — so there is nothing to
// gain by queueing it. "Put everything on a queue" is not the lesson; "put the
// slow, deferrable, retryable work on a queue" is.
//
// The charger occupancy UPDATE used to be done by trg_session_after_insert_logic.
// That trigger also inserted a payment row, which is why it had to go; the half
// of it that was genuine state management lives here now.
router.post("/start", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  const chargerId = Number(req.body?.chargerId);
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(chargerId) || !Number.isInteger(userId)) {
    return res.status(400).json({ error: "chargerId and userId are required" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Claim the charger first. The status check inside the UPDATE is what makes
    // this safe under contention: two drivers tapping the same stall at the
    // same moment both run this statement, but only one of them matches a row.
    const [claim] = await conn.query(
      `UPDATE charger SET Charger_Availability_Status = 'In Use'
        WHERE Charger_ID = ? AND Charger_Availability_Status IN ('Available','Reserved')`,
      [chargerId]
    );
    if (claim.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ error: "charger is not available" });
    }

    const [ins] = await conn.query(
      `INSERT INTO charging_session (Charger_ID, User_ID, Start_Time, Session_Status)
       VALUES (?, ?, NOW(), 'Active')`,
      [chargerId, userId]
    );

    await conn.commit();
    cache.invalidate("chargers:");
    cache.invalidate("dashboard:");

    res.status(201).json({ sessionId: ins.insertId, chargerId, status: "Active" });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/sessions/:id/stop
//
// The endpoint the driver's app calls when they unplug. Compare it with what
// the EDS 6343 version did (server/sql/02_move_billing_out_of_triggers.sql):
//
//   BEFORE  UPDATE ... SET End_Time = NOW()
//             -> trigger computes energy, rate, discount, total
//             -> trigger INSERTs a payment row
//             -> trigger UPDATEs the wallet
//           ...and only now does the request return.   ~80 ms, and all of it
//           inside a single database transaction that cannot be retried.
//
//   AFTER   UPDATE ... SET End_Time = NOW(), Session_Status stays 'Active'
//             -> enqueue { sessionId }
//             -> 202 Accepted                          ~5 ms
//
// The bill is computed by the billing worker moments later. The driver sees
// "session ended" immediately; the receipt PDF lands in their account when the
// worker gets to it. Nothing about that is worse for the user, and everything
// about it is better under load.
router.post("/:id/stop", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ error: "invalid session id" });
  }

  const conn = await pool.getConnection();
  let released = false;
  try {
    await conn.beginTransaction();

    // The WHERE clause is the guard: only a session that is still running can
    // be stopped, so a double-tap on "stop charging" enqueues exactly one
    // billing job instead of two.
    const [result] = await conn.query(
      `UPDATE charging_session
          SET End_Time = COALESCE(End_Time, NOW()), Session_Status = 'Active'
        WHERE Session_ID = ? AND Session_Status = 'Active' AND End_Time IS NULL`,
      [sessionId]
    );

    if (result.affectedRows === 0) {
      const [[existing]] = await conn.query(
        `SELECT Session_Status FROM charging_session WHERE Session_ID = ?`,
        [sessionId]
      );
      await conn.rollback();
      if (!existing) return res.status(404).json({ error: "session not found" });
      return res.status(409).json({ error: `session already ${existing.Session_Status}` });
    }

    // Free the charger straight away - that is a one-row UPDATE and the driver
    // is standing there waiting to leave. Only work that can wait gets queued.
    await conn.query(
      `UPDATE charger SET Charger_Availability_Status = 'Available'
        WHERE Charger_ID = (SELECT Charger_ID FROM charging_session WHERE Session_ID = ?)
          AND Charger_Availability_Status = 'In Use'`,
      [sessionId]
    );

    // ── The comparison mode ─────────────────────────────────────────────────
    // ?sync=1 runs the billing work INSIDE this request, the way the trigger
    // used to. It exists purely so the load generator can measure both designs
    // against the same database on the same machine (`npm run loadtest -- --sync`).
    // Never use this path in earnest - it is the control group, not a feature.
    if (req.query.sync === "1") {
      await conn.commit();
      conn.release();
      released = true;
      const result = await handleBilling({ sessionId });
      return res.json({ sessionId, mode: "sync", ...result });
    }

    // The session end, charger release, and queue publication are one commit.
    // A database error can no longer leave an ended session without a job.
    const jobId = await sendMessageTx(conn, QUEUES.BILLING, { sessionId });
    await conn.commit();

    res.status(202).json({
      sessionId,
      jobId,
      status: "Active",
      message: "Session ended. Billing is running asynchronously.",
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (!released) conn.release();
  }
});

// POST /api/sessions/bill-pending
//
// Enqueue a billing job for every session still sitting in 'Active'. Two uses:
// a recovery sweep after an outage, and the one-click way to create a big
// backlog on stage without running the load generator.
router.post("/bill-pending", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.body?.limit) || 500, 5000);
    const [rows] = await pool.query(
      `SELECT Session_ID FROM charging_session
        WHERE Session_Status = 'Active' AND End_Time IS NOT NULL
        ORDER BY Session_ID LIMIT ?`,
      [limit]
    );

    const enqueued = await sendMessageBatch(
      QUEUES.BILLING,
      rows.map((r) => ({ sessionId: r.Session_ID }))
    );

    res.status(202).json({ enqueued });
  } catch (err) {
    next(err);
  }
});

export default router;
