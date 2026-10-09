// server/boot.js - run before anything else, with `node --import ./server/boot.js`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PRELOAD AND NOT JUST AN IMPORT
// ─────────────────────────────────────────────────────────────────────────────
// Secrets have to be in process.env before any module reads them, and several
// modules read them while they are being evaluated: the storage adapter builds
// its signing key, auth.js builds its token key, the scripts build a database
// config. The obvious fix - a top-level await inside env.js - does not work.
// In ES modules a top-level await only suspends the module that imported it;
// its siblings keep evaluating. So storage.js was reading STORAGE_SIGNING_SECRET
// while the Secret Manager call was still in flight, and in production, where
// there is no fallback, the container crashed on startup.
//
// A preload module runs to completion - await included - before the entry point
// is loaded at all, which is the ordering guarantee we actually need. Child
// processes inherit execArgv, so the workers the supervisor forks get it too.
import "./env.js";
import { loadSecrets } from "./secrets.js";

const result = await loadSecrets();
if (result.provider === "gcp") {
  // Names only. The values are what we are trying to keep out of logs.
  console.log(`[boot] loaded ${result.secrets.length} secret(s) from Secret Manager: ${result.secrets.join(", ")}`);
}
