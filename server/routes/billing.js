// server/routes/billing.js — the finance inbox
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY FINANCE NEEDS A QUEUE, NOT A REPORT
// ═══════════════════════════════════════════════════════════════════════════
// A finance role built only from dashboards is a viewer with extra charts. The
// job is not looking at revenue; it is deciding things about money: does this
// membership start, is this top-up genuine, does this driver get their session
// refunded because the charger cut out at 40%.
//
// So finance gets the same shape of workflow as dispatch — an inbox of pending
// decisions, an owner for each outcome, and an audit trail — and for the same
// reason. Approving is the moment money moves; until then the request is inert,
// which is what makes it safe to leave the queue unattended overnight.
//
//   Pending ──approve──▶ Approved   subscription activated / wallet credited
//      │                            / refund paid, and a payment row written
//      └──reject──▶ Rejected        with a reason the driver can be told
//
// Every approval runs inside one transaction that both moves the money and
// records the decision. Half of that happening is the failure this design
// exists to prevent.
import { Router } from "express";
import { pool } from "../db.js";
import { allowRoles, ROLES } from "../auth.js";
import { writeAudit } from "../lib/audit.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";
import * as cache from "../adapters/cache.js";

const router = Router();

/** What a driver can ask for, and what approving it does. */
const REQUEST_TYPES = new Set([
  "subscription.new",
  "subscription.renew",
  "wallet.topup",
  "refund",
]);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/requests?status=Pending
// ─────────────────────────────────────────────────────────────────────────────

