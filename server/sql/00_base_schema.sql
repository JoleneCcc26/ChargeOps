CREATE DATABASE IF NOT EXISTS EV1;
USE EV1;

CREATE TABLE company (
    Company_ID INT PRIMARY KEY AUTO_INCREMENT,
    Company_Name VARCHAR(50) NOT NULL,
    Company_Contact_Info VARCHAR(100)
);

CREATE TABLE user (
    User_ID INT PRIMARY KEY AUTO_INCREMENT,
    User_FName VARCHAR(60) NOT NULL,
    User_LName VARCHAR(60) NOT NULL,
    User_Email VARCHAR(120) NOT NULL UNIQUE,
    User_Phone_Num VARCHAR(20),
    User_Vehicle_Brand VARCHAR(50) NOT NULL,
    User_Vehicle_Model VARCHAR(100) NOT NULL
);

CREATE TABLE membership (
    Plan_ID INT PRIMARY KEY AUTO_INCREMENT,
    Plan_Name VARCHAR(80) NOT NULL,
    Discount_Rate DECIMAL(5,2) NOT NULL,
    Monthly_Price DECIMAL(10,2) NOT NULL,
    CONSTRAINT chk_membership_discount CHECK (Discount_Rate >= 0 AND Discount_Rate <= 100),
    CONSTRAINT chk_membership_price CHECK (Monthly_Price >= 0)
);

CREATE TABLE technician (
    Technician_ID INT PRIMARY KEY AUTO_INCREMENT,
    Technician_FirstName VARCHAR(100) NOT NULL,
    Technician_LastName VARCHAR(100) NOT NULL,
    Technician_Phone VARCHAR(20),
    Technician_City VARCHAR(50) NOT NULL,
    Technician_State VARCHAR(50) NOT NULL
);

CREATE TABLE station (
    Station_ID INT PRIMARY KEY AUTO_INCREMENT,
    Company_ID INT NOT NULL,
    Station_Name VARCHAR(100) NOT NULL,
    Station_Street VARCHAR(100) NOT NULL,
    Station_City VARCHAR(50) NOT NULL,
    Station_State VARCHAR(50) NOT NULL,
    Station_Zip VARCHAR(20) NOT NULL,
    Station_Slots INT NOT NULL,
    Station_Status VARCHAR(20) NOT NULL,
    Station_Opening_Hours VARCHAR(100),
    FOREIGN KEY (Company_ID) REFERENCES company(Company_ID),
    CONSTRAINT chk_station_slots CHECK (Station_Slots > 0),
    CONSTRAINT chk_station_status CHECK (Station_Status IN ('Open', 'Closed', 'Maintenance'))
);

CREATE TABLE wallet (
    Wallet_ID INT PRIMARY KEY AUTO_INCREMENT,
    User_ID INT NOT NULL UNIQUE,
    Wallet_Balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    FOREIGN KEY (User_ID) REFERENCES user(User_ID),
    CONSTRAINT chk_wallet_balance CHECK (Wallet_Balance >= 0)
);

CREATE TABLE subscription (
    Subscription_ID INT PRIMARY KEY AUTO_INCREMENT,
    User_ID INT NOT NULL,
    Plan_ID INT NOT NULL,
    Start_Date DATE NOT NULL,
    End_Date DATE NOT NULL,
    Status VARCHAR(20) NOT NULL,
    FOREIGN KEY (User_ID) REFERENCES user(User_ID),
    FOREIGN KEY (Plan_ID) REFERENCES membership(Plan_ID),
    CONSTRAINT chk_subscription_dates CHECK (End_Date >= Start_Date),
    CONSTRAINT chk_subscription_status CHECK (Status IN ('Pending', 'Active', 'Expired', 'Cancelled'))
);

CREATE TABLE charger (
    Charger_ID INT PRIMARY KEY AUTO_INCREMENT,
    Station_ID INT NOT NULL,
    Charger_Type VARCHAR(50) NOT NULL,
    Charger_Power_Capacity DECIMAL(10,2) NOT NULL,
    Charging_Rate_Per_kWh DECIMAL(10,4) NOT NULL,
    Charger_Availability_Status VARCHAR(30) NOT NULL,
    Last_Maintenance_Date DATE NOT NULL,
    FOREIGN KEY (Station_ID) REFERENCES station(Station_ID),
    CONSTRAINT chk_charger_power CHECK (Charger_Power_Capacity > 0),
    CONSTRAINT chk_charger_rate CHECK (Charging_Rate_Per_kWh > 0),
    CONSTRAINT chk_charger_status CHECK (Charger_Availability_Status IN ('Available', 'In Use', 'Out of Service', 'Reserved'))
);

