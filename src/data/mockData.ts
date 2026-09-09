/** Sample data aligned with EV MySQL schema — replace with API calls to your backend. */

export type PlanTier = "Silver" | "Gold" | "Diamond";

export interface Company {
  id: string;
  name: string;
  country: string;
}

export type StationOperationalStatus = "open" | "closed" | "maintenance";

export interface Station {
  id: string;
  companyId: string;
  name: string;
  address: string;
  /** City name only (state is separate for filtering) */
  cityName: string;
  state: string;
  lat: number;
  lng: number;
  totalChargers: number;
  /** Parking / charging slots shown on Stations table */
  totalSlots: number;
  operationalStatus: StationOperationalStatus;
  openingHours: string;
}

export function stationCityState(s: Station): string {
  return `${s.cityName}, ${s.state}`;
}

export type ChargerStatus =
  | "available"
  | "charging"
  | "offline"
  | "maintenance"
  | "reserved";

/** UI / tariff grouping — Level 2 vs DC fast */
export type ChargerType = "dc_fast" | "level2";

/** Grouped availability for filters, badges, and summaries */
export type ChargerAvailabilityUi =
  | "available"
  | "in_use"
  | "out_of_service"
  | "reserved";

export interface Charger {
  id: string;
  stationId: string;
  label: string;
  /** Max DC or AC output power (kW) */
  maxKw: number;
  connector: "CCS" | "NACS" | "CHAdeMO" | "Type2";
  status: ChargerStatus;
  chargerType: ChargerType;
  /** Billing rate in USD per kWh delivered */
  ratePerKwh: number;
  /** Most recent maintenance visit (YYYY-MM-DD), null if none recorded */
  lastMaintenanceDate: string | null;
}

export function chargerAvailabilityUi(status: ChargerStatus): ChargerAvailabilityUi {
  if (status === "available") return "available";
  if (status === "charging") return "in_use";
  if (status === "reserved") return "reserved";
  return "out_of_service";
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  joined: string;
  subscriptionId: string | null;
  walletBalance: number;
  vehicleBrandModel: string;
}

export type SubscriptionStatus =
  | "active"
  | "pending"
  | "expired"
  | "cancelled";

export interface Subscription {
  id: string;
  userId: string;
  planTier: PlanTier;
  started: string;
  renews: string;
  status: SubscriptionStatus;
}

export interface MembershipPlan {
  tier: PlanTier;
  monthlyPrice: number;
  discountPercent: number;
  perks: string;
}

export type ChargingSessionStatus =
  | "pending"
  | "active"
  | "completed"
  | "cancelled";

export interface ChargingSession {
  id: string;
  userId: string;
  chargerId: string;
  stationId: string;
  startedAt: string;
  endedAt: string | null;
  kwh: number;
  costUsd: number;
  status: ChargingSessionStatus;
}

/** Table / badge labels — Pending & Active both use blue per UI spec */
export function sessionStatusUi(status: ChargingSessionStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        className: "bg-sky-500/20 text-sky-300 ring-sky-500/40",
      };
    case "active":
      return {
        label: "Active",
        className: "bg-sky-500/20 text-sky-300 ring-sky-500/40",
      };
    case "completed":
      return {
        label: "Completed",
        className: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className: "bg-rose-500/20 text-rose-300 ring-rose-500/40",
      };
  }
}

export type PaymentType = "charging" | "subscription" | "wallet_topup";

export type PaymentMethod = "wallet" | "credit_card" | "apple_pay";

export type PaymentRecordStatus = "completed" | "pending" | "failed";

export interface Payment {
  id: string;
  userId: string;
  amountUsd: number;
  type: PaymentType;
  status: PaymentRecordStatus;
  at: string;
  ref: string;
  method: PaymentMethod;
}

export function paymentMethodLabel(m: PaymentMethod): string {
  switch (m) {
    case "wallet":
      return "Wallet";
    case "credit_card":
      return "Credit Card";
    case "apple_pay":
      return "Apple Pay";
  }
}

export function paymentStatusUi(status: PaymentRecordStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "completed":
      return {
        label: "Success",
        className: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-rose-500/20 text-rose-300 ring-rose-500/40",
      };
    case "pending":
      return {
        label: "Pending",
        className: "bg-amber-500/20 text-amber-200 ring-amber-500/45",
      };
  }
}

