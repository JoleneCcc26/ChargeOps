-- =============================================================================
-- ChargeOps - Milestone 1 cloud schema additions
-- =============================================================================
-- These tables sit ON TOP of the EDS 6343 relational schema (company, user,
-- station, charger, charging_session, payment, maintenance_log, ...).
-- Nothing from the original model is dropped - we only add the structures the
-- cloud architecture needs:
--
--   job_queue          -> stands in for Amazon SQS (async work, retries, DLQ)
--   attachment         -> metadata for files that live in object storage (S3)
--   invoice            -> generated PDFs that live in object storage (S3)
--   charger_telemetry  -> high-volume append-only write stream (spike traffic)
--   worker_node        -> live registry of running workers (autoscaling view)
--   audit_log          -> immutable history of privileged operator actions
--
-- Design note: the file BYTES never go in MySQL. MySQL stores only "where the
-- file is + what we extracted from it". That split (relational metadata vs.
-- object storage blobs) is the single most important cloud-architecture rule
-- this project demonstrates.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. job_queue - our local stand-in for Amazon SQS
-- -----------------------------------------------------------------------------
-- Implements the same contract SQS gives you:
--   * sendMessage      -> INSERT a row with Status='ready'
--   * receiveMessage   -> SELECT ... FOR UPDATE SKIP LOCKED, flip to 'inflight'
--                         and push Visible_At into the future (visibility timeout)
--   * deleteMessage    -> Status='done'
--   * dead-letter      -> after Max_Receives failures, Status='dead'
--
-- SKIP LOCKED is what makes this a REAL queue: when four worker processes poll
-- at the same instant, each transaction locks a different set of rows and the
-- others skip past them instead of blocking. No job is ever handed out twice,
-- and no worker waits on another. Without SKIP LOCKED every worker would
-- serialize behind worker #1 and adding workers would not add throughput.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_queue (
    Job_ID        BIGINT       PRIMARY KEY AUTO_INCREMENT,
    Queue_Name    VARCHAR(50)  NOT NULL,
    Payload       JSON         NOT NULL,

    -- ready -> inflight -> done | dead
    Status        VARCHAR(20)  NOT NULL DEFAULT 'ready',

    -- Redelivery accounting. A job that is picked up but never acknowledged
    -- (worker crashed, process killed mid-demo) becomes visible again after the
    -- visibility timeout and is retried, up to Max_Receives times.
    Receive_Count INT          NOT NULL DEFAULT 0,
    Max_Receives  INT          NOT NULL DEFAULT 3,

    -- A job is only eligible for delivery when Visible_At <= NOW().
    -- Used for both the visibility timeout and exponential retry backoff.
    Visible_At    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    Locked_By     VARCHAR(64)  NULL,
    Enqueued_At   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    Started_At    DATETIME(3)  NULL,
    Finished_At   DATETIME(3)  NULL,
    Last_Error    TEXT         NULL,

    CONSTRAINT chk_job_status CHECK (Status IN ('ready','inflight','done','dead')),

    -- The polling index. Every receiveMessage call is
    --   WHERE Queue_Name=? AND Status='ready' AND Visible_At<=NOW(3)
    -- so this composite index keeps the poll fast even with 100k jobs.
    INDEX idx_job_poll (Queue_Name, Status, Visible_At),
    INDEX idx_job_finished (Finished_At)
);


