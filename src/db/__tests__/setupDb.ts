import { spawnSync } from "node:child_process";
import {
  closeTestDb,
  ensureTestDatabase,
  testDatabaseName,
  testDatabaseUrl,
  truncateAllTables,
} from "./helpers/db";

/**
 * Prepares the test database for the suite: creates it if missing, applies
 * all pending migrations through drizzle-kit, and truncates every
 * application table so the suite starts clean. Idempotent — the `test`
 * script runs this before `bun test`.
 */

function migrateTestDatabase() {
  const result = spawnSync("bunx", ["--bun", "drizzle-kit", "migrate"], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(
      `drizzle-kit migrate failed with exit code ${result.status}`,
    );
  }
}

async function main() {
  await ensureTestDatabase();
  migrateTestDatabase();
  await truncateAllTables();
  await closeTestDb();
  console.log(`test database "${testDatabaseName}" is ready`);
}

await main();
