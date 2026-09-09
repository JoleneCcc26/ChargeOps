// server/routes/users.js
import { Router } from "express";
import { pool } from "../db.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";

const router = Router();
const EFFECTIVE_SUBSCRIPTION_STATUS = `CASE
  WHEN sub.Subscription_ID IS NULL THEN NULL
  WHEN sub.Status = 'Cancelled' THEN 'Cancelled'
  WHEN sub.Start_Date > CURDATE() THEN 'Pending'
  WHEN sub.End_Date < CURDATE() THEN 'Expired'
  ELSE 'Active'
END`;

// GET /api/users?plan=Gold&subStatus=active
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    if (req.query.plan) {
      conditions.push("m.Plan_Name = ?");
      params.push(req.query.plan);
    }
    if (req.query.subStatus) {
      conditions.push(`${EFFECTIVE_SUBSCRIPTION_STATUS} = ?`);
      params.push(req.query.subStatus);
    }
    if (req.query.search) {
      conditions.push("(u.User_FName LIKE ? OR u.User_LName LIKE ? OR u.User_Email LIKE ?)");
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      params.push(q, q, q);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const latestSubscriptionJoin = `
       LEFT JOIN subscription sub ON sub.Subscription_ID = (
         SELECT s2.Subscription_ID
           FROM subscription s2
          WHERE s2.User_ID = u.User_ID
          ORDER BY (s2.Status = 'Active' AND CURDATE() BETWEEN s2.Start_Date AND s2.End_Date) DESC,
                   s2.End_Date DESC, s2.Subscription_ID DESC
          LIMIT 1
       )
       LEFT JOIN membership m ON m.Plan_ID = sub.Plan_ID`;
    const pagination = paginationFrom(req.query, { defaultPageSize: 200, maxPageSize: 500 });

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM user u ${latestSubscriptionJoin} ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT u.User_ID    AS id,
              CONCAT(u.User_FName, ' ', u.User_LName) AS name,
              u.User_Email AS email,
              u.User_Phone_Num AS phone,
              u.User_Vehicle_Brand AS vehicle_brand,
              u.User_Vehicle_Model AS vehicle_model,
              sub.Subscription_ID  AS subscription_id,
              m.Plan_Name          AS plan_tier,
              sub.Start_Date       AS started,
              sub.End_Date         AS renews,
              ${EFFECTIVE_SUBSCRIPTION_STATUS} AS subscription_status
       FROM user u
       ${latestSubscriptionJoin}
       ${where}
       ORDER BY u.User_FName, u.User_LName
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    setPaginationHeaders(res, pagination, Number(countRow.total));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get("/:id", async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT u.*,
              m.Plan_Name   AS plan_tier,
              ${EFFECTIVE_SUBSCRIPTION_STATUS} AS subscription_status,
              sub.Start_Date AS started,
              sub.End_Date   AS renews
       FROM user u
       LEFT JOIN subscription sub ON sub.Subscription_ID = (
         SELECT s2.Subscription_ID
           FROM subscription s2
          WHERE s2.User_ID = u.User_ID
          ORDER BY (s2.Status = 'Active' AND CURDATE() BETWEEN s2.Start_Date AND s2.End_Date) DESC,
                   s2.End_Date DESC, s2.Subscription_ID DESC
          LIMIT 1
       )
       LEFT JOIN membership m     ON m.Plan_ID   = sub.Plan_ID
       WHERE u.User_ID = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "User not found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

export default router;
