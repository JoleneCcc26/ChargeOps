// server/routes/dashboard.js
import { Router } from "express";
import { pool } from "../db.js";
import { cached } from "../adapters/cache.js";
import { applyTenantScope, tenantCompanyId } from "../lib/scope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Everything in this file except /site-performance reports the WHOLE network
// ─────────────────────────────────────────────────────────────────────────────
// Fleet-wide availability, network revenue, the busiest cities, who charged
// most recently — all of it is the operator's picture of their own business.
//
// A site host is not an operator. They are a landlord within the network, and
// the router-level guard in app.js let them through to all of it because the
// guard asks "may this ROLE reach this router?" and the answer for the one
// route they do need is yes. /api/dashboard/recent-sessions was handing a host
// the names of drivers at a competitor's sites.
//
// So the restriction lives here, per route, rather than at the mount. Adding a
// new dashboard endpoint without this line makes it visible to hosts, which is
// why the guard is named for what it protects rather than for a role list.
function networkWideOnly(req, res, next) {
  if (tenantCompanyId(req) !== null) {
    return res.status(403).json({
      error: "this view reports the whole network; your account is scoped to one company",
    });
  }
  next();
}

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Cache TTLs, chosen per endpoint rather than globally
// ─────────────────────────────────────────────────────────────────────────────
// The question a TTL answers is "how stale may this number be?", and the answer
// is different for each tile. Charger availability drives a driver's decision
// about where to drive, so it gets 10 seconds. The count of registered users
// changes a handful of times a day, so 60 seconds costs nothing and removes a
// COUNT(*) from every page load.
//
// Every write path that invalidates these calls cache.invalidate("dashboard:"),
// so a completed payment shows up immediately rather than at the end of the TTL.
const TTL = {
  kpis:         30,
  revenueByCity: 60,
  availability:  10,
  recentSessions: 5,
};