-- -----------------------------------------------------------------------------
-- 2. attachment - object-storage metadata + extraction results
-- -----------------------------------------------------------------------------
-- One row per uploaded file. Storage_Key is the object-storage key (identical
-- in shape to an S3 key, e.g. "maintenance/2026/08/ab12cd34.jpg").
--
-- Everything from Fault_Category down is DERIVED by the file-processing worker
-- from unstructured content - this is the "unstructured -> structured" step the
-- cloud course cares about.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachment (
    Attachment_ID   BIGINT       PRIMARY KEY AUTO_INCREMENT,

    -- What this file is about. All nullable: a technician can upload a photo
    -- before a maintenance ticket exists, and the worker links it afterwards.
    Maintenance_ID  INT          NULL,
    Station_ID      INT          NULL,
    Charger_ID      INT          NULL,
    Technician_ID   INT          NULL,

    -- Object storage pointer
    Storage_Key     VARCHAR(255) NOT NULL UNIQUE,
    Original_Name   VARCHAR(255) NOT NULL,
    Content_Type    VARCHAR(100) NOT NULL,
    Size_Bytes      BIGINT       NOT NULL,
    Checksum_SHA256 CHAR(64)     NOT NULL,
    Kind            VARCHAR(20)  NOT NULL,   -- image | document | other

    -- Async processing state
    Process_Status  VARCHAR(20)  NOT NULL DEFAULT 'pending',
    -- DATETIME(3), not DATETIME: we subtract Uploaded_At from Processed_At to
    -- report extraction latency, and at whole-second precision that metric can
    -- only ever read 0 ms, 1000 ms or 2000 ms.
    Processed_At    DATETIME(3)  NULL,
    Process_Error   TEXT         NULL,

    -- Structured fields extracted from the unstructured file
    Extracted       JSON         NULL,  -- full raw extraction result
    Fault_Category  VARCHAR(40)  NULL,  -- connector | cable | screen | payment_terminal | network | power | unknown
    Severity        VARCHAR(20)  NULL,  -- critical | major | minor
    Error_Code      VARCHAR(40)  NULL,  -- e.g. "E-4021", pulled out with a regex
    Summary         VARCHAR(500) NULL,
    Word_Count      INT          NULL,

    -- Image-specific: dimensions parsed from the file header, timestamp and
    -- GPS read from the EXIF block.
    Image_Width     INT          NULL,
    Image_Height    INT          NULL,
    Captured_At     DATETIME     NULL,
    Gps_Lat         DECIMAL(9,6) NULL,
    Gps_Lng         DECIMAL(9,6) NULL,

    -- Result of matching the photo's GPS tag against station coordinates.
    Matched_Station_ID INT       NULL,
    Match_Distance_M   INT       NULL,

    Uploaded_At     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    CONSTRAINT chk_attachment_kind   CHECK (Kind IN ('image','document','other')),
    CONSTRAINT chk_attachment_status CHECK (Process_Status IN ('pending','processing','done','failed')),

    CONSTRAINT fk_attachment_maintenance FOREIGN KEY (Maintenance_ID) REFERENCES maintenance_log(Maintenance_ID),
    CONSTRAINT fk_attachment_station FOREIGN KEY (Station_ID) REFERENCES station(Station_ID),
    CONSTRAINT fk_attachment_charger FOREIGN KEY (Charger_ID) REFERENCES charger(Charger_ID),
    CONSTRAINT fk_attachment_technician FOREIGN KEY (Technician_ID) REFERENCES technician(Technician_ID),
    CONSTRAINT fk_attachment_matched_station FOREIGN KEY (Matched_Station_ID) REFERENCES station(Station_ID),

    INDEX idx_attachment_maintenance (Maintenance_ID),
    INDEX idx_attachment_status (Process_Status),
    INDEX idx_attachment_category (Fault_Category)
);


-- -----------------------------------------------------------------------------
-- 3. invoice - PDF receipts produced by the billing worker
-- -----------------------------------------------------------------------------
-- Demonstrates the OTHER direction of file handling: the app GENERATES an
-- unstructured artifact (a PDF), stores it in object storage, and keeps only
-- the pointer plus searchable fields in MySQL.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice (
    Invoice_ID     BIGINT        PRIMARY KEY AUTO_INCREMENT,
    Invoice_Number VARCHAR(40)   NOT NULL UNIQUE,
    Session_ID     INT           NOT NULL,
    User_ID        INT           NOT NULL,
    Payment_ID     INT           NULL,
    Storage_Key    VARCHAR(255)  NOT NULL,
    Amount         DECIMAL(10,2) NOT NULL,
    Generated_At   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_invoice_session (Session_ID),
    CONSTRAINT fk_invoice_session FOREIGN KEY (Session_ID) REFERENCES charging_session(Session_ID),
    CONSTRAINT fk_invoice_user FOREIGN KEY (User_ID) REFERENCES user(User_ID),
    CONSTRAINT fk_invoice_payment FOREIGN KEY (Payment_ID) REFERENCES payment(Payment_ID),
    INDEX idx_invoice_user (User_ID)
);


