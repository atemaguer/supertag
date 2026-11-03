import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const OBJECTIVES = 40;
const ATTEMPTS = 4000;
const USAGE_REPORTS = 4;
const OTHER_EVENTS = 8;
const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/** The latest of each Attempt's cumulative usage reports, matching the seeded payloads. */
const latestTokens = (i: number) => 100 * USAGE_REPORTS + i;
const latestCost = (i: number) => (i % 7) + USAGE_REPORTS;

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} spend at scale`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("reports a long history by Objective quickly and with exact totals", async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-spend-scale-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });

      const tag = await store.createTag({ name: "scale-worker" });
      for (let index = 0; index < OBJECTIVES; index++)
        await store.createObjective({
          id: `scale-objective-${index}`,
          ownerTagId: tag.id,
          outcome: "Spend at scale",
          budgetLimitMinor: 1_000_000,
          budgetCurrency: "USD",
        });
      const team = await store.createTeam({
        id: "scale-team",
        objectiveId: "scale-objective-0",
        name: "Scale",
        leadTagId: tag.id,
        memberTagIds: [],
        maxConcurrency: 5,
      });
      const at = "2026-10-01T00:00:00.000Z";
      await store.admitTaskAssignment({
        taskId: "scale-template",
        objectiveId: "scale-objective-0",
        teamId: team.id,
        requestedByTagId: tag.id,
        assignedTagId: tag.id,
        instruction: "Spend",
        acceptanceCriteria: ["Done"],
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: { kind: "internal", objectiveId: "scale-objective-0", requestedByTagId: tag.id },
          requester: { id: tag.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: at, sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      await store.createTaskAttempt({
        taskId: "scale-template",
        attemptNumber: 1,
        workerProfile: { id: "default", revision: "1" },
        workerSnapshot: {},
        startedAt: at,
      });
      await bulkSeed(dialect, url, join(directory, "state.db"));

      const started = performance.now();
      const report = await store.readSpend({ by: "objective" });
      const elapsed = performance.now() - started;

      const expected = new Map<string, { attempts: number; cost: number; tokens: number }>();
      for (let i = 1; i <= ATTEMPTS; i++) {
        const key = `scale-objective-${i % OBJECTIVES}`;
        const totals = expected.get(key) ?? { attempts: 0, cost: 0, tokens: 0 };
        expected.set(key, {
          attempts: totals.attempts + 1,
          cost: totals.cost + latestCost(i),
          tokens: totals.tokens + latestTokens(i),
        });
      }
      // The template Attempt has no usage.
      const first = expected.get("scale-objective-0");
      if (first) first.attempts += 1;
      expect(report.groups).toHaveLength(OBJECTIVES);
      for (const group of report.groups) {
        const totals = expected.get(group.key);
        expect(group).toMatchObject({
          attempts: totals?.attempts,
          reportedCostByCurrency: { USD: totals?.cost },
          reportedTokens: totals?.tokens,
          unknownCostAttempts: group.key === "scale-objective-0" ? 1 : 0,
          unknownTokenAttempts: group.key === "scale-objective-0" ? 1 : 0,
          budget: { limitMinor: 1_000_000, currency: "USD" },
        });
      }
      expect(elapsed).toBeLessThan(dialect === "sqlite" ? 2000 : 5000);

      // Scoped reads (describe objective, status) see the same totals.
      const scoped = await store.readSpend({
        by: "objective",
        objectiveIds: ["scale-objective-3", "scale-objective-4"],
      });
      expect(scoped.groups).toEqual(
        report.groups.filter((group) =>
          ["scale-objective-3", "scale-objective-4"].includes(group.key),
        ),
      );
    }, 120_000);
  });
}

/**
 * Clone the template Task, its assignment, and its Attempt in bulk with INSERT ... SELECT, then
 * add cumulative usage reports and unrelated events for each Attempt.
 */
async function bulkSeed(dialect: "sqlite" | "postgresql", url: string, file: string) {
  const series =
    dialect === "postgresql"
      ? (count: number) => `generate_series(1, ${count}) AS n(i)`
      : (count: number) =>
          `(WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${count}) SELECT i FROM s) AS n`;
  const columns = async (table: string, run: (sql: string) => Promise<readonly Row[]>) =>
    (
      await run(
        dialect === "postgresql"
          ? `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`
          : `SELECT name FROM pragma_table_info('${table}')`,
      )
    ).map((row) => String(row["name"]));
  const clone = async (
    table: string,
    key: string,
    overrides: Record<string, string>,
    run: (sql: string) => Promise<readonly Row[]>,
  ) => {
    const names = await columns(table, run);
    const select = names.map((name) => overrides[name] ?? `x."${name}"`).join(", ");
    await run(
      `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
       SELECT ${select} FROM "${table}" x, ${series(ATTEMPTS)} WHERE x."${key}" = 'scale-template'`,
    );
  };
  const objective = `'scale-objective-' || (n.i % ${OBJECTIVES})`;
  const usage = (k: string) =>
    dialect === "postgresql"
      ? `jsonb_build_object('usage', jsonb_build_object('inputTokens', 100 * ${k} + n.i, 'outputTokens', 0, 'cachedInputTokens', 0, 'totalTokens', 100 * ${k} + n.i, 'complete', true, 'reportedCost', jsonb_build_object('amountMinor', (n.i % 7) + ${k}, 'currency', 'USD')))`
      : `json_object('usage', json_object('inputTokens', 100 * ${k} + n.i, 'outputTokens', 0, 'cachedInputTokens', 0, 'totalTokens', 100 * ${k} + n.i, 'complete', json('true'), 'reportedCost', json_object('amountMinor', (n.i % 7) + ${k}, 'currency', 'USD')))`;
  const seed = async (run: (sql: string) => Promise<readonly Row[]>) => {
    await clone("Task", "id", { id: `'scale-task-' || n.i` }, run);
    await clone(
      "TaskAssignment",
      "taskId",
      { taskId: `'scale-task-' || n.i`, objectiveId: objective },
      run,
    );
    await clone(
      "TaskAttempt",
      "taskId",
      { id: `'scale-attempt-' || n.i`, taskId: `'scale-task-' || n.i` },
      run,
    );
    const events = USAGE_REPORTS + OTHER_EVENTS;
    for (let k = 1; k <= events; k++) {
      // Interleave unrelated events so the usage lookup must skip them.
      const isUsage = k % 3 === 0 && k / 3 <= USAGE_REPORTS;
      const report = isUsage ? k / 3 : 0;
      await run(
        `INSERT INTO "TaskEvent" ("id", "taskId", "attemptId", "sequence", "type", "payload", "createdAt")
         SELECT 'scale-event-' || n.i || '-${k}', 'scale-task-' || n.i, 'scale-attempt-' || n.i, ${k},
         '${isUsage ? (report % 2 ? "usage.updated" : "execution.usage.updated") : "execution.output"}',
         ${isUsage ? usage(String(report)) : dialect === "postgresql" ? `jsonb_build_object('text', 'output ' || n.i)` : `json_object('text', 'output ' || n.i)`},
         '2026-10-01T00:00:00.000Z' FROM ${series(ATTEMPTS)}`,
      );
    }
  };
  if (dialect === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec("BEGIN");
      await seed(async (sql) => db.prepare(sql).all() as Row[]);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  } else {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    try {
      await seed(async (sql) => (await pool.query(sql)).rows);
    } finally {
      await pool.end();
    }
  }
}

type Row = Readonly<Record<string, unknown>>;
