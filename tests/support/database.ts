import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const PostgresqlPool = createRequire(new URL("../../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  connectionString: string;
  max: number;
}) => { query(text: string): Promise<unknown>; end(): Promise<void> };

import { migrateDatabase } from "../../packages/store/src/index.js";

export async function migrateSqlite(databasePath: string): Promise<void> {
  await migrateDatabase({ url: `file:${databasePath}` });
}

/** Controller sweeps must not consume work created by other parallel suites. */
export async function createIsolatedPostgresDatabase(baseUrl: string): Promise<{
  readonly url: string;
  readonly cleanup: () => Promise<void>;
}> {
  const name = `supertag_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new PostgresqlPool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const isolated = new URL(baseUrl);
  isolated.pathname = `/${name}`;
  return {
    url: isolated.toString(),
    async cleanup() {
      const connection = new PostgresqlPool({ connectionString: baseUrl, max: 1 });
      try {
        await connection.query(`DROP DATABASE "${name}"`);
      } finally {
        await connection.end();
      }
    },
  };
}
