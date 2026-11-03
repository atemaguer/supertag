import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runObjectivePause } from "../apps/cli/src/objective-pause.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  emptyTagContextPlan,
  objectiveResumeSummary,
  parseSurfaceObjectiveCommand,
  TagMessagingError,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective pause and resume`,
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(definition: Record<string, unknown> = {}) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-pause-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        if (isolated) cleanups.push(isolated.cleanup);
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const member = await store.createTag({ name: `member-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Ship the release",
          budgetLimitMinor: 100,
          ...definition,
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id, member.id],
          maxConcurrency: 4,
        });
        const reports: { objectiveId: string; text: string; deliveryKey: string }[] = [];
        const controller = new ObjectiveController(store, undefined);
        controller.setSurfaceReporter(async (objectiveId, text, deliveryKey) => {
          reports.push({ objectiveId, text, deliveryKey });
        });
        const admit = (
          taskId: string,
          options: {
            assignee?: string;
            cost?: number;
            start?: boolean;
            parentTaskId?: string;
            teamId?: string;
          } = {},
        ) => {
          const at = new Date().toISOString();
          const assignee = options.assignee ?? owner.id;
          return store.admitTaskAssignment({
            taskId,
            objectiveId: objective.id,
            teamId: options.teamId ?? team.id,
            requestedByTagId: owner.id,
            assignedTagId: assignee,
            instruction: `Produce ${taskId}`,
            acceptanceCriteria: ["Reviewed"],
            maxCostMinor: options.cost ?? 0,
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            contextPlan: emptyTagContextPlan(at),
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: assignee, name: assignee },
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            ...(options.start ? { startObjectiveExecution: true } : {}),
            ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
          });
        };
        const run = async (taskId: string, leaseOwner = "test") => {
          const claim = await store.claimTaskAssignment({ taskId, leaseOwner });
          if (!claim) throw new Error(`Could not claim ${taskId}`);
          await store.createTaskAttempt({
            taskId,
            attemptNumber: claim.attemptCount,
            workerProfile: { id: "fixture", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          return claim;
        };
        return { store, controller, owner, member, objective, team, reports, admit, run };
      }

      it("refuses new work while paused, lets running Attempts finish, and loses nothing", async () => {
        const f = await fixture();
        const root = await f.admit(`${f.objective.id}:start`, { start: true });
        const running = await f.admit(randomUUID(), { assignee: f.member.id });
        const runningClaim = await f.run(running.taskId);
        const queued = await f.admit(randomUUID(), { assignee: f.member.id });

        const paused = await f.controller.pauseObjective({ objectiveId: f.objective.id });
        expect(paused.changed).toBe(true);
        expect(paused.objective.status).toBe("working");
        expect(Date.parse(paused.objective.pausedAt ?? "")).toBeGreaterThan(0);
        // Repeating is harmless.
        expect((await f.controller.pauseObjective({ objectiveId: f.objective.id })).changed).toBe(
          false,
        );

        // New Tasks are refused; queued Tasks wait instead of starting.
        await expect(f.admit(randomUUID(), { assignee: f.member.id })).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining("paused"),
        });
        expect(await f.store.claimTaskAssignment({ taskId: queued.taskId, leaseOwner: "t" })).toBe(
          undefined,
        );
        // The running Attempt keeps its authority and settles.
        await f.store.settleTaskAssignment({
          taskId: running.taskId,
          leaseOwner: "test",
          attemptCount: runningClaim.attemptCount,
          result: { text: "Done" },
        });
        expect((await f.store.getTaskAssignment(running.taskId))?.status).toBe("submitted");
        // Messages wait unadmitted rather than failing.
        await f.controller.messageObjective({ objectiveId: f.objective.id, message: "Status?" });
        expect(await f.store.admitMailboxTaskAssignments()).toEqual([]);
        expect((await f.store.getTaskAssignment(queued.taskId))?.status).toBe("queued");
        expect((await f.store.getTaskAssignment(root.taskId))?.status).not.toBe("cancelled");

        const overview = await f.controller.readObjectiveOverview({ objectiveId: f.objective.id });
        expect(overview.attention).toContainEqual(
          expect.objectContaining({
            kind: "objective_paused",
            nextAction: `supertag resume objective ${f.objective.id}`,
          }),
        );
        expect(overview.attention.map((item) => item.kind)).not.toContain("no_scheduled_follow_up");
        const changes = await f.store.listResourceChanges?.({
          resourceType: "objective",
          resourceId: f.objective.id,
        });
        expect(changes?.at(-1)?.changes).toEqual({
          pausedAt: { previous: null, next: paused.objective.pausedAt },
        });
      });

      it("resumes and wakes the owner with a summary of what changed while paused", async () => {
        const f = await fixture();
        await f.admit(`${f.objective.id}:start`, { start: true });
        const running = await f.admit(randomUUID(), { assignee: f.member.id });
        const claim = await f.run(running.taskId);
        const queued = await f.admit(randomUUID(), { assignee: f.member.id });
        const { objective: paused } = await f.controller.pauseObjective({
          objectiveId: f.objective.id,
        });
        await f.store.settleTaskAssignment({
          taskId: running.taskId,
          leaseOwner: "test",
          attemptCount: claim.attemptCount,
          result: { text: "Done" },
        });

        const resumed = await f.controller.resumeObjective({ objectiveId: f.objective.id });
        expect(resumed.changed).toBe(true);
        expect(resumed.objective.pausedAt).toBeNull();
        expect(resumed.summary).toContain(`It was paused from ${paused.pausedAt}`);
        expect(resumed.summary).toContain(`- ${running.taskId}: submitted`);
        const wakes = (await f.store.listTagMessages(f.owner.id)).filter((message) =>
          message.idempotencyKey.startsWith(`objective-resumed:${f.objective.id}:`),
        );
        expect(wakes).toHaveLength(1);
        expect(wakes[0]).toMatchObject({ status: "pending", objectiveId: f.objective.id });
        expect(String(wakes[0]?.body["message"])).toBe(resumed.summary);
        // Work that waited may start again.
        expect(
          await f.store.claimTaskAssignment({ taskId: queued.taskId, leaseOwner: "t" }),
        ).toBeDefined();
        // Resuming a running Objective changes nothing and sends no second wake.
        const again = await f.controller.resumeObjective({ objectiveId: f.objective.id });
        expect(again).toMatchObject({ changed: false, summary: null });
      });

      it("is operator-only and refuses closed Objectives", async () => {
        const f = await fixture();
        const narrow = { operatorId: "reader", scopes: { actions: ["send_message"] } };
        await expect(
          f.controller.pauseObjective({ objectiveId: f.objective.id }, narrow),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.controller.resumeObjective({ objectiveId: f.objective.id }, narrow),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.controller.cancelObjective({ objectiveId: f.objective.id });
        await expect(
          f.controller.pauseObjective({ objectiveId: f.objective.id }),
        ).rejects.toBeInstanceOf(TagMessagingError);
      });
    },
  );
}