// GET /api/dashboard/kpis
router.get("/kpis", networkWideOnly, async (_req, res, next) => {
  try {
    const payload = await cached("dashboard:kpis", TTL.kpis, async () => {
      const [[stationRow]] = await pool.query("SELECT COUNT(*) AS total FROM station");
      const [[chargerRow]] = await pool.query("SELECT COUNT(*) AS total FROM charger");
      const [[userRow]]    = await pool.query("SELECT COUNT(*) AS total FROM user");
      const [[planRow]]    = await pool.query("SELECT COUNT(*) AS total FROM membership");

      return {
        totalStations: stationRow.total,
        totalChargers: chargerRow.total,
        totalUsers:    userRow.total,
        totalPlans:    planRow.total,
      };
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/revenue-by-city
// Uses a case-insensitive status match so rows stored as "completed",
// "COMPLETED", "Complete", etc. still count.
router.get("/revenue-by-city", networkWideOnly, async (_req, res, next) => {
  try {
    // The most expensive query on the dashboard: a three-table join and an
    // aggregate over the whole payment table. Exactly the shape that justifies
    // a cache, and the one to point at when explaining why.
    const rows = await cached("dashboard:revenue-by-city", TTL.revenueByCity, async () => {
      const [result] = await pool.query(`
        SELECT st.Station_City AS city,
               ROUND(SUM(p.Payment_Amount), 2) AS revenue
        FROM payment p
        JOIN charging_session cs ON cs.Session_ID = p.Session_ID
        JOIN charger c  ON c.Charger_ID  = cs.Charger_ID
        JOIN station st ON st.Station_ID = c.Station_ID
        WHERE LOWER(TRIM(p.Payment_Status)) IN ('completed', 'complete', 'success', 'successful')
        GROUP BY st.Station_City
        HAVING revenue IS NOT NULL AND revenue > 0
        ORDER BY revenue DESC
        LIMIT 8
      `);
      return result;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/charger-availability
router.get("/charger-availability", networkWideOnly, async (_req, res, next) => {
  try {
    // Short TTL: the telemetry worker rewrites charger status continuously, and
    // it calls cache.invalidate("chargers:") / ("dashboard:") when it does - so
    // in practice this is fresh, and the TTL is only a backstop.
    const rows = await cached("dashboard:charger-availability", TTL.availability, async () => {
      const [result] = await pool.query(`
        SELECT Charger_Availability_Status AS status, COUNT(*) AS count
        FROM charger
        GROUP BY Charger_Availability_Status
      `);
      return result;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/recent-sessions?limit=10
router.get("/recent-sessions", networkWideOnly, async (req, res, next) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const [rows] = await pool.query(
      `SELECT cs.Session_ID AS id,
              CONCAT(u.User_FName, ' ', u.User_LName) AS user_name,
              st.Station_Name AS station_name,
              cs.Start_Time  AS started_at,
              cs.End_Time    AS ended_at,
              cs.Energy_Consumed AS kwh,
              cs.Total_Cost      AS cost_usd,
              cs.Session_Status  AS status
       FROM charging_session cs
       JOIN user u     ON u.User_ID      = cs.User_ID
       JOIN charger c  ON c.Charger_ID   = cs.Charger_ID
       JOIN station st ON st.Station_ID  = c.Station_ID
       ORDER BY cs.Start_Time DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/operations — what the network looks like right now
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THESE NUMBERS AND NOT THE OLD ONES
// ═════════════════════════════════════════════════════════════════════════════
// The dashboard used to lead with total stations, total chargers, registered
// users and membership plans. All four are true, and all four are the same
// number today as last month — they describe the size of the company, not the
// state of the network. Nobody has ever changed a decision because the charger
// count was 859.
//
// An operations manager is measured on one thing: can a driver who pulls in
// actually charge? So the panel answers, in order:
//
//   how much of the network is usable right now      (availability)
//   what is waiting on me                            (dispatch queue)
//   how fast are we fixing things                    (MTTR)
//   is money coming in as usual                      (revenue vs yesterday)
//
// Each is either an instruction or an alarm. That is the test for a KPI.
router.get("/operations", networkWideOnly, async (req, res, next) => {
  try {
    const payload = await cached("dashboard:operations", 15, async () => {
    const [[fleet]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(Charger_Availability_Status = 'Available')      AS available,
              SUM(Charger_Availability_Status = 'In Use')         AS in_use,
              SUM(Charger_Availability_Status = 'Reserved')       AS reserved,
              SUM(Charger_Availability_Status = 'Out of Service') AS out_of_service
         FROM charger`
    );

    // Availability counts a charger as usable if it is serving or could serve.
    // A stall that is busy is working; only a broken one is lost capacity.
    const total = Number(fleet.total) || 1;
    const usable = Number(fleet.available) + Number(fleet.in_use) + Number(fleet.reserved);

    const [[queue]] = await pool.query(
      `SELECT
         SUM(Status = 'Reported')    AS awaiting_dispatch,
         SUM(Status = 'Assigned')    AS assigned,
         SUM(Status = 'In Progress') AS in_progress,
         SUM(Status = 'Reported' AND Severity = 'critical') AS critical_waiting,
         MAX(CASE WHEN Status = 'Reported'
                  THEN TIMESTAMPDIFF(MINUTE, Reported_At, NOW()) END) AS longest_wait_minutes
       FROM maintenance_log
       WHERE Status IN ('Reported','Assigned','In Progress')`
    );

    // Mean time to repair, over the last 30 days. The median would be steadier,
    // but MySQL has no percentile function and the average is the figure an
    // operations team is normally held to anyway.
    const [[mttr]] = await pool.query(
      `SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, Reported_At, Resolved_Time))) AS minutes,
              COUNT(*) AS resolved_count
         FROM maintenance_log
        WHERE Status = 'Resolved'
          AND Reported_At IS NOT NULL
          AND Resolved_Time > NOW() - INTERVAL 30 DAY
          AND Resolved_Time >= Reported_At`
    );

    // Today against the same elapsed slice of yesterday, so a comparison made
    // at 09:00 is not comparing nine hours against a full day.
    const [[revenue]] = await pool.query(
      `SELECT
         SUM(CASE WHEN DATE(cs.End_Time) = CURDATE() THEN cs.Total_Cost ELSE 0 END) AS today,
         SUM(CASE WHEN DATE(cs.End_Time) = CURDATE() - INTERVAL 1 DAY
                   AND TIME(cs.End_Time) <= CURTIME() THEN cs.Total_Cost ELSE 0 END) AS yesterday_so_far,
         SUM(CASE WHEN DATE(cs.End_Time) = CURDATE() THEN 1 ELSE 0 END) AS sessions_today
       FROM charging_session cs
      WHERE cs.End_Time > CURDATE() - INTERVAL 1 DAY
        AND cs.Session_Status = 'Completed'`
    );

    return {
      availability: {
        percent: Number(((usable / total) * 100).toFixed(1)),
        usable,
        total,
        breakdown: {
          available: Number(fleet.available),
          inUse: Number(fleet.in_use),
          reserved: Number(fleet.reserved),
          outOfService: Number(fleet.out_of_service),
        },
      },
      dispatch: {
        awaitingDispatch: Number(queue.awaiting_dispatch) || 0,
        assigned: Number(queue.assigned) || 0,
        inProgress: Number(queue.in_progress) || 0,
        criticalWaiting: Number(queue.critical_waiting) || 0,
        longestWaitMinutes: Number(queue.longest_wait_minutes) || 0,
      },
      mttrMinutes: Number(mttr.minutes) || 0,
      resolvedLast30Days: Number(mttr.resolved_count) || 0,
      revenue: {
        today: Number(revenue.today) || 0,
        yesterdaySoFar: Number(revenue.yesterday_so_far) || 0,
        sessionsToday: Number(revenue.sessions_today) || 0,
      },
    };

    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/availability-trend?days=14
//
// One number is a status; a line is a trend. A manager needs to know whether
// today's 93% is a recovery or the start of a slide, and no single reading can
// say which.
//
// Derived from work-order history rather than a stored time series: a charger
// was down for the span between a report and its resolution, so the outage
// hours per day fall out of the table the maintenance workflow already writes.
router.get("/availability-trend", networkWideOnly, async (req, res, next) => {
  const days = Math.max(2, Math.min(Number(req.query.days) || 14, 90));
  try {
    const payload = await cached(`dashboard:availability-trend:${days}`, 120, async () => {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM charger`);
    const fleet = Number(total) || 1;

    const [rows] = await pool.query(
      `WITH RECURSIVE calendar AS (
         SELECT CURDATE() - INTERVAL ? DAY AS d
         UNION ALL
         SELECT d + INTERVAL 1 DAY FROM calendar WHERE d < CURDATE()
       )
       SELECT c.d AS date,
              COUNT(DISTINCT m.Charger_ID) AS chargers_down
         FROM calendar c
         LEFT JOIN maintenance_log m
           ON DATE(m.Reported_At) <= c.d
          AND (m.Resolved_Time IS NULL OR DATE(m.Resolved_Time) >= c.d)
          AND m.Status <> 'Rejected'
        GROUP BY c.d
        ORDER BY c.d`,
      [days]
    );

    return rows.map((r) => ({
      date: r.date,
      chargersDown: Number(r.chargers_down),
      availabilityPercent: Number((((fleet - Number(r.chargers_down)) / fleet) * 100).toFixed(1)),
    }));

    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/problem-stations?limit=5
//
// Where the money should go next. A site that breaks repeatedly is a capital
// decision — replace the hardware, renegotiate with the installer — and it is
// invisible in a network-wide average.
router.get("/problem-stations", networkWideOnly, async (req, res, next) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 5, 20));
  try {
    const [rows] = await pool.query(
      `SELECT s.Station_ID   AS id,
              s.Station_Name AS name,
              s.Station_City AS city,
              s.Station_State AS state,
              COUNT(m.Maintenance_ID) AS faults_90d,
              SUM(m.Status IN ('Reported','Assigned','In Progress')) AS open_now,
              (SELECT COUNT(*) FROM charger c WHERE c.Station_ID = s.Station_ID) AS chargers
         FROM station s
         JOIN maintenance_log m ON m.Station_ID = s.Station_ID
        WHERE m.Reported_At > NOW() - INTERVAL 90 DAY
          AND m.Status <> 'Rejected'
        GROUP BY s.Station_ID
        ORDER BY faults_90d DESC
        LIMIT ?`,
      [limit]
    );
    res.json(
      rows.map((r) => ({
        ...r,
        faults_90d: Number(r.faults_90d),
        open_now: Number(r.open_now),
        chargers: Number(r.chargers),
        // Faults per charger, so a fourteen-stall site is not flagged simply
        // for being large.
        faults_per_charger: Number((Number(r.faults_90d) / Math.max(1, Number(r.chargers))).toFixed(2)),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/fault-codes?limit=10
//
// What is actually breaking. Codes, not prose: a cluster of one code across
// many sites is a warranty claim or a firmware bug, and prose cannot be
// grouped.
router.get("/fault-codes", networkWideOnly, async (req, res, next) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 30));
  try {
    const [rows] = await pool.query(
      `SELECT COALESCE(Fault_Code, 'unspecified') AS code,
              COUNT(*) AS count,
              SUM(Severity = 'critical') AS critical,
              COUNT(DISTINCT Station_ID) AS stations_affected
         FROM maintenance_log
        WHERE Reported_At > NOW() - INTERVAL 90 DAY
          AND Status <> 'Rejected'
        GROUP BY code
        ORDER BY count DESC
        LIMIT ?`,
      [limit]
    );
    res.json(
      rows.map((r) => ({
        code: r.code,
        count: Number(r.count),
        critical: Number(r.critical),
        stations_affected: Number(r.stations_affected),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/station-map
//
// Coordinates plus health for every site. A charging network is a geographic
// business and a list cannot show that three of the four failures are in one
// city — which is the difference between four unlucky chargers and one bad
// installer.
router.get("/station-map", networkWideOnly, async (req, res, next) => {
  try {
    const payload = await cached("dashboard:station-map", 30, async () => {
    const [rows] = await pool.query(
      `SELECT s.Station_ID    AS id,
              s.Station_Name  AS name,
              s.Station_City  AS city,
              s.Station_State AS state,
              s.Station_Lat   AS lat,
              s.Station_Lng   AS lng,
              COUNT(c.Charger_ID) AS chargers,
              SUM(c.Charger_Availability_Status = 'Out of Service') AS down,
              SUM(c.Charger_Availability_Status = 'In Use')         AS in_use
         FROM station s
         LEFT JOIN charger c ON c.Station_ID = s.Station_ID
        WHERE s.Station_Lat IS NOT NULL
        GROUP BY s.Station_ID`
    );

    return rows.map((r) => {
      const chargers = Number(r.chargers) || 0;
      const down = Number(r.down) || 0;
      return {
        id: r.id,
        name: r.name,
        city: r.city,
        state: r.state,
        lat: Number(r.lat),
        lng: Number(r.lng),
        chargers,
        down,
        inUse: Number(r.in_use) || 0,
        availabilityPercent: chargers
          ? Number((((chargers - down) / chargers) * 100).toFixed(0))
          : 100,
      };
    });

    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/site-performance
//
// One row per site: how busy the bays were, how much they earned, how often
// they were broken. Written for the site host, who is not an operator of the
// network but a landlord within it — the shopping centre whose car park the
// chargers sit in.
//
// Two things make this different from every other list endpoint:
//
//   1. It is scoped by company. A host asking this question gets their own
//      sites and nobody else's, filtered in SQL by the company id signed into
//      their token. Managers pass no scope and see the whole estate, which is
//      why the same endpoint serves both.
//
//   2. It carries no driver identity at all — not filtered out downstream,
//      never selected. A host may know bay 12 delivered 40 kWh on Tuesday;
//      who was driving is the operator's customer, not theirs.
//
// The revenue share is the host's cut, not the gross. Reporting gross to a
// landlord invites an argument at the end of every month.
router.get("/site-performance", async (req, res, next) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
  // What fraction of session revenue the host is paid. A real platform holds
  // this per contract on the company row; one rate keeps the demo honest about
  // the fact that gross and host revenue are different numbers.
  const HOST_SHARE = 0.15;

  try {
    const conditions = [];
    const params = [];
    applyTenantScope(req, conditions, params, "s.Company_ID");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `SELECT s.Station_ID    AS id,
              s.Station_Name  AS name,
              s.Station_City  AS city,
              s.Station_State AS state,
              s.Station_Street AS address,
              COUNT(DISTINCT c.Charger_ID) AS chargers,
              COUNT(DISTINCT CASE WHEN c.Charger_Availability_Status = 'Out of Service'
                                  THEN c.Charger_ID END) AS chargers_down,
              COUNT(DISTINCT CASE WHEN c.Charger_Availability_Status = 'In Use'
                                  THEN c.Charger_ID END) AS chargers_in_use,
              COUNT(DISTINCT cs.Session_ID) AS sessions,
              COALESCE(SUM(cs.Energy_Consumed), 0) AS energy_kwh,
              COALESCE(SUM(cs.Total_Cost), 0)      AS gross_revenue,
              COALESCE(SUM(TIMESTAMPDIFF(MINUTE, cs.Start_Time, cs.End_Time)), 0) AS busy_minutes
         FROM station s
         LEFT JOIN charger c ON c.Station_ID = s.Station_ID
         LEFT JOIN charging_session cs
                ON cs.Charger_ID = c.Charger_ID
               AND cs.Session_Status = 'Completed'
               AND cs.End_Time > NOW() - INTERVAL ? DAY
         ${where}
        GROUP BY s.Station_ID
        ORDER BY gross_revenue DESC`,
      [days, ...params]
    );

    const sites = rows.map((r) => {
      const chargers = Number(r.chargers) || 0;
      const gross = Number(r.gross_revenue) || 0;
      // Utilisation is busy minutes over the minutes the bays could have been
      // busy. A bay out of service still counts in the denominator on purpose:
      // a broken stall is lost revenue, and hiding it would flatter the site.
      const capacityMinutes = chargers * days * 24 * 60;
      return {
        id: r.id,
        name: r.name,
        city: r.city,
        state: r.state,
        address: r.address,
        chargers,
        chargersDown: Number(r.chargers_down) || 0,
        chargersInUse: Number(r.chargers_in_use) || 0,
        sessions: Number(r.sessions) || 0,
        energyKwh: Number(Number(r.energy_kwh).toFixed(1)),
        grossRevenue: Number(gross.toFixed(2)),
        hostRevenue: Number((gross * HOST_SHARE).toFixed(2)),
        utilisationPercent: capacityMinutes
          ? Number(((Number(r.busy_minutes) / capacityMinutes) * 100).toFixed(1))
          : 0,
      };
    });

    const totals = sites.reduce(
      (acc, s) => ({
        sites: acc.sites + 1,
        chargers: acc.chargers + s.chargers,
        chargersDown: acc.chargersDown + s.chargersDown,
        sessions: acc.sessions + s.sessions,
        energyKwh: acc.energyKwh + s.energyKwh,
        grossRevenue: acc.grossRevenue + s.grossRevenue,
        hostRevenue: acc.hostRevenue + s.hostRevenue,
      }),
      { sites: 0, chargers: 0, chargersDown: 0, sessions: 0, energyKwh: 0, grossRevenue: 0, hostRevenue: 0 }
    );

    res.json({
      days,
      hostSharePercent: HOST_SHARE * 100,
      scopedToCompany: tenantCompanyId(req),
      totals: {
        ...totals,
        energyKwh: Number(totals.energyKwh.toFixed(1)),
        grossRevenue: Number(totals.grossRevenue.toFixed(2)),
        hostRevenue: Number(totals.hostRevenue.toFixed(2)),
      },
      sites,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/host-earnings?days=30 — the landlord's statement
// ─────────────────────────────────────────────────────────────────────────────
//
// A site host is a landlord, and what a landlord wants at the end of a month is
// not a dashboard. It is a statement: what were my bays used for, what did that
// earn, what is my share, and can I see the lines it adds up from.
//
// Three things come back — a daily series to chart, a per-site breakdown, and
// the individual sessions — because "trust me, it is $423" is not a statement
// anybody signs off.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY ABSENT
// ─────────────────────────────────────────────────────────────────────────────
// No driver name, no email, no user id, at any level of detail. Not filtered
// out downstream — never selected. The host owns the car park; the drivers are
// ChargeOps' customers, and in most jurisdictions handing their identities to a
// landlord is a privacy breach rather than merely bad manners.
//
// The line items are still specific enough to audit: which bay, when, how much
// energy, what it earned. That is everything a landlord needs and nothing that
// belongs to somebody else.
router.get("/host-earnings", async (req, res, next) => {
  const days = Math.max(2, Math.min(Number(req.query.days) || 30, 365));
  const HOST_SHARE = 0.15;

  try {
    const conditions = [];
    const params = [];
    applyTenantScope(req, conditions, params, "s.Company_ID");
    const where = conditions.length ? `AND ${conditions.join(" AND ")}` : "";

    // ── Daily series ──────────────────────────────────────────────────────
    const [daily] = await pool.query(
      `WITH RECURSIVE calendar AS (
         SELECT CURDATE() - INTERVAL ? DAY AS d
         UNION ALL
         SELECT d + INTERVAL 1 DAY FROM calendar WHERE d < CURDATE()
       )
       SELECT calendar.d AS date,
              COUNT(cs.Session_ID) AS sessions,
              COALESCE(SUM(cs.Energy_Consumed), 0) AS kwh,
              COALESCE(SUM(cs.Total_Cost), 0) AS gross
         FROM calendar
         LEFT JOIN charging_session cs
                ON DATE(cs.End_Time) = calendar.d
               AND cs.Session_Status = 'Completed'
         LEFT JOIN charger c ON c.Charger_ID = cs.Charger_ID
         LEFT JOIN station s ON s.Station_ID = c.Station_ID
        WHERE (cs.Session_ID IS NULL OR 1 = 1) ${where}
        GROUP BY calendar.d
        ORDER BY calendar.d`,
      [days, ...params]
    );

    // ── Line items ────────────────────────────────────────────────────────
    // Capped rather than paginated: a statement view is for spot-checking and
    // for export, and nobody scrolls 30,000 rows in a browser.
    const [lines] = await pool.query(
      `SELECT cs.Session_ID  AS id,
              s.Station_Name AS station,
              cs.Charger_ID  AS charger_id,
              c.Charger_Type AS charger_type,
              cs.Start_Time  AS started_at,
              cs.End_Time    AS ended_at,
              TIMESTAMPDIFF(MINUTE, cs.Start_Time, cs.End_Time) AS minutes,
              cs.Energy_Consumed AS kwh,
              cs.Session_Rate_Per_kWh AS rate,
              cs.Total_Cost  AS gross
         FROM charging_session cs
         JOIN charger c ON c.Charger_ID = cs.Charger_ID
         JOIN station s ON s.Station_ID = c.Station_ID
        WHERE cs.Session_Status = 'Completed'
          AND cs.End_Time > NOW() - INTERVAL ? DAY
          ${where}
        ORDER BY cs.End_Time DESC
        LIMIT 200`,
      [days, ...params]
    );

    // ── Busiest hours, so a host can see when their bays earn ─────────────
    const [byHour] = await pool.query(
      `SELECT HOUR(cs.Start_Time) AS hour,
              COUNT(*) AS sessions,
              COALESCE(SUM(cs.Total_Cost), 0) AS gross
         FROM charging_session cs
         JOIN charger c ON c.Charger_ID = cs.Charger_ID
         JOIN station s ON s.Station_ID = c.Station_ID
        WHERE cs.Session_Status = 'Completed'
          AND cs.End_Time > NOW() - INTERVAL ? DAY
          ${where}
        GROUP BY HOUR(cs.Start_Time)
        ORDER BY hour`,
      [days, ...params]
    );

    const share = (gross) => Number((Number(gross) * HOST_SHARE).toFixed(2));

    res.json({
      days,
      hostSharePercent: HOST_SHARE * 100,
      daily: daily.map((r) => ({
        date: r.date,
        sessions: Number(r.sessions) || 0,
        kwh: Number(Number(r.kwh).toFixed(1)),
        gross: Number(Number(r.gross).toFixed(2)),
        yours: share(r.gross),
      })),
      byHour: Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.find((r) => Number(r.hour) === hour);
        return {
          hour,
          sessions: row ? Number(row.sessions) : 0,
          yours: row ? share(row.gross) : 0,
        };
      }),
      lines: lines.map((r) => ({
        id: r.id,
        station: r.station,
        chargerId: r.charger_id,
        chargerType: r.charger_type,
        endedAt: r.ended_at,
        minutes: Number(r.minutes) || 0,
        kwh: Number(r.kwh) || 0,
        rate: Number(r.rate) || 0,
        gross: Number(r.gross) || 0,
        yours: share(r.gross),
      })),
      lineLimit: 200,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
