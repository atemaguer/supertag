import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { migrate as migratePostgresql } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.ts";
import { DrizzleStore } from "./src/index.js";
import {
  migratePostgresqlDatabase,
  migrateSqliteDatabase,
  postgresqlMigrationsFolder,
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

/** Copies a migrations folder without 0014 and later. */
async function migrationsBeforePostObjective(folder: string, directory: string) {
  const base = join(directory, "migrations");
  await cp(folder, base, { recursive: true });
  const journalPath = join(base, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { tag: string }) => entry.tag < "0014_post_objective",
  );
  await writeFile(journalPath, JSON.stringify(journal));
  return base;
}

type Insert = (table: string, values: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * A Team governed by one Objective and linked to another, with posts written before posts
 * recorded their Objective: one from a Task in the linked Objective, one without a source Task,
 * and a reply from each to the linked post.
 */
async function seed(insert: Insert) {
  await insert("Tag", { id: "lead", name: "lead", status: "active", createdAt: at, updatedAt: at });
  await insert("Session", {
    id: "session",
    tagId: "lead",
    sessionKey: "s",
    createdAt: at,
    updatedAt: at,
  });
  // Both Objectives have observed the channel through channel-wide sequence 4, and the linked
  // one also has a pending batch through 3.
  for (const [id, observationState] of [
    ["governing", { cursors: { "governing:build": 4 } }],
    [
      "linked",
      { cursors: { "governing:build": 4 }, pending: { through: { "governing:build": 3 } } },
    ],
  ] as const)
    await insert("Objective", {
      id,
      ownerTagId: "lead",
      outcome: id,
      observations: "[]",
      observationState: JSON.stringify(observationState),
      runtimeActions: "[]",
      workspaces: "[]",
      createdAt: at,
      updatedAt: at,
    });
  await insert("Team", {
    id: "governing:build",
    objectiveId: "governing",
    name: "Build",
    leadTagId: "lead",
    memberTagIds: '["lead"]',
    objectiveIds: '["linked"]',
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  await insert("Workstream", { id: "governing:build", createdAt: at });
  await insert("Task", {
    id: "linked-task",
    tagId: "lead",
    sessionId: "session",
    createdAt: at,
    updatedAt: at,
  });
  await insert("TaskAssignment", {
    taskId: "linked-task",
    objectiveId: "linked",
    teamId: "governing:build",
    requestedByTagId: "lead",
    assignedTagId: "lead",
    status: "waiting",
    // Registered with wait_for.workstreamPosts after channel-wide sequence 3.
    waitState: JSON.stringify({
      workstreamPosts: { workstreamId: "governing:build", afterSequence: 3 },
    }),
    createdAt: at,
    updatedAt: at,
  });
  for (const [id, sourceTaskId, replyTo, sequence] of [
    ["governed", null, null, 1],
    ["linked-post", "linked-task", null, 2],
    // A reply from the governing Objective to the linked one would cross Objectives.
    ["cross-reply", null, "linked-post", 3],
    ["same-reply", "linked-task", "linked-post", 4],
  ] as const)
    await insert("WorkstreamPost", {
      id,
      workstreamId: "governing:build",
      authorTagId: "lead",
      sourceTaskId,
      body: id,
      references: "[]",
      replyTo,
      sequence,
      idempotencyKey: id,
      createdAt: at,
    });
  // The linked Objective's pending batch covers channel-wide sequences 2 through 3.
  await insert("TagMessage", {
    id: "observation:pending",
    senderTagId: "lead",
    recipientTagId: "lead",
    objectiveId: "linked",
    type: "message",
    body: JSON.stringify({
      kind: "observations.available",
      objectiveId: "linked",
      workstreamId: "governing:build",
      afterSequence: 1,
      throughSequence: 3,
      postIds: ["linked-post"],
    }),
    idempotencyKey: "observation:pending",
    fingerprint: "f",
    status: "pending",
    attemptCount: 0,
    createdAt: at,
    updatedAt: at,
  });
}

/** Posts renumbered per Objective in their old order. */
const upgraded = [
  { id: "governed", objectiveId: "governing", replyTo: null, sequence: 1 },
  { id: "linked-post", objectiveId: "linked", replyTo: null, sequence: 1 },
  { id: "cross-reply", objectiveId: "governing", replyTo: null, sequence: 2 },
  { id: "same-reply", objectiveId: "linked", replyTo: "linked-post", sequence: 2 },
];

/**
 * Cursors become the count of the Objective's own posts at or before the old value, so each
 * Objective's next post (its maximum plus one) lies after every cursor and wait.
 */
const upgradedCursors = {
  governing: { cursors: { "governing:build": 2 } },
  linked: { cursors: { "governing:build": 2 }, pending: { through: { "governing:build": 1 } } },
  wait: { workstreamPosts: { workstreamId: "governing:build", afterSequence: 1 } },
  batch: { afterSequence: 0, throughSequence: 1, postIds: ["linked-post"] },
};

function batchSequences(body: unknown) {
  const { afterSequence, throughSequence, postIds } = parse(body);
  return { afterSequence, throughSequence, postIds };
}

function parse(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/** A database migrated up to, but not including, 0014_post_objective. */
async function databaseBeforePostObjective() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-post-objective-upgrade-"));
  const base = await migrationsBeforePostObjective(sqliteMigrationsFolder, directory);
  const file = join(directory, "state.db");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder: base });
  return {
    db,
    file,
    cleanup: async () => {
      if (db.open) db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Team channel post Objective upgrade", () => {
  it("assigns each stored post its Task's Objective or the governing one, renumbering per Objective", async () => {
    const { db, cleanup } = await databaseBeforePostObjective();
    try {
      await seed((table, values) => insertRow(db, table, values));
      migrateSqliteDatabase(db);

      expect(
        db
          .prepare(
            "SELECT id, objectiveId, replyTo, sequence FROM WorkstreamPost ORDER BY sequence, objectiveId",
          )
          .all(),
      ).toEqual(upgraded);
      const objectives = db
        .prepare("SELECT id, observationState FROM Objective ORDER BY id")
        .all() as { id: string; observationState: string }[];
      const [wait] = db.prepare("SELECT waitState FROM TaskAssignment").all() as {
        waitState: string;
      }[];
      const batch = db.prepare("SELECT body FROM TagMessage").get() as { body: string };
      expect({
        governing: parse(objectives[0]?.observationState),
        linked: parse(objectives[1]?.observationState),
        wait: parse(wait?.waitState),
        batch: batchSequences(batch.body),
      }).toEqual(upgradedCursors);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      // A post now requires an existing Objective, and numbers repeat only across Objectives.
      const insert = (id: string, objectiveId: string, sequence: number) =>
        db
          .prepare(
            "INSERT INTO WorkstreamPost (id, workstreamId, authorTagId, objectiveId, body, `references`, sequence, idempotencyKey, createdAt) VALUES (?, 'governing:build', 'lead', ?, 'x', '[]', ?, ?, ?)",
          )
          .run(id, objectiveId, sequence, id, at);
      expect(() => insert("missing", "missing", 9)).toThrow(/FOREIGN KEY/);
      expect(() => insert("duplicate", "governing", 1)).toThrow(/UNIQUE/);
      expect(() => insert("other-numbering", "linked", 3)).not.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("does not recreate a batch ID assessed before renumbering", async () => {
    const { db, file, cleanup } = await databaseBeforePostObjective();
    const workstreamId = "governing:build";
    // The ID an observation batch had before posts recorded their Objective.
    const previousBatchId = (after: number, through: number) =>
      `observation:${createHash("sha256")
        .update(JSON.stringify(["governing", workstreamId, after, through]))
        .digest("hex")}`;
    try {
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
      for (const id of ["governing", "linked"])
        insertRow(db, "Objective", {
          id,
          ownerTagId: "lead",
          outcome: id,
          status: "working",
          executionStartedAt: at,
          observations: id === "governing" ? JSON.stringify([{ workstreamId }]) : "[]",
          observationState: JSON.stringify({
            cursors: id === "governing" ? { [workstreamId]: 3 } : {},
          }),
          runtimeActions: "[]",
          workspaces: "[]",
          createdAt: at,
          updatedAt: at,
        });
      insertRow(db, "Team", {
        id: workstreamId,
        objectiveId: "governing",
        name: "Build",
        leadTagId: "lead",
        memberTagIds: '["lead"]',
        objectiveIds: '["linked"]',
        status: "active",
        createdAt: at,
        updatedAt: at,
      });
      insertRow(db, "Workstream", { id: workstreamId, createdAt: at });
      insertRow(db, "Task", {
        id: "linked-task",
        tagId: "lead",
        sessionId: "session",
        createdAt: at,
        updatedAt: at,
      });
      insertRow(db, "TaskAssignment", {
        taskId: "linked-task",
        objectiveId: "linked",
        teamId: workstreamId,
        requestedByTagId: "lead",
        assignedTagId: "lead",
        parentTaskId: "parent",
        status: "accepted",
        createdAt: at,
        updatedAt: at,
      });
      // One linked post and two governing posts, each assessed by the governing Objective in its
      // own channel-wide batch.
      for (const [id, sourceTaskId, sequence] of [
        ["linked-post", "linked-task", 1],
        ["governed-2", null, 2],
        ["governed-3", null, 3],
      ] as const)
        insertRow(db, "WorkstreamPost", {
          id,
          workstreamId,
          authorTagId: "lead",
          sourceTaskId,
          body: id,
          references: "[]",
          sequence,
          idempotencyKey: id,
          createdAt: at,
        });
      for (const [after, through] of [
        [0, 1],
        [1, 2],
        [2, 3],
      ] as const)
        insertRow(db, "TagMessage", {
          id: previousBatchId(after, through),
          senderTagId: "lead",
          recipientTagId: "lead",
          objectiveId: "governing",
          type: "message",
          idempotencyKey: previousBatchId(after, through),
          fingerprint: "f",
          status: "processed",
          attemptCount: 1,
          createdAt: at,
          updatedAt: at,
        });
      migrateSqliteDatabase(db);
      // The governing posts become 1 and 2 with the cursor at 2, so its next post is number 3:
      // the same after and through as an assessed batch.
      db.prepare(
        "INSERT INTO WorkstreamPost (id, workstreamId, authorTagId, objectiveId, body, `references`, sequence, idempotencyKey, createdAt) VALUES ('governed-new', ?, 'lead', 'governing', 'new', '[]', 3, 'governed-new', ?)",
      ).run(workstreamId, at);
      db.close();
      const store = new DrizzleStore({ url: `file:${file}` });
      await store.connect();
      try {
        await store.reconcileObjectiveObservations();
      } finally {
        await store.disconnect();
      }
      const reopened = new Database(file);
      try {
        const created = reopened
          .prepare("SELECT id, body FROM TagMessage WHERE status != 'processed'")
          .all() as { id: string; body: string }[];
        expect(created).toHaveLength(1);
        expect(created[0]?.id).not.toBe(previousBatchId(2, 3));
        expect(parse(created[0]?.body)).toMatchObject({
          afterSequence: 2,
          throughSequence: 3,
          postIds: ["governed-new"],
        });
      } finally {
        reopened.close();
      }
    } finally {
      await cleanup();
    }
  });

  it.skipIf(!process.env["SUPERTAG_POSTGRES_URL"])(
    "assigns PostgreSQL posts their Task's Objective or the governing one, renumbering per Objective",
    async () => {
      const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
      if (postgresqlUrl === undefined) throw new Error("SUPERTAG_POSTGRES_URL is required");
      const directory = await mkdtemp(join(tmpdir(), "supertag-post-objective-upgrade-"));
      const isolated = await createIsolatedPostgresDatabase(postgresqlUrl);
      const pool = new Pool({ connectionString: isolated.url, max: 1 });
      try {
        const base = await migrationsBeforePostObjective(postgresqlMigrationsFolder, directory);
        await migratePostgresql(drizzlePostgresql(pool), { migrationsFolder: base });
        const client = await pool.connect();
        try {
          await seed(postgresInsert(client));
        } finally {
          client.release();
        }
        await migratePostgresqlDatabase(pool);
        expect(
          (
            await pool.query(
              'SELECT id, "objectiveId", "replyTo", sequence FROM "WorkstreamPost" ORDER BY sequence, "objectiveId"',
            )
          ).rows,
        ).toEqual(upgraded);
        const objectives = (
          await pool.query('SELECT "observationState" FROM "Objective" ORDER BY id')
        ).rows as { observationState: unknown }[];
        const wait = (await pool.query('SELECT "waitState" FROM "TaskAssignment"')).rows[0] as {
          waitState: unknown;
        };
        const batch = (await pool.query('SELECT body FROM "TagMessage"')).rows[0] as {
          body: unknown;
        };
        expect({
          governing: parse(objectives[0]?.observationState),
          linked: parse(objectives[1]?.observationState),
          wait: parse(wait.waitState),
          batch: batchSequences(batch.body),
        }).toEqual(upgradedCursors);
        await expect(
          pool.query(
            `INSERT INTO "WorkstreamPost" (id, "workstreamId", "authorTagId", "objectiveId", body, "references", sequence, "idempotencyKey", "createdAt")
             VALUES ('missing', 'governing:build', 'lead', 'missing', 'x', '[]', 9, 'missing', $1)`,
            [at],
          ),
        ).rejects.toThrow(/foreign key/);
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
