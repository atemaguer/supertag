import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runObjectivePause } from "../apps/cli/src/objective-pause.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  objectiveResumeSummary,
  parseSurfaceObjectiveCommand,
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

/**
 * A Worker that answers every turn with "Working on it", holding the turn while the Objective's
 * outcome says HOLD, so a test can keep one Task Attempt running across a pause.
 */
function scriptedWorklet() {
  const seen: TaskAttemptSpec[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worklet: Worklet = {
    id: "pause-worklet",
    describe: async () => ({
      id: "pause-worklet",
      protocolVersion: 1,
      host: {
        id: "pause-host",
        workers: [
          {
            id: "pause-worker",
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
      workerHostId: "pause-host",
      workletId: "pause-worklet",
      workerId: "pause-worker",
      workerProfile: { id: "default", revision: "1" },
    }),
    async *execute(spec): AsyncIterable<TaskAttemptEvent> {
      seen.push(spec);
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...identity, type: "execution.started", workerId: "pause-worker" };
      const prompt = spec.input.messages.map((message) => message.text).join("\n");
      if (prompt.includes("HOLD")) await blocked;
      yield {
        ...identity,
        type: "output.message",
        message: { role: "teammate", text: "Working on it" },
      };
      yield { ...identity, type: "execution.completed" };
    },
  };
  return { worklet, seen, release: () => release() };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective pause and resume`,
    { timeout: 60_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(outcome = "Ship the release") {
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
        for (const tag of [owner, member]) await store.bindTagWorkerHost(tag.id, "pause-host");
        const session = await startObjectiveSession({
          store,
          controlPlane,
          ownerTagId: owner.id,
          memberTagIds: [member.id],
          objective: { outcome, budgetLimitMinor: 100 },
        });
        return { store, controlPlane, owner, member, script, session };
      }

      it("holds every turn of a paused Objective and loses nothing", async () => {
        const f = await fixture();
        const first = await f.session.waitForOwnerTurn({ reason: "objective_start" });
        expect(first.task.status).toBe("completed");

        const paused = await f.controlPlane.objectives.pauseObjective({
          objectiveId: f.session.objective.id,
        });
        expect(paused.changed).toBe(true);
        expect(paused.objective.status).toBe("working");
        expect(Date.parse(paused.objective.pausedAt ?? "")).toBeGreaterThan(0);
        // Repeating is harmless.
        expect(
          (
            await f.controlPlane.objectives.pauseObjective({
              objectiveId: f.session.objective.id,
            })
          ).changed,
        ).toBe(false);

        // An operator's message is admitted and kept, but its turn does not run while paused.
        const sent = await f.controlPlane.messageObjective({
          objectiveId: f.session.objective.id,
          text: "Status?",
          operatorId: "admin",
          idempotencyKey: "status",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await f.store.findTaskById(sent.taskId))?.status).toBe("pending");
        const held = await f.store.findTaskById(sent.taskId);
        expect((await f.store.findInboundEventById(held?.inboundEventId ?? ""))?.status).toBe(
          "pending",
        );
        // Nothing of the Objective was cancelled.
        expect(await f.store.listOpenObjectiveTaskIds(f.session.objective.id)).toEqual([
          sent.taskId,
        ]);

        const overview = await f.controlPlane.objectives.readObjectiveOverview({
          objectiveId: f.session.objective.id,
        });
        expect(overview.attention).toContainEqual(
          expect.objectContaining({
            kind: "objective_paused",
            nextAction: `supertag resume objective ${f.session.objective.id}`,
          }),
        );
        const changes = await f.store.listResourceChanges?.({
          resourceType: "objective",
          resourceId: f.session.objective.id,
        });
        expect(changes?.at(-1)?.changes).toEqual({
          pausedAt: { previous: null, next: paused.objective.pausedAt },
        });
      });

      it("lets a running Task Attempt of a paused Objective finish", async () => {
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
        await f.controlPlane.objectives.pauseObjective({ objectiveId: f.session.objective.id });
        f.script.release();
        await expect
          .poll(async () => (await f.store.findTaskById(running.task.id))?.status, {
            timeout: 10_000,
          })
          .toBe("completed");
      });

      it("resumes and tells the Objective what changed while it was paused", async () => {
        const f = await fixture();
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        const { objective: paused } = await f.controlPlane.objectives.pauseObjective({
          objectiveId: f.session.objective.id,
        });
        const sent = await f.controlPlane.messageObjective({
          objectiveId: f.session.objective.id,
          text: "Status?",
          operatorId: "admin",
          idempotencyKey: "status",
        });

        const resumed = await f.controlPlane.objectives.resumeObjective({
          objectiveId: f.session.objective.id,
        });
        expect(resumed.changed).toBe(true);
        expect(resumed.objective.pausedAt).toBeNull();
        expect(resumed.summary).toContain(`It was paused from ${paused.pausedAt}`);
        expect(resumed.summary).toContain("waiting Task");
        // The summary reaches the Objective's own conversation as SuperTag's next message.
        const notice = await f.session.waitForOwnerTurn({
          reason: "objective_message",
          from: "supertag",
        });
        const event = await f.store.findInboundEventById(notice.task.inboundEventId ?? "");
        expect(event?.event.text).toBe(resumed.summary);
        // The message that waited runs now.
        await expect
          .poll(async () => (await f.store.findTaskById(sent.taskId))?.status, { timeout: 10_000 })
          .toBe("completed");
        // Resuming a running Objective changes nothing and delivers no second notice.
        expect(
          await f.controlPlane.objectives.resumeObjective({
            objectiveId: f.session.objective.id,
          }),
        ).toMatchObject({ changed: false, summary: null });
      });

      it("is operator-only and refuses closed Objectives", async () => {
        const f = await fixture();
        const narrow = { operatorId: "reader", scopes: { actions: ["send_message"] } };
        await expect(
          f.controlPlane.objectives.pauseObjective({ objectiveId: f.session.objective.id }, narrow),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.controlPlane.objectives.resumeObjective(
            { objectiveId: f.session.objective.id },
            narrow,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.controlPlane.objectives.cancelObjective({ objectiveId: f.session.objective.id });
        await expect(
          f.controlPlane.objectives.pauseObjective({ objectiveId: f.session.objective.id }),
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

  it("calls PauseObjective and ResumeObjective and prints one line", async () => {
    const calls: string[] = [];
    const answer = (method: string) => async (request: { readonly id: string }) => {
      calls.push(`${method} ${request.id}`);
      return { changed: true } as never;
    };
    const client = { pauseObjective: answer("pause"), resumeObjective: answer("resume") };
    expect(await runObjectivePause(client, "pause", ["ship"])).toContain(
      "supertag resume objective ship",
    );
    expect(await runObjectivePause(client, "resume", ["ship"])).toContain("resumed");
    expect(calls).toEqual(["pause ship", "resume ship"]);
    await expect(runObjectivePause(client, "pause", [])).rejects.toThrow(
      "Usage: supertag pause objective ID",
    );
  });

  it("names at most ten changed Tasks in the resume summary", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      id: `t${String(index).padStart(2, "0")}`,
      status: "completed" as const,
      updatedAt: "2026-01-01T00:30:00.000Z",
    }));
    const summary = objectiveResumeSummary(
      { id: "ship", updatedAt: "2026-01-01T01:00:00.000Z" },
      "2026-01-01T00:00:00.000Z",
      [...tasks, { id: "q", status: "pending", updatedAt: "2025-12-31T00:00:00.000Z" }],
    );
    expect(summary).toContain("12 Tasks changed while it was paused:");
    expect(summary).toContain("- and 2 more");
    expect(summary).toContain("1 waiting Task may start now.");
  });
});
