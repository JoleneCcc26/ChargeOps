const buckets = new Map();

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  next();
}

export function corsOptions() {
  const configured = String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set(
    configured.length > 0
      ? configured
      : ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174"]
  );

  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) return callback(null, true);
      callback(new Error("origin not allowed by CORS policy"));
    },
    exposedHeaders: ["X-Total-Count", "X-Page", "X-Page-Size", "X-Total-Pages"],
  };
}

export function rateLimit({ windowMs = 60_000, max = 600, namespace = "api" } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${namespace}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      // Say how long, and say it in seconds a person can act on.
      //
      // "too many requests" is the protocol's phrasing, not an explanation. On
      // the sign-in screen it read as a dead end — nothing told the user the
      // wait was under a minute, so it looked like the credentials or the
      // server were broken. An error should say what went wrong AND what to do.
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: `too many attempts — try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}`,
        code: "RATE_LIMITED",
        retryAfterSeconds: retryAfter,
      });
    }

    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(candidate);
      }
    }
    next();
  };
}

