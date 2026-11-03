import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import {
  type CursorRunner,
  createCursorWorker,
} from "../packages/runtime/harnesses/cursor/src/index.js";
import {
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
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
    const lead = await store.createTag({ name: "Cursor lead" });
    const builder = await store.createTag({ name: "Cursor builder" });
    await store.bindTagWorkerHost(lead.id, "cursor-host");
    await store.bindTagWorkerHost(builder.id, "cursor-host");
    await store.createObjective({
      id: "cursor-e2e",
      ownerTagId: lead.id,
      outcome: "Build a file",
      runtimeActions: ["files:write", "commands:execute"],
    });
    await store.createTeam({
      id: "cursor-e2e:build",
      objectiveId: "cursor-e2e",
      name: "Build",
      leadTagId: lead.id,
      memberTagIds: [builder.id],
    });
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
        expect(listed).toContain("read_objective");
        const result = await client.callTool({ name: "read_objective", arguments: {} });
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
        if (seen.filter((entry) => entry.task === "build").length === 1) {
          const escalation = await client.callTool({
            name: "escalate_task",
            arguments: { effort: "medium", reason: "Verify native Cursor resume" },
          });
          expect(escalation.isError).not.toBe(true);
          return;
        }
        yield {
          type: "output.message",
          text: "Edited cursor-e2e.txt after calling read_objective",
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
    const mcp = async (spec: TaskAttemptSpec, name: string, args: Record<string, unknown>) => {
      const response = await fetch(
        `${spec.coordination?.controlPlaneUrl}/internal/v1/coordination/mcp`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${spec.coordination?.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        },
      );
      const body = (await response.json()) as {
        result?: { isError?: boolean; content: Array<{ text?: string }> };
      };
      if (!response.ok || body.result?.isError) throw new Error(`${name} failed`);
      return JSON.parse(body.result?.content[0]?.text ?? "null");
    };
    let ownerRuns = 0;
    const worker: Worker = {
      describe: () => harness.describe(),
      controlCapabilities: (taskId, attemptId) =>
        harness.controlCapabilities?.(taskId, attemptId) ?? Promise.resolve(undefined),
      control: (command, options) =>
        harness.control?.(command, options) ?? Promise.reject(new Error("No control")),
      async *execute(spec, signal) {
        if (spec.tag.id === builder.id) {
          yield* harness.execute(spec, signal);
          return;
        }
        const base = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
        yield { ...base, type: "execution.started", workerId: "cursor-e2e" };
        yield { ...base, type: "execution.limits.applied", requested: {}, applied: {} };
        if (++ownerRuns === 1) {
          for (const [taskId, instruction] of [
            ["cursor-build", "Edit cursor-e2e.txt"],
            ["cursor-cancel", "Hold for cancellation"],
          ] as const)
            await mcp(spec, "assign_task", {
              taskId,
              teamId: "cursor-e2e:build",
              assignedTagId: builder.id,
              instruction,
              acceptanceCriteria: ["Cursor ran"],
              execution: { harness: "cursor", model: "unknown-cursor-model" },
            });
        }
        yield {
          ...base,
          type: "output.message",
          message: { role: "teammate", text: "Assigned Cursor work" },
        };
        yield { ...base, type: "execution.completed" };
      },
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
    const admin = async (name: string, input: Record<string, unknown>) => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/${name}`, {
        method: "POST",
        headers: { Authorization: "Bearer cursor-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "cursor-e2e", ...input }),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    await admin("start_objective", {});
    await expect
      .poll(async () => (await store.getTaskAssignment("cursor-build"))?.status, {
        timeout: 20_000,
      })
      .toBe("submitted")
      .catch(async (error: unknown) => {
        throw new Error(
          JSON.stringify({
            task: await store.getTaskAssignment("cursor-build"),
            events: await store.listTaskEvents("cursor-build"),
            seen,
            edited,
          }),
          { cause: error },
        );
      });
    expect(seen[0]?.mcp).toBe(true);
    expect(seen.filter((entry) => entry.task === "build")).toHaveLength(2);
    expect(seen.find((entry) => entry.task === "build" && entry.resume)?.resume).toMatch(/^agent-/);
    expect(edited).toContain("written by Cursor runner");
    const usage = (await store.listTaskEvents("cursor-build")).filter(
      (event) => event.type === "usage.updated",
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(JSON.stringify(usage)).toContain("unpricedModel");
    await expect
      .poll(async () => (await store.getTaskAssignment("cursor-cancel"))?.status, {
        timeout: 20_000,
      })
      .toBe("running");
    await admin("update_task", {
      taskId: "cursor-cancel",
      expectedStatus: "running",
      status: "cancelled",
    });
    await cancelled;
    await expect
      .poll(async () => (await store.listTaskAttempts("cursor-cancel"))[0]?.status, {
        timeout: 20_000,
      })
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