export type MaintenanceLogStatus = "open" | "in_progress" | "resolved";

export interface MaintenanceLog {
  /** Internal key */
  id: string;
  /** Shown in UI as maintenance ticket ID */
  maintenanceCode: string;
  chargerId: string;
  stationId: string;
  technician: string;
  issueReported: string;
  /** Category for analytics / bar chart */
  issueType: string;
  status: MaintenanceLogStatus;
  /** When the ticket was opened */
  reportedAt: string;
  /** When resolved; null if not resolved */
  resolvedAt: string | null;
}

export function maintenanceStatusUi(status: MaintenanceLogStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "resolved":
      return {
        label: "Resolved",
        className: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
      };
    case "in_progress":
      return {
        label: "In Progress",
        className: "bg-amber-500/20 text-amber-200 ring-amber-500/45",
      };
    case "open":
      return {
        label: "Open",
        className: "bg-rose-500/20 text-rose-300 ring-rose-500/40",
      };
  }
}

export const companies: Company[] = [
  { id: "c1", name: "VoltGrid Networks", country: "US" },
  { id: "c2", name: "EcoCharge Alliance", country: "US" },
];

export const stations: Station[] = [
  {
    id: "s1",
    companyId: "c1",
    name: "Downtown Transit Hub",
    address: "1200 Commerce St",
    cityName: "Austin",
    state: "TX",
    lat: 30.2672,
    lng: -97.7431,
    totalChargers: 8,
    totalSlots: 10,
    operationalStatus: "open",
    openingHours: "Mon–Sun 6:00 AM – 10:00 PM",
  },
  {
    id: "s2",
    companyId: "c1",
    name: "Riverside Retail Park",
    address: "88 Lake Blvd",
    cityName: "Austin",
    state: "TX",
    lat: 30.3072,
    lng: -97.755,
    totalChargers: 6,
    totalSlots: 8,
    operationalStatus: "maintenance",
    openingHours: "Mon–Sun 24 hours",
  },
  {
    id: "s3",
    companyId: "c2",
    name: "Airport North Lot",
    address: "1 Terminal Dr",
    cityName: "Dallas",
    state: "TX",
    lat: 32.8998,
    lng: -97.0403,
    totalChargers: 12,
    totalSlots: 14,
    operationalStatus: "open",
    openingHours: "Daily 5:00 AM – 12:00 AM",
  },
  {
    id: "s4",
    companyId: "c2",
    name: "Tech Campus East",
    address: "500 Innovation Way",
    cityName: "Houston",
    state: "TX",
    lat: 29.7604,
    lng: -95.3698,
    totalChargers: 10,
    totalSlots: 12,
    operationalStatus: "closed",
    openingHours: "Mon–Fri 7:00 AM – 7:00 PM",
  },
  {
    id: "s5",
    companyId: "c1",
    name: "River Walk Garage",
    address: "418 Villita St",
    cityName: "San Antonio",
    state: "TX",
    lat: 29.4241,
    lng: -98.4936,
    totalChargers: 6,
    totalSlots: 6,
    operationalStatus: "open",
    openingHours: "Mon–Sun 24 hours",
  },
  {
    id: "s6",
    companyId: "c2",
    name: "Union Station Plaza",
    address: "1701 Wynkoop St",
    cityName: "Denver",
    state: "CO",
    lat: 39.7531,
    lng: -104.9997,
    totalChargers: 8,
    totalSlots: 10,
    operationalStatus: "maintenance",
    openingHours: "Mon–Sun 6:00 AM – 11:00 PM",
  },
  {
    id: "s7",
    companyId: "c1",
    name: "Desert Sky Mall",
    address: "7611 W Thomas Rd",
    cityName: "Phoenix",
    state: "AZ",
    lat: 33.4806,
    lng: -112.2247,
    totalChargers: 10,
    totalSlots: 12,
    operationalStatus: "open",
    openingHours: "Mon–Sat 10:00 AM – 9:00 PM · Sun 11:00 AM – 7:00 PM",
  },
];