describe("Objective pause commands", () => {
  const mention = (text: string) =>
    ({ provider: "slack", kind: "mention", actor: { kind: "user", id: "U1" }, text }) as never;

  it("parses @SuperTag pause and resume in a surface thread", () => {
    expect(parseSurfaceObjectiveCommand(mention("@SuperTag pause"))).toEqual({ kind: "pause" });
    expect(parseSurfaceObjectiveCommand(mention("<@U0ABC> resume."))).toEqual({ kind: "resume" });
    expect(parseSurfaceObjectiveCommand(mention("@SuperTag pause now"))).toBeUndefined();
  });

  it("calls the pause and resume endpoints and prints one line", async () => {
    const calls: string[] = [];
    const client = {
      request: async <T>(path: string) => {
        calls.push(path);
        return { status: { changed: true } } as T;
      },
    };
    expect(await runObjectivePause(client, "pause", ["ship"])).toContain(
      "supertag resume objective ship",
    );
    expect(await runObjectivePause(client, "resume", ["ship"])).toContain("resumed");
    expect(calls).toEqual(["/api/v1/objectives/ship/pause", "/api/v1/objectives/ship/resume"]);
    await expect(runObjectivePause(client, "pause", [])).rejects.toThrow(
      "Usage: supertag pause objective ID",
    );
  });

  it("names at most ten changed Tasks in the resume summary", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      taskId: `t${String(index).padStart(2, "0")}`,
      status: "accepted" as const,
      updatedAt: "2026-01-01T00:30:00.000Z",
    }));
    const summary = objectiveResumeSummary(
      { id: "ship", updatedAt: "2026-01-01T01:00:00.000Z" },
      "2026-01-01T00:00:00.000Z",
      [...tasks, { taskId: "q", status: "queued", updatedAt: "2025-12-31T00:00:00.000Z" }],
    );
    expect(summary).toContain("12 Tasks changed while it was paused:");
    expect(summary).toContain("- and 2 more");
    expect(summary).toContain("1 queued or waiting Task may start again.");
  });
});
