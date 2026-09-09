// server/workers/handlers/billing.js
//
// ═════════════════════════════════════════════════════════════════════════════
// THE TRIGGER, REWRITTEN AS A WORKER
// ═════════════════════════════════════════════════════════════════════════════
// This file contains the logic that used to live in
// `trg_charging_session_after_update` in the EDS 6343 database project. See
// server/sql/02_move_billing_out_of_triggers.sql for the full before/after.
//
// What it now does, per job:
//   1. lock the session row and check it still needs billing  (idempotency)
//   2. work out energy delivered and the rate that applies
//   3. apply the user's active membership discount
//   4. take the money: wallet first, card as fallback
//   5. mark the session Completed and enqueue an invoice job atomically
//   6. let that child job render/store the PDF independently
//
// The invoice step is something a trigger physically could not do - you cannot open
// a file, call an HTTP API, or write to S3 from inside mysqld.
//
// ═════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY - THE ONE THING EVERY QUEUE FORCES YOU TO GET RIGHT
// ═════════════════════════════════════════════════════════════════════════════
// SQS, and our local queue, guarantee AT-LEAST-ONCE delivery, not exactly-once.
// A worker can compute the bill, charge the wallet, and then die before it
// acknowledges the message. The visibility timeout expires, another worker
// picks the same job up, and unless we defend against it the customer is
// charged twice.
//
// The defence here is a guarded state transition, all inside one transaction:
//
//     SELECT ... WHERE Session_ID = ? FOR UPDATE      -- serialise on the row
//     if (Session_Status !== 'Active') -> already billed, return quietly
//
// The row lock means two concurrent workers cannot both pass the check, and the
// status check means a redelivery after a successful run is a no-op. This is
// why "make the handler idempotent" is the first rule of queue-based design,
// and it is worth saying out loud in the demo.
import crypto from "node:crypto";
import { pool } from "../../db.js";
import { putObject } from "../../adapters/storage.js";
import { sendMessageTx, QUEUES } from "../../adapters/queue.js";
import { renderInvoicePdf } from "../../lib/invoice.js";
import { energyDeliveredKwh } from "../../lib/charging.js";
import * as cache from "../../adapters/cache.js";

/**
 * Handle one billing job.
 *
 * @param {{sessionId:number, endTime?:string}} payload
 */
