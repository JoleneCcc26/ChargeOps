// server/env.js — load environment variables the same way from every entry point
//
// Import this once, first, from anything that boots server code: the API
// (server/index.js, api/index.js), the workers, and the scripts.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// A bare `dotenv.config()` resolves ".env" against **process.cwd()** — the
// directory you happened to run `node` from, not the directory the code lives
// in. This project has two .env files:
//
//     .env          frontend  (VITE_API_URL)
//     server/.env   backend   (DB_PASS, storage settings, ...)
//
// so `dotenv.config()` from the repo root silently loads the FRONTEND file,
// finds no DB_PASS, and every connection falls back to an empty password. The
// failure mode is a MySQL error reading "using password: NO" even though the
// password is sitting right there in server/.env — which is a genuinely
// confusing half-hour for whoever hits it.
//
// Resolving the path relative to THIS MODULE instead makes it independent of
// where the process was started from. Same reason you use `__dirname` rather
// than a relative path anywhere else.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Order matters: dotenv does NOT overwrite a variable that is already set, so
// the first file to define a key wins. server/.env is the backend's own file,
// so it goes first; the root .env is a fallback for anyone who put everything
// in one place, and real process env (Vercel, ECS, GitHub Actions) beats both.
dotenv.config({ path: path.join(ROOT, "server", ".env") });
dotenv.config({ path: path.join(ROOT, ".env") });

export const ENV_LOADED_FROM = path.join(ROOT, "server", ".env");
