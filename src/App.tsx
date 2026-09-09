// src/App.tsx — routing, with access decided in one place
//
// Every route below is wrapped by `allowed`, which asks src/lib/access.ts the
// same question the sidebar asks. That matters because the two used to answer
// separately: the nav array decided which links to draw, and this file carried
// its own inline `user.role !== "technician"` tests. Two answers to one
// question drift, and the drift is always in the permissive direction — a page
// stays reachable by typing its address long after the link disappears.
//
// A refused route sends the user to their own home rather than to "/", because
// "/" is the operations dashboard and a technician has no business there. Home
// is per-role: the job list, the revenue queue, the site list.
//
// None of this is a security boundary. It decides what is worth rendering; the
// server decides what is allowed, in allowRoles (server/app.js) and the
// row-level filters (server/lib/scope.js).
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Chargers } from "./pages/Chargers";
import { ChargerHistory } from "./pages/ChargerHistory";
import { Dashboard } from "./pages/Dashboard";
import { MaintenanceLogPage } from "./pages/MaintenanceLog";
import { MySites } from "./pages/MySites";
import { MyWork } from "./pages/MyWork";
import { Payments } from "./pages/Payments";
import { Revenue } from "./pages/Revenue";
import { Approvals } from "./pages/Approvals";
import { Collections } from "./pages/Collections";
import { Earnings } from "./pages/Earnings";
import { Invoices } from "./pages/Invoices";
import { Sessions } from "./pages/Sessions";
import { Stations } from "./pages/Stations";
import { Users } from "./pages/Users";
import { Uploads } from "./pages/Uploads";
import { CloudOps } from "./pages/CloudOps";
import { Login } from "./pages/Login";
import { useAuth } from "./context/AuthContext";
import { canAccess, homeFor } from "./lib/access";

export default function App() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        Checking session…
      </div>
    );
  }
  if (!user) return <Login />;

  const home = homeFor(user.role);

  /** Render `element` if this role may open `path`, otherwise send them home. */
  const allowed = (path: string, element: React.ReactNode) =>
    canAccess(user.role, path) ? element : <Navigate to={home} replace />;

  return (
    <Routes>
      <Route element={<Layout />}>
        {/* The index route is the operations dashboard, so a role whose home is
            elsewhere is redirected rather than shown a screen full of numbers
            they cannot act on. */}
        <Route index element={allowed("/", <Dashboard />)} />

        <Route path="my-work" element={allowed("/my-work", <MyWork />)} />
        <Route path="revenue" element={allowed("/revenue", <Revenue />)} />
        <Route path="my-sites" element={allowed("/my-sites", <MySites />)} />
        <Route path="earnings" element={allowed("/earnings", <Earnings />)} />
        <Route path="approvals" element={allowed("/approvals", <Approvals />)} />
        <Route path="collections" element={allowed("/collections", <Collections />)} />
        <Route path="invoices" element={allowed("/invoices", <Invoices />)} />

        <Route path="stations" element={allowed("/stations", <Stations />)} />
        <Route path="chargers" element={allowed("/chargers", <Chargers />)} />
        {/* Equipment history hangs off /chargers and inherits its permission:
            anybody who may see a charger may see what has gone wrong with it. */}
        <Route path="chargers/:id/history" element={allowed("/chargers", <ChargerHistory />)} />

        <Route path="maintenance" element={allowed("/maintenance", <MaintenanceLogPage />)} />
        <Route path="sessions" element={allowed("/sessions", <Sessions />)} />
        <Route path="payments" element={allowed("/payments", <Payments />)} />
        <Route path="users" element={allowed("/users", <Users />)} />

        <Route path="uploads" element={allowed("/uploads", <Uploads />)} />
        <Route path="cloud-ops" element={allowed("/cloud-ops", <CloudOps />)} />

        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}
