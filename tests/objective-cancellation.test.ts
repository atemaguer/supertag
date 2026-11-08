import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { objectiveReportKey } from "../packages/control-plane/src/outbound-presentation.js";
import {
  objectiveCancellationNotice,
  parseObjectiveStatus,
  TagMessagingError,
} from "../packages/core/src/index.js";
import {
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { startObjectiveSession } from "./support/objective-session.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/** A Worker that answers each turn, holding it while the Objective's outcome says HOLD. */
function scriptedWorklet() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worklet: Worklet = {
    id: "cancel-worklet",
    describe: async () => ({
      id: "cancel-worklet",
      protocolVersion: 1,
      host: {
        id: "cancel-host",
        workers: [
          {
            id: "cancel-worker",
            type: "deterministic",
            profiles: [{ id: "default", revision: "1" }],
            capabilities: [SURFACE_COORDINATION_CAPABILITY],
            contextTypes: [],
            maxConcurrency: 4,
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: [SURFACE_COORDINATION_CAPABILITY],
                contextTypes: [],
              },
            ],
          },
        ],
      },
    }),
    selectPlacement: async () => ({
      workerHostId: "cancel-host",
      workletId: "cancel-worklet",
      workerId: "cancel-worker",
      workerProfile: { id: "default", revision: "1" },
    }),
    async *execute(spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> {
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...identity, type: "execution.started", workerId: "cancel-worker" };
      if (spec.input.messages.some((message) => message.text.includes("HOLD"))) await blocked;
      yield {
        ...identity,
        type: "output.message",
        message: { role: "teammate", text: "Working on it" },
      };
      yield { ...identity, type: "execution.completed" };
    },
  };
  return { worklet, release: () => release() };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective cancellation`,
    { timeout: 60_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(outcome = "Ship the release") {
        const directory = await mkdtemp(join(tmpdir(), "supertag-cancel-"));
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
        const script = scriptedWorklet();
        const controlPlane = new ControlPlane({
          store: new DrizzleStore({ url }),
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          worklet: script.worklet,
          reply: async () => ({ externalMessageId: randomUUID() }),
          dispatch: { pollIntervalMs: 10, retryBaseMs: 50, maxAttempts: 1 },
        });
        await controlPlane.start();
        cleanups.push(() => controlPlane.stop());
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const member = await store.createTag({ name: `member-${randomUUID()}` });
        for (const tag of [owner, member]) await store.bindTagWorkerHost(tag.id, "cancel-host");
        const session = await startObjectiveSession({
          store,
          controlPlane,
          ownerTagId: owner.id,
          memberTagIds: [member.id],
          objective: { outcome, budgetLimitMinor: 100 },
        });
        /** The inbound event the Objective's notices are posted on: its first turn's. */
        const anchor = async () =>
          (await store.findTaskById(session.startTaskId))?.inboundEventId ?? "";
        return { store, controlPlane, owner, member, script, session, anchor };
      }

      it("cancels every open Task of the Objective's Sessions and says why", async () => {
        const f = await fixture("Ship the release; HOLD until released");
        const running = await f.session.waitForOwnerTurn({
          reason: "objective_start",
          unsettled: true,
        });
        await expect
          .poll(async () => (await f.store.findTaskById(running.task.id))?.status, {
            timeout: 10_000,
          })
          .toBe("running");
        // A second turn waits behind it, as one Session runs one turn at a time.
        const waiting = await f.controlPlane.messageObjective({
          objectiveId: f.session.objective.id,
          text: "Status?",
          operatorId: "admin",
          idempotencyKey: "status",
        });
        expect((await f.store.findTaskById(waiting.taskId))?.status).toBe("pending");

        const result = await f.controlPlane.objectives.cancelObjective({
          objectiveId: f.session.objective.id,
          reason: "The launch moved to next quarter",
        });
        expect(result.changed).toBe(true);
        expect(new Set(result.cancelledTaskIds)).toEqual(
          new Set([running.task.id, waiting.taskId]),
        );
        const objective = await f.store.getObjective(f.session.objective.id);
        expect(objective).toMatchObject({
          status: "cancelled",
          cancellationReason: "The launch moved to next quarter",
          revision: f.session.objective.revision + 1,
        });
        expect(Date.parse(objective.cancelledAt ?? "")).toBeGreaterThan(0);
        // The waiting turn is cancelled outright; the running one stops.
        await expect
          .poll(async () => (await f.store.findTaskById(waiting.taskId))?.status, {
            timeout: 10_000,
          })
          .toBe("cancelled");
        f.script.release();
        await expect
          .poll(async () => await f.store.listOpenObjectiveTaskIds(f.session.objective.id), {
            timeout: 10_000,
          })
          .toEqual([]);

        // The reason is posted once to the Objective's thread.
        const key = objectiveReportKey(f.session.objective.id, "objective-cancelled");
        const posted = await f.store.findOutboundReply(await f.anchor(), key);
        expect(posted?.text).toBe(objectiveCancellationNotice(objective));

        const overview = await f.controlPlane.objectives.readObjectiveOverview({
          objectiveId: f.session.objective.id,
        });
        expect(overview.attention).toContainEqual(
          expect.objectContaining({
            kind: "objective_cancelled",
            message: expect.stringContaining("The launch moved to next quarter"),
            observedAt: objective.cancelledAt,
          }),
        );
        const changes = await f.store.listResourceChanges?.({
          resourceType: "objective",
          resourceId: f.session.objective.id,
        });
        expect(changes?.at(-1)?.changes).toMatchObject({
          status: { previous: "working", next: "cancelled" },
        });
      });

      it("admits no new turn of a cancelled Objective", async () => {
        const f = await fixture();
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        await f.controlPlane.objectives.cancelObjective({ objectiveId: f.session.objective.id });
        await expect(
          f.controlPlane.messageObjective({
            objectiveId: f.session.objective.id,
            text: "Try again",
            operatorId: "admin",
            idempotencyKey: "retry",
          }),
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cancelled/) });
        await expect(
          f.controlPlane.objectives.approveObjective({ objectiveId: f.session.objective.id }),
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cancelled/) });
      });

      it("is idempotent and refuses a completed Objective", async () => {
        const f = await fixture();
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        const first = await f.controlPlane.objectives.cancelObjective({
          objectiveId: f.session.objective.id,
        });
        const second = await f.controlPlane.objectives.cancelObjective({
          objectiveId: f.session.objective.id,
          reason: "Again",
        });
        expect(second.changed).toBe(false);
        expect(second.cancelledTaskIds).toEqual([]);
        expect(second.objective).toMatchObject({
          status: "cancelled",
          cancelledAt: first.objective.cancelledAt,
          cancellationReason: null,
          revision: first.objective.revision,
        });

        const done = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Already finished",
        });
        await f.store.updateObjectiveStatus(done.id, {
          status: "completed",
          expectedRevision: done.revision,
          completionSummary: "Finished",
        });
        await expect(
          f.controlPlane.objectives.cancelObjective({ objectiveId: done.id }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: "A completed Objective cannot be cancelled",
        });
        await expect(
          f.controlPlane.objectives.cancelObjective({ objectiveId: "missing" }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("keeps cancellation away from AI actors and status updates", async () => {
        const f = await fixture();
        const objective = f.session.objective;
        expect(() => parseObjectiveStatus({ status: "cancelled", expectedRevision: 1 })).toThrow(
          TagMessagingError,
        );
        // Neither the owner's update_objective tool nor an operator status update can cancel.
        await expect(
          f.store.updateObjectiveStatus(
            objective.id,
            { status: "cancelled" as never, expectedRevision: objective.revision },
            f.owner.id,
          ),
        ).rejects.toMatchObject({ statusCode: 400 });
        // Scoped operators need the cancel_objective action and Objective-wide scope.
        for (const scopes of [
          { actions: ["update_objective"] },
          { actions: ["cancel_objective"], objectiveIds: ["another"] },
        ])
          await expect(
            f.controlPlane.objectives.cancelObjective(
              { objectiveId: objective.id },
              { operatorId: "scoped", scopes },
            ),
          ).rejects.toMatchObject({ statusCode: 403 });
        expect((await f.store.getObjective(objective.id)).status).toBe("working");
        await f.controlPlane.objectives.cancelObjective(
          { objectiveId: objective.id },
          { operatorId: "scoped", scopes: { actions: ["cancel_objective"] } },
        );
        // A cancelled Objective is terminal.
        const cancelled = await f.store.getObjective(objective.id);
        await expect(
          f.store.updateObjectiveStatus(objective.id, {
            status: "working",
            expectedRevision: cancelled.revision,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });

      it("settles the leftovers of an Objective completed outside the Control Plane", async () => {
        const f = await fixture("Ship the release; HOLD until released");
        const running = await f.session.waitForOwnerTurn({
          reason: "objective_start",
          unsettled: true,
        });
        const waiting = await f.controlPlane.messageObjective({
          objectiveId: f.session.objective.id,
          text: "Status?",
          operatorId: "admin",
          idempotencyKey: "status",
        });
        // A completion recorded in the store alone leaves the open Tasks behind.
        await f.store.updateObjectiveStatus(
          f.session.objective.id,
          {
            status: "completed",
            expectedRevision: (await f.store.getObjective(f.session.objective.id)).revision,
            completionSummary: "Finished",
          },
          f.owner.id,
        );
        expect(new Set(await f.store.listOpenObjectiveTaskIds(f.session.objective.id))).toEqual(
          new Set([running.task.id, waiting.taskId]),
        );
        const settled = await f.controlPlane.objectives.settleClosedObjective(
          f.session.objective.id,
        );
        expect(new Set(settled.cancelledTaskIds)).toEqual(
          new Set([running.task.id, waiting.taskId]),
        );
        f.script.release();
        await expect
          .poll(async () => await f.store.listOpenObjectiveTaskIds(f.session.objective.id), {
            timeout: 10_000,
          })
          .toEqual([]);
        // An open Objective has nothing to settle.
        const open = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Still running",
        });
        expect(await f.controlPlane.objectives.settleClosedObjective(open.id)).toEqual({
          cancelledTaskIds: [],
        });
      });
    },
  );
}
