import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import { LocalWorklet } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { harnessRequest } from "./support/harness-request.js";
import { hostArtifactStore } from "./support/host-artifact-store.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
    `${dialect} cross-Team delivery`,
    () => {
      it("preserves exact artifact review, revision messages and manager acceptance across a Control Plane restart", async () => {
        const directory = await mkdtemp(join(tmpdir(), "cross-team-delivery-"));
        const pg =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(process.env["SUPERTAG_POSTGRES_URL"] as string)
            : undefined;
        const databaseUrl = pg?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url: databaseUrl });
        const store = new DrizzleStore({ url: databaseUrl });
        await store.connect();
        let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
        let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
        try {
          const owner = await store.createTag({ name: "Manager" }),
            producer = await store.createTag({ name: "Engineering lead" }),
            reviewer = await store.createTag({ name: "Review lead" });
          for (const tag of [owner, producer, reviewer])
            await store.bindTagWorkerHost(tag.id, "delivery-host");
          await store.createObjective({
            id: "delivery",
            ownerTagId: owner.id,
            outcome: "Deliver reviewed evidence",
            runtimeActions: ["commands:execute", "files:read", "files:write"],
            budgetLimitMinor: 100,
          });
          await store.setTagMessagingGrant({
            senderTagId: reviewer.id,
            recipientTagId: producer.id,
            messageTypes: ["message"],
          });
          const managerOperations = new Map<
            string,
            { name: string; input: Record<string, unknown> }
          >();
          const observedInputs: string[] = [];
          let firstArtifactId = "";
          let revisedInputVerified = false;
          let unauthorizedAcceptRejected = false;
          const worker = createCodexWorker({
            workspace: directory,
            // The delivery host keeps every artifact; the Control Plane holds only the catalog.
            artifactStore: hostArtifactStore(join(directory, "host-artifacts")),
            runner: async function* (request, environment) {
              if (harnessRequest(request.prompt).includes("A delegated Task changed state")) {
                yield { type: "output.message", text: "Manager notification observed" };
                return;
              }
              const server = request.mcpServers.find((s) => s.name === "supertag-coordination");
              if (server?.transport !== "mcp-http") throw Error("Missing coordination");
              const client = new Client({ name: "cross-team-test", version: "1" });
              await client.connect(
                new StreamableHTTPClientTransport(new URL(server.url), {
                  requestInit: { headers: server.headers },
                }),
              );
              const call = async (name: string, args: Record<string, unknown>) => {
                const result = await client.callTool({ name, arguments: args });
                expect(result.isError, JSON.stringify(result)).not.toBe(true);
                const block = (result.content as { type: string; text?: string }[]).find(
                  (b) => b.type === "text",
                );
                return JSON.parse(block?.text ?? "null");
              };
              try {
                const managerOperation = [...managerOperations].find(([key]) =>
                  harnessRequest(request.prompt).includes(key),
                );
                if (managerOperation) {
                  await call(managerOperation[1].name, managerOperation[1].input);
                  yield { type: "output.message", text: "Manager operation completed" };
                } else if (harnessRequest(request.prompt).includes("MANAGER_ACCEPT_VERSION_TWO")) {
                  await call("update_task", {
                    taskId: "produce-two",
                    expectedStatus: "submitted",
                    status: "accepted",
                    assessment: "Independent review-two verified the exact revised artifact",
                  });
                  yield { type: "output.message", text: "Manager accepted reviewed delivery" };
                } else if (harnessRequest(request.prompt).includes("PRODUCE_VERSION_")) {
                  const revised = harnessRequest(request.prompt).includes("PRODUCE_VERSION_TWO");
                  if (revised) {
                    const inbox = await call("read_mailbox", {});
                    expect(JSON.stringify(inbox)).toContain("Add verification details");
                    expect(JSON.stringify(inbox)).toContain(firstArtifactId);
                    const source = await environment.spawn({
                      command: globalThis.process.execPath,
                      args: [
                        "-e",
                        "const fs=require('fs'),p=require('path');const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):e.name==='evidence.txt'?[p.join(d,e.name)]:[]);const files=walk('.');if(files.length!==1)throw Error('one admitted prior artifact required');process.stdout.write(fs.readFileSync(files[0],'utf8'));",
                      ],
                      timeoutMs: 2000,
                    });
                    const prior = await source.wait();
                    expect(prior.exitCode).toBe(0);
                    expect(prior.stdout).toBe("version one: missing verification");
                    revisedInputVerified = true;
                  }
                  const content = revised
                    ? "version two: verified"
                    : "version one: missing verification";
                  const process = await environment.spawn({
                    command: globalThis.process.execPath,
                    args: [
                      "-e",
                      `require('fs').mkdirSync('outputs',{recursive:true});require('fs').writeFileSync('outputs/evidence.txt',${JSON.stringify(content)})`,
                    ],
                    timeoutMs: 2000,
                  });
                  expect((await process.wait()).exitCode).toBe(0);
                  yield { type: "output.message", text: content };
                } else if (harnessRequest(request.prompt).includes("REVIEW_VERSION_")) {
                  const revised = harnessRequest(request.prompt).includes("REVIEW_VERSION_TWO");
                  const process = await environment.spawn({
                    command: globalThis.process.execPath,
                    args: [
                      "-e",
                      "const fs=require('fs'),p=require('path');const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):e.name==='evidence.txt'?[p.join(d,e.name)]:[]);const files=walk('.');if(files.length!==1)throw Error('one admitted artifact required');process.stdout.write(fs.readFileSync(files[0],'utf8'));",
                    ],
                    timeoutMs: 2000,
                  });
                  const result = await process.wait();
                  expect(result.exitCode).toBe(0);
                  expect(result.stdout).toBe(
                    revised ? "version two: verified" : "version one: missing verification",
                  );
                  observedInputs.push(result.stdout);
                  const forbidden = await client.callTool({
                    name: "update_task",
                    arguments: {
                      taskId: revised ? "produce-two" : "produce-one",
                      expectedStatus: "submitted",
                      status: "accepted",
                      assessment: "Reviewer cannot accept manager-owned assignment",
                    },
                  });
                  expect(forbidden.isError).toBe(true);
                  unauthorizedAcceptRejected = true;
                  if (!revised)
                    await call("send_message", {
                      recipientTeamId: "engineering",
                      type: "message",
                      idempotencyKey: "revision-one",
                      body: {
                        message: "Add verification details",
                        sourceTaskId: "produce-one",
                        artifactId: firstArtifactId,
                      },
                    });
                  yield {
                    type: "output.message",
                    text: revised ? "Independent review approved" : "Revision requested",
                  };
                } else throw Error("Unexpected scripted instruction");
              } finally {
                await client.close();
              }
            },
          });
          const start = async () => {
            runtime = await startControlPlaneRuntime({
              host: "127.0.0.1",
              port: 0,
              databaseUrl,
              workletTransport: "remote",
              adminToken: "test-admin",
              credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
            });
          };
          const worklet = new LocalWorklet("delivery-worklet", "delivery-host", [worker]);
          const durableWorklet = durableTestWorklet(worklet);
          const connect = async (credential: string) => {
            if (!runtime) throw Error("No runtime");
            connection = await connectDurableTestWorklet({
              url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
              credential,
              worklet,
              durableWorklet,
            });
          };
          await start();
          const credential = await enrollWorkerHost(
            runtime?.url ??
              (() => {
                throw new Error("Runtime unavailable");
              })(),
            "test-admin",
            "delivery-host",
          );
          await connect(credential);
          const command = async (name: string, input: Record<string, unknown>) => {
            const response = await fetch(
              `${
                runtime?.url ??
                (
                  () => {
                    throw new Error("Runtime unavailable");
                  }
                )()
              }/api/v1/coordination/${name}`,
              {
                method: "POST",
                headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
                body: JSON.stringify({ objectiveId: "delivery", ...input }),
              },
            );
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(200);
            return body;
          };
          for (const [id, lead] of [
            ["engineering", producer],
            ["review", reviewer],
          ] as const)
            await command("create_team", {
              id,
              name: id,
              leadTagId: lead.id,
              memberTagIds: id === "engineering" ? [lead.id, owner.id] : [lead.id],
              maxConcurrency: 1,
            });
          const managerCommand = async (name: string, input: Record<string, unknown>) => {
            const key = `MANAGER_OPERATION_${managerOperations.size + 1}_END`;
            managerOperations.set(key, { name, input });
            await command("assign_task", {
              taskId: key,
              teamId: "engineering",
              assignedTagId: owner.id,
              instruction: key,
              acceptanceCriteria: ["Manager issues authorized coordination"],
              maxCostMinor: 5,
            });
            await submitted(key);
          };
          const assign = async (
            id: string,
            review: boolean,
            version: string,
            artifactId?: string,
          ) =>
            managerCommand("assign_task", {
              taskId: id,
              teamId: review ? "review" : "engineering",
              assignedTagId: review ? reviewer.id : producer.id,
              instruction: `${review ? "REVIEW" : "PRODUCE"}_VERSION_${version}`,
              acceptanceCriteria: ["Exact evidence inspected"],
              maxCostMinor: 5,
              ...(artifactId
                ? { inputArtifacts: [{ artifactId, paths: ["outputs/evidence.txt"] }] }
                : {}),
              ...(!review
                ? {
                    execution: {
                      outputs: {
                        directory: "outputs",
                        include: ["outputs/**"],
                        required: ["outputs/evidence.txt"],
                      },
                    },
                  }
                : {}),
            });
          const submitted = async (id: string) => {
            // A restart can catch an automatic Mailbox/follow-up Attempt in flight.
            // Its 30-second lease must expire before this Team has capacity again.
            await expect
              .poll(async () => (await store.getTaskAssignment(id))?.status, { timeout: 45000 })
              .toBe("submitted");
            const task = await store.getTaskAssignment(id);
            if (!task) throw new Error("Missing assignment");
            return task;
          };
          const artifact = async (id: string) => {
            const assignment = await submitted(id);
            const result = assignment.result as {
              taskResult: { artifacts: { artifactId: string; paths: string[] }[] };
            };
            const selected = result.taskResult.artifacts[0];
            expect(selected?.paths).toEqual(["outputs/evidence.txt"]);
            if (!selected) throw new Error("Missing artifact selection");
            return selected.artifactId;
          };
          await assign("produce-one", false, "ONE");
          const first = await artifact("produce-one");
          firstArtifactId = first;
          await assign("review-one", true, "ONE", first);
          await submitted("review-one");
          await managerCommand("update_task", {
            taskId: "produce-one",
            expectedStatus: "submitted",
            status: "rejected",
            assessment: "Independent review requests verification details",
          });
          await connection?.stop();
          connection = undefined;
          await runtime?.close();
          runtime = undefined;
          await start();
          await connect(credential);
          expect((await store.getTaskAssignment("produce-one"))?.status).toBe("rejected");
          await assign("produce-two", false, "TWO", first);
          const second = await artifact("produce-two");
          expect(second).not.toBe(first);
          await assign("review-two", true, "TWO", second);
          await submitted("review-two");
          await command("assign_task", {
            taskId: "manager-accept",
            teamId: "engineering",
            assignedTagId: owner.id,
            instruction: "MANAGER_ACCEPT_VERSION_TWO",
            acceptanceCriteria: ["Owner accepts independent review"],
            maxCostMinor: 5,
          });
          await submitted("manager-accept");
          expect((await store.getTaskAssignment("produce-two"))?.status).toBe("accepted");
          expect((await store.getTaskAssignment("review-two"))?.teamId).toBe("review");
          expect(observedInputs).toEqual([
            "version one: missing verification",
            "version two: verified",
          ]);
          expect(unauthorizedAcceptRejected).toBe(true);
          expect(revisedInputVerified).toBe(true);
          const consumed = await store.findTaskById("review-two");
          expect(JSON.stringify(consumed?.trigger)).toContain(second);
          expect(JSON.stringify(consumed?.trigger)).not.toContain(first);
        } finally {
          await connection?.stop();
          await runtime?.close();
          await store.disconnect();
          await pg?.cleanup();
          await rm(directory, { recursive: true, force: true });
        }
      }, 90000);
    },
  );
