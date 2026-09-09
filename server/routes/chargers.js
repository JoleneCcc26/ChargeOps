// server/routes/chargers.js
import { Router } from "express";
import { pool } from "../db.js";
import { allowRoles, ROLES } from "../auth.js";
import { writeAudit } from "../lib/audit.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";
import * as cache from "../adapters/cache.js";
import { applyTenantScope, denyForeignTenant } from "../lib/scope.js";

const router = Router();

// GET /api/chargers?stationId=&type=dc_fast&status=available
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    // Everything except the status filter is tracked separately, so the
    // availability breakdown below can be computed over the same fleet the user
    // is looking at while ignoring the status they happen to be filtering by.
    // Filtering to "In Use" and then being shown "In Use 143, everything else
    // 0" would tell the operator nothing.
    const scopeConditions = [];
    const scopeParams = [];
    const addScope = (sql, ...values) => {
      conditions.push(sql);
      params.push(...values);
      scopeConditions.push(sql);
      scopeParams.push(...values);
    };

    // Tenancy first: a host may filter within their own sites, never outside.
    applyTenantScope(req, conditions, params, "s.Company_ID");
    applyTenantScope(req, scopeConditions, scopeParams, "s.Company_ID");

    if (req.query.stationId) addScope("c.Station_ID = ?", req.query.stationId);
    if (req.query.type) addScope("c.Charger_Type = ?", req.query.type);
    if (req.query.search) {
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      addScope(
        "(CAST(c.Charger_ID AS CHAR) LIKE ? OR s.Station_Name LIKE ? OR c.Charger_Type LIKE ?)",
        q, q, q
      );
    }
    if (req.query.status) {
      conditions.push("c.Charger_Availability_Status = ?");
      params.push(req.query.status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const scopeWhere = scopeConditions.length ? `WHERE ${scopeConditions.join(" AND ")}` : "";
    const pagination = paginationFrom(req.query, { defaultPageSize: 500, maxPageSize: 1000 });

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM charger c
         JOIN station s ON s.Station_ID = c.Station_ID
         ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT c.Charger_ID               AS id,
              c.Station_ID               AS station_id,
              s.Station_Name             AS station_name,
              c.Charger_Type             AS charger_type,
              c.Charger_Power_Capacity   AS max_kw,
              c.Charging_Rate_Per_kWh    AS rate_per_kwh,
              c.Charger_Availability_Status AS status,
              c.Last_Maintenance_Date    AS last_maintenance_date
       FROM charger c
       JOIN station s ON s.Station_ID = c.Station_ID
       ${where}
       ORDER BY s.Station_Name, c.Charger_ID
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    // Fleet-wide availability breakdown.
    //
    // This has to come from the database, not from counting the rows on the
    // current page. The page holds 25 chargers; the fleet holds 859. Counting
    // the page and displaying the result next to a fleet-wide total produced
    // tiles reading "In Use 5" when 143 chargers were actually charging.
    const [breakdown] = await pool.query(
      `SELECT c.Charger_Availability_Status AS status, COUNT(*) AS count
         FROM charger c
         JOIN station s ON s.Station_ID = c.Station_ID
         ${scopeWhere}
         GROUP BY c.Charger_Availability_Status`,
      scopeParams
    );

    setPaginationHeaders(res, pagination, Number(countRow.total));
    res.setHeader(
      "X-Status-Counts",
      JSON.stringify(
        Object.fromEntries(breakdown.map((r) => [r.status, Number(r.count)]))
      )
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/chargers/:id
router.get("/:id", async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT c.*, s.Station_Name AS station_name, s.Company_ID AS company_id
       FROM charger c
       JOIN station s ON s.Station_ID = c.Station_ID
       WHERE c.Charger_ID = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Charger not found" });
    // Same reasoning as the station detail route: the LIST is filtered, so a
    // host never sees a foreign charger to click on — but nothing stopped them
    // typing the id, and the endpoint answered.
    if (!denyForeignTenant(req, res, row.company_id)) return;
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// GET /api/chargers/:id/history — what has gone wrong with this unit before
//
// The single most useful thing to hand a technician before they open a panel.
// "The connector latch was replaced six weeks ago" turns a diagnosis from
// guesswork into a check, and a unit that has failed four times this quarter is
// a replacement decision rather than another repair.
//
// Deliberately available to technicians: it is equipment history, not customer
// or financial data, and withholding it would make the job harder for no gain.
router.get("/:id/history", async (req, res, next) => {
  const chargerId = Number(req.params.id);
  if (!Number.isInteger(chargerId)) return res.status(400).json({ error: "invalid charger id" });

  try {
    const [[charger]] = await pool.query(
      `SELECT c.Charger_ID AS id, c.Charger_Type AS charger_type,
              c.Charger_Power_Capacity AS max_kw,
              c.Charger_Availability_Status AS status,
              c.Last_Maintenance_Date AS last_maintenance_date,
              s.Station_ID AS station_id, s.Station_Name AS station_name,
              s.Station_City AS city, s.Station_State AS state,
              s.Station_Lat AS lat, s.Station_Lng AS lng,
              s.Company_ID AS company_id
         FROM charger c
         JOIN station s ON s.Station_ID = c.Station_ID
        WHERE c.Charger_ID = ?`,
      [chargerId]
    );
    if (!charger) return res.status(404).json({ error: "charger not found" });
    // Maintenance history is equipment data, not customer data, so a technician
    // gets it freely. A site host still only gets it for their own bays: how
    // often a competitor's hardware fails is not theirs to know.
    if (!denyForeignTenant(req, res, charger.company_id)) return;
    delete charger.company_id;

    const [history] = await pool.query(
      `SELECT m.Maintenance_ID AS id,
              m.Issue_Reported  AS issue,
              m.Fault_Code      AS fault_code,
              m.Severity        AS severity,
              m.Status          AS status,
              m.Reported_At     AS reported_at,
              m.Reported_By     AS reported_by,
              m.Report_Source   AS report_source,
              m.Resolved_Time   AS resolved_at,
              m.Resolution_Notes AS resolution_notes,
              CONCAT(t.Technician_FirstName, ' ', t.Technician_LastName) AS technician_name,
              TIMESTAMPDIFF(HOUR, m.Reported_At, m.Resolved_Time) AS repair_hours
         FROM maintenance_log m
         LEFT JOIN technician t ON t.Technician_ID = m.Technician_ID
        WHERE m.Charger_ID = ?
        ORDER BY COALESCE(m.Reported_At, m.Resolved_Time) DESC
        LIMIT 50`,
      [chargerId]
    );

    // A repeat offender is worth flagging rather than leaving the reader to
    // count rows: four faults in ninety days is a hardware problem.
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS faults_90d,
              SUM(m.Status IN ('Reported','Assigned','In Progress')) AS open_now,
              ROUND(AVG(TIMESTAMPDIFF(HOUR, m.Reported_At, m.Resolved_Time))) AS avg_repair_hours
         FROM maintenance_log m
        WHERE m.Charger_ID = ?
          AND m.Reported_At > NOW() - INTERVAL 90 DAY
          AND m.Status <> 'Rejected'`,
      [chargerId]
    );

    res.json({
      charger,
      stats: {
        faults90d: Number(stats.faults_90d) || 0,
        openNow: Number(stats.open_now) || 0,
        avgRepairHours: Number(stats.avg_repair_hours) || 0,
        repeatOffender: Number(stats.faults_90d) >= 4,
      },
      history: history.map((h) => ({ ...h, repair_hours: h.repair_hours == null ? null : Number(h.repair_hours) })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/chargers/:id/status  { status, reason }
router.patch("/:id/status", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  const chargerId = Number(req.params.id);
  const status = String(req.body?.status || "");
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const allowed = new Set(["Available", "In Use", "Out of Service", "Reserved"]);

  if (!Number.isInteger(chargerId) || !allowed.has(status)) {
    return res.status(400).json({ error: "valid charger id and status are required" });
  }
  if (status === "Out of Service" && !reason) {
    return res.status(400).json({ error: "a reason is required when disabling a charger" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[current]] = await conn.query(
      `SELECT Charger_Availability_Status AS status FROM charger WHERE Charger_ID = ? FOR UPDATE`,
      [chargerId]
    );
    if (!current) {
      await conn.rollback();
      return res.status(404).json({ error: "Charger not found" });
    }

    await conn.query(
      `UPDATE charger SET Charger_Availability_Status = ? WHERE Charger_ID = ?`,
      [status, chargerId]
    );
    await writeAudit(
      {
        actor: req.user,
        action: "charger.status_changed",
        entityType: "charger",
        entityId: chargerId,
        details: { from: current.status, to: status, reason },
      },
      conn
    );
    await conn.commit();
    cache.invalidate("chargers:");
    cache.invalidate("dashboard:");
    res.json({ id: chargerId, status, previousStatus: current.status });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

export default router;