export const chargers: Charger[] = [
  {
    id: "ch1",
    stationId: "s1",
    label: "A1",
    maxKw: 150,
    connector: "CCS",
    status: "charging",
    chargerType: "dc_fast",
    ratePerKwh: 0.44,
    lastMaintenanceDate: "2025-11-18",
  },
  {
    id: "ch2",
    stationId: "s1",
    label: "A2",
    maxKw: 150,
    connector: "CCS",
    status: "available",
    chargerType: "dc_fast",
    ratePerKwh: 0.44,
    lastMaintenanceDate: "2026-01-08",
  },
  {
    id: "ch3",
    stationId: "s1",
    label: "A3",
    maxKw: 19,
    connector: "Type2",
    status: "available",
    chargerType: "level2",
    ratePerKwh: 0.28,
    lastMaintenanceDate: "2025-09-30",
  },
  {
    id: "ch4",
    stationId: "s1",
    label: "A4",
    maxKw: 19,
    connector: "Type2",
    status: "maintenance",
    chargerType: "level2",
    ratePerKwh: 0.28,
    lastMaintenanceDate: "2026-04-01",
  },
  {
    id: "ch5",
    stationId: "s2",
    label: "B1",
    maxKw: 350,
    connector: "NACS",
    status: "available",
    chargerType: "dc_fast",
    ratePerKwh: 0.52,
    lastMaintenanceDate: "2025-12-02",
  },
  {
    id: "ch6",
    stationId: "s2",
    label: "B2",
    maxKw: 350,
    connector: "NACS",
    status: "charging",
    chargerType: "dc_fast",
    ratePerKwh: 0.52,
    lastMaintenanceDate: "2026-02-14",
  },
  {
    id: "ch7",
    stationId: "s2",
    label: "B3",
    maxKw: 150,
    connector: "CCS",
    status: "offline",
    chargerType: "dc_fast",
    ratePerKwh: 0.46,
    lastMaintenanceDate: "2026-03-22",
  },
  {
    id: "ch8",
    stationId: "s3",
    label: "C1",
    maxKw: 150,
    connector: "CCS",
    status: "available",
    chargerType: "dc_fast",
    ratePerKwh: 0.41,
    lastMaintenanceDate: "2025-10-05",
  },
  {
    id: "ch9",
    stationId: "s3",
    label: "C2",
    maxKw: 150,
    connector: "CCS",
    status: "available",
    chargerType: "dc_fast",
    ratePerKwh: 0.41,
    lastMaintenanceDate: null,
  },
  {
    id: "ch10",
    stationId: "s3",
    label: "C3",
    maxKw: 50,
    connector: "CHAdeMO",
    status: "charging",
    chargerType: "dc_fast",
    ratePerKwh: 0.39,
    lastMaintenanceDate: "2026-01-22",
  },
  {
    id: "ch11",
    stationId: "s4",
    label: "D1",
    maxKw: 150,
    connector: "CCS",
    status: "available",
    chargerType: "dc_fast",
    ratePerKwh: 0.43,
    lastMaintenanceDate: "2025-08-14",
  },
  {
    id: "ch12",
    stationId: "s4",
    label: "D2",
    maxKw: 150,
    connector: "CCS",
    status: "available",
    chargerType: "dc_fast",
    ratePerKwh: 0.43,
    lastMaintenanceDate: "2026-03-01",
  },
  {
    id: "ch13",
    stationId: "s1",
    label: "A5",
    maxKw: 150,
    connector: "NACS",
    status: "reserved",
    chargerType: "dc_fast",
    ratePerKwh: 0.44,
    lastMaintenanceDate: "2025-12-20",
  },
];

export const membershipPlans: MembershipPlan[] = [
  { tier: "Silver", monthlyPrice: 9.99, discountPercent: 5, perks: "5% off sessions" },
  { tier: "Gold", monthlyPrice: 19.99, discountPercent: 10, perks: "10% off + priority support" },
  { tier: "Diamond", monthlyPrice: 39.99, discountPercent: 18, perks: "18% off + reserved bays" },
];

/** Dashboard headline KPIs — align with MySQL EV aggregates when wired to API */
export const dashboardKpis = {
  totalStations: 51,
  totalUsers: 180,
  /** Sum matches charger availability pie below */
  totalChargers: 312,
} as const;

