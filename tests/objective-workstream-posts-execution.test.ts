import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import { LocalWorklet } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { harnessRequest } from "./support/harness-request.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("shares research posts through real coordination tools without mailbox fanout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-shared-posts-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  const errors: unknown[] = [];
  const completed = new Set<string>();
  let findingId = "";
  try {
    const tags = await Promise.all(
      ["Executive", "Research", "Product", "Engineering", "Outsider"].map((name) =>
        store.createTag({ name }),
      ),
    );
    const [executive, research, product, engineering, outsider] = tags;
    if (!executive || !research || !product || !engineering || !outsider)
      throw new Error("Missing fixture Tags");
    for (const tag of tags) await store.bindTagWorkerHost(tag.id, "posts-host");
    await store.createObjective({
      id: "launch",
      ownerTagId: executive.id,
      outcome: "Validate scheduling",
      runtimeActions: [],
    });
    await store.createTeam({
      id: "team",
      objectiveId: "launch",
      name: "Launch",
      leadTagId: executive.id,
      memberTagIds: tags.map((tag) => tag.id),
      maxConcurrency: 5,
    });
    // The "evidence" Team's channel is the shared Workstream; its ID is the Team ID.
    const evidence = await store.createTeam({
      id: "evidence",
      objectiveId: "launch",
      name: "Customer evidence",
      leadTagId: executive.id,
      memberTagIds: [executive.id, research.id, product.id],
    });
    const worker = createCodexWorker({
      workspace: directory,
      profileId: "shared-posts",
      maxConcurrency: 5,
      runner: async function* (request) {
        const marker = [
          "RESEARCH_POST",
          "PRODUCT_READ",
          "ENGINEERING_REPLY",
          "PRODUCT_INCREMENTAL",
          "OUTSIDER_READ",
        ].find((marker) => harnessRequest(request.prompt).includes(marker));
        if (!marker) {
          yield { type: "output.message", text: "Ready" };
          return;
        }
        const server = request.mcpServers.find((server) => server.name === "supertag-coordination");
        if (server?.transport !== "mcp-http") throw new Error("Missing coordination tools");
        const client = new Client({ name: "shared-posts-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: server.headers },
          }) as Parameters<Client["connect"]>[0],
        );
        try {
          const before = (await store.listTaskAssignments("launch"))
            .map((task) => task.taskId)
            .sort();
          const call = async (name: string, arguments_: Record<string, unknown>) => {
            const response = await client.callTool({ name, arguments: arguments_ });
            expect(response.isError, JSON.stringify(response)).not.toBe(true);
            const content = response.content as Array<{ type: string; text?: string }>;
            return JSON.parse(content.find((item) => item.type === "text")?.text ?? "null");
          };
          if (marker === "RESEARCH_POST") {
            const input = {
              workstreamId: "evidence",
              body: "Three clinics need recurring appointments before online booking.",
              references: ["supertag://research/interviews"],
              idempotencyKey: "finding-1",
            };
            const first = await call("post_workstream", input);
            const repeat = await call("post_workstream", input);
            expect(repeat).toEqual(first);
            findingId = first.id;
            expect(first.authorTagId).toBe(research.id);
          } else if (marker === "OUTSIDER_READ") {
            const result = await client.callTool({
              name: "read_workstream",
              arguments: { workstreamId: "evidence" },
            });
            expect(result.isError).toBe(true);
          } else {
            const workstream = await call("read_workstream", {
              workstreamId: "evidence",
              afterSequence: marker === "PRODUCT_INCREMENTAL" ? 1 : 0,
              limit: 10,
            });
            const result = workstream.posts;
            expect(result).toHaveLength(1);
            if (marker === "PRODUCT_INCREMENTAL") {
              expect(result[0]).toMatchObject({
                authorTagId: engineering.id,
                replyTo: findingId,
                sequence: 2,
              });
            } else {
              expect(result[0]).toMatchObject({
                id: findingId,
                authorTagId: research.id,
                sequence: 1,
              });
              if (marker === "ENGINEERING_REPLY") {
                await call("post_workstream", {
                  workstreamId: "evidence",
                  body: "We can prioritize recurring appointments in the prototype.",
                  replyTo: findingId,
                  idempotencyKey: "engineering-reply",
                });
              }
            }
          }
          expect(
            (await store.listTaskAssignments("launch")).map((task) => task.taskId).sort(),
          ).toEqual(before);
          for (const tag of tags) expect(await store.listTagMessages(tag.id)).toEqual([]);
          completed.add(marker);
        } catch (error) {
          errors.push(error);
          throw error;
        } finally {
          await client.close();
        }
        yield { type: "output.message", text: "Shared evidence reviewed" };
      },
    });
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "posts-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    const credential = await enrollWorkerHost(runtime.url, "posts-admin", "posts-host");
    connection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet: new LocalWorklet("posts-worklet", "posts-host", [worker]),
    });
    const assign = async (marker: string, assignedTagId: string, inStream = true) => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/assign_task`, {
        method: "POST",
        headers: { Authorization: "Bearer posts-admin", "Content-Type": "application/json" },
        body: JSON.stringify({
          objectiveId: "launch",
          taskId: marker,
          assignedTagId,
          teamId: "team",
          ...(inStream ? { workstreamId: "evidence" } : {}),
          instruction: marker,
          acceptanceCriteria: ["Evidence reviewed"],
        }),
      });
      expect(response.status, await response.text()).toBe(200);
      await expect
        .poll(
          () => {
            if (errors.length) throw errors[0];
            return completed.has(marker);
          },
          { timeout: 10000 },
        )
        .toBe(true);
      await expect
        .poll(async () => (await store.getTaskAssignment(marker))?.status)
        .toBe("submitted");
    };
    await assign("RESEARCH_POST", research.id);
    await assign("PRODUCT_READ", product.id);
    await store.updateTeam("evidence", {
      expectedRevision: evidence.revision,
      memberTagIds: [executive.id, research.id, product.id, engineering.id],
    });
    await assign("ENGINEERING_REPLY", engineering.id);
    await assign("PRODUCT_INCREMENTAL", product.id);
    await assign("OUTSIDER_READ", outsider.id, false);
    for (const tag of tags) expect(await store.listTagMessages(tag.id)).toEqual([]);
    expect(
      (await store.listTaskAssignments("launch")).filter((task) => task.sourceMessageId !== null),
    ).toEqual([]);
  } finally {
    await connection?.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
