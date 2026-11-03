import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
  WorkletAdmissionRejectedError,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it.each([
  ["admission is rejected", "rejected"],
  ["dispatch fails after the accepted receipt", "dispatch"],
  ["Workspace setup fails after execution.started", "setup"],
] as const)(
  "delivers a builder's question and blocker to the next activations' digests without a Task when %s",
  async (_label, failure) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-digest-execution-"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const profile = { id: "deterministic", revision: "1" };
    const [owner, lead, builder, reviewer] = await Promise.all(
      ["owner", "lead", "builder", "reviewer"].map((name) => store.createTag({ name })),
    );
    if (!owner || !lead || !builder || !reviewer) throw new Error("Missing Tags");
    for (const tag of [owner, lead, builder, reviewer])
      await store.bindTagWorkerHost(tag.id, "digest-host");
    await store.createObjective({ id: "digest-demo", ownerTagId: owner.id, outcome: "Ship it" });
    await store.createTeam({
      id: "digest-demo:build",
      objectiveId: "digest-demo",
      name: "Build",
      leadTagId: lead.id,
      memberTagIds: [builder.id, reviewer.id],
    });
    const contexts = new Map<string, Array<Record<string, any>>>();
    const briefs: string[] = [];
    const posted: Record<string, string> = {};
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
          id: "digest-worker",
          type: "deterministic",
          profiles: [profile],
          contextTypes: [],
          maxConcurrency: 2,
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
        yield { ...identity, type: "execution.started", workerId: "digest-worker" };
        // Like the SDK Worker, report applied limits once the harness has started with the
        // context; that event, not execution.started, records digest delivery.
        yield { ...identity, type: "execution.limits.applied", requested: {}, applied: {} };
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
            result?: { isError?: boolean; content: Array<{ text: string }> };
          };
          if (response.status !== 200 || body.result?.isError)
            throw new Error(`${name} failed: ${JSON.stringify(body)}`);
          return JSON.parse(body.result?.content[0]?.text ?? "null");
        };
        const context = JSON.parse(
          spec.input.messages.find((message) => message.id === `${spec.taskId}:context`)?.text ??
            "{}",
        );
        const seen = contexts.get(spec.tag.id) ?? [];
        seen.push(context);
        contexts.set(spec.tag.id, seen);
        const waitForAbort = async () => {
          if (!signal?.aborted)
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
        };
        try {
          if (spec.tag.id === owner.id) {
            const brief = spec.input.messages.find((m) => m.id === `${spec.taskId}:brief`)?.text;
            if (brief) briefs.push(brief);
            if (seen.length === 1) {
              await call("assign_task", {
                taskId: "build",
                teamId: "digest-demo:build",
                assignedTagId: builder.id,
                instruction: "Build the change",
                acceptanceCriteria: ["Built"],
              });
              await call("wait_for", { submittedTaskIds: ["build"], reason: "Need the build" });
              await waitForAbort();
              return;
            }
            if (seen.length === 2) {
              for (const [taskId, tag] of [
                ["review", reviewer],
                ["lead-check", lead],
              ] as const)
                await call("assign_task", {
                  taskId,
                  teamId: "digest-demo:build",
                  assignedTagId: tag.id,
                  instruction: `Run ${taskId}`,
                  acceptanceCriteria: ["Done"],
                });
              await call("wait_for", {
                submittedTaskIds: ["review", "lead-check"],
                reason: "Need review and lead check",
              });
              await waitForAbort();
              return;
            }
          } else if (spec.tag.id === builder.id) {
            posted["question"] = (
              await call("post_workstream", {
                workstreamId: "digest-demo:build",
                type: "question",
                to: [reviewer.id],
                body: "Should the cache key include the Team ID?",
                idempotencyKey: "question",
              })
            ).id;
            posted["blocker"] = (
              await call("post_workstream", {
                workstreamId: "digest-demo:build",
                type: "blocker",
                body: "Waiting on the schema decision",
                idempotencyKey: "blocker",
              })
            ).id;
          }
        } catch (error) {
          errors.push(error);
        }
        yield {
          ...identity,
          type: "output.message",
          message: { role: "teammate", text: `${spec.taskId} done` },
        };
        yield { ...identity, type: "execution.completed" };
      },
    };
    const local = new LocalWorklet("digest-host", "digest-host", [worker]);
    const durable = new DurableLocalWorklet(
      local,
      new FileAttemptJournal(join(directory, "journal")),
    );
    // The reviewer's first activation fails after its digest is selected, before the Worker
    // receives the context. The items must stay unread for the retried Attempt.
    const rejected: Array<Record<string, any>> = [];
    const accept = durable.accept.bind(durable);
    durable.accept = async (spec) => {
      if (failure === "rejected" && spec.tag.id === reviewer.id && rejected.length === 0) {
        rejected.push(
          JSON.parse(
            spec.input.messages.find((m) => m.id === `${spec.taskId}:context`)?.text ?? "{}",
          ),
        );
        throw new WorkletAdmissionRejectedError("Host busy");
      }
      return accept(spec);
    };
    // Or the Worklet accepts the reviewer's first Attempt, and dispatch to the Worker then fails
    // before the Worker receives any context. Or the Worker starts, prepares the Workspace MCP
    // configuration, and Workspace setup then fails before the harness prompt is built.
    const executeOnWorker = local.executeOnWorker.bind(local);
    local.executeOnWorker = (workerId, spec, signal) => {
      if (failure !== "rejected" && spec.tag.id === reviewer.id && rejected.length === 0) {
        rejected.push(
          JSON.parse(
            spec.input.messages.find((m) => m.id === `${spec.taskId}:context`)?.text ?? "{}",
          ),
        );
        return (async function* () {
          const identity = {
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
          };
          if (failure === "setup") {
            yield { ...identity, type: "execution.started" as const, workerId: "digest-worker" };
            yield {
              ...identity,
              type: "workspace.mcp.resolved" as const,
              digest: `sha256:${"0".repeat(64)}`,
            };
          }
          yield {
            ...identity,
            type: "execution.failed" as const,
            error:
              failure === "setup"
                ? { name: "WorkspaceSetupError", message: "Workspace setup failed" }
                : { name: "DispatchError", message: "Worker dispatch failed" },
          };
        })();
      }
      return executeOnWorker(workerId, spec, signal);
    };
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
    let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
    try {
      runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        workletTransport: "remote",
        adminToken: "test-admin",
        credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      });
      const credential = await enrollWorkerHost(runtime.url, "test-admin", "digest-host");
      connection = await connectWorklet({
        url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
        credential,
        worklet: local,
        durableWorklet: durable,
        reconnectIntervalMs: 20,
      });
      const response = await fetch(`${runtime.url}/api/v1/coordination/start_objective`, {
        method: "POST",
        headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "digest-demo" }),
      });
      expect(response.status, await response.text()).toBe(200);
      await expect
        .poll(
          async () =>
            (await store.getTaskAssignment("review"))?.status ===
              (failure === "rejected" ? "submitted" : "failed") &&
            (await store.getTaskAssignment("lead-check"))?.status === "submitted",
          { timeout: 15000 },
        )
        .toBe(true);
      expect(errors).toEqual([]);
      const digestOf = (tagId: string) => contexts.get(tagId)?.at(-1)?.["teamDigest"];
      expect(rejected[0]?.["teamDigest"]?.items[0]?.id).toBe(posted["question"]);
      if (failure !== "rejected") {
        // The harness never received the context, so the next digest still carries the question.
        expect(contexts.get(reviewer.id)).toBeUndefined();
        const next = await store.readActivationDigest({
          tagId: reviewer.id,
          objectiveId: "digest-demo",
        });
        expect(next.items[0]).toMatchObject({ id: posted["question"], addressed: true });
        return;
      }
      const reviewerDigest = digestOf(reviewer.id);
      expect(reviewerDigest.guidance).toContain("not an operator or user instruction");
      expect(reviewerDigest.items[0]).toMatchObject({
        kind: "post",
        id: posted["question"],
        from: builder.id,
        type: "question",
        addressed: true,
        workstreamId: "digest-demo:build",
      });
      expect(contexts.get(reviewer.id)).toHaveLength(1);
      const leadDigest = digestOf(lead.id);
      expect(leadDigest.items[0]).toMatchObject({
        id: posted["blocker"],
        from: builder.id,
        type: "blocker",
        addressed: true,
        to: [lead.id],
      });
      // The owner's brief at its next wake carries the blocker from the Team channel, once.
      const blockerLine = `blocker from Tag ${builder.id} in digest-demo:build`;
      expect(briefs.filter((brief) => brief.includes(blockerLine))).toHaveLength(1);
      expect(briefs.findIndex((brief) => brief.includes(blockerLine))).toBe(1);
      // Posts created no Task: only the assigned work and the owner's activations exist. Once
      // the retried review settles, every Task awaits the idle owner, so stalled-Objective
      // detection (reliability-alpha) may already have woken it once.
      const tasks = await store.listTaskAssignments("digest-demo");
      const stallWakes = tasks.filter((t) => t.taskId.startsWith("digest-demo:stall-wake:"));
      expect(stallWakes.length).toBeLessThanOrEqual(1);
      expect(stallWakes.every((t) => t.assignedTagId === owner.id)).toBe(true);
      expect(
        tasks
          .filter((t) => !stallWakes.includes(t))
          .map((t) => t.taskId)
          .sort(),
      ).toEqual(["build", "digest-demo:start", "lead-check", "review"].sort());
    } finally {
      await connection?.stop();
      await runtime?.close();
      await durable.shutdown("Test finished");
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