-- End_Time, Energy_Consumed, Session_Rate_Per_kWh, Total_Cost are nullable
-- to support real-time sessions that start without a known end time.
-- They are populated automatically when the session ends (End_Time is updated).
CREATE TABLE charging_session (
    Session_ID INT PRIMARY KEY AUTO_INCREMENT,
    Charger_ID INT NOT NULL,
    User_ID INT NOT NULL,
    Start_Time DATETIME NOT NULL,
    End_Time DATETIME NULL,
    Energy_Consumed DECIMAL(10,2) NULL,
    Session_Rate_Per_kWh DECIMAL(10,4) NULL,
    Total_Cost DECIMAL(10,2) NULL,
    Session_Status VARCHAR(20) NOT NULL,
    FOREIGN KEY (Charger_ID) REFERENCES charger(Charger_ID),
    FOREIGN KEY (User_ID) REFERENCES user(User_ID),
    CONSTRAINT chk_session_time CHECK (End_Time IS NULL OR End_Time > Start_Time),
    CONSTRAINT chk_session_energy CHECK (Energy_Consumed IS NULL OR Energy_Consumed >= 0),
    CONSTRAINT chk_session_rate CHECK (Session_Rate_Per_kWh IS NULL OR Session_Rate_Per_kWh > 0),
    CONSTRAINT chk_session_cost CHECK (Total_Cost IS NULL OR Total_Cost >= 0),
    CONSTRAINT chk_session_status CHECK (Session_Status IN ('Pending', 'Completed', 'Cancelled'))
);

CREATE TABLE payment (
    Payment_ID INT PRIMARY KEY AUTO_INCREMENT,
    User_ID INT NOT NULL,
    Payment_Type VARCHAR(30) NOT NULL,
    Payment_Amount DECIMAL(10,2) NOT NULL,
    Payment_Method VARCHAR(50) NULL,
    Payment_Status VARCHAR(20) NOT NULL,
    Session_ID INT NULL,
    Subscription_ID INT NULL,
    Created_Time DATETIME NOT NULL,
    FOREIGN KEY (User_ID) REFERENCES user(User_ID),
    FOREIGN KEY (Session_ID) REFERENCES charging_session(Session_ID),
    FOREIGN KEY (Subscription_ID) REFERENCES subscription(Subscription_ID),
    UNIQUE KEY uq_payment_session (Session_ID),
    CONSTRAINT chk_payment_type CHECK (Payment_Type IN ('Charging', 'Subscription', 'Wallet Top-Up')),
    CONSTRAINT chk_payment_amount CHECK (Payment_Amount >= 0),
    CONSTRAINT chk_payment_method CHECK (Payment_Method IS NULL OR Payment_Method IN ('Wallet', 'Credit Card', 'Apple Pay')),
    CONSTRAINT chk_payment_status CHECK (Payment_Status IN ('success', 'failed', 'pending')),
    CONSTRAINT chk_payment_link CHECK (
        (Payment_Type = 'Charging' AND Session_ID IS NOT NULL AND Subscription_ID IS NULL) OR
        (Payment_Type = 'Subscription' AND Session_ID IS NULL AND Subscription_ID IS NOT NULL) OR
        (Payment_Type = 'Wallet Top-Up' AND Session_ID IS NULL AND Subscription_ID IS NULL)
    )
);

CREATE TABLE maintenance_log (
    Maintenance_ID INT PRIMARY KEY AUTO_INCREMENT,
    Charger_ID INT NOT NULL,
    Station_ID INT NOT NULL,
    Technician_ID INT NOT NULL,
    Issue_Reported TEXT NOT NULL,
    Resolved_Time DATETIME,
    Status VARCHAR(30) NOT NULL,
    FOREIGN KEY (Charger_ID) REFERENCES charger(Charger_ID),
    FOREIGN KEY (Station_ID) REFERENCES station(Station_ID),
    FOREIGN KEY (Technician_ID) REFERENCES technician(Technician_ID),
    CONSTRAINT chk_maintenance_status CHECK (Status IN ('Open', 'In Progress', 'Resolved'))
);