/** Revenue by city (e.g. from PAYMENT + STATION join) — dashboard bar chart */
export const revenueByCity = [
  { city: "Houston, TX", revenue: 42800 },
  { city: "Dallas, TX", revenue: 38500 },
  { city: "Austin, TX", revenue: 31200 },
  { city: "San Antonio, TX", revenue: 24600 },
  { city: "Fort Worth, TX", revenue: 18900 },
  { city: "El Paso, TX", revenue: 12400 },
];

/**
 * Fleet-wide charger availability (matches dashboard total charger count).
 * Labels: Available, In Use, Out of Service, Reserved.
 */
export const chargerAvailabilitySummary = [
  { name: "Available", value: 158 },
  { name: "In Use", value: 76 },
  { name: "Out of Service", value: 38 },
  { name: "Reserved", value: 40 },
] as const;

/** Network-wide user metrics — replace with API aggregates; total matches dashboard KPI */
export const userMetrics = {
  totalUsers: dashboardKpis.totalUsers,
  activeSubscribers: 131,
  silverPlanCount: 72,
  goldPlanCount: 58,
  diamondPlanCount: 28,
} as const;

export const users: User[] = [
  {
    id: "u1",
    name: "Alex Rivera",
    email: "alex.r@email.com",
    phone: "+1 512-555-0101",
    joined: "2024-06-12",
    subscriptionId: "sub1",
    walletBalance: 42.5,
    vehicleBrandModel: "Tesla Model Y",
  },
  {
    id: "u2",
    name: "Jordan Lee",
    email: "jordan.lee@email.com",
    phone: "+1 214-555-0144",
    joined: "2024-08-01",
    subscriptionId: "sub2",
    walletBalance: 120,
    vehicleBrandModel: "Hyundai Ioniq 5",
  },
  {
    id: "u3",
    name: "Sam Patel",
    email: "sam.p@email.com",
    phone: "+1 713-555-0199",
    joined: "2025-01-20",
    subscriptionId: null,
    walletBalance: 18.75,
    vehicleBrandModel: "Chevrolet Bolt EUV",
  },
  {
    id: "u4",
    name: "Taylor Kim",
    email: "t.kim@email.com",
    phone: "+1 512-555-0220",
    joined: "2025-03-05",
    subscriptionId: "sub3",
    walletBalance: 200,
    vehicleBrandModel: "Ford Mustang Mach-E",
  },
  {
    id: "u5",
    name: "Morgan Chen",
    email: "m.chen@email.com",
    phone: "+1 469-555-0301",
    joined: "2025-02-10",
    subscriptionId: "sub4",
    walletBalance: 64,
    vehicleBrandModel: "Nissan Leaf",
  },
  {
    id: "u6",
    name: "Riley Brooks",
    email: "riley.b@email.com",
    phone: "+1 512-555-0312",
    joined: "2023-11-02",
    subscriptionId: "sub5",
    walletBalance: 12.2,
    vehicleBrandModel: "Volkswagen ID.4",
  },
  {
    id: "u7",
    name: "Casey Nguyen",
    email: "casey.n@email.com",
    phone: "+1 281-555-0323",
    joined: "2024-04-18",
    subscriptionId: "sub6",
    walletBalance: 0,
    vehicleBrandModel: "Rivian R1T",
  },
  {
    id: "u8",
    name: "Jamie Foster",
    email: "jamie.foster@email.com",
    phone: "+1 915-555-0334",
    joined: "2025-04-01",
    subscriptionId: null,
    walletBalance: 250,
    vehicleBrandModel: "BMW i4",
  },
  {
    id: "u9",
    name: "Drew Martinez",
    email: "drew.m@email.com",
    phone: "+1 512-555-0345",
    joined: "2024-09-22",
    subscriptionId: "sub7",
    walletBalance: 88.9,
    vehicleBrandModel: "Kia EV6",
  },
  {
    id: "u10",
    name: "Quinn Washington",
    email: "quinn.w@email.com",
    phone: "+1 214-555-0356",
    joined: "2025-01-05",
    subscriptionId: "sub8",
    walletBalance: 35,
    vehicleBrandModel: "Mercedes-Benz EQB",
  },
];

