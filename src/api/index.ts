// src/api/index.ts — typed API calls matching EV MySQL schema
import { apiFetch, apiFetchPage, apiPatch, apiPost, apiUpload } from "./client";
import type { ApiPage } from "./client";

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  totalStations: number;
  totalChargers: number;
  totalUsers:    number;
  totalPlans:    number;
}

export interface RevenueByCity {
  city:    string;
  revenue: number;
}

export interface ChargerAvailabilityRow {
  status: string;
  count:  number;
}

export interface RecentSession {
  id:           string;
  user_name:    string;
  station_name: string;
  started_at:   string;
  ended_at:     string | null;
  /** Settled figures. Null while the session is still running. */
  kwh:          number | null;
  cost_usd:     number | null;
  status:       string;

  /** Present only on sessions that are still charging. */
  estimated?:          boolean;
  elapsed_minutes?:    number;
  estimated_kwh?:      number;
  estimated_cost_usd?: number;
}

// ── Stations ─────────────────────────────────────────────────────────────────

export interface Station {
  id:                 string;
  company_id:         string;
  company_name:       string;
  name:               string;
  address:            string;
  city_name:          string;
  state:              string;
  zip:                string;
  total_slots:        number;
  operational_status: string;
  opening_hours:      string;
}

// ── Chargers ─────────────────────────────────────────────────────────────────

