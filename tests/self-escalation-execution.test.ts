import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { describeTaskExecution } from "../apps/cli/src/resources.js";
import { OWNER_RESULT_GUIDANCE } from "../packages/control-plane/src/index.js";
import { SELF_ESCALATED_EVENT, taskWorkspaceBranch } from "../packages/core/src/index.js";
import {
  COORDINATION_CAPABILITY,
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type TaskAttemptSpec,
  WORKSPACE_IN_PLACE_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("continues a self-escalated Task in a new Attempt on the same Task branch, at most twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-self-escalation-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const profile = { id: "deterministic", revision: "1" };
  await store.applyWorkspace({ name: "app", delivery: "branch" });
  const owner = await store.createTag({ name: "owner" });
  await store.setTagExecution(owner.id, { model: ["m1", "m2"] });
  await store.bindTagWorkerHost(owner.id, "esc-host");
  await store.createObjective({
    id: "esc-demo",
    ownerTagId: owner.id,
    outcome: "Fix the race",
    workspaces: ["app"],
    budgetLimitMinor: 100,
  });
  const taskId = "esc-demo:start";
  const specs: TaskAttemptSpec[] = [];
  const refusals: string[] = [];
  const errors: unknown[] = [];
  const capabilities = [
    { id: "supertag.task-attempt.events", version: 1 },
    COORDINATION_CAPABILITY,
    WORKSPACE_IN_PLACE_CAPABILITY,
  ];
  const worker: Worker = {
    async describe() {
      return {
        id: "one-slot",
        type: "deterministic",
        profiles: [profile],
        contextTypes: [],
        maxConcurrency: 1,
        capabilities,
        profileCapabilities: [
          {
            profile,
            harness: "codex",
            models: ["m1", "m2"],
            efforts: ["low", "medium", "high"],
            capabilities,
            contextTypes: [],
          },
        ],
      };
    },
    async *execute(spec, signal) {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: "" };
      const at = () => ({ ...identity, at: new Date().toISOString() });
      yield { ...at(), type: "execution.started", workerId: "one-slot" };
      const call = async (name: string, args: Record<string, unknown>) => {
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
        return {
          isError: body.result?.isError === true,
          text: body.result?.content[0]?.text ?? "",
        };
      };
      const escalate = async (args: Record<string, unknown>) => {
        const result = await call("escalate_task", args);
        if (result.isError) throw new Error(result.text);
        if (!signal?.aborted)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
      };
      try {
        if (spec.taskId === taskId) {
          specs.push(spec);
          if (specs.length === 1) {
            for (const args of [
              { effort: "low", reason: "Try again" },
              { model: "m3", reason: "Need a bigger model" },
              { reason: "No change named" },
            ]) {
              const refused = await call("escalate_task", args);
              expect(refused.isError, refused.text).toBe(true);
              refusals.push(refused.text);
            }
            await escalate({ effort: "medium", reason: "The race needs careful tracing" });
            return;
          }
          if (specs.length === 2) {
            await escalate({ effort: "high", model: "m2", reason: "Still flaky under load" });
            return;
          }
          const capped = await call("escalate_task", { effort: "medium", reason: "Once more" });
          expect(capped.isError).toBe(true);
          refusals.push(capped.text);
        }
      } catch (error) {
        errors.push(error);
        throw error;
      }
      yield {
        ...at(),
        type: "output.message",
        message: { role: "teammate", text: "Race fixed" },
      };
      yield { ...at(), type: "execution.completed" };
    },
  };
  const local = new LocalWorklet("esc-host", "esc-host", [worker], { workspaces: ["app"] });
  const durable = new DurableLocalWorklet(
    local,
    new FileAttemptJournal(join(directory, "journal")),
  );
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
    const credential = await enrollWorkerHost(runtime.url, "test-admin", "esc-host");
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
      body: JSON.stringify({ objectiveId: "esc-demo", maxCostMinor: 40 }),
    });
    expect(response.status, await response.text()).toBe(200);
    await expect
      .poll(async () => (await store.getTaskAssignment(taskId))?.status, { timeout: 15000 })
      .toBe("accepted");
    expect(errors).toEqual([]);

    // Each Attempt ran with the execution in force when it started, on one Task branch.
    expect(specs.map((spec) => [spec.execution.model, spec.execution.effort])).toEqual([
      ["m1", "low"],
      ["m1", "medium"],
      ["m2", "high"],
    ]);
    const branch = taskWorkspaceBranch("esc-demo", taskId);
    for (const spec of specs)
      expect(spec.workspacePlan).toMatchObject({ status: "workspace", branch });
    const attempts = (await store.listTaskAttempts(taskId)).toSorted(
      (a, b) => a.attemptNumber - b.attemptNumber,
    );
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "cancelled",
      "cancelled",
      "completed",
    ]);
    expect(attempts.map((attempt) => attempt.workerSnapshot["execution"])).toMatchObject([
      { model: "m1", effort: "low" },
      { model: "m1", effort: "medium" },
      { model: "m2", effort: "high" },
    ]);
    // The owner's start instruction and the delegation guidance explain the low default.
    const instruction = specs[0]?.input.messages.find((message) => message.role === "requester");
    expect(instruction?.text).toContain("Tasks start at low reasoning effort");
    expect(instruction?.text).toContain("escalate_task");
    expect(instruction?.text).toContain(
      "Clean up processes and services you start before finishing a Task",
    );
    const firstContext = JSON.parse(
      specs[0]?.input.messages.find((message) => message.role === "system")?.text ?? "{}",
    );
    expect(firstContext.communication).toContain("Tasks start at low reasoning effort");
    expect(firstContext.communication).toContain("call escalate_task");
    expect(firstContext.communication).toContain(
      "Teammates may receive addressed posts and direct messages mid-Task when their harness accepts input",
    );
    expect(firstContext.communication).toContain(
      "Message the teammate who needs the information directly; copy the lead only when a decision is needed",
    );
    expect(firstContext.communication).toContain(
      "Keep live messages short and actionable, with references",
    );
    expect(firstContext.communication).toContain(
      "Post a `blocker` instead of stalling, ask a `question` instead of guessing",
    );
    expect(firstContext.communication).toContain(
      "Within a Team, addressed `blocker` and `question` posts or direct messages wake an idle addressee with a reply activation",
    );
    expect(firstContext.communication).toContain(
      "Other messages wait for the next activation's digest",
    );
    expect(firstContext.communication).toContain(
      "Posts and messages do not approve, assign, accept, or close work",
    );
    expect(firstContext.communication).toContain(
      "Clean up processes and services you start before finishing a Task",
    );
    // Owners and leads get the result-handling guidance in both places.
    for (const text of [instruction?.text, firstContext.communication]) {
      expect(text).toContain(OWNER_RESULT_GUIDANCE);
      expect(text).toContain("wait for the first of them");
      expect(text).toContain("After two fix rounds on the same code");
      expect(text).toContain("That limit never applies to high findings");
      expect(text).toContain("ask the operator before completing with it open");
      expect(text).toContain("ask the operator first");
    }
    const context = JSON.parse(
      specs[1]?.input.messages.find((message) => message.role === "system")?.text ?? "{}",
    );
    expect(context.wakeGuidance).toContain("You escalated this Task (effort low → medium)");
    expect(context.waitState.wake.reason).toBe("escalated");

    expect(refusals[0]).toContain("Nothing would change: this Task already runs with effort low");
    expect(refusals[1]).toContain(
      "Tag owner does not allow model m3. Allowed: harness any the Worker Host offers; model m1, m2; effort low, medium, high.",
    );
    expect(refusals[2]).toContain("Set effort, model, or both");
    expect(refusals[3]).toContain("already escalated 2 times");

    const events = (await store.listTaskEvents(taskId)).filter(
      (event) => event.type === SELF_ESCALATED_EVENT,
    );
    expect(events.map((event) => event.payload)).toMatchObject([
      {
        byTagId: owner.id,
        change: "effort low → medium",
        reason: "The race needs careful tracing",
        from: { model: "m1", effort: "low" },
        to: { model: "m1", effort: "medium" },
        escalation: 1,
      },
      {
        change: "effort medium → high, model m1 → m2",
        reason: "Still flaky under load",
        to: { model: "m2", effort: "high" },
        escalation: 2,
      },
    ]);

    // Continuations reuse the first Attempt's reservation; nothing more is charged.
    expect(await store.getTaskAssignment(taskId)).toMatchObject({ chargedMinor: 40 });
    expect(await store.getObjective("esc-demo")).toMatchObject({ spentMinor: 40 });

    const task = await store.findTaskById(taskId);
    expect(task?.execution).toMatchObject({ model: "m2", effort: "high" });
    const resource = await taskResourceFromStore(store, task as never);
    const shown = (resource.status as Record<string, unknown>)["execution"] as Record<
      string,
      unknown
    >;
    expect(describeTaskExecution(shown, { tagNames: new Map([[owner.id, "owner"]]) })).toEqual(
      expect.arrayContaining([
        "Execution: any harness, model m2, effort high (default, then self-escalated)",
        "Escalated by owner: effort low → medium: The race needs careful tracing",
        "Escalated by owner: effort medium → high, model m1 → m2: Still flaky under load",
      ]),
    );
  } finally {
    await connection?.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
