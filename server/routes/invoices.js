// server/routes/invoices.js - PDF receipts produced by the billing worker
//
// Note what the database holds and what it does not: invoice stores the amount,
// the session it belongs to, and the object-storage key. The PDF itself is in
// object storage, and the browser reaches it through a short-lived signed URL
// minted here at read time.
//
// This is the same split as attachment, in the opposite direction - files the
// system produces rather than files it receives - and it is worth showing both
// in the demo, because "unstructured file processing" covers generation as well
// as ingestion.
import { Router } from "express";
import { pool } from "../db.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";
import { getSignedUrl } from "../adapters/storage.js";

const router = Router();

// GET /api/invoices?userId=3&limit=50
router.get("/", async (req, res, next) => {
  try {
    const userId = Number(req.query.userId);
    const conditions = [];
    const params = [];

    if (Number.isInteger(userId)) {
      conditions.push("i.User_ID = ?");
      params.push(userId);
    }
    if (req.query.search) {
      // Invoice number, driver, or station — the three things somebody
      // actually has in hand when they come looking for one.
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      conditions.push(
        `(i.Invoice_Number LIKE ?
          OR CONCAT(u.User_FName, ' ', u.User_LName) LIKE ?
          OR st.Station_Name LIKE ?
          OR CAST(i.Session_ID AS CHAR) LIKE ?)`
      );
      params.push(q, q, q, q);
    }

    const from = `
       FROM invoice i
       JOIN user u ON u.User_ID = i.User_ID
       LEFT JOIN charging_session cs ON cs.Session_ID = i.Session_ID
       LEFT JOIN charger c  ON c.Charger_ID  = cs.Charger_ID
       LEFT JOIN station st ON st.Station_ID = c.Station_ID`;
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const pagination = paginationFrom(req.query, { defaultPageSize: 25, maxPageSize: 200 });

    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${where}`, params);

    const [rows] = await pool.query(
      `SELECT i.Invoice_ID     AS id,
              i.Invoice_Number AS number,
              i.Session_ID     AS session_id,
              i.User_ID        AS user_id,
              i.Payment_ID     AS payment_id,
              i.Storage_Key    AS storage_key,
              i.Amount         AS amount,
              i.Generated_At   AS generated_at,
              CONCAT(u.User_FName, ' ', u.User_LName) AS user_name,
              u.User_Email     AS user_email,
              st.Station_Name  AS station_name,
              cs.Energy_Consumed AS kwh,
              cs.End_Time      AS session_ended_at
         ${from}
         ${where}
        ORDER BY i.Invoice_ID DESC
        LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );

    setPaginationHeaders(res, pagination, Number(countRow.total));

    // The signed URL is minted per response and expires in fifteen minutes.
    //
    // It is not stored anywhere and not reusable later, which is the point: the
    // bytes live in object storage and the application hands out a short-lived
    // capability to fetch them rather than proxying every download through
    // itself. Swapping the local adapter for S3 changes getSignedUrl and
    // nothing else.
    res.json(rows.map((r) => ({ ...r, url: getSignedUrl(r.storage_key, 900) })));
  } catch (err) {
    next(err);
  }
});

export default router;
