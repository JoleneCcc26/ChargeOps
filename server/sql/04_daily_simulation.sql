-- =============================================================================
-- Daily platform simulation scheduler
-- =============================================================================
-- A database EVENT is the clock, not the business-logic engine. It adds one
-- idempotent job to the queue at 00:10 server-local time for the previous day.
-- The simulation worker then creates sessions, maintenance situations and
-- telemetry; billing remains owned by the normal billing worker.

DELIMITER $$

DROP PROCEDURE IF EXISTS sp_enqueue_daily_simulation$$

CREATE PROCEDURE sp_enqueue_daily_simulation(IN p_run_date DATE, IN p_source VARCHAR(30))
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

CREATE EVENT IF NOT EXISTS evt_chargeops_daily_simulation
ON SCHEDULE EVERY 1 DAY
STARTS TIMESTAMP(CURRENT_DATE + INTERVAL 1 DAY, '00:10:00')
ON COMPLETION PRESERVE
ENABLE
COMMENT 'Enqueue the previous day ChargeOps platform simulation'
DO CALL sp_enqueue_daily_simulation(DATE_SUB(CURRENT_DATE, INTERVAL 1 DAY), 'mysql_event');

ALTER EVENT evt_chargeops_daily_simulation
ON SCHEDULE EVERY 1 DAY
STARTS TIMESTAMP(CURRENT_DATE + INTERVAL 1 DAY, '00:10:00')
ON COMPLETION PRESERVE
ENABLE
COMMENT 'Enqueue the previous day ChargeOps platform simulation'
DO CALL sp_enqueue_daily_simulation(DATE_SUB(CURRENT_DATE, INTERVAL 1 DAY), 'mysql_event');
