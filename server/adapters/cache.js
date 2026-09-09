// server/adapters/cache.js - cache adapter (local: in-process map, cloud: ElastiCache/Redis)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A CACHE BUYS YOU, AND WHAT IT COSTS
// ─────────────────────────────────────────────────────────────────────────────
// The dashboard KPI query joins five tables and aggregates the whole payment
// table. It takes ~40 ms. That is fine for one operations manager hitting F5.
// It is NOT fine when the public "find an available charger near me" endpoint
// is called by every driver in Houston at 18:00 - that is the same query,
// thousands of times a second, returning a value that barely changes.
//
// A cache turns "N identical expensive queries per second" into "one expensive
// query per TTL". The cost is staleness: for up to TTL seconds you are showing
// data that is slightly out of date. So the engineering question is never
// "should I cache?" but "how stale is this particular number allowed to be?":
//
//     charger availability  -> 10s   (drivers need near-live data)
//     dashboard KPI tiles   -> 30s   (nobody minds a half-minute-old count)
//     revenue by month      -> 300s  (historical, changes once a day)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE FILE
// ─────────────────────────────────────────────────────────────────────────────
// Same reason as queue.js and storage.js: the routes call `cached(key, ttl, fn)`
// and never learn where the value is stored. Locally that is a Map inside the
// Node process. In the cloud it becomes Redis on ElastiCache, and the swap is
// contained here.
//
// The distinction matters more than it looks: an in-process cache is per-server,
// so with three app servers you get three copies and three times the misses,
// and you cannot invalidate a key across all of them. That is exactly the
// limitation that forces a shared cache once you scale past one instance -
// a good thing to be able to explain when asked "why Redis and not a Map?".

/** key -> { value, expiresAt } */
const store = new Map();

const stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };

/** Stop the map growing without bound if key cardinality ever gets large. */
const MAX_ENTRIES = 1000;

/** Read a key. Returns undefined on miss or expiry. Mirrors Redis GET. */
export function get(key) {
  const entry = store.get(key);
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    stats.misses++;
    stats.evictions++;
    return undefined;
  }
  stats.hits++;
  return entry.value;
}

/** Write a key with a TTL in seconds. Mirrors Redis SETEX. */
export function set(key, value, ttlSeconds = 30) {
  if (store.size >= MAX_ENTRIES) {
    // Cheapest possible eviction: drop the oldest inserted key. Redis would
    // use a proper LRU/LFU policy here.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
      stats.evictions++;
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  stats.sets++;
}

/**
 * Read-through cache helper - the only function routes actually use.
 *
 *   const kpis = await cached("dashboard:kpis", 30, () => expensiveQuery());
 *
 * On a hit it returns instantly and the database is never touched. On a miss it
 * runs `producer`, stores the result, and returns it.
 */
export async function cached(key, ttlSeconds, producer) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const value = await producer();
  set(key, value, ttlSeconds);
  return value;
}

/**
 * Invalidate by exact key or prefix. Mirrors Redis DEL / SCAN+DEL.
 *
 * Called after a write that makes cached values wrong - e.g. the telemetry
 * worker changes a charger's status, so "chargers:availability" must go.
 */
export function invalidate(keyOrPrefix) {
  let removed = 0;
  for (const k of store.keys()) {
    if (k === keyOrPrefix || k.startsWith(keyOrPrefix)) {
      store.delete(k);
      removed++;
    }
  }
  return removed;
}

export function clear() {
  store.clear();
}

/** Hit rate for the ops dashboard. A healthy read-heavy endpoint sits >80%. */
export function cacheStats() {
  const total = stats.hits + stats.misses;
  return {
    backend: "in-process-map",
    entries: store.size,
    hits: stats.hits,
    misses: stats.misses,
    sets: stats.sets,
    evictions: stats.evictions,
    hitRate: total === 0 ? 0 : Number(((stats.hits / total) * 100).toFixed(1)),
  };
}

export function resetStats() {
  stats.hits = 0;
  stats.misses = 0;
  stats.sets = 0;
  stats.evictions = 0;
}
