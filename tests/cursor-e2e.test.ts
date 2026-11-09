import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { conversationClient, workClient } from "../apps/cli/src/operator-client.js";
import {
  type CursorRunner,
  createCursorWorker,
} from "../packages/runtime/harnesses/cursor/src/index.js";
import { LocalWorklet, type Worker } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { harnessRequest } from "./support/harness-request.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("runs a Cursor Task through Control Plane and Worklet with MCP, usage, resume and cancellation", async () => {
  const directory = await mkdtemp(
    join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "supertag-cursor-e2e-"),
  );
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const seen: Array<{ task: string; resume?: string; mcp: boolean }> = [];
  let edited = "";
  let cancelPid: number | undefined;
  try {
    const builder = await store.createTag({ name: "builder" });
    await store.bindTagWorkerHost(builder.id, "cursor-host");
    // A turn takes its runtime actions from the Tag's own Roles.
    const permissions = await store.createTagPermissionSet({ name: "cursor-runtime" });
    for (const action of ["files:write", "commands:execute"])
      await store.addTagPermission({ permissionSetId: permissions.id, target: "runtime", action });
    const role = await store.createRole({
      name: "Cursor builder",
      purpose: "Edit files.",
      instructions: "Edit carefully.",
      contextSetIds: [],
      permissionSetIds: [permissions.id],
    });
    await store.assignRole({ roleId: role.id, tagId: builder.id });
    const runner: CursorRunner = async function* (request, _runnerRuntime, signal) {
      const server = request.mcpServers["supertag-coordination"];
      if (server?.type !== "http") throw new Error("Missing SuperTag MCP tools");
      const client = new Client({ name: "cursor-e2e", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      try {
        const listed = (await client.listTools()).tools.map((tool) => tool.name);
        expect(listed).toContain("list_objectives");
        const result = await client.callTool({ name: "list_objectives", arguments: {} });
        expect(result.isError).not.toBe(true);
        const task = harnessRequest(request.prompt).includes("Hold for cancellation")
          ? "cancel"
          : "build";
        seen.push({
          task,
          ...(request.resumeAgentId ? { resume: request.resumeAgentId } : {}),
          mcp: true,
        });
        if (task === "cancel") {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          cancelPid = child.pid;
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          child.kill("SIGKILL");
          await exited;
          releaseCancel();
          return;
        }
        await writeFile(join(request.workspace, "cursor-e2e.txt"), "written by Cursor runner\n");
        edited = await readFile(join(request.workspace, "cursor-e2e.txt"), "utf8");
        for (const name of [
          "agents.ndjson",
          "runs.ndjson",
          "run_events.ndjson",
          "checkpoints.ndjson",
        ])
          await writeFile(
            join(request.storeDirectory, name),
            `${JSON.stringify({ agentId: request.resumeAgentId ?? request.agentId })}\n`,
          );
        yield { type: "cursor.session", agentId: request.resumeAgentId ?? request.agentId };
        yield {
          type: "usage.updated",
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            cachedInputTokens: 0,
            totalTokens: 10,
            complete: true,
            unpricedModel: "unknown-cursor-model",
          },
        };
        yield {
          type: "output.message",
          text: "Edited cursor-e2e.txt after calling list_objectives",
          final: true,
        };
      } finally {
        await client.close();
      }
    };
    const harness = createCursorWorker({
      workspace: directory,
      profileId: "cursor-e2e",
      models: ["unknown-cursor-model"],
      allowUnsandboxedCommands: true,
      maxConcurrency: 2,
      runner,
    });
    const worker: Worker = {
      describe: () => harness.describe(),
      controlCapabilities: (taskId, attemptId) =>
        harness.controlCapabilities?.(taskId, attemptId) ?? Promise.resolve(undefined),
      control: (command, options) =>
        harness.control?.(command, options) ?? Promise.reject(new Error("No control")),
      execute: (spec, signal) => harness.execute(spec, signal),
    };
    const worklet = new LocalWorklet("cursor-worklet", "cursor-host", [worker]);
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "cursor-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    const credential = await enrollWorkerHost(runtime.url, "cursor-admin", "cursor-host");
    connection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet,
      durableWorklet: durableTestWorklet(worklet),
    });
    const message = async (text: string) =>
      (
        await conversationClient({ url: runtime?.url ?? "", token: "cursor-admin" }).sendMessage({
          tag: builder.name,
          text,
        })
      ).taskId;
    const settled = async (taskId: string, status: string) => {
      await expect
        .poll(async () => (await store.findTaskById(taskId))?.status, { timeout: 20_000 })
        .toBe(status)
        .catch(async (error: unknown) => {
          throw new Error(
            JSON.stringify({
              task: await store.findTaskById(taskId),
              events: await store.listTaskEvents(taskId),
              seen,
              edited,
            }),
            { cause: error },
          );
        });
    };

    // Two turns of the same conversation: the second resumes the native Cursor Session.
    const firstBuild = await message("Edit cursor-e2e.txt");
    await settled(firstBuild, "completed");
    const secondBuild = await message("Edit cursor-e2e.txt again");
    await settled(secondBuild, "completed");
    expect(seen[0]?.mcp).toBe(true);
    expect(seen.filter((entry) => entry.task === "build")).toHaveLength(2);
    expect(seen.find((entry) => entry.task === "build" && entry.resume)?.resume).toMatch(/^agent-/);
    expect(edited).toContain("written by Cursor runner");
    const usage = (await store.listTaskEvents(firstBuild)).filter(
      (event) => event.type === "execution.usage.updated",
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(JSON.stringify(usage)).toContain("unpricedModel");

    // An operator cancels a running turn, and its Worker stops the work it started.
    const cancelTask = await message("Hold for cancellation");
    // Cancel only once the runner holds the work, so the Worker must stop what it started.
    await expect.poll(() => cancelPid !== undefined, { timeout: 20_000 }).toBe(true);
    expect((await store.findTaskById(cancelTask))?.status).toBe("running");
    const cancellation = await workClient({ url: runtime.url, token: "cursor-admin" }).cancelTask({
      id: cancelTask,
    });
    expect(cancellation.accepted).toBe(true);
    await cancelled;
    await expect
      .poll(async () => (await store.listTaskAttempts(cancelTask))[0]?.status, { timeout: 20_000 })
      .toBe("cancelled");
    expect(cancelPid).toBeGreaterThan(0);
    await expect
      .poll(
        () => {
          try {
            process.kill(cancelPid as number, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            return true;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    cancelPid = undefined;
    expect(seen).toHaveLength(3);
  } finally {
    releaseCancel();
    if (cancelPid) {
      try {
        process.kill(cancelPid, "SIGKILL");
      } catch {}
    }
    await connection?.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
