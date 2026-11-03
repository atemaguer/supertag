import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { migrateSqliteDatabase, sqliteMigrationsFolder } from "./src/migrations.js";

/** Inserts a row filling every required column without a default with a placeholder. */
function insertRow(db: Database.Database, table: string, values: Record<string, unknown>) {
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
  Object.assign(row, values);
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO \`${table}\` (${names.map((name) => `\`${name}\``).join(", ")}) VALUES (${names
      .map(() => "?")
      .join(", ")})`,
  ).run(...names.map((name) => row[name]));
}

describe("optional Team concurrency upgrade", () => {
  it("upgrades a populated SQLite database whose Task Assignments reference its Teams", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-team-upgrade-"));
    const base = join(directory, "migrations");
    const db = new Database(join(directory, "state.db"));
    try {
      await cp(sqliteMigrationsFolder, base, { recursive: true });
      const journalPath = join(base, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (entry: { tag: string }) => entry.tag < "0003_optional_team_concurrency",
      );
      await writeFile(journalPath, JSON.stringify(journal));
      db.pragma("foreign_keys = ON");
      migrate(drizzle(db), { migrationsFolder: base });

      // Placeholder parents; only the Team rows and their referencing Task Assignments matter.
      db.pragma("foreign_keys = OFF");
      for (const [id, parentTeamId, maxConcurrency] of [
        ["o:leadership", null, 8],
        ["o:delivery", "o:leadership", 3],
      ] as const)
        insertRow(db, "Team", {
          id,
          objectiveId: "o",
          parentTeamId,
          maxConcurrency,
          name: id,
          leadTagId: "lead",
          memberTagIds: '["lead"]',
          status: "active",
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        });
      for (const teamId of ["o:leadership", "o:delivery"])
        insertRow(db, "TaskAssignment", { taskId: `${teamId}:task`, teamId, objectiveId: "o" });
      db.pragma("foreign_keys = ON");

      migrateSqliteDatabase(db);

      expect(db.prepare("SELECT id, maxConcurrency FROM Team ORDER BY id").all()).toEqual([
        { id: "o:delivery", maxConcurrency: 3 },
        { id: "o:leadership", maxConcurrency: null },
      ]);
      expect(db.prepare("SELECT count(*) AS count FROM TaskAssignment").get()).toEqual({
        count: 2,
      });
      // Placeholder Objective and Tag parents are absent; no Task Assignment lost its Team.
      expect(teamViolations(db)).toEqual([]);
      // The column now accepts an absent limit.
      db.prepare("UPDATE Team SET maxConcurrency = NULL WHERE id = 'o:delivery'").run();
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function teamViolations(db: Database.Database) {
  return (db.pragma("foreign_key_check") as { parent: string }[]).filter(
    (violation) => violation.parent === "Team",
  );
}
