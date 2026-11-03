import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  dispatchedWorkspacePlan,
  placeByLabels,
  placeTask,
  placeWorkspaceMounts,
  volumeMountRequirements,
  withRequiredCapabilities,
} from "../packages/control-plane/src/label-placement.js";
import {
  artifactVolumeLabel,
  volumeCredentialLabel,
  type WorkerHost,
} from "../packages/core/src/index.js";
import {
  LocalWorklet,
  StaticWorker,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

type LabelledHost = Pick<WorkerHost, "id" | "enrollmentStatus" | "labels">;
const host = (id: string, labels: string[], active = true): LabelledHost => ({
  id,
  enrollmentStatus: active ? "active" : "revoked",
  labels,
});

describe("label placement", () => {
  it("refuses copy mounts before reserving hosts without mapping or provider support", () => {
    const copy = { id: "supertag.workspace.mount.copy", version: 1 };
    const hostWith = (id: string, labels: string[], capabilities: readonly unknown[]) => ({
      id,
      enrollmentStatus: "active" as const,
      labels,
      workerSnapshot: {
        labels,
        workers: [{ profileCapabilities: [{ capabilities }] }],
      },
    });
    const hosts = [
      hostWith("missing", [], [copy]),
      hostWith("unsupported", [volumeCredentialLabel("data")], []),
      hostWith("ready", [volumeCredentialLabel("data")], [copy]),
    ];
    const tiers = [{ allowedWorkerHostIds: hosts.map((host) => host.id), requires: [] }];
    expect(
      placeWorkspaceMounts(tiers, hosts, [{ volume: "datasets", credential: "data" }]),
    ).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["ready"], requires: [copy] }],
    });
    expect(
      placeWorkspaceMounts(
        tiers.slice(0, 1).map((tier) => ({ ...tier, allowedWorkerHostIds: ["missing"] })),
        hosts,
        [{ volume: "datasets", credential: "data" }],
      ),
    ).toMatchObject({
      status: "unmet",
      workspaceRefusals: [expect.stringContaining("Volume datasets has no credential mapping")],
    });
    expect(
      placeWorkspaceMounts([{ allowedWorkerHostIds: ["unsupported"], requires: [] }], hosts, [
        { volume: "datasets", credential: "data" },
      ]),
    ).toMatchObject({
      status: "unmet",
      workspaceRefusals: [
        expect.stringContaining("Volume datasets needs a Workspace environment that supports copy"),
      ],
    });
    expect(
      placeWorkspaceMounts([{ allowedWorkerHostIds: ["ready"], requires: [] }], hosts, [
        { volume: "local-files" },
      ]),
    ).toMatchObject({
      status: "unmet",
      workspaceRefusals: [expect.stringContaining("Volume local-files has no credential mapping")],
    });
    const grantedOnly = {
      ...hosts[0],
      id: "granted-only",
      labels: [volumeCredentialLabel("data")],
    };
    expect(
      placeWorkspaceMounts(
        [{ allowedWorkerHostIds: ["granted-only"], requires: [] }],
        [grantedOnly],
        [{ volume: "datasets", credential: "data" }],
      ),
    ).toMatchObject({
      status: "unmet",
      workspaceRefusals: [expect.stringContaining("Volume datasets has no credential mapping")],
    });
  });

  it("resolves a Workspace's immutable mount names for surface and Objective placement", async () => {
    const plan = {
      version: 1,
      status: "workspace",
      workspace: "research",
      source: "https://example.com/research.git",
      branch: "supertag/o/t",
      delivery: "branch",
      mounts: [{ volume: "datasets" }],
    } as const;
    const noArtifacts = {
      listVolumes: async () => [],
      listWorkerHosts: async () => [],
      listVolumeIdsHoldingArtifacts: async () => [],
    };
    const store = {
      ...noArtifacts,
      findVolumeByName: async (name: string) =>
        name === "datasets" ? { source: "s3://acme/datasets", credential: "data" } : undefined,
    };
    expect(await volumeMountRequirements(store, plan)).toEqual([
      { volume: "datasets", credential: "data" },
    ]);
    expect(await volumeMountRequirements({}, plan)).toEqual([
      { volume: "datasets", missing: true },
    ]);
    expect(
      await volumeMountRequirements(
        { ...noArtifacts, findVolumeByName: async () => ({ source: "s3://acme/x" }) },
        plan,
      ),
    ).toEqual([{ volume: "datasets" }]);
    // A store that cannot say which Volumes hold artifacts refuses the mount instead of guessing.
    expect(
      await volumeMountRequirements(
        { findVolumeByName: async () => ({ source: "s3://acme/x" }) },
        plan,
      ),
    ).toEqual([
      {
        volume: "datasets",
        refused: "Volume datasets cannot be checked for artifacts and cannot be mounted",
      },
    ]);
    expect(await volumeMountRequirements(store, { ...plan, mounts: {} })).toEqual([
      { volume: "invalid mount", missing: true },
    ]);
    expect(await volumeMountRequirements(store, { ...plan, mounts: [null] })).toEqual([
      { volume: "invalid mount", missing: true },
    ]);
  });

  it.each(["http", "https"])(
    "refuses artifact Volume mounts and validates %s loopback sources",
    async (protocol) => {
      const volumes = [
        {
          id: "v-art",
          name: "artifacts",
          source: "s3://shared/hosts?region=us-east-1",
          credential: "art",
        },
        // The same bucket and prefix spelled differently: r2:// with AWS's endpoint, a trailing
        // and doubled slash, and percent-encoding.
        { id: "v-1", name: "bucket", source: "s3://shared", credential: "data" },
        { id: "v-2", name: "inside", source: "s3://shared/hosts//sha256/", credential: "data" },
        {
          id: "v-3",
          name: "aws-endpoint",
          source: "r2://shared/ho%73ts?endpoint=https://s3.us-west-2.amazonaws.com",
          credential: "data",
        },
        { id: "v-4", name: "sibling", source: "s3://shared/hosts-datasets", credential: "data" },
        { id: "v-5", name: "elsewhere", source: "s3://other/hosts", credential: "data" },
        {
          id: "v-6",
          name: "minio",
          source: `s3://shared/hosts?endpoint=${protocol}://127.0.0.1:9000`,
          credential: "data",
        },
        // A Volume the catalog records an artifact copy on holds artifacts too, advertised or not.
        { id: "v-rec", name: "recorded", source: "file:///srv/Old-Artifacts", credential: "old" },
        {
          id: "v-7",
          name: "recorded-alias",
          source: "file:///srv//old-artifacts/x",
          credential: "d",
        },
        // Valid HTTPS loopback endpoints are one origin however they are spelled.
        // Plain HTTP is invalid even when the endpoint names a local object store.
        {
          id: "v-8",
          name: "local-artifacts",
          source: `s3://local/a?endpoint=${protocol}://localhost:9000`,
          credential: "art",
        },
        {
          id: "v-9",
          name: "local-alias",
          source: `r2://local/a/b?endpoint=${protocol}://127.0.0.2:9000`,
          credential: "data",
        },
        {
          id: "v-10",
          name: "local-other-port",
          source: `r2://local/a/b?endpoint=${protocol}://127.0.0.1:9001`,
          credential: "data",
        },
      ];
      const store = {
        findVolumeByName: async (name: string) => volumes.find((volume) => volume.name === name),
        listVolumes: async () => volumes,
        // Hosts advertise their artifact Volumes; the labels carry a digest of the name only.
        listWorkerHosts: async () => [
          { labels: [artifactVolumeLabel("artifacts")], workerSnapshot: {} },
          { labels: [], workerSnapshot: { labels: [artifactVolumeLabel("local-artifacts")] } },
        ],
        listVolumeIdsHoldingArtifacts: async () => ["v-rec"],
      };
      const plan = {
        version: 1,
        status: "workspace",
        workspace: "research",
        source: "https://example.com/research.git",
        branch: "supertag/o/t",
        delivery: "branch",
        mounts: volumes.map((volume) => ({ volume: volume.name })),
      } as const;
      const holds = (volume: string) => ({
        volume,
        refused: `Volume ${volume} holds artifacts and cannot be mounted`,
      });
      const overlaps = (volume: string, artifacts: string) => ({
        volume,
        refused: `Volume ${volume} overlaps artifact Volume ${artifacts} and cannot be mounted`,
      });
      const invalid = (volume: string) => ({
        volume,
        refused: `Volume ${volume} has an invalid source and cannot be mounted`,
      });
      const requirements = await volumeMountRequirements(store, plan);
      expect(requirements).toEqual([
        holds("artifacts"),
        overlaps("bucket", "artifacts"),
        overlaps("inside", "artifacts"),
        overlaps("aws-endpoint", "artifacts"),
        { volume: "sibling", credential: "data" },
        { volume: "elsewhere", credential: "data" },
        protocol === "http" ? invalid("minio") : { volume: "minio", credential: "data" },
        holds("recorded"),
        overlaps("recorded-alias", "recorded"),
        holds("local-artifacts"),
        protocol === "http" ? invalid("local-alias") : overlaps("local-alias", "local-artifacts"),
        protocol === "http"
          ? invalid("local-other-port")
          : { volume: "local-other-port", credential: "data" },
      ]);
      expect(
        placeWorkspaceMounts(
          [{ allowedWorkerHostIds: ["laptop"], requires: [] }],
          [{ ...host("laptop", [volumeCredentialLabel("art")]), workerSnapshot: {} }],
          [holds("artifacts")],
        ),
      ).toMatchObject({
        status: "unmet",
        workspaceRefusals: ["Volume artifacts holds artifacts and cannot be mounted"],
      });
      // A Task placed before its Volume held artifacts receives no mount consent for it.
      // File artifact sources remain in the catalog without credentials to protect host aliases.
      const dispatched = await dispatchedWorkspacePlan(store, plan);
      expect(
        dispatched.status === "workspace"
          ? dispatched.volumes
              ?.filter((volume) => volume.credential !== undefined)
              .map((volume) => volume.name)
          : [],
      ).toEqual(
        protocol === "http"
          ? ["sibling", "elsewhere"]
          : ["sibling", "elsewhere", "minio", "local-other-port"],
      );
      expect(dispatched.status === "workspace" ? dispatched.volumes : []).toContainEqual({
        name: "recorded",
        source: "file:///srv/Old-Artifacts",
      });
    },
  );

  it("applies Volume placement to a Workspace before selecting a profile", async () => {
    const copy = { id: "supertag.workspace.mount.copy", version: 1 };
    const clone = { id: "supertag.workspace.clone", version: 1 };
    const source = "https://example.com/research.git";
    const plan = {
      version: 1,
      status: "workspace",
      workspace: "research",
      source,
      branch: "supertag/o/t",
      delivery: "branch",
    } as const;
    const host = (id: string, mapped: boolean) => ({
      id,
      enrollmentStatus: "active" as const,
      labels: mapped ? [volumeCredentialLabel("data")] : [],
      workerSnapshot: {
        labels: mapped ? [volumeCredentialLabel("data")] : [],
        workers: [
          {
            profiles: [{ id: "p", revision: 1 }],
            profileCapabilities: [
              {
                profile: { id: "p", revision: 1 },
                capabilities: [clone, copy],
              },
            ],
          },
        ],
      },
    });
    const hosts = [host("missing", false), host("ready", true)];
    const mounts = [{ volume: "datasets", credential: "data" }];
    expect(
      await placeTask(
        hosts.map((entry) => entry.id),
        [],
        plan,
        async () => hosts,
        [],
        { mounts },
      ),
    ).toMatchObject({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["ready"], requires: [copy] }],
    });
    expect(await placeTask(["missing"], [], plan, async () => hosts, [], { mounts })).toMatchObject(
      {
        status: "unmet",
        workspaceRefusals: [expect.stringContaining("Volume datasets")],
      },
    );
  });
  const hosts = [
    host("mac", ["arm64", "macos"]),
    host("gpu", ["gpu", "linux", "x64"]),
    host("old-gpu-mac", ["gpu", "macos"], false),
  ];

  it("keeps every bound host when nothing is required, including hosts it cannot see", () => {
    expect(placeByLabels(["mac", "unknown"], hosts, [])).toEqual({
      status: "eligible",
      allowedWorkerHostIds: ["mac", "unknown"],
    });
  });

  it("narrows bound hosts to those carrying every label; bindings still decide access", () => {
    expect(placeByLabels(["mac", "gpu"], hosts, ["gpu"])).toEqual({
      status: "eligible",
      allowedWorkerHostIds: ["gpu"],
    });
    // An unbound host never becomes eligible because of its labels.
    expect(placeByLabels(["mac"], hosts, ["gpu"])).toMatchObject({ status: "unmet" });
  });

  it("names the labels no bound host has, or every label when none has them all", () => {
    expect(placeByLabels(["gpu"], hosts, ["macos", "gpu"])).toEqual({
      status: "unmet",
      missingLabels: ["macos"],
      requirement: "labels:macos",
    });
    expect(placeByLabels(["mac", "gpu"], hosts, ["macos", "gpu"])).toEqual({
      status: "unmet",
      missingLabels: ["macos", "gpu"],
      requirement: "labels:macos,gpu",
    });
    // A revoked host's labels do not count.
    expect(placeByLabels(["old-gpu-mac"], hosts, ["macos", "gpu"])).toMatchObject({
      requirement: "labels:macos,gpu",
    });
  });

  it("places a Workspace Task on checkout, clone, then prepared environment hosts", async () => {
    const inPlace = { id: "supertag.workspace.in-place", version: 1 };
    const clone = { id: "supertag.workspace.clone", version: 1 };
    const environment = { id: "supertag.workspace.environment", version: 1 };
    const cloner = (id: string, labels: string[]) => ({
      id,
      enrollmentStatus: "active" as const,
      labels,
      workerSnapshot: { id, workers: [{ id: "w", profiles: [], capabilities: [clone] }] },
    });
    const placementHosts = [
      { ...cloner("desk", ["gpu", "workspace:app"]), workerSnapshot: { id: "desk" } },
      cloner("builder", ["gpu"]),
      cloner("laptop", []),
      {
        ...cloner("cloud", ["gpu"]),
        workerSnapshot: {
          id: "cloud",
          workers: [{ id: "w", profiles: [], capabilities: [environment] }],
        },
      },
    ];
    const plan = {
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: "supertag/o/t",
      delivery: "branch",
    } as const;
    const load = async () => placementHosts;
    const bound = ["desk", "builder", "laptop", "cloud"];
    expect(await placeTask(bound, [], plan, load)).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["desk"], requires: [inPlace] }],
    });
    expect(
      await placeTask(bound, ["gpu"], { ...plan, source: "https://example.com/app.git" }, load),
    ).toEqual({
      status: "eligible",
      tiers: [
        { allowedWorkerHostIds: ["desk"], requires: [inPlace] },
        { allowedWorkerHostIds: ["builder"], requires: [] },
        { allowedWorkerHostIds: ["cloud"], requires: [environment] },
      ],
    });
    expect(
      await placeTask(["cloud"], [], { ...plan, source: "https://example.com/app.git" }, load),
    ).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["cloud"], requires: [environment] }],
    });
    const mixed = {
      ...placementHosts[3],
      workerSnapshot: {
        workers: [
          {
            profileCapabilities: [
              { profile: { id: "local", revision: 1 }, capabilities: [] },
              { profile: { id: "cloud", revision: 1 }, capabilities: [environment] },
            ],
          },
        ],
      },
    };
    expect(
      await placeTask(
        ["cloud"],
        [],
        { ...plan, source: "https://example.com/app.git" },
        async () => [mixed],
      ),
    ).toEqual({
      status: "eligible",
      tiers: [{ allowedWorkerHostIds: ["cloud"], requires: [environment] }],
    });
    expect(
      await placeTask(
        ["cloud"],
        [],
        { ...plan, source: "https://example.com/app.git" },
        async () => [
          {
            ...mixed,
            workerSnapshot: {
              workers: [
                {
                  profileCapabilities: [
                    { capabilities: [], workspaceRefusal: "modal image does not support mounts" },
                  ],
                },
              ],
            },
          },
        ],
      ),
    ).toEqual({
      status: "unmet",
      requirement: "workspace.checkout-or-clone:app",
      workspaceRefusals: ["Worker Host cloud: modal image does not support mounts"],
    });
    expect(await placeTask(["laptop"], [], plan, load)).toEqual({
      status: "unmet",
      requirement: "labels:workspace:app",
      missingLabels: ["workspace:app"],
    });
    expect(
      await placeTask(["desk"], ["tpu"], { ...plan, source: "https://example.com/app.git" }, load),
    ).toMatchObject({ status: "unmet", requirement: "labels:tpu" });
    expect(
      await placeTask(
        ["laptop"],
        ["gpu"],
        { ...plan, source: "https://example.com/app.git" },
        load,
      ),
    ).toMatchObject({ requirement: "labels:gpu" });
    expect(
      await placeTask(
        ["desk"],
        [],
        { ...plan, workspace: "docs", source: "https://example.com/docs.git" },
        async () => [placementHosts[0] as (typeof placementHosts)[number]],
      ),
    ).toEqual({ status: "unmet", requirement: "workspace.checkout-or-clone:docs" });
    // With no labels and no Workspace, hosts are never read.
    expect(
      await placeTask(bound, [], { version: 1, status: "none" }, async () => {
        throw new Error("hosts must not be read");
      }),
    ).toEqual({ status: "eligible", tiers: [{ allowedWorkerHostIds: bound, requires: [] }] });
    const already = { requires: [inPlace] };
    expect(withRequiredCapabilities({}, [inPlace])).toEqual({ requires: [inPlace] });
    expect(withRequiredCapabilities(already, [inPlace])).toBe(already);
  });
});