export const subscriptions: Subscription[] = [
  {
    id: "sub1",
    userId: "u1",
    planTier: "Gold",
    started: "2024-07-01",
    renews: "2026-05-01",
    status: "active",
  },
  {
    id: "sub2",
    userId: "u2",
    planTier: "Diamond",
    started: "2024-09-15",
    renews: "2026-04-15",
    status: "active",
  },
  {
    id: "sub3",
    userId: "u4",
    planTier: "Silver",
    started: "2025-03-05",
    renews: "2026-03-05",
    status: "active",
  },
  {
    id: "sub4",
    userId: "u5",
    planTier: "Silver",
    started: "2026-04-01",
    renews: "2026-05-01",
    status: "pending",
  },
  {
    id: "sub5",
    userId: "u6",
    planTier: "Gold",
    started: "2023-11-02",
    renews: "2025-11-02",
    status: "expired",
  },
  {
    id: "sub6",
    userId: "u7",
    planTier: "Diamond",
    started: "2024-04-18",
    renews: "2025-04-18",
    status: "cancelled",
  },
  {
    id: "sub7",
    userId: "u9",
    planTier: "Gold",
    started: "2024-09-22",
    renews: "2026-09-22",
    status: "active",
  },
  {
    id: "sub8",
    userId: "u10",
    planTier: "Silver",
    started: "2025-01-05",
    renews: "2026-01-05",
    status: "active",
  },
];

export const sessions: ChargingSession[] = [
  {
    id: "sess1",
    userId: "u1",
    chargerId: "ch1",
    stationId: "s1",
    startedAt: "2026-04-05T08:12:00",
    endedAt: null,
    kwh: 14.2,
    costUsd: 4.8,
    status: "active",
  },
  {
    id: "sess2",
    userId: "u2",
    chargerId: "ch6",
    stationId: "s2",
    startedAt: "2026-04-05T07:45:00",
    endedAt: null,
    kwh: 22.1,
    costUsd: 6.2,
    status: "active",
  },
  {
    id: "sess3",
    userId: "u3",
    chargerId: "ch10",
    stationId: "s3",
    startedAt: "2026-04-04T18:30:00",
    endedAt: "2026-04-04T19:05:00",
    kwh: 18.4,
    costUsd: 5.1,
    status: "completed",
  },
  {
    id: "sess4",
    userId: "u1",
    chargerId: "ch2",
    stationId: "s1",
    startedAt: "2026-04-03T12:00:00",
    endedAt: "2026-04-03T12:48:00",
    kwh: 35.0,
    costUsd: 9.45,
    status: "completed",
  },
  {
    id: "sess5",
    userId: "u4",
    chargerId: "ch11",
    stationId: "s4",
    startedAt: "2026-04-02T09:10:00",
    endedAt: "2026-04-02T10:22:00",
    kwh: 48.2,
    costUsd: 12.9,
    status: "completed",
  },
  {
    id: "sess6",
    userId: "u3",
    chargerId: "ch8",
    stationId: "s3",
    startedAt: "2026-04-05T09:30:00",
    endedAt: "2026-04-05T10:02:00",
    kwh: 21.5,
    costUsd: 5.85,
    status: "completed",
  },
  {
    id: "sess7",
    userId: "u4",
    chargerId: "ch12",
    stationId: "s4",
    startedAt: "2026-04-04T11:15:00",
    endedAt: null,
    kwh: 8.1,
    costUsd: 2.4,
    status: "active",
  },
  {
    id: "sess8",
    userId: "u5",
    chargerId: "ch5",
    stationId: "s2",
    startedAt: "2026-04-05T11:00:00",
    endedAt: null,
    kwh: 0,
    costUsd: 0,
    status: "pending",
  },
  {
    id: "sess9",
    userId: "u2",
    chargerId: "ch9",
    stationId: "s3",
    startedAt: "2026-04-03T15:20:00",
    endedAt: "2026-04-03T15:22:00",
    kwh: 0,
    costUsd: 0,
    status: "cancelled",
  },
  {
    id: "sess10",
    userId: "u9",
    chargerId: "ch3",
    stationId: "s1",
    startedAt: "2026-04-01T10:00:00",
    endedAt: "2026-04-01T11:25:00",
    kwh: 27.3,
    costUsd: 7.64,
    status: "completed",
  },
  {
    id: "sess11",
    userId: "u10",
    chargerId: "ch11",
    stationId: "s4",
    startedAt: "2026-03-30T14:10:00",
    endedAt: "2026-03-30T15:02:00",
    kwh: 31.8,
    costUsd: 8.95,
    status: "completed",
  },
  {
    id: "sess12",
    userId: "u1",
    chargerId: "ch8",
    stationId: "s3",
    startedAt: "2026-03-29T09:00:00",
    endedAt: "2026-03-29T09:55:00",
    kwh: 42.1,
    costUsd: 11.2,
    status: "completed",
  },
  {
    id: "sess13",
    userId: "u6",
    chargerId: "ch2",
    stationId: "s1",
    startedAt: "2026-03-28T16:40:00",
    endedAt: "2026-03-28T17:35:00",
    kwh: 19.6,
    costUsd: 5.48,
    status: "completed",
  },
  {
    id: "sess14",
    userId: "u7",
    chargerId: "ch12",
    stationId: "s4",
    startedAt: "2026-04-04T08:00:00",
    endedAt: null,
    kwh: 0,
    costUsd: 0,
    status: "pending",
  },
  {
    id: "sess15",
    userId: "u4",
    chargerId: "ch5",
    stationId: "s2",
    startedAt: "2026-04-02T18:00:00",
    endedAt: "2026-04-02T18:50:00",
    kwh: 26.4,
    costUsd: 7.1,
    status: "completed",
  },
];

