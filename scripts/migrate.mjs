// scripts/migrate.mjs - apply the SQL files in migrations/ in order, once each.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// Until Milestone 3 the schema was created by setup-db.mjs, which also seeds
// data, geocodes stations and reshapes history: perfect for standing up a demo
// laptop, useless for a managed database that already holds real rows.
//
// A migration runner answers a different question: "which structural changes
// has THIS database already had?" Each file runs at most once, its name is
// recorded in schema_migrations, and the whole thing is safe to run again on
// every deploy. That is also what makes the move to Cloud SQL auditable - the
// tables over there were created by a file in the repository, not by hand.
//
// Usage:
//   node scripts/migrate.mjs                 apply anything not yet applied
//   node scripts/migrate.mjs --status        list applied / pending, change nothing
//   node scripts/migrate.mjs --until 0001    stop after the first file whose name
//                                            starts with 0001
//
// --until exists for one real situation: moving data into a fresh database. The
// triggers in 0002 fire on INSERT, so loading a dump of historic payments with
// them already in place would credit every wallet a second time. Create the
// tables, load the rows, then add the triggers.
import "../server/env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const STATUS_ONLY = process.argv.includes("--status");
const untilIndex = process.argv.indexOf("--until");
const UNTIL = untilIndex !== -1 ? process.argv[untilIndex + 1] : null;

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "ev",
  multipleStatements: false,
  ...(process.env.DB_SSL === "true" && { ssl: { rejectUnauthorized: false } }),
};

/** Split a script into statements, honouring `DELIMITER $$` blocks. */
function splitStatements(sql) {
  const out = [];
  let delimiter = ";";
  let buffer = "";

  const flush = () => {
    if (!buffer.trim()) return;
    const parts =
      delimiter === ";" ? buffer.split(/;\s*(?:\r?\n|$)/) : buffer.split(delimiter);
    for (const part of parts) {
      const body = stripLeadingComments(part);
      if (body) out.push(body);
    }
    buffer = "";
  };

  for (const line of sql.split(/\r?\n/)) {
    const m = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (m) {
      flush();
      delimiter = m[1];
      continue;
    }
    buffer += line + "\n";
  }
  flush();
  return out;
}

function stripLeadingComments(stmt) {
  let s = stmt;
  let m;
  while ((m = s.match(/^[ \t]*(?:--[^\n]*|#[^\n]*|\/\*![^\n]*)?(?:\r?\n)/)) !== null) {
    s = s.slice(m[0].length);
  }
  return s.trim();
}

async function main() {
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.error(`no .sql files in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const conn = await mysql.createConnection(config);
  console.log(`database ${config.user}@${config.host}:${config.port}/${config.database}\n`);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      Filename   VARCHAR(255) PRIMARY KEY,
      Applied_At DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Statements INT          NOT NULL
    )
  `);

  const [rows] = await conn.query("SELECT Filename FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.Filename));

  let stopAfterThisOne = false;
  for (const file of files) {
    if (stopAfterThisOne) {
      console.log(`  . ${file} (held back by --until ${UNTIL})`);
      continue;
    }
    if (UNTIL && file.startsWith(UNTIL)) stopAfterThisOne = true;
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }
    if (STATUS_ONLY) {
      console.log(`  + ${file} (pending)`);
      continue;
    }

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const statements = splitStatements(sql);
    process.stdout.write(`  + ${file}: ${statements.length} statement(s) ... `);
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
      } catch (err) {
        console.log("failed");
        console.error(`\n✖ ${file}: ${err.code} ${err.sqlMessage ?? err.message}`);
        console.error(`  statement: ${stmt.slice(0, 200)}...\n`);
        await conn.end();
        process.exit(1);
      }
    }
    await conn.query("INSERT INTO schema_migrations (Filename, Statements) VALUES (?, ?)", [
      file,
      statements.length,
    ]);
    console.log("applied");
  }

  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM schema_migrations");
  const [tables] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?",
    [config.database]
  );
  console.log(`\n${n} migration(s) recorded, ${tables[0].n} table(s) in ${config.database}`);
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
