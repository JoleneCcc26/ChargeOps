-- migrations/0001_initial_schema.sql
--
-- The ChargeOps relational schema: every table the application reads or writes.
-- Generated from the Milestone 3 database with `mysqldump --no-data`, so these
-- are exactly the tables that held the production rows, then committed here so
-- the managed database in Milestone 4 is created from a file in the repository
-- rather than by hand.
--
-- 20 tables: the EDS 6343 relational model (company, user, station, charger,
-- charging_session, payment, maintenance_log, technician, membership,
-- subscription, wallet) plus the cloud tables added for the platform
-- (job_queue, attachment, invoice, charger_telemetry, worker_node, audit_log,
-- simulation_run, billing_request, app_meta).
--
-- Foreign keys are created with the tables, so the file is ordered parent-first
-- by mysqldump and must be applied in one pass.

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE `app_meta` (
  `Meta_Key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Meta_Value` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Updated_At` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`Meta_Key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `attachment` (
  `Attachment_ID` bigint NOT NULL AUTO_INCREMENT,
  `Maintenance_ID` int DEFAULT NULL,
  `Station_ID` int DEFAULT NULL,
  `Charger_ID` int DEFAULT NULL,
  `Technician_ID` int DEFAULT NULL,
  `Storage_Key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Original_Name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Content_Type` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Size_Bytes` bigint NOT NULL,
  `Checksum_SHA256` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Kind` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Process_Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `Processed_At` datetime(3) DEFAULT NULL,
  `Process_Error` text COLLATE utf8mb4_unicode_ci,
  `Extracted` json DEFAULT NULL,
  `Fault_Category` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Severity` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Error_Code` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Summary` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Word_Count` int DEFAULT NULL,
  `Image_Width` int DEFAULT NULL,
  `Image_Height` int DEFAULT NULL,
  `Captured_At` datetime DEFAULT NULL,
  `Gps_Lat` decimal(9,6) DEFAULT NULL,
  `Gps_Lng` decimal(9,6) DEFAULT NULL,
  `Matched_Station_ID` int DEFAULT NULL,
  `Match_Distance_M` int DEFAULT NULL,
  `Uploaded_At` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`Attachment_ID`),
  UNIQUE KEY `Storage_Key` (`Storage_Key`),
  KEY `fk_attachment_station` (`Station_ID`),
  KEY `fk_attachment_charger` (`Charger_ID`),
  KEY `fk_attachment_technician` (`Technician_ID`),
  KEY `fk_attachment_matched_station` (`Matched_Station_ID`),
  KEY `idx_attachment_maintenance` (`Maintenance_ID`),
  KEY `idx_attachment_status` (`Process_Status`),
  KEY `idx_attachment_category` (`Fault_Category`),
  CONSTRAINT `fk_attachment_charger` FOREIGN KEY (`Charger_ID`) REFERENCES `charger` (`Charger_ID`),
  CONSTRAINT `fk_attachment_maintenance` FOREIGN KEY (`Maintenance_ID`) REFERENCES `maintenance_log` (`Maintenance_ID`),
  CONSTRAINT `fk_attachment_matched_station` FOREIGN KEY (`Matched_Station_ID`) REFERENCES `station` (`Station_ID`),
  CONSTRAINT `fk_attachment_station` FOREIGN KEY (`Station_ID`) REFERENCES `station` (`Station_ID`),
  CONSTRAINT `fk_attachment_technician` FOREIGN KEY (`Technician_ID`) REFERENCES `technician` (`Technician_ID`),
  CONSTRAINT `chk_attachment_kind` CHECK ((`Kind` in (_utf8mb4'image',_utf8mb4'document',_utf8mb4'other'))),
  CONSTRAINT `chk_attachment_status` CHECK ((`Process_Status` in (_utf8mb4'pending',_utf8mb4'processing',_utf8mb4'done',_utf8mb4'failed')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `audit_log` (
  `Audit_ID` bigint NOT NULL AUTO_INCREMENT,
  `Actor_Username` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Actor_Role` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Action` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Entity_Type` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Entity_ID` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Details` json DEFAULT NULL,
  `Created_At` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`Audit_ID`),
  KEY `idx_audit_entity` (`Entity_Type`,`Entity_ID`,`Created_At`),
  KEY `idx_audit_actor` (`Actor_Username`,`Created_At`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `billing_request` (
  `Request_ID` bigint NOT NULL AUTO_INCREMENT,
  `User_ID` int NOT NULL,
  `Request_Type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Amount` decimal(10,2) NOT NULL,
  `Plan_ID` int DEFAULT NULL,
  `Session_ID` int DEFAULT NULL,
  `Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Pending',
  `Reason` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Requested_At` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Requested_By` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Reviewed_At` datetime DEFAULT NULL,
  `Reviewed_By` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Review_Notes` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Payment_ID` int DEFAULT NULL,
  PRIMARY KEY (`Request_ID`),
  KEY `Plan_ID` (`Plan_ID`),
  KEY `idx_billing_request_queue` (`Status`,`Requested_At`),
  KEY `idx_billing_request_user` (`User_ID`),
  CONSTRAINT `billing_request_ibfk_1` FOREIGN KEY (`User_ID`) REFERENCES `user` (`User_ID`),
  CONSTRAINT `billing_request_ibfk_2` FOREIGN KEY (`Plan_ID`) REFERENCES `membership` (`Plan_ID`),
  CONSTRAINT `chk_billing_request_amount` CHECK ((`Amount` >= 0)),
  CONSTRAINT `chk_billing_request_status` CHECK ((`Status` in (_utf8mb4'Pending',_utf8mb4'Approved',_utf8mb4'Rejected'))),
  CONSTRAINT `chk_billing_request_type` CHECK ((`Request_Type` in (_utf8mb4'subscription.new',_utf8mb4'subscription.renew',_utf8mb4'wallet.topup',_utf8mb4'refund')))
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `charger` (
  `Charger_ID` int NOT NULL AUTO_INCREMENT,
  `Station_ID` int NOT NULL,
  `Charger_Type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Charger_Power_Capacity` decimal(10,2) NOT NULL,
  `Charging_Rate_Per_kWh` decimal(10,4) NOT NULL,
  `Charger_Availability_Status` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Last_Maintenance_Date` date NOT NULL,
  PRIMARY KEY (`Charger_ID`),
  KEY `Station_ID` (`Station_ID`),
  CONSTRAINT `charger_ibfk_1` FOREIGN KEY (`Station_ID`) REFERENCES `station` (`Station_ID`),
  CONSTRAINT `chk_charger_power` CHECK ((`Charger_Power_Capacity` > 0)),
  CONSTRAINT `chk_charger_rate` CHECK ((`Charging_Rate_Per_kWh` > 0)),
  CONSTRAINT `chk_charger_status` CHECK ((`Charger_Availability_Status` in (_utf8mb4'Available',_utf8mb4'In Use',_utf8mb4'Out of Service',_utf8mb4'Reserved')))
) ENGINE=InnoDB AUTO_INCREMENT=860 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `charger_telemetry` (
  `Telemetry_ID` bigint NOT NULL AUTO_INCREMENT,
  `Charger_ID` int NOT NULL,
  `Reported_At` datetime(3) NOT NULL,
  `Power_KW` decimal(10,2) NOT NULL,
  `Session_Energy_KWh` decimal(10,3) DEFAULT NULL,
  `Status_Code` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Temperature_C` decimal(5,1) DEFAULT NULL,
  `Ingested_At` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`Telemetry_ID`),
  KEY `idx_telemetry_charger_time` (`Charger_ID`,`Reported_At`),
  KEY `idx_telemetry_ingested` (`Ingested_At`)
) ENGINE=InnoDB AUTO_INCREMENT=118161 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `charging_session` (
  `Session_ID` int NOT NULL AUTO_INCREMENT,
  `Charger_ID` int NOT NULL,
  `User_ID` int NOT NULL,
  `Start_Time` datetime NOT NULL,
  `End_Time` datetime DEFAULT NULL,
  `Energy_Consumed` decimal(10,2) DEFAULT NULL,
  `Session_Rate_Per_kWh` decimal(10,4) DEFAULT NULL,
  `Total_Cost` decimal(10,2) DEFAULT NULL,
  `Session_Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`Session_ID`),
  KEY `Charger_ID` (`Charger_ID`),
  KEY `User_ID` (`User_ID`),
  CONSTRAINT `charging_session_ibfk_1` FOREIGN KEY (`Charger_ID`) REFERENCES `charger` (`Charger_ID`),
  CONSTRAINT `charging_session_ibfk_2` FOREIGN KEY (`User_ID`) REFERENCES `user` (`User_ID`),
  CONSTRAINT `chk_session_cost` CHECK (((`Total_Cost` is null) or (`Total_Cost` >= 0))),
  CONSTRAINT `chk_session_energy` CHECK (((`Energy_Consumed` is null) or (`Energy_Consumed` >= 0))),
  CONSTRAINT `chk_session_rate` CHECK (((`Session_Rate_Per_kWh` is null) or (`Session_Rate_Per_kWh` > 0))),
  CONSTRAINT `chk_session_status` CHECK ((`Session_Status` in (_utf8mb4'Active',_utf8mb4'Completed',_utf8mb4'Cancelled'))),
  CONSTRAINT `chk_session_time` CHECK (((`End_Time` is null) or (`End_Time` > `Start_Time`)))
) ENGINE=InnoDB AUTO_INCREMENT=36792 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `company` (
  `Company_ID` int NOT NULL AUTO_INCREMENT,
  `Company_Name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Company_Contact_Info` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Company_Description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`Company_ID`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `invoice` (
  `Invoice_ID` bigint NOT NULL AUTO_INCREMENT,
  `Invoice_Number` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Session_ID` int NOT NULL,
  `User_ID` int NOT NULL,
  `Payment_ID` int DEFAULT NULL,
  `Storage_Key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Amount` decimal(10,2) NOT NULL,
  `Generated_At` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`Invoice_ID`),
  UNIQUE KEY `Invoice_Number` (`Invoice_Number`),
  UNIQUE KEY `uq_invoice_session` (`Session_ID`),
  KEY `fk_invoice_payment` (`Payment_ID`),
  KEY `idx_invoice_user` (`User_ID`),
  CONSTRAINT `fk_invoice_payment` FOREIGN KEY (`Payment_ID`) REFERENCES `payment` (`Payment_ID`),
  CONSTRAINT `fk_invoice_session` FOREIGN KEY (`Session_ID`) REFERENCES `charging_session` (`Session_ID`),
  CONSTRAINT `fk_invoice_user` FOREIGN KEY (`User_ID`) REFERENCES `user` (`User_ID`)
) ENGINE=InnoDB AUTO_INCREMENT=995 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `job_queue` (
  `Job_ID` bigint NOT NULL AUTO_INCREMENT,
  `Queue_Name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Payload` json NOT NULL,
  `Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ready',
  `Receive_Count` int NOT NULL DEFAULT '0',
  `Max_Receives` int NOT NULL DEFAULT '3',
  `Visible_At` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `Locked_By` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Enqueued_At` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `Started_At` datetime(3) DEFAULT NULL,
  `Finished_At` datetime(3) DEFAULT NULL,
  `Last_Error` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`Job_ID`),
  KEY `idx_job_poll` (`Queue_Name`,`Status`,`Visible_At`),
  KEY `idx_job_finished` (`Finished_At`),
  CONSTRAINT `chk_job_status` CHECK ((`Status` in (_utf8mb4'ready',_utf8mb4'inflight',_utf8mb4'done',_utf8mb4'dead')))
) ENGINE=InnoDB AUTO_INCREMENT=120433 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `maintenance_log` (
  `Maintenance_ID` int NOT NULL AUTO_INCREMENT,
  `Charger_ID` int NOT NULL,
  `Station_ID` int NOT NULL,
  `Technician_ID` int DEFAULT NULL,
  `Issue_Reported` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `Resolved_Time` datetime DEFAULT NULL,
  `Status` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Reported_At` datetime DEFAULT NULL,
  `Reported_By` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Report_Source` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Fault_Code` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Severity` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Priority` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Assigned_At` datetime DEFAULT NULL,
  `Assigned_By` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Started_At` datetime DEFAULT NULL,
  `Resolution_Notes` text COLLATE utf8mb4_unicode_ci,
  `Open_Charger_ID` int GENERATED ALWAYS AS ((case when (`Status` in (_utf8mb4'Reported',_utf8mb4'Assigned',_utf8mb4'In Progress')) then `Charger_ID` end)) STORED,
  PRIMARY KEY (`Maintenance_ID`),
  UNIQUE KEY `uq_open_work_order_per_charger` (`Open_Charger_ID`),
  KEY `Charger_ID` (`Charger_ID`),
  KEY `Station_ID` (`Station_ID`),
  KEY `Technician_ID` (`Technician_ID`),
  CONSTRAINT `maintenance_log_ibfk_1` FOREIGN KEY (`Charger_ID`) REFERENCES `charger` (`Charger_ID`),
  CONSTRAINT `maintenance_log_ibfk_2` FOREIGN KEY (`Station_ID`) REFERENCES `station` (`Station_ID`),
  CONSTRAINT `maintenance_log_ibfk_3` FOREIGN KEY (`Technician_ID`) REFERENCES `technician` (`Technician_ID`),
  CONSTRAINT `chk_maintenance_status` CHECK ((`Status` in (_utf8mb4'Reported',_utf8mb4'Assigned',_utf8mb4'In Progress',_utf8mb4'Resolved',_utf8mb4'Rejected')))
) ENGINE=InnoDB AUTO_INCREMENT=1788 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `membership` (
  `Plan_ID` int NOT NULL AUTO_INCREMENT,
  `Plan_Name` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Discount_Rate` decimal(5,2) NOT NULL,
  `Monthly_Price` decimal(10,2) NOT NULL,
  PRIMARY KEY (`Plan_ID`),
  CONSTRAINT `chk_membership_discount` CHECK (((`Discount_Rate` >= 0) and (`Discount_Rate` <= 100))),
  CONSTRAINT `chk_membership_price` CHECK ((`Monthly_Price` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `payment` (
  `Payment_ID` int NOT NULL AUTO_INCREMENT,
  `User_ID` int NOT NULL,
  `Payment_Type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Payment_Amount` decimal(10,2) NOT NULL,
  `Payment_Method` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Payment_Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Session_ID` int DEFAULT NULL,
  `Subscription_ID` int DEFAULT NULL,
  `Created_Time` datetime NOT NULL,
  PRIMARY KEY (`Payment_ID`),
  UNIQUE KEY `uq_payment_session` (`Session_ID`),
  KEY `User_ID` (`User_ID`),
  KEY `Subscription_ID` (`Subscription_ID`),
  CONSTRAINT `payment_ibfk_1` FOREIGN KEY (`User_ID`) REFERENCES `user` (`User_ID`),
  CONSTRAINT `payment_ibfk_2` FOREIGN KEY (`Session_ID`) REFERENCES `charging_session` (`Session_ID`),
  CONSTRAINT `payment_ibfk_3` FOREIGN KEY (`Subscription_ID`) REFERENCES `subscription` (`Subscription_ID`),
  CONSTRAINT `chk_payment_amount` CHECK ((`Payment_Amount` >= 0)),
  CONSTRAINT `chk_payment_link` CHECK ((((`Payment_Type` = _utf8mb4'Charging') and (`Session_ID` is not null) and (`Subscription_ID` is null)) or ((`Payment_Type` = _utf8mb4'Subscription') and (`Session_ID` is null) and (`Subscription_ID` is not null)) or ((`Payment_Type` = _utf8mb4'Wallet Top-Up') and (`Session_ID` is null) and (`Subscription_ID` is null)))),
  CONSTRAINT `chk_payment_method` CHECK (((`Payment_Method` is null) or (`Payment_Method` in (_utf8mb4'Wallet',_utf8mb4'Credit Card',_utf8mb4'Apple Pay')))),
  CONSTRAINT `chk_payment_status` CHECK ((`Payment_Status` in (_utf8mb4'success',_utf8mb4'failed',_utf8mb4'pending',_utf8mb4'written_off'))),
  CONSTRAINT `chk_payment_type` CHECK ((`Payment_Type` in (_utf8mb4'Charging',_utf8mb4'Subscription',_utf8mb4'Wallet Top-Up')))
) ENGINE=InnoDB AUTO_INCREMENT=68375 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `simulation_run` (
  `Run_ID` bigint NOT NULL AUTO_INCREMENT,
  `Run_Date` date NOT NULL,
  `Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `Source` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `Seed_Value` bigint NOT NULL,
  `Job_ID` bigint DEFAULT NULL,
  `Session_Count` int NOT NULL DEFAULT '0',
  `Situation_Count` int NOT NULL DEFAULT '0',
  `Resolved_Count` int NOT NULL DEFAULT '0',
  `Started_At` datetime(3) DEFAULT NULL,
  `Completed_At` datetime(3) DEFAULT NULL,
  `Error_Message` text COLLATE utf8mb4_unicode_ci,
  `Created_At` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`Run_ID`),
  UNIQUE KEY `uq_simulation_run_date` (`Run_Date`),
  KEY `idx_simulation_status` (`Status`,`Created_At`),
  CONSTRAINT `chk_simulation_counts` CHECK (((`Session_Count` >= 0) and (`Situation_Count` >= 0) and (`Resolved_Count` >= 0))),
  CONSTRAINT `chk_simulation_status` CHECK ((`Status` in (_utf8mb4'queued',_utf8mb4'processing',_utf8mb4'completed',_utf8mb4'failed')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `station` (
  `Station_ID` int NOT NULL AUTO_INCREMENT,
  `Company_ID` int NOT NULL,
  `Station_Name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Station_Street` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Station_City` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Station_State` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Station_Zip` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Station_Slots` int NOT NULL,
  `Station_Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Station_Opening_Hours` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Station_Lat` decimal(9,6) DEFAULT NULL,
  `Station_Lng` decimal(9,6) DEFAULT NULL,
  PRIMARY KEY (`Station_ID`),
  KEY `Company_ID` (`Company_ID`),
  CONSTRAINT `station_ibfk_1` FOREIGN KEY (`Company_ID`) REFERENCES `company` (`Company_ID`),
  CONSTRAINT `chk_station_slots` CHECK ((`Station_Slots` > 0)),
  CONSTRAINT `chk_station_status` CHECK ((`Station_Status` in (_utf8mb4'Open',_utf8mb4'Closed',_utf8mb4'Maintenance')))
) ENGINE=InnoDB AUTO_INCREMENT=52 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `subscription` (
  `Subscription_ID` int NOT NULL AUTO_INCREMENT,
  `User_ID` int NOT NULL,
  `Plan_ID` int NOT NULL,
  `Start_Date` date NOT NULL,
  `End_Date` date NOT NULL,
  `Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`Subscription_ID`),
  KEY `User_ID` (`User_ID`),
  KEY `Plan_ID` (`Plan_ID`),
  CONSTRAINT `subscription_ibfk_1` FOREIGN KEY (`User_ID`) REFERENCES `user` (`User_ID`),
  CONSTRAINT `subscription_ibfk_2` FOREIGN KEY (`Plan_ID`) REFERENCES `membership` (`Plan_ID`),
  CONSTRAINT `chk_subscription_dates` CHECK ((`End_Date` >= `Start_Date`)),
  CONSTRAINT `chk_subscription_status` CHECK ((`Status` in (_utf8mb4'Pending',_utf8mb4'Active',_utf8mb4'Expired',_utf8mb4'Cancelled')))
) ENGINE=InnoDB AUTO_INCREMENT=501 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `technician` (
  `Technician_ID` int NOT NULL AUTO_INCREMENT,
  `Technician_FirstName` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Technician_LastName` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Technician_Phone` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Technician_City` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Technician_State` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Technician_Lat` decimal(9,6) DEFAULT NULL,
  `Technician_Lng` decimal(9,6) DEFAULT NULL,
  PRIMARY KEY (`Technician_ID`)
) ENGINE=InnoDB AUTO_INCREMENT=102 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user` (
  `User_ID` int NOT NULL AUTO_INCREMENT,
  `User_FName` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `User_LName` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `User_Email` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `User_Phone_Num` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `User_Vehicle_Brand` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `User_Vehicle_Model` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`User_ID`),
  UNIQUE KEY `User_Email` (`User_Email`)
) ENGINE=InnoDB AUTO_INCREMENT=181 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `wallet` (
  `Wallet_ID` int NOT NULL AUTO_INCREMENT,
  `User_ID` int NOT NULL,
  `Wallet_Balance` decimal(10,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`Wallet_ID`),
  UNIQUE KEY `User_ID` (`User_ID`),
  CONSTRAINT `wallet_ibfk_1` FOREIGN KEY (`User_ID`) REFERENCES `user` (`User_ID`),
  CONSTRAINT `chk_wallet_balance` CHECK ((`Wallet_Balance` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=181 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `worker_node` (
  `Worker_ID` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `Hostname` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Pid` int DEFAULT NULL,
  `Queues` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Started_At` datetime NOT NULL,
  `Last_Heartbeat` datetime(3) NOT NULL,
  `Jobs_Processed` bigint NOT NULL DEFAULT '0',
  `Jobs_Failed` bigint NOT NULL DEFAULT '0',
  `Status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'running',
  PRIMARY KEY (`Worker_ID`),
  KEY `idx_worker_heartbeat` (`Last_Heartbeat`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
