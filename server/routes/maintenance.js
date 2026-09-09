// server/routes/maintenance.js
import { Router } from "express";
import { pool } from "../db.js";
import { allowRoles, ROLES } from "../auth.js";
import { writeAudit } from "../lib/audit.js";
import { paginationFrom, setPaginationHeaders } from "../lib/pagination.js";
import * as cache from "../adapters/cache.js";
import { applyTenantScope } from "../lib/scope.js";

const router = Router();

// GET /api/maintenance?status=Open&issueType=hardware
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    // ── A technician sees their own queue, nobody else's ────────────────────
    //
    // This is enforced HERE, in the query, not in the front end. Hiding rows in
    // React would be cosmetic: the technician could read every work order in
    // the network by calling the API directly. Row-level filtering server-side
    // is the only version of this that is actually true.
    //
    // The manager and the read-only viewer still see the whole network — that
    // is their job.
    if (req.user.role === ROLES.TECHNICIAN) {
      // A technician login with no linked technician row can see nothing at
      // all. Failing closed is the right default: better an empty queue than
      // somebody else's work orders.
      conditions.push("ml.Technician_ID = ?");
      params.push(req.user.tech ?? -1);
    }

    // A site host sees work orders on their own sites only — what is broken in
    // their car park is their business; what is broken in a competitor's is not.
    applyTenantScope(req, conditions, params, "s.Company_ID");

    // Conditions other than the status filter, so the status breakdown can be
    // computed over the same set the user is looking at. Same reasoning as the
    // chargers and sessions pages: a summary tile beside a filter-wide total has
    // to count the filter, not the twenty-five rows that fit on screen.
    const scopeConditions = [...conditions];
    const scopeParams = [...params];
    const addScope = (sql, ...values) => {
      conditions.push(sql);
      params.push(...values);
      scopeConditions.push(sql);
      scopeParams.push(...values);
    };

    if (req.query.status) {
      conditions.push("ml.Status = ?");
      params.push(req.query.status);
    }
    if (req.query.issueType) addScope("ml.Issue_Reported = ?", req.query.issueType);
    if (req.query.station) addScope("s.Station_Name = ?", req.query.station);
    if (req.query.search) {
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      addScope(
        "(ml.Issue_Reported LIKE ? OR s.Station_Name LIKE ? OR CAST(ml.Maintenance_ID AS CHAR) LIKE ?)",
        q, q, q
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const pagination = paginationFrom(req.query, { defaultPageSize: 250, maxPageSize: 1000 });

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM maintenance_log ml
         JOIN station s ON s.Station_ID = ml.Station_ID
         ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT ml.Maintenance_ID AS id,
              ml.Station_ID     AS station_id,
              s.Station_Name    AS station_name,
              ml.Charger_ID     AS charger_id,
              ml.Issue_Reported AS issue_type,
              ml.Status         AS status,
              ml.Resolved_Time  AS resolved_time,
              ml.Technician_ID  AS technician_id,
              CONCAT(t.Technician_FirstName, ' ', t.Technician_LastName) AS technician_name,
              t.Technician_City AS technician_city,
              ml.Reported_At    AS reported_at,
              ml.Reported_By    AS reported_by,
              ml.Report_Source  AS report_source,
              ml.Fault_Code     AS fault_code,
              ml.Severity       AS severity,
              ml.Priority       AS priority,
              ml.Assigned_At    AS assigned_at,
              ml.Assigned_By    AS assigned_by,
              ml.Started_At     AS started_at,
              ml.Resolution_Notes AS resolution_notes
       FROM maintenance_log ml
       JOIN station s ON s.Station_ID = ml.Station_ID
       LEFT JOIN technician t ON t.Technician_ID = ml.Technician_ID
       ${where}
       -- Unassigned reports first, then by severity, then newest. The dispatch
       -- queue should open on what needs a decision, not on what is newest.
       ORDER BY CASE ml.Status WHEN 'Reported' THEN 0 WHEN 'Assigned' THEN 1
                               WHEN 'In Progress' THEN 2 ELSE 3 END,
                CASE ml.Severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,
                ml.Maintenance_ID DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    const scopeWhere = scopeConditions.length ? `WHERE ${scopeConditions.join(" AND ")}` : "";
    const [breakdown] = await pool.query(
      `SELECT ml.Status AS status, COUNT(*) AS count
         FROM maintenance_log ml
         JOIN station s ON s.Station_ID = ml.Station_ID
         ${scopeWhere}
        GROUP BY ml.Status`,
      scopeParams
    );

    setPaginationHeaders(res, pagination, Number(countRow.total));
    res.setHeader(
      "X-Status-Counts",
      JSON.stringify(Object.fromEntries(breakdown.map((r) => [r.status, Number(r.count)])))
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DISPATCH WORKFLOW
// ═══════════════════════════════════════════════════════════════════════════
// A work order moves through states, and each transition is a deliberate act by
// a specific person:
//
//   Reported ──assign──▶ Assigned ──start──▶ In Progress ──resolve──▶ Resolved
//      │                                              (manager or the assignee)
//      └──reject──▶ Rejected
//
// Each transition is its own endpoint rather than a general "update any field".
// That is not ceremony: the rule for an action lives in one obvious place
// ("only the assignee may start work", "resolving is what returns the charger
// to service"), and the audit log records what somebody DID rather than which
// column changed.

// POST /api/maintenance  — raise a new fault report
//
// Open to technicians as well as managers, because the person standing in front
// of a broken charger is usually a technician. What they cannot do is decide
// who fixes it: the report is created UNASSIGNED and lands in the manager's
// dispatch queue.
router.post("/", allowRoles(ROLES.OPS_MANAGER, ROLES.TECHNICIAN), async (req, res, next) => {
  const chargerId = Number(req.body?.chargerId);
  const issue = String(req.body?.issue || "").trim();
  const severity = String(req.body?.severity || "major");
  // A report with no code still gets one, and the code is `UNCODED`.
  //
  // A manager logging a phone call genuinely may not have a code — the driver
  // said "it wouldn't charge" and that is all anyone knows. Forcing them to
  // invent one would be worse than allowing none, so the honest label is that
  // there was none.
  //
  // But it has to be a label rather than NULL. Everything downstream groups by
  // this column, and "how many reports arrive with nothing diagnostic at all?"
  // is a real question with an interesting answer — it says how much of the
  // queue is prose a technician has to interpret on site. A NULL cannot be
  // counted; UNCODED can, and it sits in the dashboard next to the vendor
  // codes where somebody will notice if it grows.
  const faultCode = String(req.body?.faultCode || "").trim().slice(0, 40) || "UNCODED";
  // Tri-state on purpose: true, false, or absent.
  //
  // `=== true` collapsed "the operator explicitly said do not pull it" into
  // the same value as "the field was never sent", which made it impossible to
  // override the severity default downwards. Absent means "use the default for
  // this severity"; a real boolean means the reporter decided.
  const takeOutOfService =
    typeof req.body?.takeOutOfService === "boolean" ? req.body.takeOutOfService : undefined;

  // How the fault came to be known.
  //
  // A technician is standing in front of the unit; a manager almost never is.
  // They are recording something a driver phoned in, or that the monitoring
  // stack noticed at 3am, and those are not the same claim. A driver report is
  // one person's account of a bad evening; a remote alarm is the charger itself
  // saying it has failed. Which one it was changes how much a dispatcher should
  // trust it, so it is captured rather than inferred.
  const SOURCES = new Set(["field_report", "ops_report", "driver_report", "remote_alarm", "inspection"]);
  const requestedSource = String(req.body?.source || "");
  const reportSource = SOURCES.has(requestedSource)
    ? requestedSource
    : req.user.role === ROLES.TECHNICIAN
      ? "field_report"
      : "ops_report";

  if (!Number.isInteger(chargerId)) return res.status(400).json({ error: "chargerId is required" });
  if (issue.length < 5) return res.status(400).json({ error: "describe the issue (at least 5 characters)" });
  if (!["critical", "major", "minor"].includes(severity)) {
    return res.status(400).json({ error: "severity must be critical, major or minor" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // FOR UPDATE, and it is the whole point of this line.
    //
    // Two reports of the same dead charger arriving together used to both pass
    // the "is one already open?" check below and both insert — a check made
    // outside a lock is a guess about the past. Taking the charger row first
    // serialises every report for that charger behind one writer, so the
    // second one sees what the first did.
    //
    // The charger row is the right thing to lock rather than the work orders:
    // the rows being guarded do not exist yet, so there is nothing else to
    // take a lock on, and every report for one charger converges on this row.
    const [[charger]] = await conn.query(
      "SELECT Charger_ID, Station_ID FROM charger WHERE Charger_ID = ? FOR UPDATE",
      [chargerId]
    );
    if (!charger) {
      await conn.rollback();
      return res.status(404).json({ error: "charger not found" });
    }

    // One open report per charger. A second technician reporting the same dead
    // screen should join the existing report, not create a duplicate that
    // splits the history and doubles the dispatch queue.
    const [[existing]] = await conn.query(
      `SELECT Maintenance_ID FROM maintenance_log
        WHERE Charger_ID = ? AND Status IN ('Reported','Assigned','In Progress')
        ORDER BY Maintenance_ID DESC LIMIT 1`,
      [chargerId]
    );
    if (existing) {
      await conn.rollback();
      return res.status(409).json({
        error: "this charger already has an open work order",
        code: "ALREADY_REPORTED",
        maintenanceId: existing.Maintenance_ID,
      });
    }

    const [ins] = await conn.query(
      `INSERT INTO maintenance_log
         (Charger_ID, Station_ID, Technician_ID, Issue_Reported, Resolved_Time, Status,
          Reported_At, Reported_By, Report_Source, Fault_Code, Severity, Priority)
       VALUES (?, ?, NULL, ?, NULL, 'Reported', NOW(), ?, ?, ?, ?, ?)`,
      [
        chargerId,
        charger.Station_ID,
        issue.slice(0, 1000),
        req.user.sub,
        reportSource,
        faultCode,
        severity,
        severity === "critical" ? "high" : "normal",
      ]
    );

    // ── Does this report take the stall offline? ────────────────────────
    //
    // Not every fault should. A noisy cooling fan or an intermittent card
    // reader is worth a visit and not worth losing a bay over, and pulling
    // every reported charger would take a working network down over
    // paperwork. So the default follows severity — critical means nobody
    // should be routed to it — and the reporter can override that either way.
    //
    // What matters is that the answer is now RETURNED. It used to be decided
    // silently: an operator logging a major fault saw the work order appear,
    // went to the charger list, found it still Available, and had no way to
    // tell whether that was the rule working or the write failing.
    let chargerTakenOutOfService = false;
    if (takeOutOfService ?? severity === "critical") {
      const [res] = await conn.query(
        `UPDATE charger SET Charger_Availability_Status = 'Out of Service'
          WHERE Charger_ID = ? AND Charger_Availability_Status <> 'In Use'`,
        [chargerId]
      );
      chargerTakenOutOfService = res.affectedRows === 1;
    }

    await writeAudit(
      {
        actor: req.user,
        action: "maintenance.reported",
        entityType: "maintenance_log",
        entityId: ins.insertId,
        details: { chargerId, severity, faultCode, source: req.user.role },
      },
      conn
    );
    await conn.commit();
    cache.invalidate("maintenance:");
    cache.invalidate("chargers:");
    cache.invalidate("dashboard:");

    res.status(201).json({
      maintenanceId: ins.insertId,
      status: "Reported",
      assigned: false,
      chargerTakenOutOfService,
      // A charger mid-session is never yanked out from under the driver. The
      // caller is told, because "I asked for it and it did not happen" needs
      // an explanation that is not "the button is broken".
      chargerBusy: Boolean(takeOutOfService ?? severity === "critical") && !chargerTakenOutOfService,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});

    // The unique index caught a duplicate the application check did not.
    //
    // With the charger row locked above this should be unreachable, and that is
    // exactly why it is handled rather than trusted: if a future code path ever
    // inserts without taking that lock, the database still refuses, and the
    // caller deserves the same honest 409 they would have got from the check
    // rather than a 500 that reads as "the server is broken".
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: "this charger already has an open work order",
        code: "ALREADY_REPORTED",
      });
    }

    // A deadlock is contention, not a fault. Two reports for different chargers
    // can still take their row locks in an order MySQL chooses to break. The
    // client's request was valid; telling them so and letting them retry beats
    // a 500.
    if (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT") {
      return res.status(409).json({
        error: "another report for this charger is being processed — try again",
        code: "CONTENDED",
      });
    }

    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/maintenance/:id/assign  { technicianId }
//
// The dispatch decision, and the reason this application exists. Managers only:
// a technician choosing their own jobs is not dispatch.
router.post("/:id/assign", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  const id = Number(req.params.id);
  const technicianId = Number(req.body?.technicianId);
  if (!Number.isInteger(id) || !Number.isInteger(technicianId)) {
    return res.status(400).json({ error: "maintenance id and technicianId are required" });
  }
  await transition(req, res, next, {
    id,
    allowedFrom: ["Reported", "Assigned"],
    to: "Assigned",
    action: "maintenance.assigned",
    apply: async (conn, workOrderId) => {
      const [[tech]] = await conn.query(
        "SELECT Technician_ID FROM technician WHERE Technician_ID = ?",
        [technicianId]
      );
      if (!tech) return { error: "technician not found", status: 404 };
      await conn.query(
        `UPDATE maintenance_log
            SET Technician_ID = ?, Status = 'Assigned', Assigned_At = NOW(), Assigned_By = ?
          WHERE Maintenance_ID = ?`,
        [technicianId, req.user.sub, workOrderId]
      );
      return { details: { technicianId } };
    },
  });
});

// POST /api/maintenance/:id/start — the technician is on site
router.post("/:id/start", allowRoles(ROLES.OPS_MANAGER, ROLES.TECHNICIAN), async (req, res, next) => {
  await transition(req, res, next, {
    id: Number(req.params.id),
    allowedFrom: ["Assigned"],
    to: "In Progress",
    action: "maintenance.started",
    assigneeOnly: true,
    apply: async (conn, workOrderId) => {
      await conn.query(
        "UPDATE maintenance_log SET Status='In Progress', Started_At = NOW() WHERE Maintenance_ID = ?",
        [workOrderId]
      );
      return {};
    },
  });
});

// POST /api/maintenance/:id/resolve  { notes }
//
// Resolving is what returns the charger to service — the one place in the
// application where a charger comes back from Out of Service. That is why it is
// restricted to the assignee: putting a stall back into rotation on the word of
// somebody who was never on site is how a driver ends up at a dead charger.
router.post("/:id/resolve", allowRoles(ROLES.OPS_MANAGER, ROLES.TECHNICIAN), async (req, res, next) => {
  const notes = String(req.body?.notes || "").trim().slice(0, 1000);
  // ── A technician must Start before they can Resolve ──────────────────────
  //
  // Assigned → Resolved in one step produces a repair with no duration: the
  // report and the resolution land in the same second, and mean time to repair
  // — the number the whole operation is measured on — quietly averages in a
  // zero. Worse, "In Progress" is the only signal anyone has that a technician
  // is actually on site; skipping it means the dispatch board never shows the
  // work happening, only that it appeared and vanished.
  //
  // The manager keeps the direct path on purpose. Not every closure is a site
  // visit: a fault cleared by a remote reboot, or one a technician phoned in
  // from a job they had already finished, is legitimately resolved by
  // operations without anybody pressing Start.
  const isTechnician = req.user.role === ROLES.TECHNICIAN;
  await transition(req, res, next, {
    id: Number(req.params.id),
    allowedFrom: isTechnician ? ["In Progress"] : ["Assigned", "In Progress"],
    deniedHint: {
      Assigned: "start this job before resolving it — tap Start when you arrive on site",
    },
    to: "Resolved",
    action: "maintenance.resolved",
    assigneeOnly: true,
    apply: async (conn, workOrderId, current) => {
      await conn.query(
        `UPDATE maintenance_log
            SET Status='Resolved', Resolved_Time = NOW(), Resolution_Notes = ?
          WHERE Maintenance_ID = ?`,
        [notes || null, workOrderId]
      );
      const restored = await restoreChargerIfClear(conn, current.charger_id, workOrderId, {
        touchMaintenanceDate: true,
      });
      return { details: { notes, chargerRestored: restored } };
    },
  });
});

// POST /api/maintenance/:id/reject  { reason }
//
// Not every report is a fault. A manager can dismiss one, and the charger goes
// back into service — which is why only a manager may do it.
router.post("/:id/reject", allowRoles(ROLES.OPS_MANAGER), async (req, res, next) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 1000);
  if (reason.length < 3) {
    return res.status(400).json({ error: "a reason is required to reject a report" });
  }
  await transition(req, res, next, {
    id: Number(req.params.id),
    allowedFrom: ["Reported", "Assigned"],
    to: "Rejected",
    action: "maintenance.rejected",
    apply: async (conn, workOrderId, current) => {
      await conn.query(
        `UPDATE maintenance_log
            SET Status='Rejected', Resolved_Time = NOW(), Resolution_Notes = ?
          WHERE Maintenance_ID = ?`,
        [reason, workOrderId]
      );
      const restored = await restoreChargerIfClear(conn, current.charger_id, workOrderId, {
        touchMaintenanceDate: false,
      });
      return { details: { reason, chargerRestored: restored } };
    },
  });
});

/**
 * Put a charger back into service — but only if nothing else is wrong with it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CONDITION MATTERS MORE THAN THE UPDATE
 * ─────────────────────────────────────────────────────────────────────────────
 * Closing a work order used to restore the charger unconditionally. With two
 * open reports on one unit — which the missing constraint allowed — resolving
 * either one returned the stall to service while the other was still open and
 * still critical. The database then said, at the same time, that charger 848
 * was Available and that charger 848 had an unresolved critical fault.
 *
 * A driver routed to that stall finds a broken charger. That is the actual
 * cost of an inconsistent state, and it is why the restore asks the question
 * rather than assuming the answer.
 *
 * The NOT EXISTS runs inside the same transaction that just closed this work
 * order, so it sees the closure and cannot be raced by a concurrent report:
 * that report is queued behind the charger row lock taken above.
 *
 * @returns {boolean} whether the charger came back into service
 */
async function restoreChargerIfClear(conn, chargerId, workOrderId, { touchMaintenanceDate }) {
  if (!chargerId) return false;

  const [res] = await conn.query(
    `UPDATE charger c
        SET c.Charger_Availability_Status = 'Available'
            ${touchMaintenanceDate ? ", c.Last_Maintenance_Date = CURDATE()" : ""}
      WHERE c.Charger_ID = ?
        AND c.Charger_Availability_Status = 'Out of Service'
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_log m
           WHERE m.Charger_ID = c.Charger_ID
             AND m.Maintenance_ID <> ?
             AND m.Status IN ('Reported','Assigned','In Progress')
        )`,
    [chargerId, workOrderId]
  );
  return res.affectedRows === 1;
}

/**
 * Shared guard for every state transition.
 *
 * Locks the row, checks the move is legal from where the work order actually
 * is, checks the caller is allowed to make it, applies the change and writes an
 * audit entry — all in one transaction. Centralising it means a transition
 * added later cannot forget the row lock or the audit trail.
 */
async function transition(req, res, next, { id, allowedFrom, to, action, apply, assigneeOnly, deniedHint }) {
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid maintenance id" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[current]] = await conn.query(
      `SELECT Status AS status, Technician_ID AS technician_id, Charger_ID AS charger_id
         FROM maintenance_log WHERE Maintenance_ID = ? FOR UPDATE`,
      [id]
    );
    if (!current) {
      await conn.rollback();
      return res.status(404).json({ error: "work order not found" });
    }

    if (!allowedFrom.includes(current.status)) {
      await conn.rollback();
      // A bare "cannot move from Assigned to Resolved" is technically true and
      // tells the technician nothing about what to do instead. `deniedHint`
      // lets the caller say it in the words of the job.
      return res.status(409).json({
        error:
          deniedHint?.[current.status] ??
          `cannot move a work order from ${current.status} to ${to}`,
        code: "ILLEGAL_TRANSITION",
        from: current.status,
      });
    }

    if (
      assigneeOnly &&
      req.user.role === ROLES.TECHNICIAN &&
      Number(current.technician_id) !== Number(req.user.tech)
    ) {
      await conn.rollback();
      return res.status(403).json({ error: "this work order is assigned to another technician" });
    }

    const result = await apply(conn, id, current);
    if (result?.error) {
      await conn.rollback();
      return res.status(result.status ?? 400).json({ error: result.error });
    }

    await writeAudit(
      {
        actor: req.user,
        action,
        entityType: "maintenance_log",
        entityId: id,
        details: { from: current.status, to, ...(result?.details ?? {}) },
      },
      conn
    );
    await conn.commit();
    cache.invalidate("maintenance:");
    cache.invalidate("chargers:");
    cache.invalidate("dashboard:");
    res.json({ id, status: to });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

// GET /api/maintenance/summary
router.get("/summary", async (req, res, next) => {
  try {
    // Scoped like every other list a host can reach. Left unscoped this
    // reported the fault mix for the whole network, which is a competitor's
    // reliability data with the names filed off.
    const conditions = [];
    const params = [];
    applyTenantScope(req, conditions, params, "s.Company_ID");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await pool.query(`
      SELECT ml.Issue_Reported AS issue_type, ml.Status AS status, COUNT(*) AS count
      FROM maintenance_log ml
      JOIN station s ON s.Station_ID = ml.Station_ID
      ${where}
      GROUP BY ml.Issue_Reported, ml.Status
      ORDER BY ml.Issue_Reported, ml.Status
    `, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/maintenance/technicians - assignment options for operations managers
// Restricted to the roles that dispatch. The list carries every engineer's
// name, home city and current workload across the whole network — a staffing
// picture that belongs to the operator, and that a site host was able to read
// in full.
router.get("/technicians", allowRoles(ROLES.OPS_MANAGER, ROLES.VIEWER), async (req, res, next) => {
  try {
    // When a work order is named, rank by how far each technician is from THAT
    // charger. Haversine in SQL rather than in JavaScript so the ordering and
    // the limit happen in the database instead of pulling every technician back
    // to sort them here.
    const workOrderId = Number(req.query.workOrderId);
    let site = null;
    if (Number.isInteger(workOrderId)) {
      const [[row]] = await pool.query(
        `SELECT s.Station_Lat AS lat, s.Station_Lng AS lng, s.Station_State AS state
           FROM maintenance_log m
           JOIN station s ON s.Station_ID = m.Station_ID
          WHERE m.Maintenance_ID = ?`,
        [workOrderId]
      );
      if (row?.lat != null) site = row;
    }

    if (site) {
      const [ranked] = await pool.query(
        `SELECT t.Technician_ID AS id,
                CONCAT(t.Technician_FirstName, ' ', t.Technician_LastName) AS name,
                t.Technician_City  AS city,
                t.Technician_State AS state,
                COUNT(CASE WHEN m.Status IN ('Assigned','In Progress') THEN 1 END) AS open_work_orders,
                ROUND(
                  6371 * ACOS(
                    LEAST(1.0,
                      COS(RADIANS(?)) * COS(RADIANS(t.Technician_Lat)) *
                      COS(RADIANS(t.Technician_Lng) - RADIANS(?)) +
                      SIN(RADIANS(?)) * SIN(RADIANS(t.Technician_Lat))
                    )
                  )
                ) AS distance_km,
                (t.Technician_State = ?) AS same_state
           FROM technician t
           LEFT JOIN maintenance_log m ON m.Technician_ID = t.Technician_ID
          WHERE t.Technician_Lat IS NOT NULL
          GROUP BY t.Technician_ID
          -- Nearest first, and among equally near ones the least busy. Distance
          -- leads because a technician four states away is the wrong answer no
          -- matter how free their day is.
          ORDER BY distance_km ASC, open_work_orders ASC
          LIMIT 60`,
        [site.lat, site.lng, site.lat, site.state]
      );
      return res.json(
        ranked.map((r) => ({
          ...r,
          open_work_orders: Number(r.open_work_orders),
          distance_km: r.distance_km == null ? null : Number(r.distance_km),
          same_state: Boolean(Number(r.same_state)),
        }))
      );
    }

    const [rows] = await pool.query(
      // City, workload AND distance to the specific work order.
      //
      // Distance is the fact that was missing. Ranking by workload alone let a
      // manager send a technician in Texas to a charger in New York without the
      // interface objecting — the two columns it showed made that look like a
      // perfectly good choice, because the Texas technician had nothing on.
      //
      // With ?workOrderId= the list is ranked by how far each technician is
      // from that charger, so the obvious pick is the right one and a long
      // dispatch has to be chosen deliberately.
      `SELECT t.Technician_ID AS id,
              CONCAT(t.Technician_FirstName, ' ', t.Technician_LastName) AS name,
              t.Technician_City  AS city,
              t.Technician_State AS state,
              COUNT(CASE WHEN m.Status IN ('Assigned','In Progress') THEN 1 END) AS open_work_orders
         FROM technician t
         LEFT JOIN maintenance_log m ON m.Technician_ID = t.Technician_ID
        GROUP BY t.Technician_ID
        ORDER BY t.Technician_FirstName, t.Technician_LastName`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/maintenance/:id  { status?, technicianId?, note? }
router.patch(
  "/:id",
  allowRoles(ROLES.OPS_MANAGER, ROLES.TECHNICIAN),
  async (req, res, next) => {
    const id = Number(req.params.id);
    const status = req.body?.status == null ? null : String(req.body.status);
    const technicianId = req.body?.technicianId == null ? null : Number(req.body.technicianId);
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const allowedStatuses = new Set(["Open", "In Progress", "Resolved"]);

    if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid maintenance id" });
    if (status && !allowedStatuses.has(status)) return res.status(400).json({ error: "invalid status" });
    if (technicianId != null && !Number.isInteger(technicianId)) {
      return res.status(400).json({ error: "invalid technicianId" });
    }
    if (req.user.role === ROLES.TECHNICIAN && technicianId != null) {
      return res.status(403).json({ error: "technicians cannot reassign work orders" });
    }
    if (!status && technicianId == null && !note) {
      return res.status(400).json({ error: "status, technicianId, or note is required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[current]] = await conn.query(
        `SELECT Status AS status, Technician_ID AS technician_id, Charger_ID AS charger_id
           FROM maintenance_log WHERE Maintenance_ID = ? FOR UPDATE`,
        [id]
      );
      if (!current) {
        await conn.rollback();
        return res.status(404).json({ error: "maintenance record not found" });
      }
      if (current.status === "Resolved" && status && status !== "Resolved" && req.user.role !== ROLES.OPS_MANAGER) {
        await conn.rollback();
        return res.status(403).json({ error: "only an operations manager can reopen resolved work" });
      }

      // A technician may only act on work assigned to them. Without this a
      // technician could resolve any work order in the network — including one
      // they never visited — which would put a charger back into service on the
      // word of somebody who was never on site.
      if (
        req.user.role === ROLES.TECHNICIAN &&
        Number(current.technician_id) !== Number(req.user.tech)
      ) {
        await conn.rollback();
        return res
          .status(403)
          .json({ error: "this work order is assigned to another technician", code: "NOT_ASSIGNEE" });
      }

      await conn.query(
        `UPDATE maintenance_log
            SET Status = COALESCE(?, Status),
                Technician_ID = COALESCE(?, Technician_ID),
                Resolved_Time = CASE
                  WHEN ? = 'Resolved' THEN COALESCE(Resolved_Time, NOW())
                  WHEN ? IS NOT NULL AND ? <> 'Resolved' THEN NULL
                  ELSE Resolved_Time
                END
          WHERE Maintenance_ID = ?`,
        [status, technicianId, status, status, status, id]
      );

      if (status === "Resolved" && current.charger_id) {
        await conn.query(
          `UPDATE charger
              SET Charger_Availability_Status = 'Available', Last_Maintenance_Date = CURDATE()
            WHERE Charger_ID = ? AND Charger_Availability_Status = 'Out of Service'`,
          [current.charger_id]
        );
      }

      await writeAudit(
        {
          actor: req.user,
          action: "maintenance.updated",
          entityType: "maintenance_log",
          entityId: id,
          details: {
            fromStatus: current.status,
            toStatus: status || current.status,
            fromTechnicianId: current.technician_id,
            toTechnicianId: technicianId || current.technician_id,
            note,
          },
        },
        conn
      );
      await conn.commit();
      cache.invalidate("maintenance:");
      cache.invalidate("chargers:");
      cache.invalidate("dashboard:");
      res.json({ id, status: status || current.status, technicianId: technicianId || current.technician_id });
    } catch (err) {
      await conn.rollback().catch(() => {});
      next(err);
    } finally {
      conn.release();
    }
  }
);

export default router;
