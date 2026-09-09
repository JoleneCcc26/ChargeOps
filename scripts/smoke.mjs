import "../server/env.js";

const API = process.env.DEMO_API_URL || "http://localhost:4000";
let passed = 0;

function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

/**
 * Sign in, waiting out the login rate limiter rather than failing on it.
 *
 * /api/auth is capped at ten attempts a minute per IP, which is the right
 * number for the internet and an awkward one on a laptop where the browser,
 * the simulated fleet and this script all arrive from 127.0.0.1. This suite
 * alone signs in five times in a burst.
 *
 * Retrying is honest here: a 429 is the rate limiter working, not the login
 * failing, and reporting it as "ops can authenticate — false" sent me looking
 * for a broken password. So it waits for the window named in the response and
 * tries again, and says clearly what it is doing.
 */
/**
 * Passwords come from the environment, with the demo default as a fallback.
 *
 * These used to be a mix: the ops and viewer logins read their env var, and
 * every technician login hard-coded "chargeops-demo". That passes on any
 * machine whose server/.env happens to use the demo password and fails on a
 * fresh clone, because server/.env.example ships `replace-me` — so the suite
 * only worked where it was written. A test that depends on the environment it
 * was authored in tells you nothing about anyone else's.
 */
const TECH_PASSWORD = process.env.AUTH_TECH_PASSWORD || "chargeops-demo";

async function login(username, password = TECH_PASSWORD) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (res.status === 429 && attempt <= 3) {
      const reset = Number(res.headers.get("RateLimit-Reset")) || 0;
      const waitMs = Math.min(
        65_000,
        Math.max(2_000, reset ? reset * 1000 - Date.now() + 1_000 : 15_000)
      );
      console.log(`  … login rate limited, waiting ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const body = await res.json().catch(() => ({}));
    ok(
      res.ok && Boolean(body.token),
      `${username} can authenticate` +
        (res.ok ? "" : ` (HTTP ${res.status}${body.error ? `: ${body.error}` : ""})`)
    );
    return body.token;
  }
}

async function request(path, token, options = {}) {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
}

console.log("\nChargeOps authenticated API smoke test\n");

const health = await request("/api/health");
ok(health.ok && (await health.json()).status === "ok", "public health check reaches MySQL");

const anonymous = await request("/api/stations");
ok(anonymous.status === 401, "protected data rejects anonymous requests");

const ops = await login(process.env.DEMO_USERNAME || "ops", process.env.DEMO_PASSWORD || "chargeops-demo");
const usersRes = await request("/api/users?page=1&pageSize=500", ops);
const users = await usersRes.json();
ok(usersRes.ok && Number(usersRes.headers.get("X-Total-Count")) > 0, "paginated users endpoint returns total headers");
ok(new Set(users.map((user) => user.id)).size === users.length, "users endpoint returns one row per driver");

for (const path of ["/api/stations", "/api/chargers?pageSize=10", "/api/sessions?pageSize=10", "/api/payments?pageSize=10", "/api/maintenance?pageSize=10", "/api/ops/stats"]) {
  const res = await request(path, ops);
  ok(res.ok, `${path} responds for operations manager`);
}

const invalidAdminChange = await request("/api/chargers/1/status", ops, {
  method: "PATCH",
  body: JSON.stringify({ status: "Definitely Not A Status" }),
});
ok(invalidAdminChange.status === 400, "operations-manager write route validates input");

const countByDay = await request("/api/sessions/count-by-day?days=7", ops);
ok(countByDay.ok && Array.isArray(await countByDay.json()), "session aggregate route remains reachable");

const viewer = await login(
  process.env.AUTH_VIEWER_USERNAME || "viewer",
  process.env.AUTH_VIEWER_PASSWORD || "chargeops-demo"
);
const viewerWrite = await request("/api/ops/purge", viewer, { method: "POST", body: "{}" });
ok(viewerWrite.status === 403, "viewer cannot purge queue history");

const tech = await login(
  process.env.AUTH_TECH_USERNAME || "tech",
  process.env.AUTH_TECH_PASSWORD || "chargeops-demo"
);
const techUsers = await request("/api/users", tech);
ok(techUsers.status === 403, "technician cannot read customer directory");
const techMaintenance = await request("/api/maintenance?pageSize=5", tech);
ok(techMaintenance.ok, "technician can read maintenance work orders");

// ── A technician's work queue is their own ──────────────────────────────────
// Row-level scoping, enforced in the SQL rather than hidden in the UI. Without
// these checks the filter could be dropped in a refactor and nothing would
// fail — the app would quietly start showing every technician the whole
// network's work orders again.
const asRows = (payload) =>
  Array.isArray(payload) ? payload : payload.rows ?? payload.data ?? [];

const techIdentity = await (await request("/api/auth/me", tech)).json();
ok(
  Number.isInteger(techIdentity.technicianId),
  "technician login is linked to a technician record"
);

const techList = asRows(await (await request("/api/maintenance?pageSize=100", tech)).json());
const ownerIds = [...new Set(techList.map((row) => String(row.technician_id)))];
ok(
  ownerIds.length <= 1 &&
    (ownerIds.length === 0 || ownerIds[0] === String(techIdentity.technicianId)),
  "technician sees only their own work orders"
);

const opsList = asRows(await (await request("/api/maintenance?pageSize=100", ops)).json());
ok(
  new Set(opsList.map((row) => String(row.technician_id))).size > 1,
  "operations manager still sees the whole network"
);

const foreignOrder = opsList.find(
  (row) =>
    String(row.technician_id) !== String(techIdentity.technicianId) &&
    row.status !== "Resolved"
);
if (foreignOrder) {
  const stolen = await request(`/api/maintenance/${foreignOrder.id}`, tech, {
    method: "PATCH",
    body: JSON.stringify({ status: "Resolved" }),
  });
  ok(stolen.status === 403, "technician cannot resolve another technician's work order");
}

// ── Every technician on record can sign in as themselves ────────────────────
// A single hard-coded technician account cannot represent a hundred people with
// individually assigned work. These checks prove the login resolves against the
// technician table, and that a bad id is still rejected.
const roster = await (await request("/api/auth/technicians", ops)).json();
ok(Array.isArray(roster) && roster.length > 1, "operations manager can list technician accounts");

const someone =
  roster.find((t) => String(t.id) !== String(techIdentity.technicianId)) ?? roster[0];
const asSomeone = await login(someone.username);
const asSomeoneMe = await (await request("/api/auth/me", asSomeone)).json();
ok(
  Number(asSomeoneMe.technicianId) === Number(someone.id),
  `technician ${someone.username} signs in as themselves, not a shared account`
);

const ghost = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "tech999999", password: TECH_PASSWORD }),
});
ok(ghost.status === 401, "a technician id that does not exist cannot sign in");

console.log(`\n✔ ${passed} smoke checks passed\n`);
