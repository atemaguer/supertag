import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { conversationClient, workClient } from "../apps/cli/src/operator-client.js";
import { TaskStatus } from "../packages/operator-api/src/index.js";
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

it("schedules each Tag's Task onto the Worker its harness names and persists the concrete Attempt selection", async () => {
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
    // Each Tag pins its own harness; a Task of that Tag must run on a matching Worker profile.
    const researcher = await store.createTag({ name: "Researcher" });
    const coder = await store.createTag({ name: "Coder" });
    const stranded = await store.createTag({ name: "Stranded" });
    expect(researcher).not.toHaveProperty("workerProfile");
    await store.setTagExecution(researcher.id, { harness: "research" });
    await store.setTagExecution(coder.id, { harness: "coding" });
    await store.setTagExecution(stranded.id, { harness: "unavailable" });
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
    for (const tag of [researcher, coder, stranded])
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
    const message = async (tagName: string) =>
      (
        await conversationClient({
          url: runtime?.url ?? "",
          token: "selection-admin",
        }).sendMessage({ tag: tagName, text: "Do the work" })
      ).taskId;
    const researchTask = await message(researcher.name);
    const codingTask = await message(coder.name);
    const pendingTask = await message(stranded.name);
    await expect
      .poll(async () => (await store.findTaskById(codingTask))?.status, {
        timeout: 10000,
      })
      .toBe("completed");
    await expect
      .poll(async () => (await store.findTaskById(researchTask))?.status, {
        timeout: 10000,
      })
      .toBe("completed");
    expect(observed.filter((spec) => spec.taskId === researchTask)).toHaveLength(1);
    expect(selectPlacement).toHaveBeenCalled();
    expect(observed.some((spec) => spec.workerProfile.id.startsWith("decoy-"))).toBe(false);
    expect(observed.find((spec) => spec.taskId === researchTask)?.workerProfile).toEqual({
      id: "research",
      revision: "1",
    });
    expect(observed.find((spec) => spec.taskId === codingTask)?.workerProfile).toEqual({
      id: "coding",
      revision: "1",
    });
    expect(observed.find((spec) => spec.taskId === researchTask)?.placement).toMatchObject({
      allowedWorkerHostIds: ["selection-host"],
      workerHostId: "selection-host",
      workletId: "selection",
      workerId: "research",
    });
    expect(observed.find((spec) => spec.taskId === codingTask)?.placement).toMatchObject({
      allowedWorkerHostIds: ["selection-host"],
      workerHostId: "selection-host",
      workletId: "selection",
      workerId: "coding",
    });
    for (const taskId of [researchTask, codingTask]) {
      const [attempt] = await store.listTaskAttempts(taskId);
      expect(attempt?.workerProfile).toEqual(
        observed.find((spec) => spec.taskId === taskId)?.workerProfile,
      );
      expect(attempt?.workerSnapshot["placement"]).toMatchObject({
        workerHostId: "selection-host",
      });
      expect(observed.find((spec) => spec.taskId === taskId)?.authorization.tag).not.toHaveProperty(
        "workerProfile",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // A Tag pinned to a harness no bound Worker Host provides is never placed.
    expect(await store.listTaskAttempts(pendingTask)).toHaveLength(0);
    expect((await store.findTaskById(pendingTask))?.status).toBe("pending");
    expect(
      await workClient({ url: runtime.url, token: "selection-admin" }).getTask({ id: pendingTask }),
    ).toMatchObject({ id: pendingTask, status: TaskStatus.PENDING });

    // With no effort configured, the Task starts at low effort.
    expect((await store.findTaskById(researchTask))?.execution).toMatchObject({
      harness: "research",
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