-- -----------------------------------------------------------------------------
-- 4. charger_telemetry - the high-volume write stream
-- -----------------------------------------------------------------------------
-- Every charger heartbeats every few seconds. 500 chargers x 1 beat / 10s is
-- ~50 inserts/sec sustained, and far more during a spike.
--
-- Deliberate design choices, all of them exam-answerable:
--   * NO foreign keys. FK checks take a shared lock on the parent row; on an
--     append-only firehose that is pure overhead. Referential integrity is
--     enforced by the ingest worker instead.
--   * Append-only, never UPDATEd - so writes never contend with each other.
--   * Written in BATCHES by the worker (one multi-row INSERT per ~200 beats)
--     rather than one INSERT per HTTP request. This is the whole point of
--     putting a queue in front of the database.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS charger_telemetry (
    Telemetry_ID       BIGINT        PRIMARY KEY AUTO_INCREMENT,
    Charger_ID         INT           NOT NULL,
    Reported_At        DATETIME(3)   NOT NULL,
    Power_KW           DECIMAL(10,2) NOT NULL,
    Session_Energy_KWh DECIMAL(10,3) NULL,
    Status_Code        VARCHAR(30)   NOT NULL,
    Temperature_C      DECIMAL(5,1)  NULL,
    Ingested_At        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX idx_telemetry_charger_time (Charger_ID, Reported_At),
    INDEX idx_telemetry_ingested (Ingested_At)
);


-- -----------------------------------------------------------------------------
-- 5. worker_node - live worker registry
-- -----------------------------------------------------------------------------
-- Each worker process registers itself and heartbeats every 2 seconds. The ops
-- dashboard reads this table to draw the "workers currently running" line, so
-- you can literally watch the supervisor scale from 1 -> 6 -> 1 during the demo.
--
-- In AWS this table is replaced by ECS service metrics / Lambda concurrency;
-- we keep it in MySQL because we have no CloudWatch locally.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_node (
    Worker_ID      VARCHAR(64)  PRIMARY KEY,
    Hostname       VARCHAR(100) NULL,
    Pid            INT          NULL,
    Queues         VARCHAR(200) NULL,
    Started_At     DATETIME     NOT NULL,
    Last_Heartbeat DATETIME(3)  NOT NULL,
    Jobs_Processed BIGINT       NOT NULL DEFAULT 0,
    Jobs_Failed    BIGINT       NOT NULL DEFAULT 0,
    Status         VARCHAR(20)  NOT NULL DEFAULT 'running',

    INDEX idx_worker_heartbeat (Last_Heartbeat)
);


-- -----------------------------------------------------------------------------
-- 6. audit_log - privileged changes made through the operations UI
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    Audit_ID       BIGINT       PRIMARY KEY AUTO_INCREMENT,
    Actor_Username VARCHAR(100) NOT NULL,
    Actor_Role     VARCHAR(40)  NOT NULL,
    Action         VARCHAR(100) NOT NULL,
    Entity_Type    VARCHAR(80)  NOT NULL,
    Entity_ID      VARCHAR(100) NOT NULL,
    Details        JSON         NULL,
    Created_At     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX idx_audit_entity (Entity_Type, Entity_ID, Created_At),
    INDEX idx_audit_actor (Actor_Username, Created_At)
);


-- -----------------------------------------------------------------------------
-- 7. simulation_run - one idempotent platform simulation per calendar day
-- -----------------------------------------------------------------------------
-- The MySQL EVENT only enqueues a job. The worker creates sessions, maintenance
-- situations and telemetry through the same application-layer paths as normal
-- traffic, so scheduled demo data cannot bypass billing or wallet safeguards.
CREATE TABLE IF NOT EXISTS simulation_run (
    Run_ID            BIGINT       PRIMARY KEY AUTO_INCREMENT,
    Run_Date          DATE         NOT NULL,
    Status            VARCHAR(20)  NOT NULL DEFAULT 'queued',
    Source            VARCHAR(30)  NOT NULL DEFAULT 'manual',
    Seed_Value        BIGINT       NOT NULL,
    Job_ID            BIGINT       NULL,
    Session_Count     INT          NOT NULL DEFAULT 0,
    Situation_Count   INT          NOT NULL DEFAULT 0,
    Resolved_Count    INT          NOT NULL DEFAULT 0,
    Started_At        DATETIME(3)  NULL,
    Completed_At      DATETIME(3)  NULL,
    Error_Message     TEXT         NULL,
    Created_At        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE KEY uq_simulation_run_date (Run_Date),
    INDEX idx_simulation_status (Status, Created_At),
    CONSTRAINT chk_simulation_status CHECK (Status IN ('queued','processing','completed','failed')),
    CONSTRAINT chk_simulation_counts CHECK (
      Session_Count >= 0 AND Situation_Count >= 0 AND Resolved_Count >= 0
    )
);


