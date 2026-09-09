# Basic (Join, filter, ordering)
# 1: Join the charger and station tables to display each charger along with its station name and charger type.
SELECT c.Charger_ID, s.Station_Name, c.Charger_Type
FROM charger c
JOIN station s ON c.Station_ID = s.Station_ID;

# 2: Join the user and subscription tables to retrieve all users who currently have an active subscription, including their ID, first name, last name, and email. 
SELECT DISTINCT u.User_ID, u.User_FName, u.User_LName, u.User_Email
FROM user u
JOIN subscription s ON u.User_ID = s.User_ID
WHERE s.Status = 'Active';

# 3. Join the company and station tables to display each station alongside its company, filtered to Texas locations only, including full address details and operating hours.
SELECT C.Company_ID, C.Company_Name, S.Station_ID, S.Station_Name, S.Station_Street, S.Station_State, S.Station_City, S.Station_Zip, S.Station_Slots, S.Station_Status, S.Station_Opening_Hours FROM company C
JOIN station S
ON C.Company_ID = S.Company_ID
WHERE S.Station_State = 'TX';

# 4: Retrieve users with active subscriptions and their corresponding membership plans by joining the user, subscription, and membership tables, and display the results ordered by plan name and user name.
SELECT u.User_ID,
       u.User_FName,
       u.User_LName,
       m.Plan_Name
FROM user u
JOIN subscription s ON u.User_ID = s.User_ID
JOIN membership m ON s.Plan_ID = m.Plan_ID
WHERE s.Status = 'Active'
ORDER BY m.Plan_Name, u.User_LName, u.User_FName;


# 5: Retrieve details of completed charging sessions by joining the company, station, charger, and charging_session tables, including company name, station name, and session cost, and present the results in descending order of session cost.
SELECT c.Company_Name,
       s.Station_Name,
       cs.Session_ID,
       cs.Total_Cost AS Session_Cost
FROM company c
JOIN station s ON c.Company_ID = s.Company_ID
JOIN charger ch ON s.Station_ID = ch.Station_ID
JOIN charging_session cs ON ch.Charger_ID = cs.Charger_ID
WHERE cs.Session_Status = 'Completed'
ORDER BY cs.Total_Cost DESC;

# 6: Join the technician and maintenance_log tables to retrieve details of maintenance tasks assigned to each technician, including technician information, maintenance ID, station ID, and reported issues, and display the results ordered by technician name.
SELECT t.Technician_ID,
       t.Technician_FirstName,
       t.Technician_LastName,
       t.Technician_City,
       m.Maintenance_ID,
       m.Station_ID,
       m.Issue_Reported
FROM technician t
JOIN maintenance_log m ON t.Technician_ID = m.Technician_ID
ORDER BY t.Technician_LastName, t.Technician_FirstName;

-- ----------------------------------------------------
# Intermediate (group by + having, subqueries)
# 1: Calculate the total spending of each user based on successful payments and retrieve users whose total spending exceeds 200, displaying the results in descending order of total spending.
SELECT User_ID,  SUM(Payment_Amount) AS Total_Spent
FROM payment
WHERE Payment_Status = 'success'
GROUP BY User_ID
Having Total_Spent > 200
Order By Total_Spent DESC;

# 2: Compute the average charging cost for each station by joining charging_session, charger, and station tables, and identify stations whose average cost exceeds the overall average cost of completed charging sessions, displaying the results in descending order.
SELECT s.Station_ID,
       s.Station_Name,
       ROUND(AVG(cs.Total_Cost), 2) AS Station_Avg_Cost
FROM charging_session cs
JOIN charger c ON cs.Charger_ID = c.Charger_ID
JOIN station s ON c.Station_ID = s.Station_ID
WHERE cs.Session_Status = 'Completed'
GROUP BY s.Station_ID, s.Station_Name
HAVING AVG(cs.Total_Cost) > (
    SELECT AVG(Total_Cost)
    FROM charging_session
    WHERE Session_Status = 'Completed'
)
ORDER BY Station_Avg_Cost DESC;

# 3: Compute the number of power-related maintenance issues for each station in Texas by joining the station and maintenance_log tables, and display the results in descending order of issue count.
SELECT s.Station_ID,
       s.Station_Name,
       COUNT(m.Maintenance_ID) AS Power_Issues
FROM station s
JOIN maintenance_log m ON s.Station_ID = m.Station_ID
WHERE s.Station_State = 'TX'
  AND m.Issue_Reported LIKE '%power%'
