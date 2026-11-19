import { testDatabaseUrl } from "./db";

/**
 * Runs before the suite loads (bun test --preload): points DATABASE_URL at
 * the test database before any module reads it, so code paths that use the
 * shared `db` instance (route handlers, Better Auth) operate on the test
 * database as well.
 */
process.env.DATABASE_URL = testDatabaseUrl;
