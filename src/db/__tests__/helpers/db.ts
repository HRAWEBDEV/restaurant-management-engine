import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

/**
 * DB test harness.
 *
 * DB-backed tests never run against the development database: a dedicated
 * test database (development database name + `_test`) is created and
 * migrated by `setupDb.ts`, and tables are truncated to reset state between
 * tests. The SQL client connects lazily, so importing this module from
 * tests that never query is harmless.
 */

function requireDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("DATABASE_URL is not defined");
  }
  return new URL(raw);
}

const databaseUrl = requireDatabaseUrl();

const databaseName = databaseUrl.pathname.replace(/^\/+/, "");
if (databaseName.length === 0) {
  throw new Error("DATABASE_URL must include a database name");
}

const testDatabaseName = `${databaseName}_test`;

const testDatabaseUrl = new URL(databaseUrl.toString());
testDatabaseUrl.pathname = `/${testDatabaseName}`;

const testUrl = testDatabaseUrl.toString();
const client = new SQL(testUrl, { max: 5 });
const testDb = drizzle({ client, connection: { max: 5 } });

/** Creates the test database if it does not exist yet. */
async function ensureTestDatabase() {
  const adminUrl = new URL(databaseUrl.toString());
  adminUrl.pathname = "/postgres";

  const admin = new SQL(adminUrl.toString(), { max: 1 });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}`;
    if (existing.length === 0) {
      const name = testDatabaseName.replaceAll('"', '""');
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Truncates every application table in the test database (the drizzle
 * migrations bookkeeping is left alone). Used to reset state between tests.
 */
async function truncateAllTables() {
  const rows: { tablename: string }[] =
    await client`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'drizzle%'`;
  const tables = rows.map((row) => row.tablename);
  if (tables.length === 0) {
    return;
  }

  const list = tables
    .map((name) => `"${name.replaceAll('"', '""')}"`)
    .join(", ");
  await client.unsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

/** Closes the harness connection; call from afterAll. */
async function closeTestDb() {
  await client.end();
}

export type TestDb = typeof testDb;
export {
  closeTestDb,
  ensureTestDatabase,
  testDatabaseName,
  testDb,
  testUrl as testDatabaseUrl,
  truncateAllTables,
};
