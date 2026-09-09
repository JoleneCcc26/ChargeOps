// server/index.js — Local dev entry point.
// Starts the Express app on a real port so Vite can proxy /api to it.
// Vercel does NOT run this file — it uses api/index.js instead.
import { app } from "./app.js";
import { dbConfig, pingDatabase } from "./db.js";

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    const db = await pingDatabase();
    console.log(`[server] connected to MySQL database "${db}" @ ${dbConfig.host}:${dbConfig.port}`);
  } catch (err) {
    console.error("\n[server] ❌ Could not connect to MySQL.");
    console.error(`         host=${dbConfig.host} port=${dbConfig.port} user=${dbConfig.user} database=${dbConfig.database}`);
    console.error(`         ${err.code ?? ""} ${err.message}`);
    console.error("         → Check server/.env (DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME)");
    console.error("         → Make sure MySQL is running and the `ev` database exists.\n");
    // Don't exit — the /api/health endpoint still reports the problem to the UI.
  }

  app.listen(PORT, () =>
    console.log(`[server] running on http://localhost:${PORT}`)
  );
})();