export const payments: Payment[] = [
  {
    id: "p1",
    userId: "u1",
    amountUsd: 9.45,
    type: "charging",
    status: "completed",
    at: "2026-04-03T12:48:00",
    ref: "PAY-CHG-1001",
    method: "wallet",
  },
  {
    id: "p2",
    userId: "u2",
    amountUsd: 39.99,
    type: "subscription",
    status: "completed",
    at: "2026-04-01T00:05:00",
    ref: "PAY-SUB-8842",
    method: "credit_card",
  },
  {
    id: "p3",
    userId: "u3",
    amountUsd: 50,
    type: "wallet_topup",
    status: "completed",
    at: "2026-03-28T14:20:00",
    ref: "PAY-WAL-2201",
    method: "apple_pay",
  },
  {
    id: "p4",
    userId: "u4",
    amountUsd: 12.9,
    type: "charging",
    status: "completed",
    at: "2026-04-02T10:22:00",
    ref: "PAY-CHG-1002",
    method: "credit_card",
  },
  {
    id: "p5",
    userId: "u1",
    amountUsd: 19.99,
    type: "subscription",
    status: "completed",
    at: "2026-03-15T00:00:00",
    ref: "PAY-SUB-7701",
    method: "apple_pay",
  },
  {
    id: "p6",
    userId: "u2",
    amountUsd: 6.2,
    type: "charging",
    status: "pending",
    at: "2026-04-05T07:45:00",
    ref: "PAY-CHG-1003",
    method: "wallet",
  },
  {
    id: "p7",
    userId: "u5",
    amountUsd: 24.5,
    type: "charging",
    status: "completed",
    at: "2026-04-04T16:10:00",
    ref: "PAY-CHG-1004",
    method: "apple_pay",
  },
  {
    id: "p8",
    userId: "u9",
    amountUsd: 39.99,
    type: "subscription",
    status: "failed",
    at: "2026-03-22T09:00:00",
    ref: "PAY-SUB-9011",
    method: "credit_card",
  },
  {
    id: "p9",
    userId: "u10",
    amountUsd: 100,
    type: "wallet_topup",
    status: "completed",
    at: "2026-03-20T11:30:00",
    ref: "PAY-WAL-3302",
    method: "credit_card",
  },
  {
    id: "p10",
    userId: "u6",
    amountUsd: 15.75,
    type: "charging",
    status: "completed",
    at: "2026-03-10T08:45:00",
    ref: "PAY-CHG-0998",
    method: "wallet",
  },
  {
    id: "p11",
    userId: "u7",
    amountUsd: 19.99,
    type: "subscription",
    status: "pending",
    at: "2026-03-18T00:00:00",
    ref: "PAY-SUB-7720",
    method: "apple_pay",
  },
  {
    id: "p12",
    userId: "u4",
    amountUsd: 75,
    type: "wallet_topup",
    status: "completed",
    at: "2026-02-28T13:15:00",
    ref: "PAY-WAL-3290",
    method: "apple_pay",
  },
  {
    id: "p13",
    userId: "u8",
    amountUsd: 8.2,
    type: "charging",
    status: "completed",
    at: "2026-02-14T19:20:00",
    ref: "PAY-CHG-0950",
    method: "credit_card",
  },
  {
    id: "p14",
    userId: "u3",
    amountUsd: 19.99,
    type: "subscription",
    status: "completed",
    at: "2026-02-01T00:05:00",
    ref: "PAY-SUB-6601",
    method: "wallet",
  },
  {
    id: "p15",
    userId: "u1",
    amountUsd: 42.3,
    type: "charging",
    status: "completed",
    at: "2026-01-25T14:00:00",
    ref: "PAY-CHG-0888",
    method: "credit_card",
  },
  {
    id: "p16",
    userId: "u5",
    amountUsd: 25,
    type: "wallet_topup",
    status: "failed",
    at: "2026-01-12T10:00:00",
    ref: "PAY-WAL-3100",
    method: "credit_card",
  },
  {
    id: "p17",
    userId: "u2",
    amountUsd: 11.1,
    type: "charging",
    status: "completed",
    at: "2026-01-08T07:30:00",
    ref: "PAY-CHG-0850",
    method: "apple_pay",
  },
  {
    id: "p18",
    userId: "u10",
    amountUsd: 39.99,
    type: "subscription",
    status: "completed",
    at: "2025-12-20T00:00:00",
    ref: "PAY-SUB-5501",
    method: "credit_card",
  },
  {
    id: "p19",
    userId: "u6",
    amountUsd: 60,
    type: "wallet_topup",
    status: "completed",
    at: "2025-12-05T16:40:00",
    ref: "PAY-WAL-3001",
    method: "apple_pay",
  },
  {
    id: "p20",
    userId: "u9",
    amountUsd: 33.4,
    type: "charging",
    status: "completed",
    at: "2025-11-18T12:15:00",
    ref: "PAY-CHG-0720",
    method: "wallet",
  },
  {
    id: "p21",
    userId: "u4",
    amountUsd: 19.99,
    type: "subscription",
    status: "completed",
    at: "2025-11-05T00:00:00",
    ref: "PAY-SUB-4402",
    method: "credit_card",
  },
  {
    id: "p22",
    userId: "u7",
    amountUsd: 18.6,
    type: "charging",
    status: "pending",
    at: "2026-04-05T14:22:00",
    ref: "PAY-CHG-1005",
    method: "wallet",
  },
];

