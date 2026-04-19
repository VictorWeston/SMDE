import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import pool from "./connection";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function migrate() {
  // Ensure migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      file_name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Get already-applied migrations
  const { rows: applied } = await pool.query(
    "SELECT file_name FROM schema_migrations ORDER BY file_name"
  );
  const appliedSet = new Set(applied.map((r) => r.file_name));

  // Read and sort migration files
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip: ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`  apply: ${file}`);

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(
        "INSERT INTO schema_migrations (file_name) VALUES ($1)",
        [file]
      );
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      console.error(`  FAILED: ${file}`, err);
      throw err;
    }
  }

  console.log("Migrations complete.");
}

// Run directly: npx ts-node src/db/migrate.ts
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export default migrate;