#############################################################################################
###### TRIGGERS #################


DELIMITER $$

DROP TRIGGER IF EXISTS trg_subscription_before_insert$$

## 1. Automatically set subscription status (ACTIVE, PENDING, EXPIRED) based on date range before insertion
CREATE TRIGGER trg_subscription_before_insert
BEFORE INSERT ON subscription
FOR EACH ROW
BEGIN
    IF NEW.Start_Date > CURDATE() THEN SET NEW.Status = 'Pending';
    ELSEIF NEW.End_Date < CURDATE() THEN SET NEW.Status = 'Expired';
    ELSE SET NEW.Status = 'Active';
    END IF;
END$$


DROP TRIGGER IF EXISTS trg_subscription_after_insert_payment$$

## 2. Generate a pending payment record automatically after a new subscription is created
CREATE TRIGGER trg_subscription_after_insert_payment
AFTER INSERT ON subscription
FOR EACH ROW
BEGIN
    DECLARE v_price DECIMAL(10,2);
    SELECT Monthly_Price INTO v_price FROM membership WHERE Plan_ID = NEW.Plan_ID;
    INSERT INTO payment (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status, Session_ID, Subscription_ID, Created_Time)
    VALUES (NEW.User_ID, 'Subscription', v_price, NULL, 'pending', NULL, NEW.Subscription_ID, NOW());
END$$


DROP TRIGGER IF EXISTS trg_charging_session_before_insert$$

DROP TRIGGER IF EXISTS trg_charging_session_before_insert$$

## 3. Handle both real-time sessions (no End_Time) and historical inserts (End_Time provided).
## - Real-time: lock the rate, set status to Pending, defer all calculations to trigger 10.
## - Historical: calculate Energy_Consumed and Total_Cost immediately on insert,
##   applying any active membership discount, then mark the session Completed.
## Total cost = Energy_Consumed * Session_Rate_Per_kWh * (1 - Discount)
CREATE TRIGGER trg_charging_session_before_insert
BEFORE INSERT ON charging_session
FOR EACH ROW
BEGIN
    DECLARE v_rate     DECIMAL(10,4);
    DECLARE v_power    DECIMAL(10,2);
    DECLARE v_hours    DECIMAL(10,4);
    DECLARE v_discount DECIMAL(5,2) DEFAULT 0;

    -- Always lock the rate from the charger at insert time
    SELECT Charging_Rate_Per_kWh, Charger_Power_Capacity INTO v_rate, v_power
    FROM charger WHERE Charger_ID = NEW.Charger_ID;

    SET NEW.Session_Rate_Per_kWh = v_rate;

    IF NEW.End_Time IS NULL THEN
        -- -------------------------------------------------------
        -- REAL-TIME SESSION: just started, no end time yet
        -- Defer all calculations to trigger 10 (before update)
        -- -------------------------------------------------------
        SET NEW.Session_Status  = 'Pending';
        SET NEW.Energy_Consumed = NULL;
        SET NEW.Total_Cost      = NULL;

    ELSE
        -- -------------------------------------------------------
        -- HISTORICAL INSERT: End_Time already provided
        -- Calculate everything now
        -- -------------------------------------------------------

        -- Reject invalid time range
        IF NEW.End_Time <= NEW.Start_Time THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'End_Time must be after Start_Time';
        END IF;

        -- Cap sessions that exceed 15 hours
        IF TIMESTAMPDIFF(HOUR, NEW.Start_Time, NEW.End_Time) > 15 THEN
            SET NEW.End_Time = DATE_ADD(NEW.Start_Time, INTERVAL 15 HOUR);
        END IF;

        -- Look up any active membership discount for this user
        SELECT COALESCE(m.Discount_Rate, 0) INTO v_discount
        FROM subscription s
        JOIN membership m ON s.Plan_ID = m.Plan_ID
        WHERE s.User_ID = NEW.User_ID
          AND s.Status  = 'Active'
          AND NEW.Start_Time BETWEEN s.Start_Date AND s.End_Date
        LIMIT 1;

        -- Use provided Energy_Consumed if given, otherwise estimate
        IF NEW.Energy_Consumed IS NULL OR NEW.Energy_Consumed = 0 THEN
            SET v_hours = TIMESTAMPDIFF(SECOND, NEW.Start_Time, NEW.End_Time) / 3600.0;
            SET NEW.Energy_Consumed = ROUND(v_power * v_hours * (0.7 + RAND() * 0.3), 2);
        END IF;

        -- Use provided Total_Cost if given, otherwise calculate
        IF NEW.Total_Cost IS NULL OR NEW.Total_Cost = 0 THEN
            SET NEW.Total_Cost = ROUND(
                NEW.Energy_Consumed * v_rate * (1 - v_discount / 100.0),
                2
            );
        END IF;

        -- Mark as Completed
        SET NEW.Session_Status = 'Completed';

    END IF;
