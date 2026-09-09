// server/db.js — MySQL connection pool
//
// ./env.js must be imported before anything reads process.env — it resolves
// server/.env relative to the source file rather than the working directory.
// See the comment block in that file for why a bare dotenv.config() is a trap
// in this repo.
import "./env.js";
import mysql from "mysql2/promise";

// SSL is required by most managed cloud MySQL providers (Aiven, PlanetScale,
// AWS RDS in strict mode, etc.) but should stay OFF for a local dev MySQL.
// Opt in by setting DB_SSL=true in Vercel (or any production env).
//
// We use { rejectUnauthorized: false } to avoid having to bundle the provider's
// CA certificate — the connection is still encrypted (TLS), we just don't
// verify the server's cert chain. For a student/demo project this is fine; if
// you want stricter verification, download the provider's ca.pem and load it
// via `ca: fs.readFileSync('./ca.pem')` instead.
const sslEnabled = process.env.DB_SSL === "true";

export const dbConfig = {
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASS     || "",
  database: process.env.DB_NAME     || "ev",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ...(sslEnabled && { ssl: { rejectUnauthorized: false } }),
};

export const pool = mysql.createPool(dbConfig);

/**
 * Quick smoke-test that the pool can talk to MySQL and the target DB exists.
 * Run at server boot so credential / db-name mistakes fail loudly instead of
 * silently breaking every API call.
 */
export async function pingDatabase() {
  const conn = await pool.getConnection();
  try {
    await conn.query("SELECT 1");
    const [[row]] = await conn.query("SELECT DATABASE() AS db");
    return row.db;
  } finally {
    conn.release();
  }
}