export const maintenanceLogs: MaintenanceLog[] = [
  {
    id: "m1",
    maintenanceCode: "MNT-2026-0142",
    chargerId: "ch4",
    stationId: "s1",
    technician: "R. Santos",
    issueReported: "Cooling fan replacement required; unit derating",
    issueType: "Cooling",
    status: "open",
    reportedAt: "2026-04-01T11:00:00",
    resolvedAt: null,
  },
  {
    id: "m2",
    maintenanceCode: "MNT-2026-0118",
    chargerId: "ch7",
    stationId: "s2",
    technician: "M. Chen",
    issueReported: "Network module firmware update and connectivity test",
    issueType: "Network",
    status: "resolved",
    reportedAt: "2026-03-22T09:30:00",
    resolvedAt: "2026-03-24T15:00:00",
  },
  {
    id: "m3",
    maintenanceCode: "MNT-2026-0155",
    chargerId: "ch10",
    stationId: "s3",
    technician: "A. Okonkwo",
    issueReported: "CHAdeMO connector latch sticking; customer unable to plug in",
    issueType: "Connector",
    status: "in_progress",
    reportedAt: "2026-04-02T08:15:00",
    resolvedAt: null,
  },
  {
    id: "m4",
    maintenanceCode: "MNT-2026-0099",
    chargerId: "ch2",
    stationId: "s1",
    technician: "R. Santos",
    issueReported: "OCPP handshake failures after backend deploy",
    issueType: "Software",
    status: "resolved",
    reportedAt: "2026-03-10T14:20:00",
    resolvedAt: "2026-03-11T16:45:00",
  },
  {
    id: "m5",
    maintenanceCode: "MNT-2026-0130",
    chargerId: "ch11",
    stationId: "s4",
    technician: "L. Patel",
    issueReported: "Screen flicker on payment terminal",
    issueType: "Display",
    status: "open",
    reportedAt: "2026-03-28T10:00:00",
    resolvedAt: null,
  },
  {
    id: "m6",
    maintenanceCode: "MNT-2026-0124",
    chargerId: "ch5",
    stationId: "s2",
    technician: "M. Chen",
    issueReported: "High ambient temperature warning; verify cooling ducts",
    issueType: "Cooling",
    status: "resolved",
    reportedAt: "2026-03-25T09:00:00",
    resolvedAt: "2026-03-27T11:30:00",
  },
  {
    id: "m7",
    maintenanceCode: "MNT-2026-0105",
    chargerId: "ch8",
    stationId: "s3",
    technician: "A. Okonkwo",
    issueReported: "Intermittent VLAN drop on port 3",
    issueType: "Network",
    status: "resolved",
    reportedAt: "2026-03-05T13:10:00",
    resolvedAt: "2026-03-06T17:00:00",
  },
  {
    id: "m8",
    maintenanceCode: "MNT-2026-0160",
    chargerId: "ch3",
    stationId: "s1",
    technician: "L. Patel",
    issueReported: "CCS cable wear at strain relief",
    issueType: "Connector",
    status: "in_progress",
    reportedAt: "2026-04-04T07:45:00",
    resolvedAt: null,
  },
  {
    id: "m9",
    maintenanceCode: "MNT-2026-0088",
    chargerId: "ch12",
    stationId: "s4",
    technician: "R. Santos",
    issueReported: "DC contactor chatter under load",
    issueType: "Power supply",
    status: "resolved",
    reportedAt: "2026-02-18T11:00:00",
    resolvedAt: "2026-02-20T09:15:00",
  },
  {
    id: "m10",
    maintenanceCode: "MNT-2026-0077",
    chargerId: "ch9",
    stationId: "s3",
    technician: "M. Chen",
    issueReported: "Billing sync stuck; manual reconciliation",
    issueType: "Software",
    status: "resolved",
    reportedAt: "2026-02-01T15:30:00",
    resolvedAt: "2026-02-02T10:00:00",
  },
  {
    id: "m11",
    maintenanceCode: "MNT-2026-0163",
    chargerId: "ch6",
    stationId: "s2",
    technician: "A. Okonkwo",
    issueReported: "Liquid detection sensor false positive",
    issueType: "Cooling",
    status: "open",
    reportedAt: "2026-04-05T06:20:00",
    resolvedAt: null,
  },
  {
    id: "m12",
    maintenanceCode: "MNT-2026-0148",
    chargerId: "ch1",
    stationId: "s1",
    technician: "L. Patel",
    issueReported: "RFID reader not detecting member cards",
    issueType: "Network",
    status: "in_progress",
    reportedAt: "2026-04-03T12:00:00",
    resolvedAt: null,
  },
];

/** Revenue by day (sample) for charts */
export const revenueByDay = [
  { day: "Mar 30", revenue: 420 },
  { day: "Mar 31", revenue: 512 },
  { day: "Apr 1", revenue: 890 },
  { day: "Apr 2", revenue: 640 },
  { day: "Apr 3", revenue: 720 },
  { day: "Apr 4", revenue: 580 },
  { day: "Apr 5", revenue: 310 },
];

export const sessionsByDay = [
  { day: "Mar 30", sessions: 42 },
  { day: "Mar 31", sessions: 51 },
  { day: "Apr 1", sessions: 68 },
  { day: "Apr 2", sessions: 55 },
  { day: "Apr 3", sessions: 61 },
  { day: "Apr 4", sessions: 48 },
  { day: "Apr 5", sessions: 29 },
];

export function companyName(id: string) {
  return companies.find((c) => c.id === id)?.name ?? id;
}

export function stationName(id: string) {
  return stations.find((s) => s.id === id)?.name ?? id;
}

export function userName(id: string) {
  return users.find((u) => u.id === id)?.name ?? id;
}

export function subscriptionForUser(userId: string): Subscription | undefined {
  return subscriptions.find((s) => s.userId === userId);
}