END$$

DROP TRIGGER IF EXISTS trg_session_after_insert_charger_status$$

## 4. Update charger status to 'In Use' automatically when a charging session begins
CREATE TRIGGER trg_session_after_insert_charger_status
AFTER INSERT ON charging_session
FOR EACH ROW
BEGIN
    -- As soon as a Pending session is created, mark the charger as occupied
    UPDATE charger
    SET Charger_Availability_Status = 'In Use'
    WHERE Charger_ID = NEW.Charger_ID;
END$$


DROP TRIGGER IF EXISTS trg_payment_after_insert_topup$$

## 5. Update wallet balance when a 'Wallet Top-Up' payment is successful
CREATE TRIGGER trg_payment_after_insert_topup
AFTER INSERT ON payment
FOR EACH ROW
BEGIN
    IF NEW.Payment_Type = 'Wallet Top-Up' AND NEW.Payment_Status = 'success' THEN
        UPDATE wallet SET Wallet_Balance = Wallet_Balance + NEW.Payment_Amount WHERE User_ID = NEW.User_ID;
    END IF;
END$$


DROP TRIGGER IF EXISTS trg_payment_before_update_wallet$$

## 6. Validate wallet balance before payment:
-- If sufficient: deduct balance and mark payment as success.
-- If insufficient: fail payment and cancel the associated subscription.
CREATE TRIGGER trg_payment_before_update_wallet
BEFORE UPDATE ON payment
FOR EACH ROW
BEGIN
    IF OLD.Payment_Status = 'pending' AND NEW.Payment_Status = 'success' THEN

        IF NEW.Payment_Method = 'Wallet' THEN
            IF (SELECT Wallet_Balance FROM wallet WHERE User_ID = NEW.User_ID) < NEW.Payment_Amount THEN
                SET NEW.Payment_Status = 'failed';

                IF NEW.Subscription_ID IS NOT NULL THEN
                    UPDATE subscription
                    SET Status = 'Cancelled'
                    WHERE Subscription_ID = NEW.Subscription_ID;
                END IF;

            ELSE
                UPDATE wallet SET Wallet_Balance = Wallet_Balance - NEW.Payment_Amount WHERE User_ID = NEW.User_ID;
            END IF;
        END IF;

        IF NEW.Payment_Status = 'success' AND NEW.Session_ID IS NOT NULL THEN
            UPDATE charging_session SET Session_Status = 'Completed' WHERE Session_ID = NEW.Session_ID;
        END IF;

    END IF;
END$$


DROP TRIGGER IF EXISTS trg_maintenance_after_update$$

## 7. Sync the 'Last_Maintenance_Date' of a charger when a maintenance log is marked as 'Resolved'
CREATE TRIGGER trg_maintenance_after_update
AFTER UPDATE ON maintenance_log
FOR EACH ROW
BEGIN
    IF NEW.Status = 'Resolved' AND NEW.Resolved_Time IS NOT NULL THEN
        UPDATE charger SET Last_Maintenance_Date = DATE(NEW.Resolved_Time) WHERE Charger_ID = NEW.Charger_ID;
    END IF;
END$$


DROP TRIGGER IF EXISTS trg_session_after_update_release_charger$$

## 8. Automatically release the charger (set to 'Available') when the session is marked as 'Completed'
CREATE TRIGGER trg_session_after_update_release_charger
AFTER UPDATE ON charging_session
FOR EACH ROW
BEGIN
    -- If status changes from something else to 'Completed', free up the charger
    IF OLD.Session_Status <> 'Completed' AND NEW.Session_Status = 'Completed' THEN
        UPDATE charger
        SET Charger_Availability_Status = 'Available'
        WHERE Charger_ID = NEW.Charger_ID;
    END IF;
END$$


