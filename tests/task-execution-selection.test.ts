import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
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
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("schedules one Tag's Tasks by their own requirements and persists the concrete Attempt selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-task-selection-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  let decoyConnection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  const observed: TaskAttemptSpec[] = [];
  const worker = (id: string, capability: string): Worker => ({
    async describe() {
      const profile = { id, revision: "1" };
      const capabilities = [
        { id: "supertag.coordination", version: 1 },
        { id: capability, version: 1 },
      ];
      return {
        id,
        type: "deterministic",
        profiles: [profile],
        capabilities,
        contextTypes: [],
        profileCapabilities: [{ profile, harness: id, capabilities, contextTypes: [] }],
        maxConcurrency: 1,
      };
    },
    async *execute(spec) {
      observed.push(spec);
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...identity, type: "execution.started", workerId: id };
      yield {
        ...identity,
        type: "output.message",
        message: { role: "teammate", text: `Completed by ${id}` },
      };
      yield { ...identity, type: "execution.completed" };
    },
  });
  try {
    const tag = await store.createTag({ name: "Engineering" });
    expect(tag).not.toHaveProperty("workerProfile");
    await store.createObjective({
      id: "objective",
      ownerTagId: tag.id,
      outcome: "Complete research and implementation",
    });
    await store.createTeam({
      id: "team",
      objectiveId: "objective",
      name: "Engineering",
      leadTagId: tag.id,
      memberTagIds: [],
      maxConcurrency: 2,
    });
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "selection-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    const decoyCredential = await enrollWorkerHost(runtime.url, "selection-admin", "decoy-host");
    decoyConnection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential: decoyCredential,
      worklet: new LocalWorklet("decoy", "decoy-host", [
        worker("decoy-research", "search"),
        worker("decoy-coding", "write"),
      ]),
    });
    const credential = await enrollWorkerHost(runtime.url, "selection-admin", "selection-host");
    await store.bindTagWorkerHost(tag.id, "selection-host");
    const selectedWorklet = new LocalWorklet("selection", "selection-host", [
      worker("research", "search"),
      worker("coding", "write"),
    ]);
    const durable = durableTestWorklet(selectedWorklet);
    const selectPlacement = vi.spyOn(durable, "selectPlacement");
    connection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet: selectedWorklet,
      durableWorklet: durable,
    });
    for (const [taskId, capability] of [
      ["research-task", "search"],
      ["coding-task", "write"],
      ["pending-task", "unavailable"],
    ]) {
      const response = await fetch(`${runtime.url}/api/v1/coordination/assign_task`, {
        method: "POST",
        headers: { Authorization: "Bearer selection-admin", "Content-Type": "application/json" },
        body: JSON.stringify({
          objectiveId: "objective",
          taskId,
          teamId: "team",
          assignedTagId: tag.id,
          instruction: `Perform ${capability}`,
          acceptanceCriteria: ["Evidence"],
          execution: { requires: [{ id: capability, version: 1 }] },
        }),
      });
      expect(response.status, await response.text()).toBe(200);
    }
    await expect
      .poll(async () => (await store.getTaskAssignment("coding-task"))?.status, {
        timeout: 10000,
      })
      .toBe("submitted");
    await expect
      .poll(async () => (await store.getTaskAssignment("research-task"))?.status, {
        timeout: 10000,
      })
      .toBe("submitted");
    expect(observed.filter((spec) => spec.taskId === "research-task")).toHaveLength(1);
    expect(selectPlacement).toHaveBeenCalled();
    expect(observed.some((spec) => spec.workerProfile.id.startsWith("decoy-"))).toBe(false);
    expect(observed.find((spec) => spec.taskId === "research-task")?.workerProfile).toEqual({
      id: "research",
      revision: "1",
    });
    expect(observed.find((spec) => spec.taskId === "coding-task")?.workerProfile).toEqual({
      id: "coding",
      revision: "1",
    });
    expect(observed.find((spec) => spec.taskId === "research-task")?.placement).toEqual({
      allowedWorkerHostIds: ["selection-host"],
      workerHostId: "selection-host",
      workletId: "selection",
      workerId: "research",
    });
    expect(observed.find((spec) => spec.taskId === "coding-task")?.placement).toEqual({
      allowedWorkerHostIds: ["selection-host"],
      workerHostId: "selection-host",
      workletId: "selection",
      workerId: "coding",
    });
    for (const taskId of ["research-task", "coding-task"]) {
      const [attempt] = await store.listTaskAttempts(taskId);
      expect(attempt?.workerProfile).toEqual(
        observed.find((spec) => spec.taskId === taskId)?.workerProfile,
      );
      expect(attempt?.workerSnapshot["placement"]).toMatchObject({
        allowedWorkerHostIds: ["selection-host"],
        workerHostId: "selection-host",
      });
      expect(observed.find((spec) => spec.taskId === taskId)?.authorization.tag).not.toHaveProperty(
        "workerProfile",
      );
    }
    expect(await store.listTaskAttempts("pending-task")).toHaveLength(0);
    expect((await store.getTaskAssignment("pending-task"))?.status).toBe("queued");
    await expect
      .poll(
        async () =>
          (await store.listTaskEvents("pending-task")).filter(
            (event) => event.type === "task.scheduling-incompatible",
          ).length,
      )
      .toBe(1);
    const schedulingEvent = (await store.listTaskEvents("pending-task")).find(
      (event) => event.type === "task.scheduling-incompatible",
    );
    expect(schedulingEvent?.payload).toMatchObject({
      version: 1,
      status: "incompatible",
      execution: { requires: [{ id: "unavailable", version: 1 }] },
      unmetRequirements: ["execution.requires.unavailable@1"],
    });
    const readResponse = await fetch(`${runtime.url}/api/v1/coordination/read_task`, {
      method: "POST",
      headers: { Authorization: "Bearer selection-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ objectiveId: "objective", taskId: "pending-task" }),
    });
    const readBody = await readResponse.text();
    expect(readResponse.status, readBody).toBe(200);
    expect(JSON.parse(readBody)).toMatchObject({
      taskId: "pending-task",
      scheduling: {
        status: "incompatible",
        unmetRequirements: ["execution.requires.unavailable@1"],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await store.listTaskEvents("pending-task")).filter(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    ).toHaveLength(1);
    // With no effort configured, the Task starts at low effort.
    expect((await store.findTaskById("research-task"))?.execution).toEqual({
      requires: [{ id: "search", version: 1 }],
      effort: "low",
    });
  } finally {
    await connection?.stop();
    await decoyConnection?.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