router.get("/requests", async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    const scopeConditions = [];
    const scopeParams = [];

    if (req.query.status) {
      conditions.push("br.Status = ?");
      params.push(req.query.status);
    }
    if (req.query.type) {
      conditions.push("br.Request_Type = ?");
      params.push(req.query.type);
      scopeConditions.push("br.Request_Type = ?");
      scopeParams.push(req.query.type);
    }
    if (req.query.search) {
      const clause =
        "(CONCAT(u.User_FName,' ',u.User_LName) LIKE ? OR u.User_Email LIKE ? OR CAST(br.Request_ID AS CHAR) LIKE ?)";
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      conditions.push(clause);
      params.push(q, q, q);
      scopeConditions.push(clause);
      scopeParams.push(q, q, q);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const scopeWhere = scopeConditions.length ? `WHERE ${scopeConditions.join(" AND ")}` : "";
    const pagination = paginationFrom(req.query, { defaultPageSize: 50, maxPageSize: 500 });

    const from = `
       FROM billing_request br
       JOIN user u ON u.User_ID = br.User_ID
       LEFT JOIN membership m ON m.Plan_ID = br.Plan_ID`;

    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${where}`, params);

    const [rows] = await pool.query(
      `SELECT br.Request_ID   AS id,
              br.User_ID      AS user_id,
              CONCAT(u.User_FName, ' ', u.User_LName) AS user_name,
              u.User_Email    AS user_email,
              br.Request_Type AS type,
              br.Amount       AS amount,
              br.Plan_ID      AS plan_id,
              m.Plan_Name     AS plan_name,
              m.Discount_Rate AS plan_discount,
              br.Session_ID   AS session_id,
              br.Status       AS status,
              br.Reason       AS reason,
              br.Requested_At AS requested_at,
              br.Requested_By AS requested_by,
              br.Reviewed_At  AS reviewed_at,
              br.Reviewed_By  AS reviewed_by,
              br.Review_Notes AS review_notes,
              br.Payment_ID   AS payment_id,
              w.Wallet_Balance AS wallet_balance
       ${from}
       LEFT JOIN wallet w ON w.User_ID = br.User_ID
       ${where}
       -- Pending first and oldest first: a queue is worked from the front, and
       -- the request that has waited longest is the one somebody is chasing.
       ORDER BY CASE br.Status WHEN 'Pending' THEN 0 ELSE 1 END,
                br.Requested_At ASC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );

    const [breakdown] = await pool.query(
      `SELECT br.Status AS status, COUNT(*) AS count ${from} ${scopeWhere} GROUP BY br.Status`,
      scopeParams
    );

    setPaginationHeaders(res, pagination, Number(countRow.total));
    res.setHeader(
      "X-Status-Counts",
      JSON.stringify(Object.fromEntries(breakdown.map((r) => [r.status, Number(r.count)])))
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/requests — a driver asks for something
// ─────────────────────────────────────────────────────────────────────────────
//
// Raised by operations on the driver's behalf (a phone call, an email), which
// is how these arrive in a business with no consumer app yet. Finance cannot
// raise one for themselves: whoever asks and whoever approves must be different
// people, or the approval means nothing.
router.post("/requests", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  const userId = Number(req.body?.userId);
  const type = String(req.body?.type || "");
  const planId = req.body?.planId == null ? null : Number(req.body.planId);
  const sessionId = req.body?.sessionId == null ? null : Number(req.body.sessionId);
  const reason = String(req.body?.reason || "").trim().slice(0, 500);

  if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId is required" });
  if (!REQUEST_TYPES.has(type)) {
    return res.status(400).json({ error: `type must be one of ${[...REQUEST_TYPES].join(", ")}` });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[driver]] = await conn.query(`SELECT User_ID FROM user WHERE User_ID = ?`, [userId]);
    if (!driver) {
      await conn.rollback();
      return res.status(404).json({ error: "driver not found" });
    }

    // The amount is derived, never taken from the client. A membership costs
    // what the plan costs and a refund is worth what the session was billed —
    // letting the caller name the figure would let them name any figure.
    let amount = 0;
    if (type === "subscription.new" || type === "subscription.renew") {
      const [[plan]] = await conn.query(
        `SELECT Monthly_Price FROM membership WHERE Plan_ID = ?`,
        [planId]
      );
      if (!plan) {
        await conn.rollback();
        return res.status(400).json({ error: "planId is required for a subscription request" });
      }
      amount = Number(plan.Monthly_Price);
    } else if (type === "refund") {
      const [[session]] = await conn.query(
        `SELECT Total_Cost, User_ID FROM charging_session WHERE Session_ID = ?`,
        [sessionId]
      );
      if (!session) {
        await conn.rollback();
        return res.status(400).json({ error: "sessionId is required for a refund" });
      }
      if (Number(session.User_ID) !== userId) {
        await conn.rollback();
        return res.status(400).json({ error: "that session belongs to a different driver" });
      }
      amount = Number(session.Total_Cost ?? 0);
    } else {
      // A top-up is the one case where the driver genuinely chooses the figure.
      amount = Number(req.body?.amount);
      if (!(amount > 0) || amount > 1000) {
        return await rollbackWith(conn, res, 400, "top-up amount must be between 0 and 1000");
      }
    }

    // One open request of a kind per driver, so a driver clicking twice does not
    // get two memberships and finance does not review the same thing twice.
    const [[duplicate]] = await conn.query(
      `SELECT Request_ID FROM billing_request
        WHERE User_ID = ? AND Request_Type = ? AND Status = 'Pending'`,
      [userId, type]
    );
    if (duplicate) {
      await conn.rollback();
      return res.status(409).json({
        error: "this driver already has a pending request of that type",
        requestId: duplicate.Request_ID,
      });
    }

    const [ins] = await conn.query(
      `INSERT INTO billing_request
         (User_ID, Request_Type, Amount, Plan_ID, Session_ID, Status, Reason, Requested_By)
       VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?)`,
      [userId, type, amount, planId, sessionId, reason || null, req.user.sub]
    );

    await writeAudit(
      {
        actor: req.user,
        action: "billing.requested",
        entityType: "billing_request",
        entityId: ins.insertId,
        details: { userId, type, amount },
      },
      conn
    );
    await conn.commit();
    cache.invalidate("billing:");

    res.status(201).json({ requestId: ins.insertId, type, amount, status: "Pending" });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

async function rollbackWith(conn, res, status, error) {
  await conn.rollback();
  return res.status(status).json({ error });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/requests/:id/approve — the money moves here
// ─────────────────────────────────────────────────────────────────────────────

router.post("/requests/:id/approve", allowRoles(ROLES.FINANCE), async (req, res, next) => {
  const id = Number(req.params.id);
  const notes = String(req.body?.notes || "").trim().slice(0, 500);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid request id" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the request and re-check its state. Two finance users clicking
    // approve at the same instant must not credit the wallet twice — the same
    // guarded transition the billing worker uses on a session.
    const [[request]] = await conn.query(
      `SELECT * FROM billing_request WHERE Request_ID = ? FOR UPDATE`,
      [id]
    );
    if (!request) return await rollbackWith(conn, res, 404, "request not found");
    if (request.Status !== "Pending") {
      return await rollbackWith(conn, res, 409, `this request was already ${request.Status}`);
    }

    const amount = Number(request.Amount);
    let paymentId = null;
    let outcome = {};

    if (request.Request_Type === "wallet.topup") {
      // The 'Wallet Top-Up' payment type still has a database trigger that
      // credits the wallet, so writing the payment IS the credit. Doing it
      // again here would double it.
      const [pay] = await conn.query(
        `INSERT INTO payment
           (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status, Created_Time)
         VALUES (?, 'Wallet Top-Up', ?, 'Credit Card', 'success', NOW())`,
        [request.User_ID, amount]
      );
      paymentId = pay.insertId;
      const [[wallet]] = await conn.query(
        `SELECT Wallet_Balance FROM wallet WHERE User_ID = ?`,
        [request.User_ID]
      );
      outcome = { walletBalance: Number(wallet?.Wallet_Balance ?? 0) };

    } else if (request.Request_Type === "refund") {
      // Refunds go back to the wallet rather than to the card: it is instant,
      // it needs no payment-processor integration, and the driver can spend it
      // on the charge that replaces the one that failed.
      await conn.query(
        `UPDATE wallet SET Wallet_Balance = Wallet_Balance + ? WHERE User_ID = ?`,
        [amount, request.User_ID]
      );
      const [pay] = await conn.query(
        `INSERT INTO payment
           (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status, Session_ID, Created_Time)
         VALUES (?, 'Charging', ?, 'Wallet', 'success', ?, NOW())
         ON DUPLICATE KEY UPDATE Payment_Amount = VALUES(Payment_Amount)`,
        [request.User_ID, 0, request.Session_ID]
      );
      paymentId = pay.insertId || null;
      outcome = { refunded: amount, toWallet: true };

    } else {
      // A membership. Extend an existing subscription rather than stacking a
      // second one, so a driver renewing does not end up with two active plans
      // and two discounts.
      const [[existing]] = await conn.query(
        `SELECT Subscription_ID, End_Date FROM subscription
          WHERE User_ID = ? AND Plan_ID = ? AND Status <> 'Cancelled'
          ORDER BY End_Date DESC LIMIT 1`,
        [request.User_ID, request.Plan_ID]
      );

      let subscriptionId;
      if (existing && new Date(existing.End_Date) >= new Date()) {
        await conn.query(
          `UPDATE subscription
              SET End_Date = DATE_ADD(End_Date, INTERVAL 30 DAY), Status = 'Active'
            WHERE Subscription_ID = ?`,
          [existing.Subscription_ID]
        );
        subscriptionId = existing.Subscription_ID;
        outcome = { extended: true, subscriptionId };
      } else {
        const [sub] = await conn.query(
          `INSERT INTO subscription (User_ID, Plan_ID, Start_Date, End_Date, Status)
           VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 30 DAY), 'Active')`,
          [request.User_ID, request.Plan_ID]
        );
        subscriptionId = sub.insertId;
        outcome = { created: true, subscriptionId };
      }

      const [pay] = await conn.query(
        `INSERT INTO payment
           (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status, Subscription_ID, Created_Time)
         VALUES (?, 'Subscription', ?, 'Credit Card', 'success', ?, NOW())`,
        [request.User_ID, amount, subscriptionId]
      );
      paymentId = pay.insertId;
    }

    await conn.query(
      `UPDATE billing_request
          SET Status = 'Approved', Reviewed_At = NOW(), Reviewed_By = ?,
              Review_Notes = ?, Payment_ID = ?
        WHERE Request_ID = ?`,
      [req.user.sub, notes || null, paymentId, id]
    );

    await writeAudit(
      {
        actor: req.user,
        action: "billing.approved",
        entityType: "billing_request",
        entityId: id,
        details: { type: request.Request_Type, amount, ...outcome },
      },
      conn
    );
    await conn.commit();
    cache.invalidate("billing:");
    cache.invalidate("dashboard:");

    res.json({ id, status: "Approved", amount, paymentId, ...outcome });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/requests/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
//
// A reason is mandatory. Somebody has to tell the driver why, and "rejected"
// on its own is not an answer anybody can act on.
router.post("/requests/:id/reject", allowRoles(ROLES.FINANCE), async (req, res, next) => {
  const id = Number(req.params.id);
  const notes = String(req.body?.notes || "").trim().slice(0, 500);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid request id" });
  if (notes.length < 3) return res.status(400).json({ error: "a reason is required to reject" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[request]] = await conn.query(
      `SELECT Status, Request_Type FROM billing_request WHERE Request_ID = ? FOR UPDATE`,
      [id]
    );
    if (!request) return await rollbackWith(conn, res, 404, "request not found");
    if (request.Status !== "Pending") {
      return await rollbackWith(conn, res, 409, `this request was already ${request.Status}`);
    }

    await conn.query(
      `UPDATE billing_request
          SET Status = 'Rejected', Reviewed_At = NOW(), Reviewed_By = ?, Review_Notes = ?
        WHERE Request_ID = ?`,
      [req.user.sub, notes, id]
    );
    await writeAudit(
      {
        actor: req.user,
        action: "billing.rejected",
        entityType: "billing_request",
        entityId: id,
        details: { type: request.Request_Type, notes },
      },
      conn
    );
    await conn.commit();
    cache.invalidate("billing:");

    res.json({ id, status: "Rejected" });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/summary — the finance headline
// ─────────────────────────────────────────────────────────────────────────────
//
// Three questions, in the order finance asks them: what is waiting on me, is
// the money arriving, and what has not been collected.
router.get("/summary", async (_req, res, next) => {
  try {
    const [[queue]] = await pool.query(
      `SELECT COUNT(*) AS pending,
              SUM(Amount) AS pending_value,
              MAX(TIMESTAMPDIFF(HOUR, Requested_At, NOW())) AS oldest_hours
         FROM billing_request WHERE Status = 'Pending'`
    );

    // ── A wallet top-up is not revenue ──────────────────────────────────────
    //
    // It is a customer deposit: money the platform is holding on somebody
    // else's behalf, and owes back to them either as electricity or as a
    // refund. On a balance sheet it is a liability, not income.
    //
    // Summing the payment table without asking what kind of payment each row
    // is DOUBLE COUNTS: the driver tops up $50 (counted once), then spends that
    // same $50 on charging (counted again). The seeded data has $16,205 of
    // top-ups against $7,563 of charging, so the error was more than twice the
    // size of the real number it was inflating.
    //
    // Revenue is therefore energy sold plus memberships. Deposits are reported
    // beside it under their own name, because a finance user does want to know
    // how much float they are holding — they just must not add it to income.
    const [[revenue]] = await pool.query(
      `SELECT
         SUM(CASE WHEN DATE(Created_Time) = CURDATE()
                   AND Payment_Type IN ('Charging','Subscription')
                  THEN Payment_Amount ELSE 0 END) AS today,
         SUM(CASE WHEN Created_Time > NOW() - INTERVAL 30 DAY
                   AND Payment_Type IN ('Charging','Subscription')
                  THEN Payment_Amount ELSE 0 END) AS last_30_days,
         SUM(CASE WHEN Payment_Type = 'Subscription'
                   AND Created_Time > NOW() - INTERVAL 30 DAY THEN Payment_Amount ELSE 0 END) AS subscription_30d,
         SUM(CASE WHEN Payment_Type = 'Charging'
                   AND Created_Time > NOW() - INTERVAL 30 DAY THEN Payment_Amount ELSE 0 END) AS charging_30d,
         SUM(CASE WHEN Payment_Type = 'Wallet Top-Up'
                   AND Created_Time > NOW() - INTERVAL 30 DAY THEN Payment_Amount ELSE 0 END) AS deposits_30d
       FROM payment WHERE Payment_Status = 'success'`
    );

    // What the platform is actually holding right now, across every wallet.
    // The running total of deposits taken minus energy paid for out of them.
    const [[float_]] = await pool.query(
      `SELECT IFNULL(SUM(Wallet_Balance), 0) AS held FROM wallet`
    );

    // Uncollected revenue: the driver took the energy and the payment failed.
    // Not a data fault — a debt, and finance's job.
    const [[unpaid]] = await pool.query(
      `SELECT COUNT(*) AS sessions, SUM(cs.Total_Cost) AS value
         FROM charging_session cs
        WHERE cs.Session_Status = 'Completed'
          AND EXISTS (SELECT 1 FROM payment p WHERE p.Session_ID = cs.Session_ID)
          AND NOT EXISTS (
            SELECT 1 FROM payment ok
             WHERE ok.Session_ID = cs.Session_ID
               -- A written-off debt is closed. It stays visible in the audit
               -- trail and in revenue reporting as money forgiven, but it is
               -- no longer work sitting in somebody's queue.
               AND ok.Payment_Status IN ('success', 'written_off'))`
    );

    res.json({
      inbox: {
        pending: Number(queue.pending) || 0,
        pendingValue: Number(queue.pending_value) || 0,
        oldestHours: Number(queue.oldest_hours) || 0,
      },
      revenue: {
        today: Number(revenue.today) || 0,
        last30Days: Number(revenue.last_30_days) || 0,
        subscription30d: Number(revenue.subscription_30d) || 0,
        charging30d: Number(revenue.charging_30d) || 0,
      },
      deposits: {
        last30Days: Number(revenue.deposits_30d) || 0,
        heldNow: Number(float_.held) || 0,
      },
      uncollected: {
        sessions: Number(unpaid.sessions) || 0,
        value: Number(unpaid.value) || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/reconciliation — does the money add up?
// ─────────────────────────────────────────────────────────────────────────────
//
// Every settled session should have exactly one successful payment and one
// invoice. Where those three counts disagree, something in the pipeline dropped
// a step, and finance is the function that notices.
router.get("/reconciliation", async (req, res, next) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
  try {
    // Seeded history is held to a different standard from what the application
    // settled, and the invoice column is why.
    //
    // Invoices are PDFs written by the files worker when a session settles.
    // Sessions that arrived in the seed dump predate the invoice table entirely
    // and can never have one — but the activity step spreads them across recent
    // dates, so a date filter alone pulls them into this window and reports 40
    // missing invoices a day, every day, forever. A finance screen that is
    // permanently red is a finance screen nobody reads.
    //
    // So the invoice column counts only sessions above the seed watermark
    // recorded at build time (the same watermark the doctor script uses), and
    // says how many rows it excluded rather than quietly dropping them.
    const [[mark]] = await pool.query(
      `SELECT IFNULL(MAX(CAST(Meta_Value AS UNSIGNED)), 0) AS v
         FROM app_meta WHERE Meta_Key = 'seed_max_session_id'`
    );
    const seedMax = Number(mark?.v) || 0;

    const [rows] = await pool.query(
      `SELECT DATE(cs.End_Time) AS date,
              COUNT(*) AS sessions,
              SUM(cs.Total_Cost) AS session_value,
              COUNT(DISTINCT p.Payment_ID) AS payments,
              COUNT(DISTINCT CASE WHEN cs.Session_ID > ? THEN cs.Session_ID END) AS invoiceable,
              COUNT(DISTINCT i.Invoice_ID) AS invoices
         FROM charging_session cs
         LEFT JOIN payment p ON p.Session_ID = cs.Session_ID AND p.Payment_Status = 'success'
         LEFT JOIN invoice i ON i.Session_ID = cs.Session_ID
        WHERE cs.Session_Status = 'Completed'
          AND cs.End_Time > NOW() - INTERVAL ? DAY
        GROUP BY DATE(cs.End_Time)
        ORDER BY date DESC`,
      [seedMax, days]
    );

    res.json(
      rows.map((r) => {
        const sessions = Number(r.sessions);
        const payments = Number(r.payments);
        const invoices = Number(r.invoices);
        const invoiceable = Number(r.invoiceable);
        return {
          date: r.date,
          sessions,
          sessionValue: Number(r.session_value) || 0,
          payments,
          invoices,
          // How many of that day's sessions the application settled, and so how
          // many invoices there should be. Below that count on a seeded day the
          // answer is legitimately zero.
          invoiceable,
          // Named rather than left for the reader to subtract: a gap here means
          // a driver charged and was not billed.
          unbilled: sessions - payments,
          missingInvoices: Math.max(0, invoiceable - invoices),
          balanced: sessions === payments && invoices >= invoiceable,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/uncollected — the debt, itemised
// ─────────────────────────────────────────────────────────────────────────────
//
// The summary tile says "$533 uncollected across 52 sessions" and that is where
// it ended: a number nobody can act on. Chasing a debt means knowing which
// driver, which session, how much, and how long ago — a total is a symptom
// report, not a worklist.
//
// A session lands here when the energy was delivered and every payment attempt
// against it failed. That is a card decline, not a data fault, and it is
// finance's job rather than an engineering one.
router.get("/uncollected", async (req, res, next) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
  try {
    const [rows] = await pool.query(
      `SELECT cs.Session_ID    AS session_id,
              cs.User_ID       AS user_id,
              CONCAT(u.User_FName, ' ', u.User_LName) AS user_name,
              u.User_Email     AS user_email,
              s.Station_Name   AS station_name,
              cs.Charger_ID    AS charger_id,
              cs.End_Time      AS ended_at,
              cs.Energy_Consumed AS kwh,
              cs.Total_Cost    AS amount,
              DATEDIFF(NOW(), cs.End_Time) AS days_outstanding,
              COUNT(p.Payment_ID) AS attempts,
              MAX(p.Created_Time) AS last_attempt,
              w.Wallet_Balance AS wallet_balance
         FROM charging_session cs
         JOIN user u    ON u.User_ID = cs.User_ID
         JOIN charger c ON c.Charger_ID = cs.Charger_ID
         JOIN station s ON s.Station_ID = c.Station_ID
         LEFT JOIN wallet w ON w.User_ID = cs.User_ID
         JOIN payment p ON p.Session_ID = cs.Session_ID
        WHERE cs.Session_Status = 'Completed'
          AND NOT EXISTS (
            SELECT 1 FROM payment ok
             WHERE ok.Session_ID = cs.Session_ID
               -- A written-off debt is closed. It stays visible in the audit
               -- trail and in revenue reporting as money forgiven, but it is
               -- no longer work sitting in somebody's queue.
               AND ok.Payment_Status IN ('success', 'written_off'))
        GROUP BY cs.Session_ID
        -- Oldest first: a debt gets harder to collect the longer it sits, and
        -- the queue should be worked from the end that is going cold.
        ORDER BY cs.End_Time ASC
        LIMIT ?`,
      [limit]
    );

    res.json(
      rows.map((r) => ({
        ...r,
        kwh: Number(r.kwh) || 0,
        amount: Number(r.amount) || 0,
        attempts: Number(r.attempts) || 0,
        daysOutstanding: Number(r.days_outstanding) || 0,
        walletBalance: r.wallet_balance == null ? null : Number(r.wallet_balance),
        // Whether the driver could pay this off from the balance they already
        // hold. If they can, this is a retry rather than a collections case.
        coveredByWallet: r.wallet_balance != null && Number(r.wallet_balance) >= Number(r.amount),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/revenue-trend?days=30 — where the money comes from
// ─────────────────────────────────────────────────────────────────────────────
//
// Split by type on purpose. A single revenue line hides the thing a finance
// user is actually watching: energy sales are the business and memberships are
// a small, steady add-on, so the two moving differently is a signal. Deposits
// are charted alongside and never summed in — they are money held, not earned.
router.get("/revenue-trend", async (req, res, next) => {
  const days = Math.max(2, Math.min(Number(req.query.days) || 30, 365));
  try {
    const [rows] = await pool.query(
      `WITH RECURSIVE calendar AS (
         SELECT CURDATE() - INTERVAL ? DAY AS d
         UNION ALL
         SELECT d + INTERVAL 1 DAY FROM calendar WHERE d < CURDATE()
       )
       SELECT calendar.d AS date,
              COALESCE(SUM(CASE WHEN p.Payment_Type = 'Charging'     THEN p.Payment_Amount END), 0) AS charging,
              COALESCE(SUM(CASE WHEN p.Payment_Type = 'Subscription' THEN p.Payment_Amount END), 0) AS membership,
              COALESCE(SUM(CASE WHEN p.Payment_Type = 'Wallet Top-Up' THEN p.Payment_Amount END), 0) AS deposits,
              COUNT(CASE WHEN p.Payment_Type = 'Charging' THEN 1 END) AS charging_count
         FROM calendar
         LEFT JOIN payment p
           ON DATE(p.Created_Time) = calendar.d
          AND p.Payment_Status = 'success'
        GROUP BY calendar.d
        ORDER BY calendar.d`,
      [days]
    );

    res.json(
      rows.map((r) => ({
        date: r.date,
        charging: Number(r.charging) || 0,
        membership: Number(r.membership) || 0,
        deposits: Number(r.deposits) || 0,
        chargingCount: Number(r.charging_count) || 0,
        revenue: (Number(r.charging) || 0) + (Number(r.membership) || 0),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// COLLECTIONS — what finance can actually DO about a debt
// ═════════════════════════════════════════════════════════════════════════════
//
// Listing the debt beside the driver's wallet balance and stopping there put
// the decision on screen and left the doing somewhere else. There are only two
// honest outcomes for an uncollected session, and which one applies is decided
// by a number already on the row:
//
//   balance covers it   → take it. The money is there and it is owed.
//   balance does not    → you cannot collect what is not there. Either wait
//                         for a top-up, or write it off.
//
// The third thing a system like this could do — suspend the account until it
// is settled — is deliberately not here. It is a customer-relations decision
// with a support conversation attached, not a button on a finance screen.
//
// Both actions are FINANCE only and both write an audit entry. Writing off a
// debt is forgiving money; it should be as traceable as approving a refund.

/**
 * Settle one session from the driver's wallet.
 *
 * There is one payment row per session — a unique index enforces it — so this
 * updates the failed attempt rather than adding a second. Adding one would
 * make the session look billed twice to every report that counts payments.
 */
router.post("/uncollected/:sessionId/retry", allowRoles(ROLES.FINANCE), async (req, res, next) => {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId)) return res.status(400).json({ error: "invalid session id" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the session first, then the wallet, and always in that order.
    // Two finance users retrying different sessions for the same driver would
    // otherwise be able to take the same balance twice.
    const [[session]] = await conn.query(
      `SELECT cs.Session_ID, cs.User_ID, cs.Total_Cost AS amount
         FROM charging_session cs
        WHERE cs.Session_ID = ? AND cs.Session_Status = 'Completed'
        FOR UPDATE`,
      [sessionId]
    );
    if (!session) return await rollbackWith(conn, res, 404, "session not found or not settled");

    const [[payment]] = await conn.query(
      `SELECT Payment_ID, Payment_Status FROM payment WHERE Session_ID = ? FOR UPDATE`,
      [sessionId]
    );
    if (!payment) return await rollbackWith(conn, res, 404, "no payment attempt on that session");
    if (payment.Payment_Status === "success") {
      return await rollbackWith(conn, res, 409, "that session has already been paid");
    }
    if (payment.Payment_Status === "written_off") {
      return await rollbackWith(conn, res, 409, "that debt was written off");
    }

    const [[wallet]] = await conn.query(
      `SELECT Wallet_ID, Wallet_Balance AS balance FROM wallet WHERE User_ID = ? FOR UPDATE`,
      [session.User_ID]
    );
    const amount = Number(session.amount);
    const balance = Number(wallet?.balance ?? 0);

    // Refuse rather than overdraw. A negative wallet is one of the invariants
    // the doctor script asserts, and "the balance was short" is a fact finance
    // needs told plainly so they can pick the other branch.
    if (!wallet || balance + 0.005 < amount) {
      return await rollbackWith(
        conn,
        res,
        409,
        `balance is ${balance.toFixed(2)}, short of ${amount.toFixed(2)} by ${(amount - balance).toFixed(2)}`
      );
    }

    await conn.query(
      `UPDATE wallet SET Wallet_Balance = Wallet_Balance - ? WHERE Wallet_ID = ?`,
      [amount, wallet.Wallet_ID]
    );
    await conn.query(
      `UPDATE payment
          SET Payment_Status = 'success',
              Payment_Method = 'Wallet',
              Payment_Amount = ?,
              Created_Time = NOW()
        WHERE Payment_ID = ?`,
      [amount, payment.Payment_ID]
    );

    await writeAudit(
      {
        actor: req.user,
        action: "billing.debt_collected",
        entityType: "charging_session",
        entityId: sessionId,
        details: { amount, from: "wallet", balanceBefore: balance, balanceAfter: balance - amount },
      },
      conn
    );

    await conn.commit();
    cache.invalidate("billing:");
    cache.invalidate("dashboard:");
    res.json({
      sessionId,
      collected: amount,
      balanceAfter: Number((balance - amount).toFixed(2)),
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

/**
 * Give up on a debt, on the record.
 *
 * Chasing $2.08 costs more than $2.08, and pretending a receivable is still
 * collectable is how a ledger drifts away from reality. Written off is a third
 * payment state rather than a deletion: the session keeps its history, the
 * money is visibly forgiven rather than quietly missing, and the reason is
 * attached to whoever decided it.
 */
router.post("/uncollected/:sessionId/write-off", allowRoles(ROLES.FINANCE), async (req, res, next) => {
  const sessionId = Number(req.params.sessionId);
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!Number.isInteger(sessionId)) return res.status(400).json({ error: "invalid session id" });
  if (reason.length < 3) {
    return res.status(400).json({ error: "a reason is required to write off a debt" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[payment]] = await conn.query(
      `SELECT p.Payment_ID, p.Payment_Status, cs.Total_Cost AS amount
         FROM payment p
         JOIN charging_session cs ON cs.Session_ID = p.Session_ID
        WHERE p.Session_ID = ? FOR UPDATE`,
      [sessionId]
    );
    if (!payment) return await rollbackWith(conn, res, 404, "no payment attempt on that session");
    if (payment.Payment_Status === "success") {
      return await rollbackWith(conn, res, 409, "that session was paid — nothing to write off");
    }
    if (payment.Payment_Status === "written_off") {
      return await rollbackWith(conn, res, 409, "that debt was already written off");
    }

    await conn.query(
      `UPDATE payment SET Payment_Status = 'written_off' WHERE Payment_ID = ?`,
      [payment.Payment_ID]
    );
    await writeAudit(
      {
        actor: req.user,
        action: "billing.debt_written_off",
        entityType: "charging_session",
        entityId: sessionId,
        details: { amount: Number(payment.amount), reason },
      },
      conn
    );

    await conn.commit();
    cache.invalidate("billing:");
    res.json({ sessionId, writtenOff: Number(payment.amount), reason });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

export default router;