-- -----------------------------------------------------------------------------
-- APP_META - small key/value facts about this installation
-- -----------------------------------------------------------------------------
-- Some questions can only be answered by something that was recorded at build
-- time. The one that forced this table into existence: "was this row seeded, or
-- did the application produce it?"
--
-- It matters because the two are held to different standards. Every session the
-- application settles must have a PDF invoice; the seeded history predates the
-- invoice table entirely and never can. Without a recorded watermark the only
-- way to tell them apart is a hard-coded id, which silently becomes wrong the
-- moment the seed data changes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS APP_META (
    Meta_Key   VARCHAR(64)  PRIMARY KEY,
    Meta_Value VARCHAR(255) NOT NULL,
    Updated_At DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP
);


-- -----------------------------------------------------------------------------
-- BILLING_REQUEST - money decisions that need a human
-- -----------------------------------------------------------------------------
-- The finance counterpart of a maintenance work order, and it exists for the
-- same reason: some things must not happen automatically.
--
-- A driver asking to start a membership, top up a wallet, or be refunded for a
-- session on a charger that failed halfway through is asking somebody to move
-- money. That is a decision, and a decision needs an owner, a queue, an audit
-- trail and a reversible outcome — none of which a status column on another
-- table provides.
--
-- The lifecycle mirrors dispatch deliberately, so the application has one shape
-- of workflow rather than two:
--
--   Pending  ──approve──▶  Approved   (the money actually moves)
--      │
--      └────reject────▶   Rejected   (with a reason the driver can be told)
--
-- Approving is what has the side effect: a subscription becomes Active, a
-- wallet is credited, a refund is paid. Nothing happens while the request sits
-- in the queue, which is exactly what makes the queue safe to leave unattended.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS BILLING_REQUEST (
    Request_ID   BIGINT       PRIMARY KEY AUTO_INCREMENT,
    User_ID      INT          NOT NULL,

    -- subscription.new | subscription.renew | wallet.topup | refund
    Request_Type VARCHAR(30)  NOT NULL,
    Amount       DECIMAL(10,2) NOT NULL,

    -- Only one of these applies, depending on the type. A membership request
    -- names a plan; a refund names the session being disputed.
    Plan_ID      INT          NULL,
    Session_ID   INT          NULL,

    Status       VARCHAR(20)  NOT NULL DEFAULT 'Pending',
    Reason       VARCHAR(500) NULL,          -- what the driver asked for, in their words

    Requested_At DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    Requested_By VARCHAR(64)  NOT NULL,      -- the driver, or an agent acting for them

    Reviewed_At  DATETIME     NULL,
    Reviewed_By  VARCHAR(64)  NULL,
    Review_Notes VARCHAR(500) NULL,

    -- What approving actually produced, so the decision and its consequence are
    -- linked. Null until approved.
    Payment_ID   INT          NULL,

    CONSTRAINT chk_billing_request_type
      CHECK (Request_Type IN ('subscription.new','subscription.renew','wallet.topup','refund')),
    CONSTRAINT chk_billing_request_status
      CHECK (Status IN ('Pending','Approved','Rejected')),
    CONSTRAINT chk_billing_request_amount CHECK (Amount >= 0),

    FOREIGN KEY (User_ID)    REFERENCES USER(User_ID),
    FOREIGN KEY (Plan_ID)    REFERENCES MEMBERSHIP(Plan_ID),

    -- The finance inbox reads this constantly: pending first, oldest first.
    INDEX idx_billing_request_queue (Status, Requested_At),
    INDEX idx_billing_request_user (User_ID)
);
