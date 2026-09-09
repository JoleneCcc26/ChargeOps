// src/api/client.ts — base fetch wrapper
//
// VITE_API_URL can be either:
//   - a relative path like "/api"  (dev, via Vite proxy) — resolved against window.location.origin
//   - a full URL like "http://localhost:4000/api" (prod, or no proxy)
const BASE = import.meta.env.VITE_API_URL ?? "/api";
const TOKEN_KEY = "chargeops.auth.token";

export function setApiToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getApiToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(headers: Record<string, string> = {}) {
  const token = getApiToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

function buildUrl(path: string): URL {
  const full = `${BASE}${path}`;
  // If BASE is absolute (starts with http:// or https://) `new URL(full)` works.
  // Otherwise we resolve against the page origin so relative bases like "/api" are valid.
  return /^https?:\/\//i.test(full)
    ? new URL(full)
    : new URL(full, window.location.origin);
}

export async function apiFetch<T>(
  path: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = buildUrl(path);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    });
  }
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface ApiPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /**
   * Optional server-computed breakdown over the WHOLE filtered set, not just
   * this page. Summary tiles must use this rather than counting `items`, which
   * only ever holds one page.
   */
  statusCounts?: Record<string, number>;
}

export async function apiFetchPage<T>(
  path: string,
  params: Record<string, string | number | undefined>
): Promise<ApiPage<T>> {
  const url = buildUrl(path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const items = (await res.json()) as T[];
  return {
    items,
    total: Number(res.headers.get("X-Total-Count")) || items.length,
    page: Number(res.headers.get("X-Page")) || 1,
    pageSize: Number(res.headers.get("X-Page-Size")) || items.length,
    totalPages: Number(res.headers.get("X-Total-Pages")) || (items.length ? 1 : 0),
    statusCounts: parseStatusCounts(res.headers.get("X-Status-Counts")),
  };
}

function parseStatusCounts(header: string | null): Record<string, number> | undefined {
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, Number(v) || 0])
    );
  } catch {
    return undefined;
  }
}

/** POST with a JSON body. Used by the ops controls (redrive, purge) and /stop. */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(path).toString(), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(buildUrl(path).toString(), {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Multipart upload.
 *
 * No Content-Type header is set on purpose: the browser has to generate it
 * itself so it can append the multipart boundary token. Setting it by hand is
 * the classic way to make a working upload endpoint start returning 400.
 */
export async function apiUpload<T>(
  path: string,
  files: File[],
  fields: Record<string, string | number | null | undefined> = {}
): Promise<T> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined && v !== "") form.append(k, String(v));
  }

  const res = await fetch(buildUrl(path).toString(), { method: "POST", headers: authHeaders(), body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Resolve a server-issued signed URL (which is relative, e.g. "/api/files/...")
 * against whatever base the app is talking to. Needed because in production
 * VITE_API_URL may be an absolute URL on another host.
 */
export function resolveFileUrl(signedPath: string): string {
  if (/^https?:\/\//i.test(signedPath)) return signedPath;
  // Signed URLs already start with /api, and BASE is usually "/api" too, so
  // strip the duplicate prefix before joining.
  const withoutApi = signedPath.replace(/^\/api/, "");
  return buildUrl(withoutApi).toString();
}
