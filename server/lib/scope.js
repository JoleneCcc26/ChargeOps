// server/lib/scope.js — row-level tenancy for site hosts
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT A SITE HOST IS, AND WHY IT CHANGES THE QUERIES
// ═════════════════════════════════════════════════════════════════════════════
// Chargers sit in somebody else's car park: a shopping centre, a hotel, an
// office block. That business — the site host — is a real user of the platform.
// They want to know how much their bays were used and what their share of the
// revenue is, and they must never see another host's sites, another host's
// revenue, or any driver's identity.
//
// That is a different kind of permission from every other rule in this
// application. Everywhere else the question is "may this role reach this
// endpoint?", answered once by `allowRoles`. Here the endpoint is allowed and
// the question is "which ROWS may they see?", which has to be answered inside
// every query.
//
// Hiding rows in the front end would not be a boundary at all; nor would
// filtering the array after fetching it, since the rows would already have
// crossed the wire. The filter has to be in the SQL, which is what this module
// makes hard to forget.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT MATTERS FOR THE CLOUD MIGRATION
// ═════════════════════════════════════════════════════════════════════════════
// This is multi-tenancy, and it is the point at which "put the database in the
// cloud" stops being a lift-and-shift. A shared table with a tenant column is
// the simplest of the tenancy models; the alternatives (a schema per tenant, a
// database per tenant) trade cost against isolation, and the choice drives
// backup, encryption, and which compliance questions a customer will ask.
// Naming the boundary here is what makes that discussion possible later.

/**
 * The company a request is confined to, or null for staff who see everything.
 *
 * @param {import("express").Request} req
 * @returns {number|null}
 */
export function tenantCompanyId(req) {
  // `co` is signed into the token, so a host cannot widen their own scope by
  // editing a request — the claim would fail its HMAC check.
  return req.user?.role === "site_host" ? Number(req.user.co) || -1 : null;
}

/**
 * Append a company filter to a WHERE clause being built.
 *
 * Takes the column to compare so callers can pass whichever alias they have in
 * scope (`s.Company_ID` in a station query, `st.Company_ID` where station is
 * joined as `st`).
 *
 * A site host whose account names no company gets -1, which matches nothing.
 * Failing closed is deliberate: an empty page is a bug report, whereas a
 * missing filter is a data leak nobody notices.
 *
 * @param {import("express").Request} req
 * @param {string[]} conditions  mutated
 * @param {unknown[]} params     mutated
 * @param {string} column        e.g. "s.Company_ID"
 */
export function applyTenantScope(req, conditions, params, column) {
  const companyId = tenantCompanyId(req);
  if (companyId === null) return false;
  conditions.push(`${column} = ?`);
  params.push(companyId);
  return true;
}

/**
 * True when this request must never see driver identities.
 *
 * A site host may know that bay 12 delivered 40 kWh on Tuesday. They may not
 * know who was driving — that is the platform operator's customer, not theirs,
 * and in most jurisdictions handing it over would be a privacy breach rather
 * than merely bad manners.
 */
export function mustHideDriverIdentity(req) {
  return req.user?.role === "site_host";
}

/**
 * Refuse a single row that belongs to another company.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM applyTenantScope
 * ─────────────────────────────────────────────────────────────────────────────
 * applyTenantScope filters a LIST. That is only half the boundary, and it is
 * the half that is easy to remember because you can see the result: a host's
 * station page shows fourteen rows instead of fifty-one, so the filter is
 * obviously working.
 *
 * The other half is the DETAIL endpoint, and it is invisible. Nobody clicks
 * through to a station they cannot see, so nothing in the interface ever
 * reveals that GET /api/stations/1 answers a host who has no business with
 * station 1. It answered for weeks. The list filter created the appearance of
 * tenancy without the substance of it.
 *
 * Returns 404 rather than 403 on purpose. Answering "403 Forbidden" confirms
 * the row exists, which lets a host enumerate a competitor's estate one id at a
 * time — the count alone is commercially interesting. "It is not there" tells
 * them nothing they did not already know.
 *
 * @returns {boolean} true when the caller may proceed
 */
export function denyForeignTenant(req, res, ownerCompanyId) {
  const companyId = tenantCompanyId(req);
  if (companyId === null) return true;                  // staff: no restriction
  if (Number(ownerCompanyId) === companyId) return true; // their own row
  res.status(404).json({ error: "not found" });
  return false;
}

/**
 * Roles that may see the whole network rather than one company's slice.
 *
 * Used to guard the aggregate dashboard endpoints. A site host gets
 * /api/dashboard/site-performance, which is scoped to them; every other
 * dashboard route reports the entire estate and is not theirs to read.
 */
export function isNetworkWide(req) {
  return tenantCompanyId(req) === null;
}
