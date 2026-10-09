-- migrations/0002_triggers_routines_events.sql
--
-- The database-side logic: row-level triggers that keep derived columns
-- honest, the stored procedure that queues a day of simulated activity, and
-- the nightly event that calls it.
--
-- Two deliberate changes from the dump this was generated from. DEFINER
-- clauses are gone, because recreating "owned by root@%" on a managed instance
-- needs SUPER, which the application user does not have and should not have.
-- And the event is created after the procedure it calls, which mysqldump does
-- not guarantee.

-- trigger: CREATE TRIGGER `trg_maintenance_after_update` AFTER UPDATE O
DELIMITER $$
CREATE  TRIGGER `trg_maintenance_after_update` AFTER UPDATE ON `maintenance_log` FOR EACH ROW BEGIN
    IF NEW.Status = 'Resolved' AND NEW.Resolved_Time IS NOT NULL THEN
        UPDATE charger SET Last_Maintenance_Date = DATE(NEW.Resolved_Time) WHERE Charger_ID = NEW.Charger_ID;
    END IF;
END$$
DELIMITER ;

-- trigger: CREATE TRIGGER `trg_payment_after_insert_topup` AFTER INSERT
DELIMITER $$
CREATE  TRIGGER `trg_payment_after_insert_topup` AFTER INSERT ON `payment` FOR EACH ROW BEGIN
    IF NEW.Payment_Type = 'Wallet Top-Up' AND NEW.Payment_Status = 'success' THEN
        UPDATE wallet SET Wallet_Balance = Wallet_Balance + NEW.Payment_Amount WHERE User_ID = NEW.User_ID;
    END IF;
END$$
DELIMITER ;

-- trigger: CREATE TRIGGER `trg_subscription_before_insert` BEFORE INSER
DELIMITER $$
CREATE  TRIGGER `trg_subscription_before_insert` BEFORE INSERT ON `subscription` FOR EACH ROW BEGIN
    IF NEW.Start_Date > CURDATE() THEN SET NEW.Status = 'Pending';
    ELSEIF NEW.End_Date < CURDATE() THEN SET NEW.Status = 'Expired';
    ELSE SET NEW.Status = 'Active';
    END IF;
END$$
DELIMITER ;

-- procedure: CREATE PROCEDURE `sp_enqueue_daily_simulation`(IN p_run_date
DELIMITER $$
CREATE PROCEDURE `sp_enqueue_daily_simulation`(IN p_run_date DATE, IN p_source VARCHAR(30))
BEGIN
    DECLARE v_run_id BIGINT DEFAULT NULL;
    DECLARE v_job_id BIGINT DEFAULT NULL;
    DECLARE v_status VARCHAR(20) DEFAULT NULL;
    DECLARE v_job_status VARCHAR(20) DEFAULT NULL;

    -- One run row per date: that uniqueness is what makes the daily event safe
    -- to fire twice without doubling the day's data.
    INSERT IGNORE INTO simulation_run (Run_Date, Status, Source, Seed_Value)
    VALUES (
      p_run_date,
      'queued',
      LEFT(COALESCE(NULLIF(p_source, ''), 'manual'), 30),
      CRC32(DATE_FORMAT(p_run_date, '%Y-%m-%d'))
    );

    IF ROW_COUNT() = 1 THEN
        SET v_run_id = LAST_INSERT_ID();
    ELSE
        -- =====================================================================
        -- The row already exists. Whether that means "done" or "stuck" matters.
        -- =====================================================================
        -- This branch used to do nothing at all, and that turned any failure
        -- into a permanent one: the run row blocked the INSERT, so no new job
        -- was ever queued, and the only way to retry a day was to delete the
        -- row by hand. A daily simulation that cannot be re-run after a bad
        -- deploy has to be repaired with SQL, which is not a thing anyone
        -- should have to know.
        --
        -- So: completed days stay untouched — re-running them would duplicate
        -- the data the uniqueness is there to prevent. A day that failed, or
        -- that is still 'queued' with no live job behind it, is re-armed.
        SELECT Run_ID, Status INTO v_run_id, v_status
          FROM simulation_run WHERE Run_Date = p_run_date;

        SELECT jq.Status INTO v_job_status
          FROM simulation_run sr
          LEFT JOIN job_queue jq ON jq.Job_ID = sr.Job_ID
         WHERE sr.Run_ID = v_run_id;

        IF v_status = 'completed'
           OR (v_status = 'processing' AND v_job_status IN ('ready', 'inflight'))
           OR (v_status = 'queued'     AND v_job_status IN ('ready', 'inflight')) THEN
            SET v_run_id = NULL;   -- nothing to do: done, or genuinely in flight
        ELSE
            UPDATE simulation_run
               SET Status = 'queued', Error_Message = NULL,
                   Started_At = NULL, Completed_At = NULL
             WHERE Run_ID = v_run_id;
        END IF;
    END IF;

    IF v_run_id IS NOT NULL THEN
        INSERT INTO job_queue (Queue_Name, Payload, Max_Receives, Visible_At)
        VALUES (
          'simulation',
          JSON_OBJECT(
            'type', 'simulation.daily',
            'runId', v_run_id,
            'runDate', DATE_FORMAT(p_run_date, '%Y-%m-%d')
          ),
          3,
          NOW(3)
        );
        SET v_job_id = LAST_INSERT_ID();
        UPDATE simulation_run SET Job_ID = v_job_id WHERE Run_ID = v_run_id;
    END IF;
END$$
DELIMITER ;

-- event: CREATE EVENT `evt_chargeops_daily_simulation` ON SCHEDULE EV
DELIMITER $$
CREATE  EVENT `evt_chargeops_daily_simulation` ON SCHEDULE EVERY 1 DAY STARTS '2026-09-30 00:10:00' ON COMPLETION PRESERVE ENABLE COMMENT 'Enqueue the previous day ChargeOps platform simulation' DO CALL sp_enqueue_daily_simulation(DATE_SUB(CURRENT_DATE, INTERVAL 1 DAY), 'mysql_event')$$
DELIMITER ;