export async function handleBilling(payload) {
  // The billing queue carries related job types. Invoice rendering is its own
  // retryable job so a PDF failure can never replay a wallet debit.
  if (payload?.type === "invoice.generate") {
    return handleInvoiceGenerate(payload);
  }
  if (payload?.type === "subscription.charge") {
    return handleSubscriptionCharge(payload);
  }

  const sessionId = Number(payload?.sessionId);
  if (!Number.isInteger(sessionId)) {
    // A malformed payload will never succeed, no matter how often we retry it.
    // Throwing sends it down the retry path and ultimately to the dead-letter
    // queue, where a human can look at it - which is the correct outcome.
    throw new Error(`billing: invalid payload ${JSON.stringify(payload)}`);
  }

  let result = null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── 1. Lock the session and re-check it still needs work ────────────────
    const [[session]] = await conn.query(
      `SELECT cs.Session_ID, cs.User_ID, cs.Charger_ID, cs.Start_Time, cs.End_Time,
              cs.Energy_Consumed, cs.Session_Rate_Per_kWh, cs.Total_Cost, cs.Session_Status,
              c.Charging_Rate_Per_kWh, c.Charger_Power_Capacity, c.Station_ID,
              st.Station_Name, st.Station_City, st.Station_State,
              u.User_FName, u.User_LName, u.User_Email
         FROM charging_session cs
         JOIN charger c  ON c.Charger_ID  = cs.Charger_ID
         JOIN station st ON st.Station_ID = c.Station_ID
         JOIN user u     ON u.User_ID     = cs.User_ID
        WHERE cs.Session_ID = ?
        FOR UPDATE`,
      [sessionId]
    );

    if (!session) throw new Error(`billing: session ${sessionId} not found`);

    if (session.Session_Status !== "Active") {
      // Already billed by an earlier delivery of this same message. Acknowledge
      // and move on - this is the happy path for a duplicate, not an error.
      await conn.commit();
      return { skipped: true, reason: `session already ${session.Session_Status}` };
    }

    // ── 2. Energy and rate ──────────────────────────────────────────────────
    const endTime = session.End_Time ?? new Date(payload.endTime ?? Date.now());
    const hours = Math.max(
      0,
      (new Date(endTime).getTime() - new Date(session.Start_Time).getTime()) / 3_600_000
    );

    // If the meter reported a reading, always trust it. Only estimate when the
    // charger never sent one (which is what the telemetry stream is for).
    //
    // The estimate goes through the shared charging model rather than a flat
    // `power × hours` product. Nameplate power is a peak the charger holds only
    // briefly, and no session can deliver more energy than the battery can
    // hold — a 350 kW stall left running for four hours would otherwise bill
    // the driver for 1190 kWh, about fifteen car batteries. See
    // server/lib/charging.js.
    const energyKwh =
      session.Energy_Consumed != null
        ? Number(session.Energy_Consumed)
        : energyDeliveredKwh(session.Charger_Power_Capacity, hours);

    // Lock in the rate that was in effect for this session. Storing it on the
    // row (rather than joining to charger at report time) means a later price
    // change cannot silently rewrite history - the same reason invoices store
    // the price, not a pointer to the price.
    const rate =
      session.Session_Rate_Per_kWh != null
        ? Number(session.Session_Rate_Per_kWh)
        : Number(session.Charging_Rate_Per_kWh);

    // ── 3. Membership discount ──────────────────────────────────────────────
    const [[member]] = await conn.query(
      `SELECT m.Plan_Name, m.Discount_Rate
         FROM subscription s
         JOIN membership m ON m.Plan_ID = s.Plan_ID
        WHERE s.User_ID = ?
          AND s.Status <> 'Cancelled'
          AND DATE(?) BETWEEN s.Start_Date AND s.End_Date
        ORDER BY m.Discount_Rate DESC
        LIMIT 1`,
      [session.User_ID, session.Start_Time]
    );

    const discountRate = member ? Number(member.Discount_Rate) : 0;
    const grossCost = energyKwh * rate;
    const discountAmount = Number((grossCost * (discountRate / 100)).toFixed(2));
    const totalCost = Number((grossCost - discountAmount).toFixed(2));

    // ── 4. Take the money ───────────────────────────────────────────────────
    // Wallet first (it is prepaid, so it is cheapest for the operator), card as
    // fallback. The wallet row is locked FOR UPDATE so two sessions ending at
    // the same instant cannot both read the same balance and overdraw it - the
    // classic lost-update race, and the reason the CHECK constraint
    // `Wallet_Balance >= 0` alone is not enough.
    const [[wallet]] = await conn.query(
      `SELECT Wallet_ID, Wallet_Balance FROM wallet WHERE User_ID = ? FOR UPDATE`,
      [session.User_ID]
    );

    let paymentMethod = "Credit Card";
    if (wallet && Number(wallet.Wallet_Balance) >= totalCost) {
      await conn.query(
        `UPDATE wallet SET Wallet_Balance = Wallet_Balance - ? WHERE Wallet_ID = ?`,
        [totalCost, wallet.Wallet_ID]
      );
      paymentMethod = "Wallet";
    }

    // ── 5. Close out the session ────────────────────────────────────────────
    await conn.query(
      `UPDATE charging_session
          SET End_Time             = COALESCE(End_Time, ?),
              Energy_Consumed      = ?,
              Session_Rate_Per_kWh = ?,
              Total_Cost           = ?,
              Session_Status       = 'Completed'
        WHERE Session_ID = ?`,
      [new Date(endTime), energyKwh, rate, totalCost, sessionId]
    );

    const [payRes] = await conn.query(
      `INSERT INTO payment
         (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status,
          Session_ID, Subscription_ID, Created_Time)
       VALUES (?, 'Charging', ?, ?, 'success', ?, NULL, ?)`,
      [session.User_ID, totalCost, paymentMethod, sessionId, new Date(endTime)]
    );
    const paymentId = payRes.insertId;

    const invoiceNumber = `INV-${new Date(endTime).getFullYear()}-${String(sessionId).padStart(6, "0")}`;
    const invoiceInput = {
      invoiceNumber,
      sessionId,
      paymentId,
      user: {
        id: session.User_ID,
        name: `${session.User_FName} ${session.User_LName}`,
        email: session.User_Email,
      },
      station: {
        name: session.Station_Name,
        city: session.Station_City,
        state: session.Station_State,
      },
      chargerId: session.Charger_ID,
      startTime: session.Start_Time,
      endTime,
      hours,
      energyKwh,
      rate,
      grossCost: Number(grossCost.toFixed(2)),
      planName: member?.Plan_Name ?? null,
      discountRate,
      discountAmount,
      totalCost,
      paymentMethod,
    };

    // The payment, completed session, and follow-up invoice job are one atomic
    // commit. Once money is recorded, an independently retryable invoice job is
    // guaranteed to exist, even if the worker dies immediately after commit.
    const invoiceJobId = await sendMessageTx(conn, QUEUES.BILLING, {
      type: "invoice.generate",
      invoiceInput,
    });

    await conn.commit();
    result = { sessionId, totalCost, paymentMethod, energyKwh, invoiceNumber, invoiceJobId };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  // Revenue tiles are now stale.
  cache.invalidate("dashboard:");

  return result;
}

