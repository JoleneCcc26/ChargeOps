-- =============================================================================
-- ChargeOps - move billing OUT of MySQL triggers and INTO an async worker
-- =============================================================================
-- This is the single most important change between the EDS 6343 database
-- project and the cloud project, so it gets its own migration file and its own
-- slide.
--
-- THE RULE WE APPLIED
-- -------------------
-- We did not delete triggers by taste. We used one mechanical test:
--
--     Does the trigger write to payment or wallet?
--       yes -> it is BUSINESS LOGIC. It moves to a worker.
--       no  -> it is a CONSTRAINT or operational state sync. It stays.
--
-- Money is the business. Everything else - "mark the subscription Active",
-- "stamp the charger's last maintenance date" - is keeping one column
-- consistent with another, which is exactly what a database is for.
--
--     "Triggers guard the shape of the data. Workers run the business."
--
-- WHAT WE HAD
-- -----------
-- Ending a charging session was one UPDATE that cascaded through four triggers:
--
--     UPDATE charging_session SET End_Time = NOW() WHERE Session_ID = 42;
--       -> trg_charging_session_before_update_finalize
--            look up charger power + rate
--            look up the user's active membership discount
--            compute Energy_Consumed and Total_Cost
--            set Session_Status = 'Completed'
--       -> trg_session_after_update_logic
--            INSERT INTO payment
--            UPDATE charger back to 'Available'
--       -> trg_payment_before_update_wallet  (on the payment's later update)
--            UPDATE wallet
--     ...and only THEN does the UPDATE return to the caller.
--
-- WHY THAT DOES NOT SURVIVE THE CLOUD
-- -----------------------------------
-- 1. It cannot scale independently. Billing ran inside mysqld, the single
--    hardest tier to scale out. If 500 sessions end at 18:00, the ONLY way to
--    add billing capacity is to buy a bigger database instance.
-- 2. It cannot be retried. If the wallet debit fails, the trigger raises and
--    the user's session UPDATE rolls back too - the session "un-ends". There is
--    no backoff, no dead-letter queue, no partial success.
-- 3. It cannot be observed. No per-step metrics, no logs, no traces. You cannot
--    answer "how long does billing take at p95?" from a trigger.
-- 4. It blocks the user. The driver's "stop charging" tap waits for
--    invoice-worthy work before it gets a response.
-- 5. It cannot call anything outside the database. Generating a PDF, writing to
--    object storage, or sending an email is simply impossible from a trigger.
--
-- WHAT WE DO NOW
-- --------------
--     POST /api/sessions/:id/stop
--        -> UPDATE charging_session SET End_Time=NOW(), Session_Status='Pending'
--        -> UPDATE charger back to 'Available'   (one row, the driver is waiting)
--        -> enqueue { sessionId } on the "billing" queue
--        -> return 202 Accepted immediately      (~5 ms instead of ~80 ms)
--
--     billing worker (server/workers/handlers/billing.js), N processes:
--        -> compute energy + rate + membership discount
--        -> debit wallet / INSERT payment
--        -> render a PDF invoice into object storage
--        -> mark the session Completed
--        with retries, exponential backoff, a dead-letter queue, and an
--        idempotency guard so an at-least-once redelivery cannot double-bill.
--
-- NOTE: dropping trg_session_after_update_logic is not just tidiness, it is
-- REQUIRED for correctness. The worker sets Session_Status = 'Completed' at the
-- end of its run; if that trigger were still armed it would fire on the
-- worker's own UPDATE and insert a SECOND payment row on top of the one the
-- worker just wrote.
-- =============================================================================


-- ── DROPPED: writes payment or wallet ───────────────────────────────────────

-- Computed Energy_Consumed / Total_Cost on insert.
-- Now: server/workers/handlers/billing.js
DROP TRIGGER IF EXISTS trg_charging_session_before_insert;

-- Computed the final bill when End_Time was set. This is the one that used to
-- own the whole calculation.
-- Now: server/workers/handlers/billing.js
DROP TRIGGER IF EXISTS trg_charging_session_before_update_finalize;

-- INSERTed payment for a session inserted already-completed, and occupied the
-- charger for a real-time one.
-- Now: the worker bills; POST /api/sessions/:id/start occupies the charger.
DROP TRIGGER IF EXISTS trg_session_after_insert_logic;

-- INSERTed payment and released the charger on Pending -> Completed.
-- Now: the worker bills; the /stop route releases the charger.
DROP TRIGGER IF EXISTS trg_session_after_update_logic;

-- Debited wallet and activated the subscription when a payment went
-- pending -> success.
-- Now: the worker writes payments as 'success' directly, having already taken
-- the money under a row lock.
DROP TRIGGER IF EXISTS trg_payment_before_update_wallet;

-- Generated the first monthly payment row for a new subscription.
-- Now: billing queue, job type "subscription.charge".
DROP TRIGGER IF EXISTS trg_subscription_after_insert_payment;

-- Older names from earlier revisions of the schema, dropped so this migration
-- is idempotent across every version of the database anyone on the team has.
DROP TRIGGER IF EXISTS trg_charging_session_after_update;
DROP TRIGGER IF EXISTS trg_charging_session_after_update_payment;
DROP TRIGGER IF EXISTS trg_charging_session_after_insert_historical_payment;
DROP TRIGGER IF EXISTS trg_session_complete_payment;
DROP TRIGGER IF EXISTS trg_payment_before_insert;
DROP TRIGGER IF EXISTS trg_session_after_insert_charger_status;
DROP TRIGGER IF EXISTS trg_session_after_update_release_charger;


-- ── KEPT: constraints and operational state sync ─────────────────────────────
--
--   trg_subscription_before_insert
--       Derives Status from the date range. Pure SET NEW.*, touches no other
--       table. This is a CHECK constraint that needed a bit of logic - it
--       belongs next to the data, and moving it to the app layer would let a
--       bad row in through any other client.
--
--   trg_maintenance_after_update
--       Stamps charger.Last_Maintenance_Date when a ticket is resolved. Keeps
--       one column consistent with another. No money, no external calls.
--
--   trg_payment_after_insert_topup
--       Credits wallet when a 'Wallet Top-Up' payment succeeds.
--
--       This one DOES write wallet, so by our own rule it should have moved.
--       We have not migrated it because nothing in the app performs top-ups
--       yet - dropping it would remove working behaviour and replace it with
--       nothing. It is the next thing to move, and it is listed as such in
--       docs/ARCHITECTURE.md. Flagging it beats quietly leaving it out of the
--       story.
--
--       It cannot conflict with the billing worker: it fires only for
--       Payment_Type = 'Wallet Top-Up', and the worker only ever writes
--       Payment_Type = 'Charging'.