DROP TRIGGER IF EXISTS trg_charging_session_before_update_finalize$$

## 9. Finalize a charging session when End_Time is provided.
## Calculates Energy_Consumed (if not manually supplied), applies any active
## membership discount, computes Total_Cost, and marks the session Completed.
## Total cost = Charger_Power_Capacity * Charging_Hours * Session_Rate_Per_kWh * (1 - Discount)
CREATE TRIGGER trg_charging_session_before_update_finalize
BEFORE UPDATE ON charging_session
FOR EACH ROW
BEGIN
    DECLARE v_power    DECIMAL(10,2);
    DECLARE v_hours    DECIMAL(10,4);
    DECLARE v_discount DECIMAL(5,2) DEFAULT 0;

    -- Only run when End_Time transitions from NULL to a real value
    IF OLD.End_Time IS NULL AND NEW.End_Time IS NOT NULL THEN

        -- Reject an end time that is not after the start time
        IF NEW.End_Time <= OLD.Start_Time THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'End_Time must be after Start_Time';
        END IF;

        -- Cap sessions that exceed 15 hours to prevent runaway billing
        IF TIMESTAMPDIFF(HOUR, OLD.Start_Time, NEW.End_Time) > 15 THEN
            SET NEW.End_Time = DATE_ADD(OLD.Start_Time, INTERVAL 15 HOUR);
        END IF;

        -- Compute duration in fractional hours
        SET v_hours = TIMESTAMPDIFF(SECOND, OLD.Start_Time, NEW.End_Time) / 3600.0;

        -- Retrieve charger power capacity for energy estimation
        SELECT Charger_Power_Capacity INTO v_power
        FROM charger WHERE Charger_ID = OLD.Charger_ID;

        -- Look up any active membership discount for this user
        SELECT COALESCE(m.Discount_Rate, 0) INTO v_discount
        FROM subscription s
        JOIN membership m ON s.Plan_ID = m.Plan_ID
        WHERE s.User_ID = OLD.User_ID
          AND s.Status  = 'Active'
          AND CURDATE() BETWEEN s.Start_Date AND s.End_Date
        LIMIT 1;

        -- Estimate energy if not manually provided (randomised between 70-100% of rated capacity)
        IF NEW.Energy_Consumed IS NULL OR NEW.Energy_Consumed = 0 THEN
            SET NEW.Energy_Consumed = ROUND(v_power * v_hours * (0.7 + RAND() * 0.3), 2);
        END IF;

        -- Calculate total cost using the rate locked at session start
        SET NEW.Total_Cost = ROUND(
            NEW.Energy_Consumed * OLD.Session_Rate_Per_kWh * (1 - v_discount / 100.0),
            2
        );

        -- Mark the session as completed
        SET NEW.Session_Status = 'Completed';

    END IF;
END$$


DROP TRIGGER IF EXISTS trg_charging_session_after_update_payment$$

## 10. Generate a pending charging payment record once a session is finalized.
## Fires after trigger 10 has set Session_Status to 'Completed' and Total_Cost is known.
CREATE TRIGGER trg_charging_session_after_update_payment
AFTER UPDATE ON charging_session
FOR EACH ROW
BEGIN
    -- Only create the payment record on the single Pending -> Completed transition
    IF OLD.Session_Status = 'Pending' AND NEW.Session_Status = 'Completed' THEN
        INSERT INTO payment (
            User_ID, Payment_Type, Payment_Amount,
            Payment_Method, Payment_Status,
            Session_ID, Subscription_ID, Created_Time
        )
        VALUES (
            NEW.User_ID, 'Charging', NEW.Total_Cost,
            NULL, 'pending',
            NEW.Session_ID, NULL, NEW.End_Time
        );
    END IF;
END$$
## 11. Generate new payment records if session inserted was completed
CREATE TRIGGER trg_charging_session_after_insert_historical_payment
AFTER INSERT ON charging_session
FOR EACH ROW
BEGIN
    IF NEW.Session_Status = 'Completed' THEN
        INSERT INTO payment (User_ID, Payment_Type, Payment_Amount, Payment_Method, Payment_Status, Session_ID, Subscription_ID, Created_Time)
        VALUES (NEW.User_ID, 'Charging', NEW.Total_Cost, NULL, 'pending', NEW.Session_ID, NULL, NEW.End_Time);
    END IF;
END$$

DELIMITER ;
