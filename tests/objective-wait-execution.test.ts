import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { objectiveSummary } from "../packages/control-plane/src/objective-summary.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it.each([0, 12])(
  "resumes after restart with %i extra Tasks",
  async (extraAssignments) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-wait-execution-"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const profile = { id: "deterministic", revision: "1" };
    const owner = await store.createTag({ name: "owner" });
    const researcher = await store.createTag({ name: "research" });
    await store.bindTagWorkerHost(owner.id, "durable-host");
    await store.bindTagWorkerHost(researcher.id, "durable-host");
    await store.createObjective({
      id: "wait-demo",
      ownerTagId: owner.id,
      outcome: "Validate scheduling",
    });
    await store.createTeam({
      id: "research",
      objectiveId: "wait-demo",
      name: "Research",
      leadTagId: researcher.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const leadAttempts: string[] = [];
    const errors: unknown[] = [];
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: profile,
              capabilities: [
                { id: "supertag.task-attempt.events", version: 1 },
                { id: "supertag.coordination", version: 1 },
              ],
              contextTypes: [],
            },
          ],
          id: "one-slot",
          type: "deterministic",
          profiles: [profile],
          contextTypes: [],
          maxConcurrency: 1,
          capabilities: [
            { id: "supertag.task-attempt.events", version: 1 },
            { id: "supertag.coordination", version: 1 },
          ],
        };
      },
      async *execute(spec, signal) {
        const identity = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
        yield { ...identity, type: "execution.started", workerId: "one-slot" };
        if (spec.tag.id === owner.id)
          yield {
            ...identity,
            type: "usage.updated",
            usage: {
              inputTokens: 10,
              outputTokens: 3,
              cachedInputTokens: 5,
              totalTokens: 18,
              complete: false,
            },
          };
        const call = async (name: string, args: Record<string, unknown> = {}) => {
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
            error?: unknown;
            result?: { isError?: boolean; content: Array<{ text: string }> };
          };
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body.error).toBeUndefined();
          expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
          return JSON.parse(body.result?.content[0]?.text ?? "null");
        };
        try {
          if (spec.tag.id === owner.id) {
            leadAttempts.push(spec.attemptId);
            if (leadAttempts.length === 1) {
              const context = JSON.parse(
                spec.input.messages.find((message) => message.role === "system")?.text ?? "{}",
              );
              expect(context.currentWork.tasks).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ taskId: "existing-review" })]),
              );
              await call("assign_task", {
                taskId: "interviews",
                teamId: "research",
                assignedTagId: researcher.id,
                instruction: "Research scheduling",
                acceptanceCriteria: ["Evidence"],
                requiresApproval: true,
              });
              await call("wait_for", {
                submittedTaskIds: ["interviews"],
                reason: "Need the research result before review",
              });
              if (!signal?.aborted)
                await new Promise<void>((resolve) =>
                  signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
              yield {
                ...identity,
                type: "usage.updated",
                usage: {
                  inputTokens: 12,
                  outputTokens: 5,
                  cachedInputTokens: 5,
                  totalTokens: 22,
                  complete: true,
                  reportedCost: { amountMinor: 2, currency: "USD" },
                },
              };
            } else if (leadAttempts.length === 2) {
              expect(leadAttempts).toHaveLength(2);
              expect(
                spec.input.messages.some((message) => message.text.includes("waitState")),
              ).toBe(true);
              expect(
                spec.input.messages.some((message) =>
                  message.text.includes("Dependencies are acceptance-only gates"),
                ),
              ).toBe(true);
              expect(
                spec.input.messages.some((message) =>
                  message.text.includes("execution.requires declares capabilities"),
                ),
              ).toBe(true);
              expect(
                spec.input.messages.some((message) =>
                  message.text.includes(
                    "Before accepting a source Task, inspect queued dependents",
                  ),
                ),
              ).toBe(true);
              const context = JSON.parse(
                spec.input.messages.find((message) => message.role === "system")?.text ?? "{}",
              );
              // This assignment was made while the manager was asleep and was never
              // mentioned in its original request or previous execution.
              if (extraAssignments > 0) {
                expect(context.currentWork.tasks).not.toEqual(
                  expect.arrayContaining([expect.objectContaining({ taskId: "existing-review" })]),
                );
                expect(context.currentWork.pages.tasks.nextOffset).not.toBeNull();
              }
              const visible = [...context.currentWork.tasks];
              let offset = context.currentWork.pages.tasks.nextOffset;
              while (offset !== null) {
                const page = await call("read_objective", { offset });
                expect(page.pages.tasks.offset).toBe(offset);
                visible.push(...page.tasks);
                expect(
                  page.pages.tasks.nextOffset === null || page.pages.tasks.nextOffset > offset,
                ).toBe(true);
                offset = page.pages.tasks.nextOffset;
              }
              expect(visible).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ taskId: "existing-review", status: "queued" }),
                  expect.objectContaining({ taskId: "interviews", status: "submitted" }),
                ]),
              );
              expect(new Set(visible.map((item) => item.taskId)).size).toBe(extraAssignments + 3);
              expect(context.currentWorkGuidance).toContain("supersedes historical conversation");
              expect(context.waitState.reason).toBe("Need the research result before review");
              const child = await call("read_task", { taskId: "interviews" });
              expect(child.result.text).toBe("Solo practices need simpler scheduling");
              await call("update_task", {
                taskId: "interviews",
                expectedStatus: "submitted",
                status: "accepted",
                assessment: "Research supports a focused prototype",
              });
              await call("wait_for", {
                // The Objective owner reads the Research Team's channel without being a member.
                workstreamPosts: { workstreamId: "research", afterSequence: 0 },
              });
            } else {
              expect(leadAttempts).toHaveLength(3);
              const workstream = await call("read_workstream", {
                workstreamId: "research",
                afterSequence: 0,
                limit: 100,
              });
              const posts = workstream.posts;
              expect(posts).toHaveLength(50);
              expect(posts.at(-1).sequence).toBe(50);
              expect(
                spec.input.messages.some((message) => message.text.includes("workstream_posts")),
              ).toBe(true);
            }
          }
        } catch (error) {
          errors.push(error);
          throw error;
        }
        yield {
          ...identity,
          type: "output.message",
          message: {
            role: "teammate",
            text:
              spec.tag.id === owner.id
                ? "Research coordinated"
                : "Solo practices need simpler scheduling",
          },
        };
        yield { ...identity, type: "execution.completed" };
      },
    };
    const local = new LocalWorklet("durable-host", "durable-host", [worker]);
    const durable = new DurableLocalWorklet(
      local,
      new FileAttemptJournal(join(directory, "journal")),
    );
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
    let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
    let credential: string | undefined;
    const start = (port: number) =>
      startControlPlaneRuntime({
        host: "127.0.0.1",
        port,
        databaseUrl,
        workletTransport: "remote",
        adminToken: "test-admin",
        credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      });
    const admin = async (command: string, input: Record<string, unknown> = {}) => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/${command}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "wait-demo", ...input }),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    try {
      runtime = await start(0);
      const port = Number(new URL(runtime.url).port);
      credential = await enrollWorkerHost(runtime.url, "test-admin", "durable-host");
      connection = await connectWorklet({
        url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
        credential,
        worklet: local,
        durableWorklet: durable,
        reconnectIntervalMs: 20,
      });
      expect(connection.negotiatedProtocolVersion).toBe(18);
      await admin("start_objective");
      await expect
        .poll(async () => (await store.getTaskAssignment("wait-demo:start"))?.status, {
          timeout: 10000,
        })
        .toBe("waiting");
      const persistedObjective = await store.getObjective("wait-demo");
      if (!persistedObjective) throw new Error("Missing Objective");
      const persistedTasks = await store.listTaskAssignments("wait-demo");
      const waitingTask = persistedTasks.find((task) => task.taskId === "wait-demo:start");
      const discovery = objectiveSummary(persistedObjective, persistedTasks, [], [], {});
      expect(discovery.tasks.find((task) => task["taskId"] === "wait-demo:start")).toMatchObject({
        waiting: {
          registeredAt: waitingTask?.waitState?.registeredAt,
          acceptedTasks: { total: waitingTask?.waitState?.acceptedTaskIds.length },
          submittedTasks: { total: waitingTask?.waitState?.submittedTaskIds.length },
        },
      });
      const firstAttempt = leadAttempts[0];
      if (!firstAttempt) throw new Error("Lead did not execute");
      expect((await durable.inspect(firstAttempt))?.status).toBe("cancelled");
      const inspection = await fetch(`${runtime.url}/api/v1/tasks/wait-demo%3Astart/execution`, {
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(await inspection.json()).toMatchObject({
        availability: "available",
        receipt: { status: "cancelled", attemptId: firstAttempt },
      });
      expect((await store.getTaskAssignment("interviews"))?.approval).toBe("pending");
      await runtime.close();
      runtime = await start(port);
      await expect.poll(() => connection?.isConnected, { timeout: 10000 }).toBe(true);
      const persistedEvents = await fetch(`${runtime.url}/api/v1/tasks/wait-demo%3Astart/events`, {
        headers: { Authorization: "Bearer test-admin" },
      });
      const usageEvents = (
        (await persistedEvents.json()) as {
          items: Array<{ type: string; attemptId: string; payload: unknown }>;
        }
      ).items.filter((event) => event.type === "usage.updated" && event.attemptId === firstAttempt);
      expect(usageEvents).toHaveLength(2);
      expect(usageEvents.at(-1)?.payload).toMatchObject({
        usage: {
          totalTokens: 22,
          complete: true,
          reportedCost: { amountMinor: 2, currency: "USD" },
        },
      });
      for (let index = 0; index < extraAssignments; index++) {
        await admin("assign_task", {
          taskId: `background-${index}`,
          teamId: "research",
          assignedTagId: researcher.id,
          instruction: `Distinct background responsibility ${index}`,
          acceptanceCriteria: ["Evidence"],
          requiresApproval: true,
        });
      }
      await admin("assign_task", {
        taskId: "existing-review",
        teamId: "research",
        assignedTagId: researcher.id,
        instruction: "Independently review the research evidence",
        acceptanceCriteria: ["Evidence reviewed"],
        requiresApproval: true,
      });
      await admin("update_task", {
        taskId: "interviews",
        expectedStatus: "queued",
        approval: "approved",
      });
      await expect
        .poll(async () => (await store.getTaskAssignment("interviews"))?.status, { timeout: 10000 })
        .toBe("accepted");
      await expect
        .poll(async () => (await store.getTaskAssignment("wait-demo:start"))?.status, {
          timeout: 10000,
        })
        .toBe("waiting");
      await runtime.close();
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          store.postWorkstream({
            workstreamId: "research",
            authorTagId: researcher.id,
            body: `Finding ${i}`,
            idempotencyKey: `finding-${i}`,
          }),
        ),
      );
      runtime = await start(port);
      await expect.poll(() => connection?.isConnected, { timeout: 10000 }).toBe(true);
      await expect
        .poll(async () => (await store.getTaskAssignment("wait-demo:start"))?.status, {
          timeout: 10000,
        })
        .toBe("accepted");
      expect(leadAttempts).toHaveLength(3);
      expect(new Set(leadAttempts).size).toBe(3);
      expect((await store.getTaskAssignment("wait-demo:start"))?.waitState?.wake).toMatchObject({
        reason: "workstream_posts",
        workstreamId: "research",
        throughSequence: 50,
      });
      expect(
        (await store.listTaskAssignments("wait-demo")).map((task) => task.taskId).sort(),
      ).toEqual(
        [
          ...Array.from({ length: extraAssignments }, (_, i) => `background-${i}`),
          "existing-review",
          "interviews",
          "wait-demo:start",
        ].sort(),
      );
      expect(errors).toEqual([]);
    } finally {
      await connection?.stop();
      await runtime?.close();
      await durable.shutdown("Test finished");
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  25000,
);
