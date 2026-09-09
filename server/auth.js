import crypto from "node:crypto";
import { Router } from "express";
import { pool } from "./db.js";

export const ROLES = Object.freeze({
  /** Owns network availability: triage, dispatch, SLA. */
  OPS_MANAGER: "ops_manager",
  /** Works their own assigned jobs and nothing else. */
  TECHNICIAN: "technician",
  /** Revenue, reconciliation, refunds, collections. No operational control. */
  FINANCE: "finance",
  /**
   * The business whose car park the chargers sit in — a mall, a hotel, an
   * office. They see utilisation and their share of revenue for THEIR sites
   * only, and never another host's data or a driver's identity.
   *
   * This is the one role that makes the application multi-tenant, and it is
   * scoped by Company_ID rather than by a permission flag: the boundary is a
   * row filter in SQL, not a hidden menu.
   */
  SITE_HOST: "site_host",
  /** Read-only across the network — management, investors. */
  VIEWER: "viewer",
});

const TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.AUTH_TOKEN_TTL_SECONDS) || 8 * 60 * 60);
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "chargeops-local-token-secret-change-me";

function configuredUsers() {
  if (process.env.AUTH_USERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.AUTH_USERS_JSON);
      const allowedRoles = new Set(Object.values(ROLES));
      const valid = Array.isArray(parsed)
        ? parsed.filter(
            (user) =>
              user &&
              typeof user.username === "string" &&
              user.username.trim() &&
              typeof user.password === "string" &&
              user.password &&
              allowedRoles.has(user.role) &&
              (user.role !== ROLES.TECHNICIAN || Number.isInteger(user.technicianId))
          )
        : [];
      if (valid.length > 0) return valid;
      console.warn("[auth] AUTH_USERS_JSON contains no valid users; using demo accounts");
    } catch (err) {
      console.warn(`[auth] AUTH_USERS_JSON is invalid: ${err.message}`);
    }
  }

  return [
    {
      username: process.env.AUTH_OPS_USERNAME || "ops",
      password: process.env.AUTH_OPS_PASSWORD || "chargeops-demo",
      role: ROLES.OPS_MANAGER,
      displayName: "Operations Manager",
    },
    {
      username: process.env.AUTH_TECH_USERNAME || "tech",
      password: process.env.AUTH_TECH_PASSWORD || "chargeops-demo",
      role: ROLES.TECHNICIAN,
      displayName: "Field Technician",
      // Links the login account to a row in the `technician` table.
      //
      // Without this the application cannot answer "which technician is this?",
      // so it cannot show a technician their own work queue — every technician
      // would see every work order in the network. This is the identity join
      // between the auth layer and the business data.
      technicianId: Number(process.env.AUTH_TECH_TECHNICIAN_ID) || 1,
    },
    {
      username: process.env.AUTH_FINANCE_USERNAME || "finance",
      password: process.env.AUTH_FINANCE_PASSWORD || "chargeops-demo",
      role: ROLES.FINANCE,
      displayName: "Finance & Billing",
    },
    {
      username: process.env.AUTH_HOST_USERNAME || "host",
      password: process.env.AUTH_HOST_PASSWORD || "chargeops-demo",
      role: ROLES.SITE_HOST,
      // A placeholder until the first request resolves the real company name;
      // signing in as host<id> names the company directly.
      displayName: "Site Host",
      // Which company's sites this host owns. Everything they can see is
      // filtered by it.
      companyId: Number(process.env.AUTH_HOST_COMPANY_ID) || 6,
    },
    {
      username: process.env.AUTH_VIEWER_USERNAME || "viewer",
      password: process.env.AUTH_VIEWER_PASSWORD || "chargeops-demo",
      role: ROLES.VIEWER,
      displayName: "Read-only Viewer",
    },
  ];
}

const users = configuredUsers();

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signature(input) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(input).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    displayName: user.displayName || user.username,
    technicianId: user.technicianId ?? null,
    companyId: user.companyId ?? null,
  };
}