export interface Charger {
  id:                    string;
  station_id:            string;
  station_name:          string;
  charger_type:          string;
  max_kw:                number;
  rate_per_kwh:          number;
  status:                string;
  last_maintenance_date: string | null;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export interface User {
  id:                  string;
  name:                string;
  email:               string;
  phone:               string;
  vehicle_brand:       string;
  vehicle_model:       string;
  subscription_id:     string | null;
  plan_tier:           string | null;
  started:             string | null;
  renews:              string | null;
  subscription_status: string | null;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface ChargingSession {
  id:           string;
  user_id:      string;
  user_name:    string;
  station_id:   string;
  station_name: string;
  charger_id:   string;
  started_at:   string;
  ended_at:     string | null;
  /** Settled figures. Null while the session is still running. */
  kwh:          number | null;
  cost_usd:     number | null;
  status:       string;

  /** Present only on sessions that are still charging. */
  estimated?:          boolean;
  elapsed_minutes?:    number;
  estimated_kwh?:      number;
  estimated_cost_usd?: number;
}

export interface SessionCountByDay {
  date:  string;
  count: number;
}

// ── Payments ──────────────────────────────────────────────────────────────────

export interface Payment {
  id:         string;
  user_id:    string;
  user_name:  string;
  type:       string;
  method:     string;
  amount:     number;
  status:     string;
  session_id: string | null;
  created_at: string;
}

export interface RevenueByMonth {
  month:   string;
  revenue: number;
}

export interface PaymentTypeBreakdown {
  type:  string;
  count: number;
  total: number;
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export interface MaintenanceLog {
  id:            string;
  station_id:    string;
  station_name:  string;
  charger_id:    string | null;
  issue_type:    string;
  /** Reported | Assigned | In Progress | Resolved | Rejected */
  status:        string;
  resolved_time: string | null;
  /** Null while the work order is still waiting to be dispatched. */
  technician_id:   string | null;
  technician_name: string | null;
  technician_city: string | null;
  reported_at:     string | null;
  reported_by:     string | null;
  /** telemetry | field_report | ops_report | inspection */
  report_source:   string | null;
  fault_code:      string | null;
  severity:        string | null;
  priority:        string | null;
  assigned_at:     string | null;
  assigned_by:     string | null;
  started_at:      string | null;
  resolution_notes: string | null;
}

export interface MaintenanceSummaryRow {
  issue_type: string;
  status:     string;
  count:      number;
}

export interface PaymentFilterOptions {
  types: string[];
  statuses: string[];
  methods: string[];
}

export interface PaymentAnalytics {
  typeBreakdown: PaymentTypeBreakdown[];
  monthly: RevenueByMonth[];
}

export interface Technician {
  id: string;
  name: string;
  city: string;
  state: string;
  /** Work orders currently Assigned or In Progress. Drives the dispatch order. */
  open_work_orders: number;
  /** Present when the list was requested for a specific work order. */
  distance_km?: number | null;
  same_state?: boolean;
}

// ── API functions ─────────────────────────────────────────────────────────────

export const fetchDashboardKpis       = () => apiFetch<DashboardKpis>("/dashboard/kpis");
export const fetchRevenueByCity       = () => apiFetch<RevenueByCity[]>("/dashboard/revenue-by-city");
export const fetchChargerAvailability = () => apiFetch<ChargerAvailabilityRow[]>("/dashboard/charger-availability");
export const fetchRecentSessions      = (limit = 10) => apiFetch<RecentSession[]>("/dashboard/recent-sessions", { limit });

export const fetchStations = (filters?: { state?: string; status?: string }) =>
  apiFetch<Station[]>("/stations", filters);
export const fetchStation  = (id: string) => apiFetch<Station>(`/stations/${id}`);

export const fetchChargers = (filters?: { stationId?: string; type?: string; status?: string }) =>
  apiFetch<Charger[]>("/chargers", filters);
export const fetchChargersPage = (filters: { stationId?: string; type?: string; status?: string; search?: string; page: number; pageSize: number }): Promise<ApiPage<Charger>> =>
  apiFetchPage<Charger>("/chargers", filters);
export const fetchCharger  = (id: string) => apiFetch<Charger>(`/chargers/${id}`);
export const updateChargerStatus = (id: string, status: string, reason: string) =>
  apiPatch<{ id: number; status: string; previousStatus: string }>(`/chargers/${id}/status`, { status, reason });

export const fetchUsers = (filters?: { plan?: string; subStatus?: string }) =>
  apiFetch<User[]>("/users", filters);
export const fetchUsersPage = (filters: { plan?: string; subStatus?: string; search?: string; page: number; pageSize: number }): Promise<ApiPage<User>> =>
  apiFetchPage<User>("/users", filters);
export const fetchUser  = (id: string) => apiFetch<User>(`/users/${id}`);

export const fetchSessions          = (filters?: { days?: number; status?: string }) =>
  apiFetch<ChargingSession[]>("/sessions", filters);
export const fetchSessionsPage = (filters: { days?: number; status?: string; search?: string; page: number; pageSize: number }): Promise<ApiPage<ChargingSession>> =>
  apiFetchPage<ChargingSession>("/sessions", filters);
export const fetchSessionCountByDay = (days = 30) =>
  apiFetch<SessionCountByDay[]>("/sessions/count-by-day", { days });

export const fetchPayments             = (filters?: { type?: string; status?: string }) =>
  apiFetch<Payment[]>("/payments", filters);
export const fetchPaymentsPage = (filters: { type?: string; status?: string; method?: string; search?: string; days?: number; page: number; pageSize: number }): Promise<ApiPage<Payment>> =>
  apiFetchPage<Payment>("/payments", filters);
export const fetchRevenueByMonth       = () => apiFetch<RevenueByMonth[]>("/payments/revenue-by-month");
export const fetchPaymentTypeBreakdown = () => apiFetch<PaymentTypeBreakdown[]>("/payments/type-breakdown");
export const fetchPaymentFilterOptions = () => apiFetch<PaymentFilterOptions>("/payments/filter-options");
export const fetchPaymentAnalytics = (filters?: { type?: string; status?: string; method?: string; search?: string; days?: number }) =>
  apiFetch<PaymentAnalytics>("/payments/analytics", filters);

export const fetchMaintenanceLogs    = (filters?: { status?: string; issueType?: string }) =>
  apiFetch<MaintenanceLog[]>("/maintenance", filters);
export const fetchMaintenancePage = (filters: { status?: string; issueType?: string; station?: string; search?: string; page: number; pageSize: number }): Promise<ApiPage<MaintenanceLog>> =>
  apiFetchPage<MaintenanceLog>("/maintenance", filters);
export const fetchMaintenanceSummary = () => apiFetch<MaintenanceSummaryRow[]>("/maintenance/summary");
/**
 * Technicians available to dispatch.
 *
 * Pass the work order and the list comes back ranked by distance to that
 * charger — without it there is nothing stopping a manager sending somebody
 * four states away.
 */
export const fetchTechnicians = (workOrderId?: string) =>
  apiFetch<Technician[]>("/maintenance/technicians", workOrderId ? { workOrderId } : undefined);
/** Raise a new fault report. Created unassigned — dispatch is a separate act. */
export const reportFault = (body: {
  chargerId: number; issue: string; severity: string;
  faultCode?: string; takeOutOfService?: boolean;
}) => apiPost<{
  maintenanceId: number;
  status: string;
  assigned: boolean;
  chargerTakenOutOfService: boolean;
  chargerBusy: boolean;
}>("/maintenance", body);

/**
 * One function per transition, mirroring the API.
 *
 * Deliberately not a single `setStatus(id, status)`: each move has its own rule
 * about who may make it and what else happens (resolving returns the charger to
 * service; rejecting does too, but only a manager may do it). Naming the action
 * keeps those rules discoverable instead of buried in a switch.
 */
export const assignWorkOrder = (id: string, technicianId: number) =>
  apiPost<{ id: number; status: string }>(`/maintenance/${id}/assign`, { technicianId });
export const startWorkOrder = (id: string) =>
  apiPost<{ id: number; status: string }>(`/maintenance/${id}/start`);
export const resolveWorkOrder = (id: string, notes: string) =>
  apiPost<{ id: number; status: string }>(`/maintenance/${id}/resolve`, { notes });
export const rejectWorkOrder = (id: string, reason: string) =>
  apiPost<{ id: number; status: string }>(`/maintenance/${id}/reject`, { reason });

export const updateMaintenance = (id: string, body: { status?: string; technicianId?: number; note?: string }) =>
  apiPatch<{ id: number; status: string; technicianId: number }>(`/maintenance/${id}`, body);

// ═════════════════════════════════════════════════════════════════════════════
// Cloud project additions
// ═════════════════════════════════════════════════════════════════════════════

// ── Attachments: unstructured file intake ────────────────────────────────────

export type ProcessStatus = "pending" | "processing" | "done" | "failed";

export interface Attachment {
  id:              number;
  name:            string;
  storage_key:     string;
  content_type:    string;
  size_bytes:      number;
  kind:            "image" | "document" | "other";
  process_status:  ProcessStatus;
  process_error:   string | null;

  /** Everything below is DERIVED by the worker from the file's contents. */
  fault_category:  string | null;
  severity:        "critical" | "major" | "minor" | null;
  error_code:      string | null;
  summary:         string | null;
  word_count:      number | null;
  image_width:     number | null;
  image_height:    number | null;
  captured_at:     string | null;
  gps_lat:         number | null;
  gps_lng:         number | null;
  match_distance_m: number | null;

  maintenance_id:  number | null;
  charger_id:      number | null;
  station_name:    string | null;
  matched_station_name: string | null;

  uploaded_at:     string;
  processed_at:    string | null;
  /** Milliseconds from upload to extraction complete — the async latency. */
  process_ms:      number | null;

  extracted:       Record<string, unknown> | null;
  /** Short-lived signed URL minted by the server on every read. */
  url:             string;
}

export interface AttachmentStats {
  total:      number;
  pending:    number;
  processing: number;
  done:       number;
  failed:     number;
  images:     number;
  documents:  number;
  totalBytes: number;
  avgProcessMs: number;
  byCategory: { category: string; severity: string; count: number }[];
}

export interface UploadAccepted {
  accepted: {
    attachmentId: number;
    jobId: number;
    key: string;
    name: string;
    kind: string;
    sizeBytes: number;
    processStatus: ProcessStatus;
  }[];
  message: string;
}

export const fetchAttachments = (filters?: {
  status?: string; category?: string; severity?: string; kind?: string; limit?: number;
}) => apiFetch<Attachment[]>("/attachments", filters as Record<string, string | number>);

export const fetchAttachmentStats = () => apiFetch<AttachmentStats>("/attachments/stats");

export const uploadAttachments = (
  files: File[],
  meta: { stationId?: number; chargerId?: number; technicianId?: number; maintenanceId?: number }
) => apiUpload<UploadAccepted>("/attachments", files, meta);

export const reprocessAttachment = (id: number) =>
  apiPost<{ attachmentId: number; jobId: number }>(`/attachments/${id}/reprocess`);

// ── Ops: live infrastructure metrics ─────────────────────────────────────────

export interface QueueStat {
  queue:            string;
  ready:            number;
  inflight:         number;
  dead:             number;
  done:             number;
  backlog:          number;
  throughputPerSec: number;
  avgLatencyMs:     number;
  maxLatencyMs:     number;
}

export interface OpsStats {
  timestamp: string;
  queues: QueueStat[];
  totals: { backlog: number; throughput: number; dead: number; completed: number };
  workers: {
    count: number;
    totalProcessed: number;
    totalFailed: number;
    nodes: {
      id: string; pid: number; queues: string;
      processed: number; failed: number; heartbeatAgeMs: number;
    }[];
  };
  cache: {
    backend: string; entries: number; hits: number; misses: number;
    sets: number; evictions: number; hitRate: number;
  };
  storage: {
    bucket: string; backend: string; root: string;
    objectCount: number; totalBytes: number;
  };
  data: {
    telemetryRows: number; attachments: number;
    invoices: number; pendingSessions: number;
  };
  host: { cpus: number; freeMemMb: number; uptimeSec: number };
}

export interface DeadLetter {
  id: number; queue: string; attempts: number;
  error: string; payload: string; failedAt: string;
}

export interface ArchitectureRow {
  layer: string; local: string; cloud: string; dimension: string;
}

export const fetchOpsStats     = () => apiFetch<OpsStats>("/ops/stats");
export const fetchDeadLetters  = () => apiFetch<DeadLetter[]>("/ops/dead-letters");
export const fetchArchitecture = () => apiFetch<ArchitectureRow[]>("/ops/architecture");
export const redriveDeadLetters = (queue?: string) =>
  apiPost<{ redriven: number }>("/ops/redrive", { queue });
export const purgeCompletedJobs = () => apiPost<{ purged: number }>("/ops/purge");

// ── Telemetry ────────────────────────────────────────────────────────────────

export interface TelemetryThroughputPoint {
  bucket: string; rowsWritten: number; perSecond: number;
}

export interface TelemetryStats {
  total: number; lastMinute: number; avgLagMs: number;
}

export const fetchTelemetryThroughput = () =>
  apiFetch<TelemetryThroughputPoint[]>("/telemetry/throughput");
export const fetchTelemetryStats = () => apiFetch<TelemetryStats>("/telemetry/stats");

// ── Invoices (PDFs generated by the billing worker) ──────────────────────────

export interface Invoice {
  id: number; number: string; session_id: number; user_id: number;
  payment_id: number | null; storage_key: string; amount: number;
  generated_at: string; user_name: string; station_name: string | null;
  kwh: number | null; url: string;
}

export const fetchInvoices = (limit = 50) => apiFetch<Invoice[]>("/invoices", { limit });

// ── Session control (the write path that replaced the trigger) ───────────────

export const stopSession = (id: number) =>
  apiPost<{ sessionId: number; jobId: number; status: string; message: string }>(
    `/sessions/${id}/stop`
  );

export const billPendingSessions = (limit = 500) =>
  apiPost<{ enqueued: number }>("/sessions/bill-pending", { limit });
