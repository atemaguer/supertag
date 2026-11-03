import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.ts";
import { describeTaskExecution } from "../apps/cli/src/resources.ts";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment } from "../packages/core/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  NATIVE_AGENT_LIMIT_CAPABILITY,
  REPORTED_COST_LIMIT_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/** A Worker that advertises a profile per harness and never runs anything. */
function advertisingWorker(): Worker {
  const codex = { id: "local-codex", revision: "1" };
  const claude = { id: "local-claude-code", revision: "1" };
  return {
    describe: async () => ({
      id: "host/worker",
      type: "test",
      profiles: [codex, claude],
      capabilities: [COORDINATION_CAPABILITY],
      contextTypes: [],
      profileCapabilities: [
        {
          profile: codex,
          harness: "codex",
          models: ["gpt-6-sol", "gpt-6-max"],
          efforts: ["low", "medium", "high"],
          capabilities: [COORDINATION_CAPABILITY, NATIVE_AGENT_LIMIT_CAPABILITY],
          contextTypes: [],
        },
        {
          profile: claude,
          harness: "claude-code",
          models: ["claude-opus-5-5"],
          efforts: ["low", "medium", "high"],
          capabilities: [COORDINATION_CAPABILITY, REPORTED_COST_LIMIT_CAPABILITY],
          contextTypes: [],
        },
      ],
    }),
    // biome-ignore lint/correctness/useYield: never scheduled in these tests.
    async *execute() {
      throw new Error("not scheduled");
    },
  } as unknown as Worker;
}

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} execution selection at assignment`,
    () => {
      const cleanups: (() => Promise<unknown> | unknown)[] = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(options: { readonly connected?: boolean } = {}) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-execution-selection-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const { createIsolatedPostgresDatabase } = await import("./support/database.js");
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const role = await store.createRole({
          name: `Builder ${randomUUID()}`,
          purpose: "Build changes.",
          execution: {
            harness: "codex",
            model: ["gpt-6-sol", "gpt-6-max"],
            effort: ["medium", "high"],
          },
        });
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const builder = await store.createTag({ name: `builder-${randomUUID()}` });
        await store.assignRole({ roleId: role.id, tagId: builder.id });
        for (const tag of [owner, builder]) await store.bindTagWorkerHost(tag.id, "host");
        const objective = await store.createObjective({
          id: `objective-${randomUUID().slice(0, 8)}`,
          ownerTagId: owner.id,
          outcome: "Ship the change.",
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Delivery",
          leadTagId: owner.id,
          memberTagIds: [builder.id],
          maxConcurrency: 4,
        });
        const worklet = new LocalWorklet(
          "w",
          "host",
          options.connected === false ? [] : [advertisingWorker()],
        );
        const controller = new ObjectiveController(store, durableTestWorklet(worklet));
        controller.activateCoordination({ url: "http://127.0.0.1:1" });
        cleanups.push(() => controller.stop());
        const assign = async (extra: Record<string, unknown> = {}) =>
          (await controller.command("assign_task", {
            objectiveId: objective.id,
            taskId: randomUUID(),
            teamId: team.id,
            assignedTagId: builder.id,
            instruction: "Change the code",
            acceptanceCriteria: ["Changed"],
            ...extra,
          })) as TaskAssignment;
        const execution = async (task: TaskAssignment) =>
          (await store.findTaskById(task.taskId))?.execution;
        const resolved = async (task: TaskAssignment) =>
          (await store.listTaskEvents(task.taskId)).find(
            (event) => event.type === "task.execution-resolved",
          )?.payload;
        /** Settles a Task as if its Attempt ran: failed with an error, or submitted. */
        const finish = async (task: TaskAssignment, outcome: { error?: string }) => {
          const claimed = await store.claimTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "test",
          });
          if (!claimed) throw new Error("Task was not claimable");
          return store.settleTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "test",
            attemptCount: claimed.attemptCount,
            ...(outcome.error === undefined
              ? { result: { text: "done" } }
              : { failed: true, result: { error: outcome.error } }),
          });
        };
        return { store, controller, owner, builder, assign, execution, resolved, finish };
      }

      it("records the defaults: the Tag's settings, then its Role's", async () => {
        const f = await fixture();
        const task = await f.assign();
        expect(await f.execution(task)).toEqual({
          harness: "codex",
          model: "gpt-6-sol",
          effort: "medium",
        });
        expect(await f.resolved(task)).toMatchObject({ source: "default", model: "gpt-6-sol" });
        await f.store.setTagExecution(f.builder.id, { effort: ["high"] });
        expect(await f.execution(await f.assign())).toMatchObject({
          model: "gpt-6-sol",
          effort: "high",
        });
      });

      it("starts at low effort with every effort allowed when nothing sets one", async () => {
        const f = await fixture();
        const task = await f.assign({ assignedTagId: f.owner.id });
        expect(await f.execution(task)).toEqual({ effort: "low" });
        expect(await f.resolved(task)).toMatchObject({ source: "default", effort: "low" });
        const high = await f.assign({ assignedTagId: f.owner.id, execution: { effort: "high" } });
        expect(await f.execution(high)).toEqual({ effort: "high" });
      });

      it("records a self-escalation, wakes the Task at once, and caps escalations per Task", async () => {
        const f = await fixture();
        const task = await f.assign();
        await expect(
          f.controller.command("escalate_task", {
            objectiveId: task.objectiveId,
            effort: "high",
            reason: "Operators cannot escalate",
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const escalate = async (effort: "medium" | "high", maxEscalations = 2) => {
          const claimed = await f.store.claimTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "test",
          });
          if (!claimed) throw new Error("Task was not claimable");
          const escalated = await f.store.escalateTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "test",
            attemptCount: claimed.attemptCount,
            execution: { harness: "codex", model: "gpt-6-sol", effort },
            change: `effort → ${effort}`,
            reason: "Harder than it looked",
            maxEscalations,
          });
          return { claimed, escalated };
        };
        const { claimed, escalated } = await escalate("high");
        expect(escalated.waitState).toMatchObject({
          attemptCount: claimed.attemptCount,
          escalation: { change: "effort → high", byTagId: f.builder.id },
        });
        expect(await f.execution(task)).toMatchObject({ effort: "high" });
        // A second request in the same Attempt is refused; the Attempt is already stopping.
        await expect(
          f.store.escalateTaskAssignment({
            taskId: task.taskId,
            leaseOwner: "test",
            attemptCount: claimed.attemptCount,
            execution: { effort: "medium" },
            change: "effort → medium",
            reason: "Again",
            maxEscalations: 2,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "test",
          attemptCount: claimed.attemptCount,
          result: { text: "Execution suspended until its durable wait condition is satisfied" },
        });
        expect((await f.store.getTaskAssignment(task.taskId))?.status).toBe("waiting");
        await f.store.wakeWaitingTaskAssignments();
        expect(await f.store.getTaskAssignment(task.taskId)).toMatchObject({
          status: "queued",
          waitState: { wake: { reason: "escalated" } },
        });
        await expect(escalate("medium", 1)).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining("This Task already escalated 1 time, the most allowed"),
        });
        expect(
          (await f.store.listTaskEvents(task.taskId))
            .filter((event) => event.type === "task.self-escalated")
            .map((event) => event.payload),
        ).toMatchObject([
          { change: "effort → high", reason: "Harder than it looked", escalation: 1 },
        ]);
      });

      it("accepts a model and effort within the range and refuses others with the allowed values", async () => {
        const f = await fixture();
        const task = await f.assign({ execution: { model: "gpt-6-max", effort: "high" } });
        expect(await f.execution(task)).toMatchObject({ model: "gpt-6-max", effort: "high" });
        expect(await f.resolved(task)).toMatchObject({
          source: "chosen",
          chosenByTagId: f.owner.id,
        });
        await expect(f.assign({ execution: { model: "gpt-5" } })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining(
            "does not allow model gpt-5. Allowed: harness codex; model gpt-6-sol, gpt-6-max; effort medium, high.",
          ),
        });
        await expect(f.assign({ execution: { effort: "low" } })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining("effort low"),
        });
        await expect(f.assign({ execution: { harness: "claude-code" } })).rejects.toMatchObject({
          statusCode: 400,
        });
      });

      it("raises effort, then the model, after work failures and rejections", async () => {
        const f = await fixture();
        const first = await f.assign();
        await f.finish(first, { error: "Tests still fail after the change" });
        const second = await f.assign();
        expect(await f.execution(second)).toMatchObject({ model: "gpt-6-sol", effort: "high" });
        expect(await f.resolved(second)).toMatchObject({
          source: "escalated",
          escalation: "effort medium → high",
          escalatedFromTaskId: first.taskId,
        });
        await f.finish(second, {});
        await f.store.reviewTaskAssignment(second.taskId, f.owner.id, false, "Still broken");
        const third = await f.assign();
        expect(await f.execution(third)).toMatchObject({ model: "gpt-6-max", effort: "medium" });
        expect(await f.resolved(third)).toMatchObject({
          escalation: "model gpt-6-sol → gpt-6-max",
        });
        const resource = await taskResourceFromStore(
          f.store,
          (await f.store.findTaskById(third.taskId)) as never,
        );
        const shown = (resource.status as Record<string, unknown>)["execution"] as Record<
          string,
          unknown
        >;
        expect(describeTaskExecution(shown, {})).toEqual([
          `Execution: codex, model gpt-6-max, effort medium (escalated: model gpt-6-sol → gpt-6-max after Task ${second.taskId} failed or was rejected)`,
        ]);
        expect(
          describeTaskExecution(
            {
              source: "chosen",
              chosenByTagId: f.owner.id,
              harness: "codex",
              latestAttempt: {
                harness: "opencode",
                model: "openai/gpt-6-sol",
                modelSource: "host-default",
                effort: "high",
                effortIgnored: "opencode has no reasoning-effort option; effort high was ignored",
              },
            },
            { tagNames: new Map([[f.owner.id, "lead"]]) },
          ),
        ).toEqual([
          "Execution: codex, model the host default, effort the harness default (chosen by lead)",
          "Latest Attempt ran: opencode, model openai/gpt-6-sol (host default), effort high",
          "  opencode has no reasoning-effort option; effort high was ignored",
        ]);
        // An accepted Task resets to the defaults.
        await f.finish(third, {});
        await f.store.reviewTaskAssignment(third.taskId, f.owner.id, true, "Good");
        expect(await f.execution(await f.assign())).toMatchObject({
          model: "gpt-6-sol",
          effort: "medium",
        });
      });

      it("does not escalate after provider-limit, credential, or host failures", async () => {
        const f = await fixture();
        for (const error of [
          "You've hit your usage limit. Try again later.",
          "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
          "Execution lease expired; explicit reassignment required",
        ]) {
          const failed = await f.assign();
          await f.finish(failed, { error });
          const next = await f.assign();
          expect(await f.resolved(next), error).toMatchObject({ source: "default" });
          expect(await f.execution(next)).toMatchObject({ effort: "medium" });
          await f.store.cancelTaskAssignment(next.taskId, f.owner.id);
        }
      });

      it("refuses execution limits no connected profile enforces, naming the satisfiable ones", async () => {
        const f = await fixture();
        await expect(
          f.assign({ execution: { limits: { maxReportedTokens: 1000 } } }),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining(
            "enforces execution.limits.maxReportedTokens. Satisfiable limits: maxNativeAgents",
          ),
        });
        expect(
          await f.execution(await f.assign({ execution: { limits: { maxNativeAgents: 0 } } })),
        ).toMatchObject({ limits: { maxNativeAgents: 0 } });
        // With no bound host connected, a host that connects later may enforce it.
        const offline = await fixture({ connected: false });
        await expect(
          offline.assign({ execution: { limits: { maxReportedTokens: 1000 } } }),
        ).resolves.toMatchObject({ status: "queued" });
      });
    },
  );