/**
 * Render the invoice PDF, put it in object storage, record the pointer.
 *
 * Idempotent on Invoice_Number via INSERT ... ON DUPLICATE KEY UPDATE, so a
 * redelivered job overwrites its own invoice rather than creating a second one.
 */
export async function handleInvoiceGenerate(payload) {
  const data = payload?.invoiceInput;
  if (!data?.invoiceNumber || !Number.isInteger(Number(data.sessionId)) || !data?.user?.id) {
    throw new Error(`invoice: invalid payload ${JSON.stringify(payload)}`);
  }

  const pdf = await renderInvoicePdf(data);
  const year = String(data.invoiceNumber).split("-")[1] || new Date().getUTCFullYear();
  const key = `invoices/${year}/${data.invoiceNumber}.pdf`;
  await putObject(key, pdf, "application/pdf");

  await pool.query(
    `INSERT INTO invoice
       (Invoice_Number, Session_ID, User_ID, Payment_ID, Storage_Key, Amount, Generated_At)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE Storage_Key = VALUES(Storage_Key),
                             Payment_ID  = VALUES(Payment_ID),
                             Amount      = VALUES(Amount),
                             Generated_At = NOW()`,
    [data.invoiceNumber, data.sessionId, data.user.id, data.paymentId, key, data.totalCost]
  );

  return { invoiceNumber: data.invoiceNumber, storageKey: key };
}

/**
 * Monthly subscription charge - the other job the dropped
 * `trg_subscription_after_insert_payment` trigger used to do inline.
 */
export async function handleSubscriptionCharge(payload) {
  const subscriptionId = Number(payload?.subscriptionId);
  if (!Number.isInteger(subscriptionId)) {
    throw new Error(`billing: invalid subscription payload ${JSON.stringify(payload)}`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sub]] = await conn.query(
      `SELECT s.Subscription_ID, s.User_ID, m.Monthly_Price, m.Plan_Name
         FROM subscription s
         JOIN membership m ON m.Plan_ID = s.Plan_ID
        WHERE s.Subscription_ID = ?
        FOR UPDATE`,
      [subscriptionId]
    );
    if (!sub) throw new Error(`billing: subscription ${subscriptionId} not found`);

    // Idempotency guard: one successful charge per subscription per calendar
    // month. A redelivery inside the same month finds this row and stops.
    const [[existing]] = await conn.query(
      `SELECT Payment_ID FROM payment
        WHERE Subscription_ID = ?
          AND Payment_Status = 'success'
          AND YEAR(Created_Time) = YEAR(NOW())
          AND MONTH(Created_Time) = MONTH(NOW())
        LIMIT 1`,
      [subscriptionId]
    );
    if (existing) {
      await conn.commit();
      return { skipped: true, reason: "already charged this month" };
    }

    await conn.query(
      `INSERT INTO payment
         (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status,
          Session_ID, Subscription_ID, Created_Time)
       VALUES (?, 'Subscription', ?, 'Credit Card', 'success', NULL, ?, NOW())`,
      [sub.User_ID, sub.Monthly_Price, subscriptionId]
    );

    await conn.commit();
    cache.invalidate("dashboard:");
    return { subscriptionId, amount: Number(sub.Monthly_Price) };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** Unused today, kept so invoice numbers stay collision-free if we ever shard. */
export function randomInvoiceSuffix() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
