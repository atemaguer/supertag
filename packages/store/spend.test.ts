import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectiveSessionKey } from "@supertag/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";
import { DrizzleSpendStore } from "./src/spend-store.js";

it("estimates historical Codex token reports while retaining unknowns without tokens", async () => {
  const rows = [
    {
      attemptId: "with-tokens",
      startedAt: "2026-10-03T07:00:00.000Z",
      tagId: "tag",
      tagName: "Builder",
      objectiveId: "objective",
      budgetLimitMinor: 1000,
      budgetCurrency: "USD",
      workerSnapshot: JSON.stringify({ execution: { harness: "codex", model: "gpt-7-preview" } }),
      latestUsage: JSON.stringify({
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
          complete: true,
        },
      }),
    },
    {
      attemptId: "no-tokens",
      startedAt: "2026-10-03T07:01:00.000Z",
      tagId: "tag",
      tagName: "Builder",
      objectiveId: "objective",
      budgetLimitMinor: 1000,
      budgetCurrency: "USD",
      workerSnapshot: JSON.stringify({ execution: { harness: "codex", model: "gpt-7-preview" } }),
      latestUsage: null,
    },
  ];
  const store = new DrizzleSpendStore("sqlite", async () => rows);
  expect((await store.readSpend()).groups[0]).toMatchObject({
    reportedCostByCurrency: null,
    unpricedModels: { "gpt-7-preview": 1 },
    unpricedTokens: 1_100_000,
    unknownCostAttempts: 2,
    unknownTokenAttempts: 1,
  });
});

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} spend`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("groups the latest valid usage of either event type per Attempt, keeps currencies separate, and exposes unknowns", async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-spend-"));
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
      const tag = await store.createTag({ name: "spend-worker" });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: tag.id,
        outcome: "Track spend",
        budgetLimitMinor: 1000,
        budgetCurrency: "USD",
      });
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: randomUUID(),
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: "2026-09-30T00:00:00.000Z",
      });
      const route = await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:spend",
      });
      const session = await store.openSession({
        tagId: tag.id,
        sessionKey: objectiveSessionKey(objective.id),
        origin: {},
        objectiveId: objective.id,
        at: "2026-09-30T00:00:00.000Z",
      });
      /** One turn of the Objective's Session: every Attempt under it is that Objective's spend. */
      async function turn(at: string): Promise<string> {
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: {
            tagRouteId: route.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:spend",
          },
          requester: { id: tag.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as const;
        const eventId = randomUUID();
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: tag.id,
          authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          event: {
            eventId,
            logicalEventId: eventId,
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:spend",
            sessionKey: objectiveSessionKey(objective.id),
            actor: { id: tag.id, kind: "bot" },
            internal: { kind: "delivery", from: { kind: "supertag" }, reason: "objective_notice" },
            text: "Spend",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "spend",
              target: { channelId: "spend", threadTs: "spend" },
            },
            source: {},
            metadata: {},
          },
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: tag.id,
          sessionId: session.id,
          execution: {},
          actor: { id: tag.id, kind: "bot" },
          trigger: { origin: "objective_notice" },
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          createdAt: at,
        });
        return task.id;
      }
      const started = [
        "2026-09-30T23:00:00.000Z",
        "2026-10-01T01:00:00.000Z",
        "2026-10-01T02:00:00.000Z",
        "2026-10-01T02:30:00.000Z",
        "2026-10-01T03:00:00.000Z",
      ];
      const usage = (totalTokens: number, cost?: { amountMinor: number; currency: string }) => ({
        usage: {
          inputTokens: totalTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens,
          complete: true,
          ...(cost ? { reportedCost: cost } : {}),
        },
      });
      // Successive cumulative reports per Attempt, oldest first; the latest valid one counts.
      const reports: Array<Array<{ type: string; payload: Record<string, unknown> }>> = [
        [{ type: "usage.updated", payload: usage(2, { amountMinor: 1, currency: "USD" }) }],
        [
          { type: "usage.updated", payload: usage(10, { amountMinor: 7, currency: "USD" }) },
          {
            type: "execution.usage.updated",
            payload: usage(15, { amountMinor: 9, currency: "USD" }),
          },
        ],
        [
          {
            type: "execution.usage.updated",
            payload: usage(20, { amountMinor: 3, currency: "EUR" }),
          },
          {
            type: "execution.usage.updated",
            payload: usage(25, { amountMinor: 4, currency: "EUR" }),
          },
          // Malformed later usage does not replace the latest valid report.
          { type: "usage.updated", payload: { usage: { totalTokens: 99 } } },
        ],
        // Tokens without a price name the unpriced model.
        [
          {
            type: "execution.usage.updated",
            payload: { usage: { ...usage(5).usage, unpricedModel: "gpt-x" } },
          },
        ],
        [],
      ];
      const taskIds: string[] = [];
      for (const [index, at] of started.entries()) {
        const taskId = await turn(at);
        taskIds.push(taskId);
        const attempt = await store.createTaskAttempt({
          taskId,
          attemptNumber: 1,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: at,
        });
        for (const report of reports[index] ?? [])
          await store.appendTaskEvent({ taskId, attemptId: attempt.id, ...report });
      }
      const report = await store.readSpend({ by: "objective", since: "2026-10-01T00:00:00Z" });
      expect(report.groups).toEqual([
        {
          key: objective.id,
          attempts: 4,
          reportedCostByCurrency: { USD: 9, EUR: 4 },
          unknownCostAttempts: 2,
          unpricedModels: { "gpt-x": 1 },
          unpricedTokens: 5,
          reportedTokens: 45,
          unknownTokenAttempts: 1,
          budget: { limitMinor: 1000, currency: "USD" },
        },
      ]);
      expect((await store.readSpend({ by: "tag" })).groups[0]).toMatchObject({
        key: tag.id,
        name: tag.name,
        attempts: 5,
        reportedCostByCurrency: { USD: 10, EUR: 4 },
        reportedTokens: 47,
      });
      expect((await store.readSpend({ by: "day" })).groups.map((group) => group.key)).toEqual([
        "2026-09-30",
        "2026-10-01",
      ]);
      // An Attempt without usage is unknown, never zero.
      expect((await store.readSpend({ since: "2026-10-01T03:00:00Z" })).groups[0]).toMatchObject({
        attempts: 1,
        reportedCostByCurrency: null,
        unknownCostAttempts: 1,
        reportedTokens: null,
        unknownTokenAttempts: 1,
      });
      expect(
        (await store.readSpend({ taskIds: taskIds.slice(0, 2), since: "2026-10-01T00:00:00Z" }))
          .groups[0],
      ).toMatchObject({
        attempts: 1,
        reportedCostByCurrency: { USD: 9 },
      });
      expect((await store.readSpend({ taskIds: [] })).groups).toEqual([]);
      expect(
        await store.readSpend({ objectiveIds: [objective.id], since: "2026-10-01T00:00:00Z" }),
      ).toEqual(report);
      expect((await store.readSpend({ objectiveIds: ["unrelated-objective"] })).groups).toEqual([]);
      expect((await store.readSpend({ objectiveIds: [] })).groups).toEqual([]);
      await expect(store.readSpend({ since: "tomorrow" })).rejects.toThrow("ISO timestamp");
    });
  });
}

for (const provider of ["sqlite", "postgresql"] as const) {
  it(`${provider} reads Objective spend in one query with a constant-size scope`, async () => {
    const { DrizzleSpendStore } = await import("./src/spend-store.js");
    const query = vi.fn(async () => []);
    const store = new DrizzleSpendStore(provider, query);
    await store.readSpend({ objectiveIds: ["objective"], since: "2026-10-01T00:00:00Z" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        `t."objectiveId" IN (${provider === "sqlite" ? "SELECT value FROM json_each(?)" : "SELECT jsonb_array_elements_text($2::jsonb)"})`,
      ),
      ["2026-10-01T00:00:00.000Z", JSON.stringify(["objective"])],
    );
  });
}
