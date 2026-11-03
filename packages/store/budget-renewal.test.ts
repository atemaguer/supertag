import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import type { AdmitTaskAssignmentInput } from "../core/src/index.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} budget renewal`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-coordination-metrics-"));
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
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const worker = await store.createTag({ name: `worker-${randomUUID()}` });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Measure coordination",
        budgetCurrency: "USD",
        budgetLimitMinor: 1000,
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Metrics Team",
        leadTagId: owner.id,
        memberTagIds: [worker.id],
        maxConcurrency: 1_000,
      });
      const assignment = (taskId: string, requiresApproval = false): AdmitTaskAssignmentInput => ({
        taskId,
        objectiveId: objective.id,
        teamId: team.id,
        requestedByTagId: owner.id,
        assignedTagId: worker.id,
        instruction: `Measure ${taskId}`,
        acceptanceCriteria: ["Recorded"],
        requiresApproval,
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: new Date().toISOString(),
          tag: { id: worker.id, name: worker.name },
          origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      return { store, owner, worker, objective, assignment };
    }

    async function exhaust(f: Awaited<ReturnType<typeof fixture>>, id: string, own = false) {
      const input = f.assignment(id);
      await f.store.admitTaskAssignment({
        ...input,
        ...(own
          ? {
              assignedTagId: f.owner.id,
              authorizationSnapshot: {
                ...input.authorizationSnapshot,
                tag: { id: f.owner.id, name: f.owner.name },
              },
            }
          : {}),
        execution: { limits: { maxReportedTokens: 1000 } },
      });
      await f.store.claimTaskAssignment({ taskId: id, leaseOwner: "test" });
      await f.store.settleTaskAssignment({
        taskId: id,
        leaseOwner: "test",
        attemptCount: 1,
        failed: true,
        result: {
          failureKind: "budget-exhausted",
          budgetExhaustion: { requiresAuthorization: true },
        },
      });
    }
    it("reserves new cost without erasing prior charges or weakening native-agent controls", async () => {
      const f = await fixture();
      const id = "money";
      await f.store.admitTaskAssignment({
        ...f.assignment(id),
        maxCostMinor: 100,
        execution: {
          limits: { maxNativeAgents: 0, maxReportedCost: { amountMinor: 100, currency: "USD" } },
        },
      });
      await f.store.claimTaskAssignment({ taskId: id, leaseOwner: "test" });
      await f.store.settleTaskAssignment({
        taskId: id,
        leaseOwner: "test",
        attemptCount: 1,
        failed: true,
        result: { failureKind: "budget-exhausted" },
      });
      const base = { expectedStatus: "failed", status: "queued" } as const;
      await expect(
        f.store.updateTaskAssignment(
          id,
          { ...base, executionLimits: { maxReportedTokens: 1000 } },
          f.owner.id,
        ),
      ).rejects.toThrow("every existing budget dimension");
      await expect(
        f.store.updateTaskAssignment(
          id,
          {
            ...base,
            executionLimits: {
              maxNativeAgents: 1,
              maxReportedCost: { amountMinor: 200, currency: "USD" },
            },
          },
          f.owner.id,
        ),
      ).rejects.toThrow("native-agent");
      await expect(
        f.store.updateTaskAssignment(
          id,
          { ...base, executionLimits: { maxReportedCost: { amountMinor: 1000, currency: "USD" } } },
          f.owner.id,
        ),
      ).rejects.toThrow("Objective budget exhausted");
      await f.store.updateTaskAssignment(
        id,
        { ...base, executionLimits: { maxReportedCost: { amountMinor: 200, currency: "USD" } } },
        f.owner.id,
      );
      expect(await f.store.getObjective(f.objective.id)).toMatchObject({
        spentMinor: 100,
        reservedMinor: 200,
      });
      expect((await f.store.findTaskById(id))?.execution.limits?.maxNativeAgents).toBe(0);
      expect(await f.store.claimTaskAssignment({ taskId: id, leaseOwner: "again" })).toMatchObject({
        chargedMinor: 300,
        attemptCount: 2,
      });
      expect(await f.store.getObjective(f.objective.id)).toMatchObject({
        spentMinor: 300,
        reservedMinor: 0,
      });
    });
    it("returns only the renewed reservation on cancellation and keeps prior spending", async () => {
      const f = await fixture();
      const id = "cancel-renewal";
      await f.store.admitTaskAssignment({
        ...f.assignment(id),
        maxCostMinor: 100,
        execution: { limits: { maxReportedCost: { amountMinor: 100, currency: "USD" } } },
      });
      await f.store.claimTaskAssignment({ taskId: id, leaseOwner: "test" });
      await f.store.settleTaskAssignment({
        taskId: id,
        leaseOwner: "test",
        attemptCount: 1,
        failed: true,
        result: { failureKind: "budget-exhausted" },
      });
      await f.store.updateTaskAssignment(
        id,
        {
          expectedStatus: "failed",
          status: "queued",
          executionLimits: { maxReportedCost: { amountMinor: 50, currency: "USD" } },
        },
        f.owner.id,
      );
      await f.store.updateTaskAssignment(
        id,
        { expectedStatus: "queued", status: "cancelled" },
        f.owner.id,
      );
      expect(await f.store.getObjective(f.objective.id)).toMatchObject({
        spentMinor: 100,
        reservedMinor: 0,
      });
      expect((await f.store.getTaskAssignment(id))?.result).toMatchObject({
        budgetRenewal: { previousChargedMinor: 100 },
      });
    });
    it("requires explicit authorized allocation and preserves Session identity and history", async () => {
      const f = await fixture();
      await exhaust(f, "renew");
      const before = await f.store.findTaskById("renew");
      await expect(
        f.store.updateTaskAssignment(
          "renew",
          { expectedStatus: "failed", status: "queued" },
          f.owner.id,
        ),
      ).rejects.toThrow("explicit executionLimits");
      await expect(
        f.store.updateTaskAssignment(
          "renew",
          {
            expectedStatus: "failed",
            status: "queued",
            executionLimits: { maxReportedTokens: 1000 },
          },
          f.worker.id,
        ),
      ).rejects.toThrow();
      const updated = await f.store.updateTaskAssignment(
        "renew",
        {
          expectedStatus: "failed",
          status: "queued",
          executionLimits: { maxReportedTokens: 1000 },
        },
        f.owner.id,
      );
      expect(updated.status).toBe("queued");
      expect(updated.attemptCount).toBe(1);
      expect((await f.store.findTaskById("renew"))?.sessionId).toBe(before?.sessionId);
      expect(
        (await f.store.listTaskEvents("renew")).filter((e) => e.type === "task.budget-renewed"),
      ).toHaveLength(1);
      await expect(
        f.store.updateTaskAssignment(
          "renew",
          {
            expectedStatus: "failed",
            status: "queued",
            executionLimits: { maxReportedTokens: 2000 },
          },
          f.owner.id,
        ),
      ).rejects.toThrow();
      expect(
        (await f.store.claimTaskAssignment({ taskId: "renew", leaseOwner: "test2" }))?.attemptCount,
      ).toBe(2);
    });
    it("denies a manager renewing its own budget but permits the authenticated operator", async () => {
      const f = await fixture();
      await exhaust(f, "self", true);
      const update = {
        expectedStatus: "failed",
        status: "queued",
        executionLimits: { maxReportedTokens: 500 },
      } as const;
      await expect(f.store.updateTaskAssignment("self", update, f.owner.id)).rejects.toThrow(
        "own budget",
      );
      expect(
        (await f.store.updateTaskAssignment("self", update, f.owner.id, { administrator: true }))
          .status,
      ).toBe("queued");
    });
  });
}
