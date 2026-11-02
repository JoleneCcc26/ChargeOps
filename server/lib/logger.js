// server/lib/logger.js - one JSON object per line on stdout/stderr.
//
// On GKE the logging agent reads each container's output, and a line that is a
// JSON object becomes a structured entry: `severity` sets the log level,
// `message` becomes the summary, and `httpRequest` fills Cloud Logging's own
// request fields. The 5xx log-based metric filters on httpRequest.status, so
// every API response is logged through httpLogger() below.
//
// JSON is on in production (NODE_ENV=production, which the runtime image sets)
// or with LOG_FORMAT=json. Local development keeps readable text.
import { format } from "node:util";

export const jsonLogs =
  process.env.LOG_FORMAT === "json" ||
  (process.env.LOG_FORMAT !== "text" && process.env.NODE_ENV === "production");

const service = process.env.LOG_SERVICE || "chargeops-api";

function errorFields(err) {
  if (!(err instanceof Error)) return undefined;
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

export function log(severity, message, fields = {}) {
  if (!jsonLogs) {
    const extra = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
    const out = severity === "ERROR" || severity === "WARNING" ? process.stderr : process.stdout;
    out.write(`${severity.padEnd(7)} ${message}${extra}\n`);
    return;
  }
  const entry = {
    severity,
    message,
    time: new Date().toISOString(),
    serviceContext: { service },
    ...fields,
  };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ severity, message, time: entry.time, serviceContext: { service } });
  }
  (severity === "ERROR" || severity === "WARNING" ? process.stderr : process.stdout).write(line + "\n");
}

export const logger = {
  debug: (msg, fields) => log("DEBUG", msg, fields),
  info:  (msg, fields) => log("INFO", msg, fields),
  warn:  (msg, fields) => log("WARNING", msg, fields),
  error: (msg, fields) => log("ERROR", msg, fields),
};

// Existing console.* calls across the server and workers become JSON entries
// too, so nothing reaches Cloud Logging as unstructured text. An Error's stack
// stays in `message`, which is where Error Reporting looks for it.
export function installJsonConsole() {
  if (!jsonLogs || console.__jsonLogs) return;
  const wrap = (severity) => (...args) => {
    const err = args.find((a) => a instanceof Error);
    const message = format(...args.map((a) => (a instanceof Error ? a.stack : a))).trim();
    log(severity, message, err ? { error: errorFields(err) } : {});
  };
  console.log = wrap("INFO");
  console.info = wrap("INFO");
  console.debug = wrap("DEBUG");
  console.warn = wrap("WARNING");
  console.error = wrap("ERROR");
  console.__jsonLogs = true;
}

// Health probes hit the API every few seconds per pod; logging each success
// would bury everything else. A failed probe is still logged.
const QUIET_PATHS = new Set(["/api/health", "/api/health/live"]);

export function httpLogger() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      // Path only: a query string can carry a signed download token.
      const path = (req.originalUrl || req.url).split("?")[0];
      const status = res.statusCode;
      if (status < 400 && QUIET_PATHS.has(path)) return;
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const severity = status >= 500 ? "ERROR" : status >= 400 ? "WARNING" : "INFO";
      log(severity, `${req.method} ${path} ${status}`, {
        logType: "http_request",
        httpRequest: {
          requestMethod: req.method,
          requestUrl: path,
          status,
          responseSize: String(res.getHeader("content-length") ?? 0),
          userAgent: req.get("user-agent"),
          remoteIp: req.ip,
          latency: `${seconds.toFixed(3)}s`,
        },
        ...(res.locals.error ? { error: res.locals.error } : {}),
      });
    });
    next();
  };
}

export { errorFields };