export function issueToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: user.username,
    role: user.role,
    name: user.displayName || user.username,
    // Signed into the token so every request knows which technician row this
    // login represents, without a database lookup on the hot path.
    tech: user.technicianId ?? null,
    // Site hosts are scoped to one company; every query they make is filtered
    // by it server-side.
    co: user.companyId ?? null,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${signature(unsigned)}`;
}

export function verifyToken(token) {
  const [header, payload, sig, extra] = String(token ?? "").split(".");
  if (!header || !payload || !sig || extra) return null;

  const expected = signature(`${header}.${payload}`);
  if (!safeEqual(sig, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !claims.sub ||
      !Object.values(ROLES).includes(claims.role) ||
      Number(claims.exp) <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  if (process.env.AUTH_DISABLED === "true") {
    req.user = { sub: "local-dev", role: ROLES.OPS_MANAGER, name: "Local Developer", tech: null };
    return next();
  }

  const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  const claims = verifyToken(match?.[1]);
  if (!claims) {
    return res.status(401).json({ error: "authentication required", code: "AUTH_REQUIRED" });
  }
  req.user = claims;
  next();
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "insufficient permissions", code: "FORBIDDEN" });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Technician logins come from the database, not from this file
// ─────────────────────────────────────────────────────────────────────────────
// There are a hundred technicians in the `technician` table and work is assigned
// to them individually. A single hard-coded `tech` account cannot represent
// that: it pins every technician login to one person, so the manager can assign
// a job to whoever is nearest the site and then nobody can sign in as them to
// pick it up. The dispatch handoff — the whole point of the workflow — becomes
// undemonstrable.
//
// So any technician on record can sign in as `tech<their id>`, e.g. `tech42`.
// Identity is resolved against the business data, which is where technician
// identity actually lives.
//
// DEMO-ONLY CREDENTIAL MODEL, and worth stating plainly: every technician
// shares one password, and it is stored in plain text. A real deployment needs
// per-user password hashes (bcrypt/argon2) or an external identity provider.
// That is the correct next step and it does not change anything else here —
// only this function would be rewritten.
const TECH_USERNAME_PATTERN = /^tech[.\-_]?(\d{1,6})$/i;

async function resolveTechnicianLogin(username, password) {
  const match = TECH_USERNAME_PATTERN.exec(username);
  if (!match) return null;

  // Check the password before touching the database, so a wrong password costs
  // the same whether or not that technician id exists.
  const expected = process.env.AUTH_TECH_PASSWORD || "chargeops-demo";
  if (!safeEqual(password, expected)) return null;

  const technicianId = Number(match[1]);
  const [[row]] = await pool.query(
    `SELECT Technician_ID   AS id,
            Technician_FirstName AS first_name,
            Technician_LastName  AS last_name,
            Technician_City  AS city,
            Technician_State AS state
       FROM technician
      WHERE Technician_ID = ?`,
    [technicianId]
  );
  if (!row) return null;

  return {
    username: `tech${row.id}`,
    role: ROLES.TECHNICIAN,
    displayName: `${row.first_name} ${row.last_name} (${row.city}, ${row.state})`,
    technicianId: row.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Site-host logins come from the database too
// ─────────────────────────────────────────────────────────────────────────────
// Six companies own sites on this network, and tenancy is the thing a site-host
// account exists to demonstrate. A single `host` account pinned to one company
// by an environment variable can only ever show one side of that: to check that
// GreenGrid cannot see EVgo's revenue you had to edit server/.env and restart
// the API, which is not a test anybody runs twice.
//
// So the technician pattern applies here for the same reason it applied there —
// identity that lives in the business data should be resolved from the business
// data. Any company on record can sign in as `host<company id>`: `host1` is
// ChargePoint America, `host6` is GreenGrid Energy. Signing in as two of them in
// succession is then a ten-second check that the boundary is real, and the
// doctor's cross-tenant probe can pick a company rather than assume one.
//
// The plain `host` alias stays, pointing at whichever company
// AUTH_HOST_COMPANY_ID names, so nothing that already referenced it breaks.
//
// Same demo-only credential model as the technicians above: one shared
// password, stored in plain text. Real deployments need per-user hashes or an
// identity provider, and only this function changes.
const HOST_USERNAME_PATTERN = /^host[.\-_]?(\d{1,6})$/i;

async function resolveSiteHostLogin(username, password) {
  const match = HOST_USERNAME_PATTERN.exec(username);
  if (!match) return null;

  // Password first, so a wrong password costs the same whether or not that
  // company exists — otherwise the timing difference enumerates the estate.
  const expected = process.env.AUTH_HOST_PASSWORD || "chargeops-demo";
  if (!safeEqual(password, expected)) return null;

  const companyId = Number(match[1]);
  const [[row]] = await pool.query(
    `SELECT Company_ID AS id, Company_Name AS name FROM company WHERE Company_ID = ?`,
    [companyId]
  );
  if (!row) return null;

  return {
    username: `host${row.id}`,
    role: ROLES.SITE_HOST,
    displayName: row.name,
    companyId: row.id,
  };
}

export const authRouter = Router();

authRouter.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    // Static accounts first (ops, viewer, and the generic `tech` alias), then
    // fall back to a technician looked up by id.
    const staticUser = users.find((candidate) => safeEqual(candidate.username, username));
    const user =
      staticUser && safeEqual(staticUser.password, password)
        ? staticUser
        : (await resolveTechnicianLogin(username, password)) ??
          (await resolveSiteHostLogin(username, password));

    if (!user) {
      return res
        .status(401)
        .json({ error: "invalid username or password", code: "INVALID_CREDENTIALS" });
    }

    res.json({ token: issueToken(user), user: publicUser(user), expiresIn: TOKEN_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/technicians - which technician accounts can sign in
//
// Exposed so the login screen can offer real names instead of asking someone to
// guess an id, and so the demo can show that these are database records rather
// than three accounts baked into the source.
authRouter.get("/technicians", requireAuth, allowRoles(ROLES.OPS_MANAGER), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.Technician_ID AS id,
              CONCAT('tech', t.Technician_ID) AS username,
              CONCAT(t.Technician_FirstName, ' ', t.Technician_LastName) AS name,
              t.Technician_City  AS city,
              t.Technician_State AS state,
              COUNT(CASE WHEN m.Status IN ('Reported','Assigned','In Progress') THEN 1 END) AS open_work_orders
         FROM technician t
         LEFT JOIN maintenance_log m ON m.Technician_ID = t.Technician_ID
        GROUP BY t.Technician_ID
        ORDER BY open_work_orders DESC, t.Technician_ID`
    );
    res.json(rows.map((r) => ({ ...r, open_work_orders: Number(r.open_work_orders) })));
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({
    username: req.user.sub,
    role: req.user.role,
    displayName: req.user.name || req.user.sub,
    technicianId: req.user.tech ?? null,
    companyId: req.user.co ?? null,
  });
});
