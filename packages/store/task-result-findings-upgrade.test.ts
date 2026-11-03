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

const FINDINGS_MIGRATION = "0010_task_result_findings";
const lists = { decisions: [], changes: [], unresolved: [], references: [], artifacts: [] };
const existingFinding = { id: "F1", severity: "high", summary: "Kept", status: "open" };
const legacyResult = { summary: "Legacy", ...lists };
const currentResult = { summary: "Current", ...lists, findings: [existingFinding] };
const currentHistory = [{ sessionId: "current-1", result: currentResult }];
const legacyHistory = [
  { sessionId: "history-1", result: { summary: "First", ...lists } },
  { sessionId: "history-2", result: { summary: "Second", ...lists } },
];
const legacyAssignmentResult = { text: "Done", taskResult: { summary: "Done", ...lists } };
const mailboxAssignmentResult = { text: "Delivered" };
// Findings present but not a list are replaced too, so every stored result validates afterwards.
const malformedResult = { summary: "Malformed", ...lists, findings: "F1 high" };
const malformedHistory = [
  { sessionId: "malformed-1", result: { summary: "Null", ...lists, findings: null } },
  { sessionId: "malformed-2", result: { summary: "Object", ...lists, findings: { F1: "high" } } },
];
const malformedAssignmentResult = {
  text: "Done",
  taskResult: { summary: "Done", ...lists, findings: { severity: "high" } },
};

const tasks = [
  { id: "legacy", result: legacyResult, sessionHistory: [] },
  { id: "current", result: currentResult, sessionHistory: currentHistory },
  { id: "empty", result: null, sessionHistory: [] },
  { id: "history", result: null, sessionHistory: legacyHistory },
  { id: "malformed", result: malformedResult, sessionHistory: [] },
  // A separate row: the placeholder rows have no parents, and PostgreSQL rechecks foreign keys
  // when one transaction updates the same row twice.
  { id: "malformed-history", result: null, sessionHistory: malformedHistory },
];
const assignments = [
  { taskId: "legacy", result: legacyAssignmentResult },
  { taskId: "mailbox", result: mailboxAssignmentResult },
  { taskId: "malformed", result: malformedAssignmentResult },
];
const expectedTasks = [
  { id: "current", result: currentResult, sessionHistory: currentHistory },
  { id: "empty", result: null, sessionHistory: [] },
  {
    id: "history",
    result: null,
    sessionHistory: legacyHistory.map((entry) => ({
      ...entry,
      result: { ...entry.result, findings: [] },
    })),
  },
  { id: "legacy", result: { ...legacyResult, findings: [] }, sessionHistory: [] },
  {
    id: "malformed",
    result: { ...malformedResult, findings: [] },
    sessionHistory: [],
  },
  {
    id: "malformed-history",
    result: null,
    sessionHistory: malformedHistory.map((entry) => ({
      ...entry,
      result: { ...entry.result, findings: [] },
    })),
  },
];
const expectedAssignments = [
  {
    taskId: "legacy",
    result: {
      ...legacyAssignmentResult,
      taskResult: { ...legacyAssignmentResult.taskResult, findings: [] },
    },
  },
  { taskId: "mailbox", result: mailboxAssignmentResult },
  {
    taskId: "malformed",
    result: {
      ...malformedAssignmentResult,
      taskResult: { ...malformedAssignmentResult.taskResult, findings: [] },
    },
  },
];

/** Copies a migrations folder whose journal stops before the findings migration. */
async function migrationsBeforeFindings(source: string, directory: string): Promise<string> {
  const base = join(directory, "migrations");
  await cp(source, base, { recursive: true });
  const journalPath = join(base, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < FINDINGS_MIGRATION,
  );
  await writeFile(journalPath, JSON.stringify(journal));
  return base;
}

/** JSON columns are stored as text in SQLite and passed as JSON text to PostgreSQL. */
function encoded(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      key === "result" || key === "sessionHistory"
        ? value === null
          ? null
          : JSON.stringify(value)
        : value,
    ]),
  );
}

/** Parses JSON text columns read back from SQLite. */
function decoded(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" && key !== "id" && key !== "taskId" ? JSON.parse(value) : value,
    ]),
  );
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

describe("Task result findings upgrade", () => {
  it("gives SQLite Task results without a findings list an empty one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-findings-upgrade-"));
    const db = new Database(join(directory, "state.db"));
    try {
      const base = await migrationsBeforeFindings(sqliteMigrationsFolder, directory);
      migrate(drizzle(db), { migrationsFolder: base });
      // Placeholder Objective, Team, and Tag parents; only the stored results matter.
      db.pragma("foreign_keys = OFF");
      for (const task of tasks) insertSqliteRow(db, "Task", encoded(task));
      for (const assignment of assignments)
        insertSqliteRow(db, "TaskAssignment", encoded(assignment));
      db.pragma("foreign_keys = ON");

      migrateSqliteDatabase(db);

      expect(
        (
          db.prepare("SELECT id, result, sessionHistory FROM Task ORDER BY id").all() as Record<
            string,
            unknown
          >[]
        ).map(decoded),
      ).toEqual(expectedTasks);
      expect(
        (
          db.prepare("SELECT taskId, result FROM TaskAssignment ORDER BY taskId").all() as Record<
            string,
            unknown
          >[]
        ).map(decoded),
      ).toEqual(expectedAssignments);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env["SUPERTAG_POSTGRES_URL"])(
    "gives PostgreSQL Task results without a findings list an empty one",
    async () => {
      const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
      if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
      const directory = await mkdtemp(join(tmpdir(), "supertag-findings-upgrade-"));
      const isolated = await createIsolatedPostgresDatabase(postgresqlUrl);
      const pool = new Pool({ connectionString: isolated.url, max: 1 });
      try {
        const base = await migrationsBeforeFindings(postgresqlMigrationsFolder, directory);
        await migratePostgresql(drizzlePostgresql(pool), { migrationsFolder: base });
        const client = await pool.connect();
        try {
          // Placeholder parents; skip foreign key triggers for this session only.
          await client.query("SET session_replication_role = replica");
          const insert = async (table: string, values: Record<string, unknown>) => {
            const columns = (
              await client.query(
                `SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
                [table],
              )
            ).rows as { column_name: string; data_type: string }[];
            const row: Record<string, unknown> = {};
            for (const column of columns)
              row[column.column_name] = /int|numeric|double|real/i.test(column.data_type)
                ? 0
                : column.data_type === "boolean"
                  ? false
                  : "{}";
            Object.assign(row, values);
            const names = Object.keys(row);
            await client.query(
              `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names
                .map((_, index) => `$${index + 1}`)
                .join(", ")})`,
              names.map((name) => row[name]),
            );
          };
          for (const task of tasks) await insert("Task", encoded(task));
          for (const assignment of assignments) await insert("TaskAssignment", encoded(assignment));
          await client.query("SET session_replication_role = origin");
        } finally {
          client.release();
        }

        await migratePostgresqlDatabase(pool);

        expect(
          (await pool.query('SELECT id, result, "sessionHistory" FROM "Task" ORDER BY id')).rows,
        ).toEqual(expectedTasks);
        expect(
          (await pool.query('SELECT "taskId", result FROM "TaskAssignment" ORDER BY "taskId"'))
            .rows,
        ).toEqual(expectedAssignments);
      } finally {
        await pool.end();
        await isolated.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
