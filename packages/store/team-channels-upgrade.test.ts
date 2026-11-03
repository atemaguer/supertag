import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { migrate as migratePostgresql } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.ts";
import {
  migratePostgresqlDatabase,
  migrateSqliteDatabase,
  postgresqlMigrationsFolder,
  SQLITE_FOREIGN_KEYS_OFF_MIGRATIONS,
  sqliteMigrationsFolder,
} from "./src/migrations.js";

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

const at = "2026-10-04T00:00:00.000Z";

/** Copies a migrations folder without 0012 and later. */
async function migrationsBeforeChannels(folder: string, directory: string) {
  const base = join(directory, "migrations");
  await cp(folder, base, { recursive: true });
  const journalPath = join(base, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < "0012_team_channels",
  );
  await writeFile(journalPath, JSON.stringify(journal));
  return base;
}

async function databaseBeforeChannels() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-channel-upgrade-"));
  const db = new Database(join(directory, "state.db"));
  const base = await migrationsBeforeChannels(sqliteMigrationsFolder, directory);
  db.pragma("foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder: base });
  // Real parents throughout: enforcement stays on while the old rows are written.
  insertRow(db, "Tag", {
    id: "lead",
    name: "lead",
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  insertRow(db, "Session", {
    id: "session",
    tagId: "lead",
    sessionKey: "s",
    createdAt: at,
    updatedAt: at,
  });
  insertRow(db, "Task", {
    id: "task",
    tagId: "lead",
    sessionId: "session",
    createdAt: at,
    updatedAt: at,
  });
  insertRow(db, "Objective", {
    id: "o",
    ownerTagId: "lead",
    outcome: "Coordinate",
    observations: "[]",
    observationState: '{"cursors":{}}',
    runtimeActions: "[]",
    workspaces: "[]",
    createdAt: at,
    updatedAt: at,
  });
  insertRow(db, "Team", {
    id: "o:build",
    objectiveId: "o",
    name: "Build",
    leadTagId: "lead",
    memberTagIds: '["lead"]',
    objectiveIds: "[]",
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  for (const id of ["ad-hoc", "o:build"])
    insertRow(db, "Workstream", {
      id,
      objectiveId: "o",
      title: id,
      ownerTagId: "lead",
      participantTagIds: '["lead"]',
      status: "working",
      createdAt: at,
      updatedAt: at,
    });
  for (const [id, workstreamId] of [
    ["ad-hoc-post", "ad-hoc"],
    ["team-post", "o:build"],
  ] as const)
    insertRow(db, "WorkstreamPost", {
      id,
      workstreamId,
      authorTagId: "lead",
      body: "Finding",
      references: "[]",
      sequence: 1,
      idempotencyKey: id,
      createdAt: at,
    });
  insertRow(db, "TagMessage", {
    id: "message",
    senderTagId: "lead",
    recipientTagId: "lead",
    objectiveId: "o",
    directTeamId: "o:build",
    workstreamId: "ad-hoc",
    type: "message",
    body: "{}",
    idempotencyKey: "message",
    fingerprint: "f",
    status: "processed",
    createdAt: at,
    updatedAt: at,
  });
  insertRow(db, "TaskAssignment", {
    taskId: "task",
    objectiveId: "o",
    teamId: "o:build",
    workstreamId: "ad-hoc",
    sourceMessageId: "message",
    requestedByTagId: "lead",
    assignedTagId: "lead",
    status: "accepted",
    createdAt: at,
    updatedAt: at,
  });
  insertRow(db, "ResourceChange", {
    id: "change",
    resourceType: "team",
    resourceId: "o:build",
    fromRevision: 0,
    toRevision: 1,
    sourceMessageId: "message",
    changes: "{}",
    createdAt: at,
  });
  return {
    db,
    cleanup: async () => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Team channel upgrade", () => {
  it("gives every Team its channel and drops ad-hoc Workstreams, keeping the rows that reference rebuilt tables", async () => {
    const { db, cleanup } = await databaseBeforeChannels();
    try {
      insertRow(db, "Team", {
        id: "o:review",
        objectiveId: "o",
        name: "Review",
        leadTagId: "lead",
        memberTagIds: '["lead"]',
        objectiveIds: "[]",
        status: "active",
        createdAt: "2026-10-04T01:00:00.000Z",
        updatedAt: at,
      });
      migrateSqliteDatabase(db);

      expect(db.prepare("SELECT * FROM Workstream ORDER BY id").all()).toEqual([
        { id: "o:build", createdAt: at },
        { id: "o:review", createdAt: "2026-10-04T01:00:00.000Z" },
      ]);
      expect(db.prepare("SELECT id, type, `to` FROM WorkstreamPost").all()).toEqual([
        { id: "team-post", type: "note", to: "[]" },
      ]);
      const message = db.prepare("SELECT * FROM TagMessage").get() as Record<string, unknown>;
      // The Team direct-message column from the earlier migration survives the rebuild.
      expect(message).toMatchObject({ id: "message", type: "message", directTeamId: "o:build" });
      expect(message).not.toHaveProperty("workstreamId");
      // References into the rebuilt TagMessage table survive the rebuild.
      expect(db.prepare("SELECT sourceMessageId, workstreamId FROM TaskAssignment").get()).toEqual({
        sourceMessageId: "message",
        workstreamId: null,
      });
      expect(db.prepare("SELECT sourceMessageId FROM ResourceChange").get()).toEqual({
        sourceMessageId: "message",
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      // The channel row now requires its Team.
      expect(() =>
        db.prepare("INSERT INTO Workstream (id, createdAt) VALUES ('missing', ?)").run(at),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      await cleanup();
    }
  });

  it("rolls back when the rebuild would leave a broken reference", async () => {
    const { db, cleanup } = await databaseBeforeChannels();
    try {
      db.pragma("foreign_keys = OFF");
      insertRow(db, "ResourceChange", {
        id: "orphan",
        resourceType: "team",
        resourceId: "o:build",
        fromRevision: 1,
        toRevision: 2,
        sourceMessageId: "missing-message",
        changes: "{}",
        createdAt: at,
      });
      db.pragma("foreign_keys = ON");
      expect(() => migrateSqliteDatabase(db)).toThrow(/__team_channels_foreign_key_check/);
      // Nothing changed, and enforcement is back on.
      expect(db.prepare("SELECT count(*) AS count FROM Workstream").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT workstreamId FROM TagMessage").get()).toEqual({
        workstreamId: "ad-hoc",
      });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      await cleanup();
    }
  });
  it("drops an old Workstream from another Objective that reused a Team ID, and posts by non-members", async () => {
    const { db, cleanup } = await databaseBeforeChannels();
    try {
      insertRow(db, "Tag", {
        id: "outsider",
        name: "outsider",
        status: "active",
        createdAt: at,
        updatedAt: at,
      });
      insertRow(db, "Objective", {
        id: "other",
        ownerTagId: "outsider",
        outcome: "Elsewhere",
        observations: "[]",
        observationState: '{"cursors":{}}',
        runtimeActions: "[]",
        workspaces: "[]",
        createdAt: at,
        updatedAt: at,
      });
      insertRow(db, "Team", {
        id: "o:review",
        objectiveId: "o",
        name: "Review",
        leadTagId: "lead",
        memberTagIds: '["lead"]',
        objectiveIds: "[]",
        status: "active",
        createdAt: "2026-10-04T01:00:00.000Z",
        updatedAt: at,
      });
      // A Workstream in another Objective that took this Team's ID, with a planted post.
      insertRow(db, "Workstream", {
        id: "o:review",
        objectiveId: "other",
        title: "planted",
        ownerTagId: "outsider",
        participantTagIds: '["outsider"]',
        status: "working",
        createdAt: at,
        updatedAt: at,
      });
      for (const [id, workstreamId, sequence] of [
        ["planted-post", "o:review", 1],
        ["outsider-post", "o:build", 2],
      ] as const)
        insertRow(db, "WorkstreamPost", {
          id,
          workstreamId,
          authorTagId: "outsider",
          body: "Planted",
          references: "[]",
          sequence,
          idempotencyKey: id,
          createdAt: at,
        });
      migrateSqliteDatabase(db);

      expect(db.prepare("SELECT * FROM Workstream ORDER BY id").all()).toEqual([
        { id: "o:build", createdAt: at },
        { id: "o:review", createdAt: "2026-10-04T01:00:00.000Z" },
      ]);
      expect(db.prepare("SELECT id FROM WorkstreamPost ORDER BY id").all()).toEqual([
        { id: "team-post" },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("fails on a broken reference out of a rebuilt table, not only into it", async () => {
    const { db, cleanup } = await databaseBeforeChannels();
    try {
      db.pragma("foreign_keys = OFF");
      insertRow(db, "TagMessage", {
        id: "orphan-sender",
        senderTagId: "missing-tag",
        recipientTagId: "lead",
        objectiveId: "o",
        type: "message",
        body: "{}",
        idempotencyKey: "orphan-sender",
        fingerprint: "f",
        status: "processed",
        createdAt: at,
        updatedAt: at,
      });
      db.pragma("foreign_keys = ON");
      expect(() => migrateSqliteDatabase(db)).toThrow(/__team_channels_foreign_key_check/);
      expect(db.prepare("SELECT count(*) AS count FROM Workstream").get()).toEqual({ count: 2 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("turns foreign keys off only while a migration that needs it is pending", async () => {
    expect([...SQLITE_FOREIGN_KEYS_OFF_MIGRATIONS]).toEqual(["0012_team_channels"]);
    const { db, cleanup } = await databaseBeforeChannels();
    try {
      const pragma = vi.spyOn(db, "pragma");
      migrateSqliteDatabase(db);
      expect(pragma).toHaveBeenCalledWith("foreign_keys = OFF");
      pragma.mockClear();
      // With 0011 applied, a later run keeps enforcement on throughout.
      migrateSqliteDatabase(db);
      expect(pragma).not.toHaveBeenCalledWith("foreign_keys = OFF");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it.skipIf(!process.env["SUPERTAG_POSTGRES_URL"])(
    "drops PostgreSQL Workstreams from another Objective that reused a Team ID, and posts by non-members",
    async () => {
      const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
      if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
      const directory = await mkdtemp(join(tmpdir(), "supertag-channel-upgrade-"));
      const isolated = await createIsolatedPostgresDatabase(postgresqlUrl);
      const pool = new Pool({ connectionString: isolated.url, max: 1 });
      try {
        const base = await migrationsBeforeChannels(postgresqlMigrationsFolder, directory);
        await migratePostgresql(drizzlePostgresql(pool), { migrationsFolder: base });
        const client = await pool.connect();
        try {
          const insert = postgresInsert(client);
          for (const id of ["lead", "outsider"])
            await insert("Tag", { id, name: id, status: "active", createdAt: at, updatedAt: at });
          for (const [id, ownerTagId] of [
            ["o", "lead"],
            ["other", "outsider"],
          ])
            await insert("Objective", {
              id,
              ownerTagId,
              outcome: id,
              observations: "[]",
              observationState: '{"cursors":{}}',
              runtimeActions: "[]",
              workspaces: "[]",
              createdAt: at,
              updatedAt: at,
            });
          for (const id of ["o:build", "o:review"])
            await insert("Team", {
              id,
              objectiveId: "o",
              name: id,
              leadTagId: "lead",
              memberTagIds: '["lead"]',
              objectiveIds: "[]",
              status: "active",
              createdAt: at,
              updatedAt: at,
            });
          for (const [id, objectiveId, ownerTagId] of [
            ["o:build", "o", "lead"],
            ["o:review", "other", "outsider"],
            ["ad-hoc", "o", "lead"],
          ])
            await insert("Workstream", {
              id,
              objectiveId,
              title: id,
              ownerTagId,
              participantTagIds: JSON.stringify([ownerTagId]),
              status: "working",
              revision: 1,
              createdAt: at,
              updatedAt: at,
            });
          for (const [id, workstreamId, authorTagId] of [
            ["team-post", "o:build", "lead"],
            ["outsider-post", "o:build", "outsider"],
            ["planted-post", "o:review", "outsider"],
            ["ad-hoc-post", "ad-hoc", "lead"],
          ] as const)
            await insert("WorkstreamPost", {
              id,
              workstreamId,
              authorTagId,
              body: "Post",
              references: "[]",
              sequence: id.length,
              idempotencyKey: id,
              createdAt: at,
            });
        } finally {
          client.release();
        }

        await migratePostgresqlDatabase(pool);

        expect((await pool.query('SELECT id FROM "Workstream" ORDER BY id')).rows).toEqual([
          { id: "o:build" },
          { id: "o:review" },
        ]);
        expect((await pool.query('SELECT id FROM "WorkstreamPost" ORDER BY id')).rows).toEqual([
          { id: "team-post" },
        ]);
      } finally {
        await pool.end();
        await isolated.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

/** Inserts a PostgreSQL row filling required columns without a default with placeholders. */
function postgresInsert(client: PoolClient) {
  return async (table: string, values: Record<string, unknown>) => {
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
}