GROUP BY s.Station_ID, s.Station_Name
ORDER BY Power_Issues DESC;

#4: Retrieve users who are registered in the system but have never used a charging session, by identifying users whose IDs do not appear in the charging_session table.
SELECT 
    u.User_ID,
    u.User_FName,
    u.User_LName,
    u.User_Email
FROM user u
WHERE NOT EXISTS (
    SELECT *
    FROM charging_session cs
    WHERE cs.User_ID = u.User_ID
);

# 5. Identify users with wallet balances between 200 and 500 who do not have an active subscription, and retrieve their full name and email to support targeted marketing and increase subscription conversions.
SELECT 
    u.User_ID,
    CONCAT(u.User_FName, ' ', u.User_LName) AS Full_Name,
    u.User_Email,
    w.Wallet_Balance
FROM user u
JOIN wallet w 
ON u.User_ID = w.User_ID
WHERE w.Wallet_Balance BETWEEN 200 AND 500
AND NOT EXISTS (
    SELECT *
    FROM subscription s
    WHERE s.User_ID = u.User_ID
    AND s.Status = 'Active'
);

# 6: Calculate the average number of maintenance tasks per station for each company and rank companies from highest to lowest.
SELECT c.Company_ID,
       c.Company_Name,
       ROUND(COUNT(m.Maintenance_ID) * 1.0 / COUNT(DISTINCT s.Station_ID), 2) AS Avg_Maintenance_Tasks_Per_Station
FROM company c
JOIN station s ON c.Company_ID = s.Company_ID
LEFT JOIN maintenance_log m ON s.Station_ID = m.Station_ID
GROUP BY c.Company_ID, c.Company_Name
ORDER BY Avg_Maintenance_Tasks_Per_Station DESC;

# 7: Identifying the top 5 EV vehicle brands with the highest average energy consumption per session
SELECT 
    u.User_Vehicle_Brand, 
    ROUND(AVG(cs.Energy_Consumed), 2) AS Average_Energy_kWh
FROM user u
JOIN charging_session cs ON u.User_ID = cs.User_ID
WHERE cs.Session_Status = 'Completed'
GROUP BY u.User_Vehicle_Brand
ORDER BY Average_Energy_kWh DESC
LIMIT 5;

# 8: Compute the total charging revenue earned by each company and rank companies from highest to lowest.
SELECT c.Company_ID,
       c.Company_Name,
       SUM(cs.Total_Cost) AS Total_Revenue
FROM company c
JOIN station s ON c.Company_ID = s.Company_ID
JOIN charger ch ON s.Station_ID = ch.Station_ID
JOIN charging_session cs ON ch.Charger_ID = cs.Charger_ID
WHERE cs.Session_Status = 'Completed'
GROUP BY c.Company_ID, c.Company_Name
ORDER BY Total_Revenue DESC;

-- ----------------------------------------------------
# Advanced queries


# 1: Create a view to summarize total charging revenue by station and Retrieve stations whose revenue is above the average station revenue
CREATE VIEW station_revenue_summary AS
SELECT s.Station_ID,
       s.Station_Name,
       s.Station_City,
       SUM(cs.Total_Cost) AS Total_Revenue
FROM station s
JOIN charger c ON s.Station_ID = c.Station_ID
JOIN charging_session cs ON c.Charger_ID = cs.Charger_ID
WHERE cs.Session_Status = 'Completed'
GROUP BY s.Station_ID, s.Station_Name, s.Station_City;

SELECT Station_ID,
       Station_Name,
       Station_City,
       Total_Revenue
FROM station_revenue_summary
WHERE Total_Revenue > (
    SELECT AVG(Total_Revenue)
    FROM station_revenue_summary
)
ORDER BY Total_Revenue DESC;

#2: Create a combined user list of active subscribers and users with wallet balances above 300.
SELECT u.User_ID,
       CONCAT(u.User_FName, ' ', u.User_LName) AS Full_Name,
       u.User_Email,
       'Active Subscriber' AS User_Group
FROM user u
JOIN subscription s ON u.User_ID = s.User_ID
WHERE s.Status = 'Active'

UNION

SELECT u.User_ID,
       CONCAT(u.User_FName, ' ', u.User_LName) AS Full_Name,
       u.User_Email,
       'High Wallet Balance' AS User_Group
FROM user u
JOIN wallet w ON u.User_ID = w.User_ID
WHERE w.Wallet_Balance > 300;