it("holds a surface Task until a bound Worker Host carries the Tag's runsOn labels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-surface-labels-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: new LocalWorklet("labels-worklet", "labels-host", [new StaticWorker()], {
      labels: ["gpu"],
    }),
    reply: async () => {},
    dispatch: { pollIntervalMs: 5 },
  });
  try {
    await controlPlane.start();
    const account = await controlPlane.setupSurfaceAccount({
      provider: "slack",
      externalAccountId: "T-LABELS",
      displayName: "Labels",
      authMethod: "slack-socket-mode",
      configuration: {},
      secrets: { botToken: "fake", appToken: "fake" },
    });
    const tag = await store.createTag({ name: "Labels" });
    await store.bindTagWorkerHost(tag.id, "labels-host");
    await store.setTagRunsOn(tag.id, ["gpu", "tpu"]);
    await store.addTagRoute({ tagId: tag.id, surfaceAccountId: account.id, scope: "channel:C1" });
    const admission = await controlPlane.ingestSurfaceEvent({
      eventId: "one",
      logicalEventId: "one",
      provider: "slack",
      externalAccountId: "T-LABELS",
      kind: "mention",
      scope: "channel:C1",
      sessionKey: "slack:T-LABELS:C1:1",
      actor: { id: "U1", kind: "user" },
      text: "Say hello",
      occurredAt: new Date().toISOString(),
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "T-LABELS|C1|1",
        target: { channelId: "C1", threadTs: "1" },
      },
      source: {},
      metadata: {},
    });
    const taskId = admission.taskId as string;
    // Labels place work; they never reject it. The Task waits for an eligible host.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await store.findTaskById(taskId))?.status).toBe("pending");
    expect(await store.listTaskAttempts(taskId)).toHaveLength(0);

    await store.setTagRunsOn(tag.id, ["GPU"]);
    await expect
      .poll(async () => (await store.findTaskById(taskId))?.status, { timeout: 5000 })
      .toBe("completed");
  } finally {
    await controlPlane.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

it("places Objective Tasks only on bound Worker Hosts that carry the Tag's runsOn labels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-objective-labels-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const connections: Awaited<ReturnType<typeof connectDurableTestWorklet>>[] = [];
  const observed: TaskAttemptSpec[] = [];
  const worker = (id: string): Worker => ({
    async describe() {
      const profile = { id, revision: "1" };
      const capabilities = [{ id: "supertag.coordination", version: 1 }];
      return {
        id,
        type: "deterministic",
        profiles: [profile],
        capabilities,
        contextTypes: [],
        profileCapabilities: [{ profile, harness: "codex", capabilities, contextTypes: [] }],
        maxConcurrency: 1,
      };
    },
    async *execute(spec) {
      observed.push(spec);
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
      yield { ...identity, at: new Date().toISOString(), type: "execution.started", workerId: id };
      yield {
        ...identity,
        at: new Date().toISOString(),
        type: "output.message",
        message: { role: "teammate", text: `Completed by ${id}` },
      };
      yield { ...identity, at: new Date().toISOString(), type: "execution.completed" };
    },
  });
  try {
    const gpuTag = await store.createTag({ name: "Trainer" });
    const tpuTag = await store.createTag({ name: "Researcher" });
    await store.createObjective({ id: "objective", ownerTagId: gpuTag.id, outcome: "Train" });
    await store.createTeam({
      id: "team",
      objectiveId: "objective",
      name: "Training",
      leadTagId: gpuTag.id,
      memberTagIds: [tpuTag.id],
      maxConcurrency: 2,
    });
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "labels-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    for (const [workerHostId, labels] of [
      ["cpu-host", []],
      ["gpu-host", ["gpu"]],
    ] as const) {
      const credential = await enrollWorkerHost(runtime.url, "labels-admin", workerHostId);
      for (const tag of [gpuTag, tpuTag]) await store.bindTagWorkerHost(tag.id, workerHostId);
      connections.push(
        await connectDurableTestWorklet({
          url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
          credential,
          worklet: new LocalWorklet(
            `${workerHostId}-worklet`,
            workerHostId,
            [worker(workerHostId)],
            {
              labels: [...labels],
            },
          ),
        }),
      );
    }
    await expect
      .poll(async () => (await store.findWorkerHostById("gpu-host"))?.labels ?? [])
      .toContain("gpu");
    expect((await store.findWorkerHostById("gpu-host"))?.labels).toContain("harness:codex");
    await store.setTagRunsOn(gpuTag.id, ["gpu"]);
    await store.setTagRunsOn(tpuTag.id, ["gpu", "tpu"]);

    for (const [taskId, tag] of [
      ["gpu-task", gpuTag],
      ["tpu-task", tpuTag],
    ] as const) {
      const response = await fetch(`${runtime.url}/api/v1/coordination/assign_task`, {
        method: "POST",
        headers: { Authorization: "Bearer labels-admin", "Content-Type": "application/json" },
        body: JSON.stringify({
          objectiveId: "objective",
          taskId,
          teamId: "team",
          assignedTagId: tag.id,
          instruction: "Train the model",
          acceptanceCriteria: ["Trained"],
        }),
      });
      expect(response.status, await response.text()).toBe(200);
    }
    await expect
      .poll(async () => (await store.getTaskAssignment("gpu-task"))?.status, { timeout: 10000 })
      .toBe("submitted");
    expect(observed.find((spec) => spec.taskId === "gpu-task")?.placement).toMatchObject({
      allowedWorkerHostIds: ["gpu-host"],
      workerHostId: "gpu-host",
    });

    await expect
      .poll(
        async () =>
          (await store.listTaskEvents("tpu-task")).find(
            (event) => event.type === "task.scheduling-incompatible",
          )?.payload,
        { timeout: 10000 },
      )
      .toMatchObject({ status: "incompatible", unmetRequirements: ["labels:tpu"] });
    expect(observed.some((spec) => spec.taskId === "tpu-task")).toBe(false);
  } finally {
    for (const connection of connections) await connection.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
