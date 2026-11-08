import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { advertisesWorkspaceClone, type WorkerHost } from "../packages/core/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptSpec,
  WORKSPACE_CLONE_CAPABILITY,
  WORKSPACE_IN_PLACE_CAPABILITY,
  type Worker,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

describe("Scheduling Workspace Tasks on hosts that clone", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const started: TaskAttemptSpec[] = [];
  const worker = (capabilities: { inPlace?: boolean; clone?: boolean }): Worker => ({
    async describe() {
      return {
        profileCapabilities: [
          {
            profile: { id: "default", revision: "1" },
            capabilities: [
              COORDINATION_CAPABILITY,
              SURFACE_COORDINATION_CAPABILITY,
              ...(capabilities.inPlace ? [WORKSPACE_IN_PLACE_CAPABILITY] : []),
              ...(capabilities.clone ? [WORKSPACE_CLONE_CAPABILITY] : []),
            ],
            contextTypes: [],
          },
        ],
        id: "worker",
        type: "test",
        profiles: [{ id: "default", revision: "1" }],
        capabilities: [
          COORDINATION_CAPABILITY,
          SURFACE_COORDINATION_CAPABILITY,
          ...(capabilities.inPlace ? [WORKSPACE_IN_PLACE_CAPABILITY] : []),
          ...(capabilities.clone ? [WORKSPACE_CLONE_CAPABILITY] : []),
        ],
        contextTypes: [],
      };
    },
    async *execute(spec) {
      started.push(spec);
      yield {
        type: "execution.started",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        workerId: "worker",
      };
      yield {
        type: "execution.completed",
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
    },
  });

  async function fixture(options: {
    source?: string;
    worklet: LocalWorklet;
    /** Worker Hosts known to the Control Plane besides the embedded Worklet's host. */
    hosts?: WorkerHost[];
    bindings?: string[];
  }) {
    started.length = 0;
    const directory = await mkdtemp(join(tmpdir(), "supertag-clone-scheduling-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    await store.applyWorkspace({
      name: "app",
      ...(options.source === undefined ? {} : { source: options.source }),
      delivery: "branch",
    });
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    const member = await store.createTag({ name: `member-${randomUUID()}` });
    for (const tag of [owner, member])
      for (const host of options.bindings ?? ["host"]) await store.bindTagWorkerHost(tag.id, host);
    const team = await store.createTeam({
      id: randomUUID(),
      name: `delivery-${randomUUID()}`,
      memberTagIds: [owner.id, member.id],
      maxConcurrency: 1,
    });
    const objective = await store.createObjective({
      id: `objective-${randomUUID().slice(0, 8)}`,
      ownerTagId: owner.id,
      teamId: team.id,
      outcome: "Ship the change.",
      workspaces: ["app"],
    });
    // Other Worker Hosts come from stored descriptors; the embedded Worklet reports its own.
    const persistence = new Proxy(store, {
      get(target, property) {
        if (property === "listWorkerHosts") return async () => options.hosts ?? [];
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const controlPlane = new ControlPlane({
      store: persistence,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      worklet: durableTestWorklet(options.worklet),
      reply: async () => undefined,
      dispatch: { pollIntervalMs: 10 },
    });
    controlPlane.objectives.activateCoordination({ url: "http://127.0.0.1:1" });
    await controlPlane.start();
    cleanups.push(() => controlPlane.stop());
    // Starting the Objective admits the first turn of its own conversation, which carries the
    // Objective's only Workspace.
    const { taskId } = await controlPlane.startObjective(objective.id);
    const hold = () =>
      eventually(async () =>
        (await store.listTaskEvents(taskId)).find(
          (event) => event.type === "task.scheduling-incompatible",
        ),
      );
    return { store, taskId, hold };
  }

  it("places a Task on a host that clones when the Workspace records a source", async () => {
    await fixture({
      source: "https://github.com/acme/app.git",
      worklet: new LocalWorklet("w", "host", [worker({ inPlace: true, clone: true })]),
    });
    const spec = await eventually(async () => started[0]);
    expect(spec.workspacePlan).toMatchObject({
      status: "workspace",
      source: "https://github.com/acme/app.git",
    });
    expect(spec.placement?.allowedWorkerHostIds).toEqual(["host"]);
  });

  it("holds a Task with a source when no bound host declares a checkout or clones", async () => {
    const f = await fixture({
      source: "https://github.com/acme/app.git",
      worklet: new LocalWorklet("w", "host", [worker({ inPlace: true })]),
    });
    expect((await f.hold()).payload).toMatchObject({
      unmetRequirements: ["workspace.checkout-or-clone:app"],
    });
    expect(started).toEqual([]);
  });

  it("does not clone a Workspace that records no source", async () => {
    const f = await fixture({
      worklet: new LocalWorklet("w", "host", [worker({ inPlace: true, clone: true })]),
    });
    expect((await f.hold()).payload).toMatchObject({
      unmetRequirements: ["labels:workspace:app"],
    });
    expect(started).toEqual([]);
  });

  it("prefers hosts that declare a checkout and falls back to hosts that clone", async () => {
    const at = new Date().toISOString();
    const desk: WorkerHost = {
      id: "desk",
      credentialId: "desk",
      credentialRevision: 1,
      enrollmentStatus: "active",
      connectionGeneration: 1,
      connectionStatus: "connected",
      workerSnapshot: { id: "desk", workers: [], workspaces: ["app"] },
      labels: ["workspace:app"],
      grantedLabels: [],
      capacity: 1,
      availableSlots: 1,
      activeAttempts: 0,
      ready: true,
      draining: false,
      failedAuthenticationCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    // The declaring host is tried first; this Worklet cannot place there, so the Task runs on
    // the host that clones.
    await fixture({
      source: "https://github.com/acme/app.git",
      worklet: new LocalWorklet("w", "host", [worker({ inPlace: true, clone: true })]),
      hosts: [desk],
      bindings: ["desk", "host"],
    });
    const spec = await eventually(async () => started[0]);
    expect(spec.placement?.allowedWorkerHostIds).toEqual(["host"]);

    // When the embedded host itself declares the checkout, only the declaring tier is offered.
    await fixture({
      source: "https://github.com/acme/app.git",
      worklet: new LocalWorklet("w", "host", [worker({ inPlace: true, clone: true })], {
        workspaces: ["app"],
      }),
      hosts: [
        {
          ...desk,
          id: "laptop",
          labels: [],
          workerSnapshot: {
            id: "laptop",
            workers: [{ id: "worker", profiles: [], capabilities: [WORKSPACE_CLONE_CAPABILITY] }],
          },
        },
      ],
      bindings: ["host", "laptop"],
    });
    const preferred = await eventually(async () => started[0]);
    expect(preferred.placement?.allowedWorkerHostIds).toEqual(["host"]);
  });

  it("advertises the clone capability only for in-place profiles of a Worker that clones", async () => {
    const resolvers = (cloneSources: boolean) =>
      new WorkspaceResolverRegistry([
        new WorkspaceEnvironmentResolver({ checkouts: [], cloneSources }),
      ]);
    const cloning = createClaudeCodeWorker({
      workspace: tmpdir(),
      workspaceResolvers: resolvers(true),
    });
    const capabilities = (await cloning.describe()).profileCapabilities?.[0]?.capabilities;
    expect(capabilities).toContainEqual(WORKSPACE_CLONE_CAPABILITY);
    expect(capabilities).toContainEqual(WORKSPACE_IN_PLACE_CAPABILITY);
    const host = await new LocalWorklet("w", "host", [cloning]).describe();
    expect(advertisesWorkspaceClone(host.host as never)).toBe(true);

    const plain = createClaudeCodeWorker({
      workspace: tmpdir(),
      workspaceResolvers: resolvers(false),
    });
    expect((await plain.describe()).profileCapabilities?.[0]?.capabilities).not.toContainEqual(
      WORKSPACE_CLONE_CAPABILITY,
    );
    const mixed = await new LocalWorklet("w", "host", [cloning, plain]).describe();
    expect(advertisesWorkspaceClone(mixed.host as never)).toBe(false);
    expect(advertisesWorkspaceClone({ workers: [] })).toBe(false);
  });
});

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
