import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

if (!process.env.DATABASE_URL!) {
  throw new Error("DATABASE_URL is not defined");
}

const client = new SQL(process.env.DATABASE_URL!, {
  max: 20,
});
const db = drizzle({
  client,
  connection: {
    max: 20,
  },
});

async function testConnection() {
  await db.execute("SELECT 1");
}

async function closeConnection() {
  await client.end();
}

type DBExecutor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type { DBExecutor };
export { db, closeConnection, testConnection };
