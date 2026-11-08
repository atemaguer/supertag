import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  NATIVE_AGENT_LIMIT_CAPABILITY,
  REPORTED_COST_LIMIT_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";

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
    `${dialect} execution selection at admission`,
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
        const plain = await store.createTag({ name: `plain-${randomUUID()}` });
        const builder = await store.createTag({ name: `builder-${randomUUID()}` });
        await store.assignRole({ roleId: role.id, tagId: builder.id });
        for (const tag of [plain, builder]) await store.bindTagWorkerHost(tag.id, "host");
        const worklet = new LocalWorklet(
          "w",
          "host",
          options.connected === false ? [] : [advertisingWorker()],
        );
        const controlPlane = new ControlPlane({
          store,
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          worklet,
          reply: async () => {},
        });
        await controlPlane.start();
        cleanups.push(() => controlPlane.stop());
        const account = await controlPlane.setupSurfaceAccount({
          provider: "slack",
          externalAccountId: `T-${randomUUID().slice(0, 8)}`,
          displayName: "Execution",
          authMethod: "slack-socket-mode",
          configuration: {},
          secrets: { botToken: "fake", appToken: "fake" },
        });
        for (const tag of [plain, builder])
          await store.addTagRoute({
            tagId: tag.id,
            surfaceAccountId: account.id,
            scope: `channel:${tag.name}`,
          });

        /** One message to the Tag, with the execution the caller asked for. */
        const admit = async (
          tag: { readonly id: string; readonly name: string },
          execution?: Record<string, unknown>,
        ) => {
          const id = randomUUID();
          const result = await controlPlane.ingestSurfaceEvent(
            {
              eventId: id,
              logicalEventId: id,
              provider: "slack",
              externalAccountId: account.externalAccountId,
              kind: "mention",
              scope: `channel:${tag.name}`,
              sessionKey: `slack:${tag.name}:${id}`,
              actor: { id: "U1", kind: "user" },
              text: "Change the code",
              occurredAt: new Date().toISOString(),
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: id,
                target: { channelId: tag.name, threadTs: id },
              },
              source: {},
              metadata: {},
            },
            execution === undefined ? {} : { execution: execution as never },
          );
          return result;
        };
        const taskOf = async (
          tag: { readonly id: string; readonly name: string },
          execution?: Record<string, unknown>,
        ) => {
          const result = await admit(tag, execution);
          const taskId = (result as { taskId?: string }).taskId;
          if (taskId === undefined) throw new Error(`The event was ${result.status}`);
          return taskId;
        };
        const execution = async (taskId: string) => (await store.findTaskById(taskId))?.execution;
        const resolved = async (taskId: string) =>
          (await store.listTaskEvents(taskId)).find(
            (event) => event.type === "task.execution-resolved",
          )?.payload;
        return { store, plain, builder, admit, taskOf, execution, resolved };
      }

      it("records the defaults: the Tag's settings, then its Role's", async () => {
        const f = await fixture();
        const task = await f.taskOf(f.builder);
        expect(await f.execution(task)).toEqual({
          harness: "codex",
          model: "gpt-6-sol",
          effort: "medium",
        });
        expect(await f.resolved(task)).toMatchObject({ source: "default", model: "gpt-6-sol" });
        await f.store.setTagExecution(f.builder.id, { effort: ["high"] });
        expect(await f.execution(await f.taskOf(f.builder))).toMatchObject({
          model: "gpt-6-sol",
          effort: "high",
        });
      });

      it("starts at low effort with every effort allowed when nothing sets one", async () => {
        const f = await fixture();
        const task = await f.taskOf(f.plain);
        expect(await f.execution(task)).toEqual({ effort: "low" });
        expect(await f.resolved(task)).toMatchObject({ source: "default", effort: "low" });
        const high = await f.taskOf(f.plain, { effort: "high" });
        expect(await f.execution(high)).toEqual({ effort: "high" });
      });

      it("accepts a model and effort within the range and refuses others with the allowed values", async () => {
        const f = await fixture();
        const task = await f.taskOf(f.builder, { model: "gpt-6-max", effort: "high" });
        expect(await f.execution(task)).toMatchObject({ model: "gpt-6-max", effort: "high" });
        expect(await f.resolved(task)).toMatchObject({ source: "chosen" });
        await expect(f.admit(f.builder, { model: "gpt-5" })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining(
            "does not allow model gpt-5. Allowed: harness codex; model gpt-6-sol, gpt-6-max; effort medium, high.",
          ),
        });
        await expect(f.admit(f.builder, { effort: "low" })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining("effort low"),
        });
        await expect(f.admit(f.builder, { harness: "claude-code" })).rejects.toMatchObject({
          statusCode: 400,
        });
      });

      it("records the execution limits the caller asked for", async () => {
        const f = await fixture();
        expect(
          await f.execution(await f.taskOf(f.builder, { limits: { maxNativeAgents: 0 } })),
        ).toMatchObject({ limits: { maxNativeAgents: 0 } });
      });
    },
  );
