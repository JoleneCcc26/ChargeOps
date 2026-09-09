// api/index.js — Vercel Serverless Function entry point.
//
// Vercel automatically turns files in /api into serverless functions.
// We export the Express app as the handler, so every /api/* request on the
// deployed site flows through the same Express router stack used locally.
//
// The DB pool inside server/db.js is module-scoped, so Vercel's runtime
// reuses it across warm invocations on the same instance.
import { app } from "../server/app.js";

export default app;
