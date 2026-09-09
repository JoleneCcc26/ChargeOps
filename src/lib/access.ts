// src/lib/access.ts — one place that says who sees what
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═════════════════════════════════════════════════════════════════════════════
// The sidebar and the router used to answer the same question separately: the
// nav array decided which links to draw, and App.tsx decided which routes to
// render, each with its own inline role test. Two answers to one question drift
// — a link stays visible after its route starts redirecting, or a page remains
// reachable by typing the address after the link is gone.
//
// Worse, both defaulted to permissive. A nav entry with no `roles` was shown to
// everybody, which is how a field technician ended up looking at network
// revenue on the dashboard. So here every entry names its roles, and the type
// makes the field required: forgetting one is a compile error rather than a
// quiet hole.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS IS NOT SECURITY
// ═════════════════════════════════════════════════════════════════════════════
// Nothing in the browser can be a boundary. A determined technician can call
// the API directly whatever the sidebar shows, so every rule below is mirrored
// by `allowRoles` in server/app.js, and the row-level filters in
// server/lib/scope.js. This file decides what is WORTH SHOWING; the server
// decides what is allowed.
import type { Role } from "../context/AuthContext";

export interface NavEntry {
  to: string;
  label: string;
  /** Required — see the note above about permissive defaults. */
  roles: Role[];
  /**
   * Icon name, resolved to a component in Layout. Kept as a string so this
   * file stays free of React imports and can be read as pure configuration.
   */
  icon: IconName;
  group?: string;
  end?: boolean;
}

export type IconName =
  | "home" | "wrench" | "wallet" | "building" | "map" | "plug"
  | "clipboard" | "inbox" | "zap" | "card" | "users" | "upload" | "activity"
  | "receipt" | "handCoins" | "fileText";

/**
 * Every navigable destination, with the roles that may see it.
 *
 * Ordered as each role should read it: the thing you act on first is first.
 */
export const NAV: NavEntry[] = [
  // ── Operations manager and viewer ─────────────────────────────────────────
  { to: "/", label: "Operations", icon: "home", end: true, roles: ["ops_manager", "viewer"] },

  // ── Role-specific home pages ──────────────────────────────────────────────
  // Each lands on the question its user actually opens the application to ask.
  { to: "/my-work", label: "My work", icon: "wrench", end: true, roles: ["technician"] },
  // ── Finance gets three destinations, not one long page ────────────────────
  //
  // These were stacked on /revenue — an approval queue, a revenue chart, a
  // debt ledger and a reconciliation table on one scroll. They are three
  // different jobs done at three different times: approvals are worked daily
  // and are somebody waiting on you; collections is a weekly sweep; revenue is
  // what you read before a meeting. Stacking them means the urgent thing sits
  // below a chart.
  { to: "/revenue", label: "Revenue", icon: "wallet", end: true, roles: ["finance"] },
  { to: "/approvals", label: "Approvals", icon: "inbox", roles: ["finance"] },
  { to: "/collections", label: "Collections", icon: "handCoins", roles: ["finance"] },
  // The PDFs the billing worker produced. Operations and the viewer get it too:
  // it is the visible end of the asynchronous pipeline, and the one screen that
  // shows a file the system generated rather than one it was given.
  { to: "/invoices", label: "Invoices", icon: "fileText", roles: ["finance", "ops_manager", "viewer"] },
  // A landlord asks two separate questions: "are my sites working?" and "what
  // am I owed, and can I see the lines?". The second is a statement somebody
  // checks at month end, not something to scroll past on the way to a fault.
  { to: "/my-sites", label: "My sites", icon: "building", end: true, roles: ["site_host"] },
  { to: "/earnings", label: "Earnings", icon: "receipt", roles: ["site_host"] },

  // ── Shared infrastructure views ───────────────────────────────────────────
  // A technician needs equipment detail to do the job; a site host sees only
  // their own rows, filtered in SQL rather than hidden here.
  { to: "/stations", label: "Stations", icon: "map", roles: ["ops_manager", "technician", "site_host", "viewer"] },
  { to: "/chargers", label: "Chargers", icon: "plug", roles: ["ops_manager", "technician", "site_host", "viewer"] },

  // ── Work orders ───────────────────────────────────────────────────────────
  { to: "/maintenance", label: "Dispatch", icon: "clipboard", roles: ["ops_manager", "viewer"] },
  { to: "/maintenance", label: "Work orders", icon: "clipboard", roles: ["site_host"] },

  // ── Money and customers. Never the technician, never the site host. ───────
  // No billing entry for the manager.
  //
  // They can still RAISE a request through the API — POST /api/billing/requests
  // is operations-only, because whoever asks for money to move and whoever
  // approves it have to be different people. But a manager cannot approve, and
  // a queue you can only read is a queue you stop reading. Finance owns this
  // screen; it is their home page, under the name "Revenue".
  { to: "/sessions", label: "Sessions", icon: "zap", roles: ["ops_manager", "finance", "viewer"] },
  { to: "/payments", label: "Payments", icon: "card", roles: ["ops_manager", "finance", "viewer"] },
  { to: "/users", label: "Drivers", icon: "users", roles: ["ops_manager", "viewer"] },

  // ── Cloud ─────────────────────────────────────────────────────────────────
  { to: "/uploads", label: "Field uploads", icon: "upload", group: "Cloud", roles: ["ops_manager", "technician"] },
  { to: "/cloud-ops", label: "Cloud ops", icon: "activity", group: "Cloud", roles: ["ops_manager", "viewer"] },
];

/**
 * Where a role lands after signing in.
 *
 * Rather than sending everybody to one dashboard and hiding the parts they may
 * not see, each role opens on a page built for them. A technician's first
 * screen is their job list, not a network overview with the revenue removed.
 */
export const HOME_BY_ROLE: Record<Role, string> = {
  ops_manager: "/",
  viewer: "/",
  technician: "/my-work",
  finance: "/revenue",
  site_host: "/my-sites",
};

export function navFor(role: Role): NavEntry[] {
  return NAV.filter((entry) => entry.roles.includes(role));
}

export function homeFor(role: Role): string {
  return HOME_BY_ROLE[role] ?? "/";
}

/**
 * May this role open this path?
 *
 * Used by the router so an address typed by hand is refused the same way the
 * missing link implies — otherwise removing a link only hides a page rather
 * than closing it.
 */
export function canAccess(role: Role, path: string): boolean {
  const normalised = path === "" ? "/" : path;
  return NAV.some((entry) => entry.to === normalised && entry.roles.includes(role));
}

/** How each role is described in the interface. */
export const ROLE_LABEL: Record<Role, string> = {
  ops_manager: "Operations Manager",
  technician: "Field Technician",
  finance: "Finance & Billing",
  site_host: "Site Host",
  viewer: "Read-only Viewer",
};
