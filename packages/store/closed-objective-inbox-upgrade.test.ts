import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { migrate as migratePostgresql } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.ts";
import {
  migratePostgresqlDatabase,
  migrateSqliteDatabase,
  postgresqlMigrationsFolder,
  sqliteMigrationsFolder,
} from "./src/migrations.js";

const RESOLUTION_MIGRATION = "0009_objective_message_resolution";
const CANCELLED_AT = "2026-10-02T05:00:00.000Z";
const COMPLETED_AT = "2026-10-02T06:00:00.000Z";
const objectives = [
  { id: "cancelled", status: "cancelled", cancelledAt: CANCELLED_AT, updatedAt: CANCELLED_AT },
  { id: "completed", status: "completed", cancelledAt: null, updatedAt: COMPLETED_AT },
  { id: "working", status: "working", cancelledAt: null, updatedAt: COMPLETED_AT },
];
const expectedMessages = [
  { id: "cancelled:question", resolvedAt: CANCELLED_AT, resolutionReason: "Objective cancelled" },
  { id: "cancelled:report", resolvedAt: null, resolutionReason: null },
  { id: "completed:question", resolvedAt: COMPLETED_AT, resolutionReason: "Objective completed" },
  { id: "completed:report", resolvedAt: null, resolutionReason: null },
  { id: "working:question", resolvedAt: null, resolutionReason: null },
  { id: "working:report", resolvedAt: null, resolutionReason: null },
];
const expectedApprovals = [
  {
    id: "cancelled:approval",
    status: "expired",
    decidedAt: CANCELLED_AT,
    reason: "Objective cancelled",
  },
  {
    id: "completed:approval",
    status: "expired",
    decidedAt: COMPLETED_AT,
    reason: "Objective completed",
  },
  { id: "working:approval", status: "pending", decidedAt: null, reason: null },
];

/** Copies a migrations folder whose journal stops before the resolution migration. */
async function migrationsBeforeResolution(source: string, directory: string): Promise<string> {
  const base = join(directory, "migrations");
  await cp(source, base, { recursive: true });
  const journalPath = join(base, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < RESOLUTION_MIGRATION,
  );
  await writeFile(journalPath, JSON.stringify(journal));
  return base;
}

/** Rows for one Objective: an unanswered question, a report, and a pending approval request. */
function rowsFor(objective: (typeof objectives)[number]) {
  const message = (suffix: string, needsReply: boolean) => ({
    id: `${objective.id}:${suffix}`,
    objectiveId: objective.id,
    senderTagId: "owner",
    sourceTaskId: `${objective.id}:task`,
    type: "message",
    needsReply,
    body: "{}",
    idempotencyKey: suffix,
    fingerprint: suffix,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  });
  return {
    objective: {
      ...objective,
      outcome: "Outcome",
      ownerTagId: "owner",
      createdAt: "2026-10-02T00:00:00.000Z",
    },
    messages: [message("question", true), message("report", false)],
    approval: {
      id: `${objective.id}:approval`,
      objectiveId: objective.id,
      taskId: `${objective.id}:task`,
      requestingTagId: "owner",
      kind: "action",
      actions: "[]",
      summary: "Approve",
      status: "pending",
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
  };
}

/** Inserts a SQLite row filling every required column without a default with a placeholder. */
function insertSqliteRow(db: Database.Database, table: string, values: Record<string, unknown>) {
  const columns = db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const row: Record<string, unknown> = {};
  for (const column of columns)
    if (column.notnull && column.dflt_value === null)
      row[column.name] = /int/i.test(column.type) ? 0 : "{}";
  for (const [key, value] of Object.entries(values))
    row[key] = typeof value === "boolean" ? Number(value) : value;
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO \`${table}\` (${names.map((name) => `\`${name}\``).join(", ")}) VALUES (${names
      .map(() => "?")
      .join(", ")})`,
  ).run(...names.map((name) => row[name]));
}

describe("closed Objective operator inbox upgrade", () => {
  it("resolves a closed SQLite Objective's pending question and approval request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-inbox-upgrade-"));
    const db = new Database(join(directory, "state.db"));
    try {
      const base = await migrationsBeforeResolution(sqliteMigrationsFolder, directory);
      migrate(drizzle(db), { migrationsFolder: base });
      // Placeholder Tag and Task parents; only the Objective, its messages and approvals matter.
      db.pragma("foreign_keys = OFF");
      for (const objective of objectives) {
        const rows = rowsFor(objective);
        insertSqliteRow(db, "Objective", rows.objective);
        for (const message of rows.messages) insertSqliteRow(db, "ObjectiveMessage", message);
        insertSqliteRow(db, "ApprovalRequest", rows.approval);
      }
      db.pragma("foreign_keys = ON");

      migrateSqliteDatabase(db);

      expect(
        db
          .prepare("SELECT id, resolvedAt, resolutionReason FROM ObjectiveMessage ORDER BY id")
          .all(),
      ).toEqual(expectedMessages);
      expect(
        db.prepare("SELECT id, status, decidedAt, reason FROM ApprovalRequest ORDER BY id").all(),
      ).toEqual(expectedApprovals);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env["SUPERTAG_POSTGRES_URL"])(
    "resolves a closed PostgreSQL Objective's pending question and approval request",
    async () => {
      const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
      if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
      const directory = await mkdtemp(join(tmpdir(), "supertag-inbox-upgrade-"));
      const isolated = await createIsolatedPostgresDatabase(postgresqlUrl);
      const pool = new Pool({ connectionString: isolated.url, max: 1 });
      try {
        const base = await migrationsBeforeResolution(postgresqlMigrationsFolder, directory);
        await migratePostgresql(drizzlePostgresql(pool), { migrationsFolder: base });
        const client = await pool.connect();
        try {
          // Placeholder Tag and Task parents; skip foreign key triggers for this session only.
          await client.query("SET session_replication_role = replica");
          const insert = async (table: string, values: Record<string, unknown>) => {
            const names = Object.keys(values);
            await client.query(
              `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names
                .map((_, index) => `$${index + 1}`)
                .join(", ")})`,
              names.map((name) => values[name]),
            );
          };
          for (const objective of objectives) {
            const rows = rowsFor(objective);
            await insert("Objective", rows.objective);
            for (const message of rows.messages) await insert("ObjectiveMessage", message);
            await insert("ApprovalRequest", rows.approval);
          }
          await client.query("SET session_replication_role = origin");
        } finally {
          client.release();
        }

        await migratePostgresqlDatabase(pool);

        expect(
          (
            await pool.query(
              'SELECT id, "resolvedAt", "resolutionReason" FROM "ObjectiveMessage" ORDER BY id',
            )
          ).rows,
        ).toEqual(expectedMessages);
        expect(
          (
            await pool.query(
              'SELECT id, status, "decidedAt", reason FROM "ApprovalRequest" ORDER BY id',
            )
          ).rows,
        ).toEqual(expectedApprovals);
      } finally {
        await pool.end();
        await isolated.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
