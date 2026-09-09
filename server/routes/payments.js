// server/routes/payments.js
import { Router } from "express";
import { pool } from "../db.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";

const router = Router();

// Case-insensitive check for "successfully charged" statuses.
const COMPLETED_WHERE =
  "LOWER(TRIM(Payment_Status)) IN ('completed', 'complete', 'success', 'successful')";
const SUCCESSFUL_PAYMENT =
  "LOWER(TRIM(p.Payment_Status)) IN ('completed', 'complete', 'success', 'successful')";

function paymentFilters(query) {
  const conditions = [];
  const params = [];
  if (query.type)   { conditions.push("p.Payment_Type = ?");   params.push(query.type); }
  if (query.status) { conditions.push("p.Payment_Status = ?"); params.push(query.status); }
  if (query.method) { conditions.push("p.Payment_Method = ?"); params.push(query.method); }

  // A time window, applied here rather than at each call site so the table and
  // the revenue breakdown above it can never disagree about which period they
  // are describing. A donut labelled "93% energy" over all time sitting above a
  // table filtered to this week is two different claims on one screen.
  const days = Number(query.days);
  if (Number.isFinite(days) && days > 0) {
    conditions.push("p.Created_Time > NOW() - INTERVAL ? DAY");
    params.push(Math.min(days, 3650));
  }
  if (query.search) {
    conditions.push("(CONCAT(u.User_FName, ' ', u.User_LName) LIKE ? OR CAST(p.Payment_ID AS CHAR) LIKE ? OR p.Payment_Method LIKE ?)");
    const q = `%${String(query.search).slice(0, 100)}%`;
    params.push(q, q, q);
  }
  return { conditions, params };
}

// GET /api/payments/revenue-by-month  ← must come BEFORE "/:id" style routes
router.get("/revenue-by-month", async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(Created_Time, '%Y-%m') AS month,
             ROUND(SUM(Payment_Amount), 2) AS revenue
      FROM payment
      WHERE ${COMPLETED_WHERE}
        AND Created_Time IS NOT NULL
      GROUP BY DATE_FORMAT(Created_Time, '%Y-%m')
      ORDER BY month DESC
      LIMIT 12
    `);
    res.json(rows.reverse());
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/type-breakdown
router.get("/type-breakdown", async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT Payment_Type AS type,
             COUNT(*) AS count,
             ROUND(SUM(Payment_Amount), 2) AS total
      FROM payment
      WHERE ${COMPLETED_WHERE}
      GROUP BY Payment_Type
      HAVING total IS NOT NULL AND total > 0
      ORDER BY total DESC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/status-values — diagnostic: shows actual status values
router.get("/status-values", async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT Payment_Status FROM payment ORDER BY Payment_Status"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/filter-options - values from the full table, not one page
router.get("/filter-options", async (_req, res, next) => {
  try {
    const [[types], [statuses], [methods]] = await Promise.all([
      pool.query("SELECT DISTINCT Payment_Type AS value FROM payment ORDER BY Payment_Type"),
      pool.query("SELECT DISTINCT Payment_Status AS value FROM payment ORDER BY Payment_Status"),
      pool.query("SELECT DISTINCT Payment_Method AS value FROM payment WHERE Payment_Method IS NOT NULL ORDER BY Payment_Method"),
    ]);
    res.json({
      types: types.map((row) => row.value),
      statuses: statuses.map((row) => row.value),
      methods: methods.map((row) => row.value),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/analytics - global aggregates for the active filters
router.get("/analytics", async (req, res, next) => {
  try {
    const { conditions, params } = paymentFilters(req.query);
    conditions.push(SUCCESSFUL_PAYMENT);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const from = "FROM payment p LEFT JOIN user u ON u.User_ID = p.User_ID";
    const [[typeBreakdown], [monthly]] = await Promise.all([
      pool.query(`
        SELECT p.Payment_Type AS type, COUNT(*) AS count,
               ROUND(SUM(p.Payment_Amount), 2) AS total
          ${from} ${where}
         GROUP BY p.Payment_Type
         HAVING total IS NOT NULL AND total > 0
         ORDER BY total DESC
      `, params),
      pool.query(`
        SELECT DATE_FORMAT(p.Created_Time, '%Y-%m') AS month,
               ROUND(SUM(p.Payment_Amount), 2) AS revenue
          ${from} ${where}
           AND p.Created_Time IS NOT NULL
         GROUP BY DATE_FORMAT(p.Created_Time, '%Y-%m')
         ORDER BY month DESC
         LIMIT 12
      `, params),
    ]);
    res.json({ typeBreakdown, monthly: monthly.reverse() });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments?type=Charging&status=Completed
router.get("/", async (req, res, next) => {
  try {
    const { conditions, params } = paymentFilters(req.query);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const pagination = paginationFrom(req.query, { defaultPageSize: 250, maxPageSize: 1000 });
    const from = `FROM payment p LEFT JOIN user u ON u.User_ID = p.User_ID`;
    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${where}`, params);

    const [rows] = await pool.query(
      `SELECT p.Payment_ID     AS id,
              p.User_ID        AS user_id,
              CONCAT(u.User_FName, ' ', u.User_LName) AS user_name,
              p.Payment_Type   AS type,
              p.Payment_Method AS method,
              p.Payment_Amount AS amount,
              p.Payment_Status AS status,
              p.Session_ID     AS session_id,
              p.Created_Time   AS created_at
       ${from}
       ${where}
       ORDER BY p.Created_Time DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    setPaginationHeaders(res, pagination, Number(countRow.total));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
