import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { hostCredentialPath } from "../apps/cli/src/local-state.ts";
import { formatRows } from "../apps/cli/src/ps.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import {
  EPHEMERAL_HOST_STORAGE,
  EPHEMERAL_ONLY_COPY_WARNING,
  hostServiceStorageWarnings,
} from "../apps/cli/src/storage-durability.ts";
import { taskStorage } from "../apps/cli/src/task-storage.ts";
import { bringUp } from "../apps/cli/src/up.ts";
import { workletStorageWarnings } from "../apps/cli/src/worker.ts";
import { resolveWorkletCredential } from "../apps/cli/src/worker-host-join.ts";
import {
  readWorkerHostCredential,
  writeWorkerHostCredential,
} from "../apps/cli/src/worker-hosts.ts";
import { fakeWorkRpc } from "./support/fake-work-rpc.ts";

const EPHEMERAL_LINE =
  "Ephemeral storage: Task files and artifacts on this host are lost if it stops.";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "supertag-storage-durability-"));
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function sandboxWorkers(provider: string) {
  return [
    {
      id: "codex",
      type: "codex",
      capabilities: [],
      profiles: [{ id: "codex", revision: "1" }],
      contextTypes: [],
      profileCapabilities: [
        {
          profile: { id: "codex", revision: "1" },
          capabilities: [{ id: `supertag.execution.remote-sandbox.${provider}`, version: 1 }],
          contextTypes: [],
        },
      ],
    },
  ];
}

async function describeHost(status: Record<string, unknown>): Promise<string> {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  vi.spyOn(client, "request").mockResolvedValue({
    apiVersion: "supertag/v1",
    kind: "WorkerHost",
    metadata: { id: "ci-7" },
    spec: { draining: false },
    status: { phase: "ready", labels: [], workers: [], ...status },
  });
  return runResourceCommand(client, "describe", ["worker-host", "ci-7"]);
}

describe("describe worker-host", () => {
  it("says an ephemeral host's Task files and artifacts are lost if it stops", async () => {
    expect(EPHEMERAL_HOST_STORAGE).toBe(EPHEMERAL_LINE);
    const text = await describeHost({ ephemeral: true });
    expect(text).toContain(`${EPHEMERAL_LINE}\n`);
    expect(text).not.toContain("Storage: persistent");
  });

  it("keeps recorded sandbox warnings when the host omits its capabilities", async () => {
    const text = await describeHost({
      ephemeral: false,
      workers: [],
      storage: { sandboxes: ["e2b", "modal"], placementUnknown: false },
    });
    expect(text).toContain("Task files in e2b sandboxes are lost");
    expect(text).toContain("Task files in modal sandboxes are lost");
    expect(text).not.toContain("Storage: persistent");
  });

  it("does not treat missing execution evidence as persistent Task storage", async () => {
    const text = await describeHost({ ephemeral: false, workers: [] });
    expect(text).toContain("Task storage durability is unknown");
    expect(text).not.toContain("Storage: persistent");
  });

  it("counts a host whose Workers run remote sandboxes as ephemeral", async () => {
    const text = await describeHost({
      ephemeral: false,
      workers: sandboxWorkers("modal"),
      storage: { sandboxes: ["e2b"], placementUnknown: false },
    });
    expect(text).toContain(
      "Ephemeral storage: Task files in e2b sandboxes are lost when each sandbox stops.\n",
    );
    expect(text).not.toContain(EPHEMERAL_LINE);
  });

  it("says a host joined without an ephemeral Auth Key is persistent", async () => {
    const text = await describeHost({
      ephemeral: false,
      storage: { sandboxes: [], placementUnknown: false },
    });
    expect(text).toContain("Storage: persistent\n");
    expect(text).not.toContain("Ephemeral storage");
  });
});

describe("supertag ps", () => {
  const host = {
    service: "ci",
    type: "host" as const,
    state: "running" as const,
    configured: true,
    workerHostId: "ci-7",
  };

  it("prints the ephemeral storage line under an ephemeral host", () => {
    expect(formatRows([{ ...host, ephemeral: true }])).toContain(`\n  ${EPHEMERAL_LINE}\n`);
  });

  it("prints the sandbox line under a host with a remote sandbox environment", () => {
    expect(formatRows([{ ...host, environment: "modal" }])).toContain(
      "\n  Ephemeral storage: Task files in modal sandboxes are lost when each sandbox stops.\n",
    );
  });

  it("prints nothing about storage for a persistent local host", () => {
    expect(formatRows([host])).not.toContain("Ephemeral storage");
    expect(formatRows([{ ...host, artifactVolume: "team" }])).not.toContain("Ephemeral storage");
  });

  it("says an ephemeral host's artifacts outlive it on its artifact Volume", () => {
    const text = formatRows([{ ...host, ephemeral: true, artifactVolume: "team" }]);
    expect(text).toContain(
      "\n  Ephemeral storage: Task files on this host are lost if it stops; its artifacts are kept on Volume team.\n",
    );
    expect(text).not.toContain(EPHEMERAL_LINE);
  });
});

describe("describe task", () => {
  async function describeTask(storage: unknown, delivery?: unknown): Promise<string> {
    const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
    fakeWorkRpc([
      {
        apiVersion: "supertag/v1",
        kind: "Task",
        metadata: { id: "task-1" },
        spec: { tagId: "builder", sessionId: "session" },
        status: { phase: "completed", storage, ...(delivery ? { delivery } : {}) },
      },
    ]);
    return runResourceCommand(client, "describe", ["task", "task-1"]);
  }

  it("says where each output and artifact lives and flags ephemeral-only copies", async () => {
    const text = await describeTask(
      {
        taskFiles: { workerHostId: "ci-7", ephemeral: true },
        artifacts: [
          {
            artifactId: "art-report",
            title: "Report",
            files: 1,
            locations: [
              { kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false },
              { kind: "volume", volume: "team-artifacts" },
            ],
            ephemeralOnly: false,
          },
          {
            artifactId: "art-notes",
            title: "Notes",
            files: 3,
            locations: [
              { kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false },
            ],
            ephemeralOnly: true,
          },
          {
            artifactId: "art-kept",
            title: "Kept",
            files: 1,
            locations: [
              { kind: "worker-host", workerHostId: "build-1", ephemeral: false, removed: false },
            ],
            ephemeralOnly: false,
          },
        ],
        moreArtifacts: false,
      },
      {
        patches: [],
        outputs: [{ artifactId: "art-report", paths: ["outputs/report.md"] }],
      },
    );
    expect(text).toContain("Storage:\n");
    expect(text).toContain("  Task files: Worker Host ci-7 (ephemeral); lost if it stops\n");
    expect(text).toContain(
      '  Output art-report "Report" (1 file): Worker Host ci-7 (ephemeral), Volume team-artifacts\n',
    );
    expect(text).not.toContain("Control Plane artifact store");
    expect(text).toContain(
      '  Artifact art-notes "Notes" (3 files): Worker Host ci-7 (ephemeral)\n',
    );
    expect(text).toContain(
      '  Artifact art-notes "Notes" (3 files): Worker Host ci-7 (ephemeral)\n    Ephemeral storage risk',
    );
    expect(text).toContain(
      '  Artifact art-kept "Kept" (1 file): Worker Host build-1 (persistent)\n',
    );
    expect(text.match(/Ephemeral storage risk/gu)).toHaveLength(1);
    // The Control Plane keeps no copy, so it is never offered as the way to keep one.
    expect(text).toContain(
      "    Ephemeral storage risk: no durable copy recorded; files may be lost when the producing Worker Host stops, or already unavailable. The Control Plane keeps no copy; a persistent Worker Host or a Volume would keep one.\n",
    );
  });

  it("places Task files in a remote sandbox and a branch in the host's checkout", async () => {
    const sandbox = await describeTask({
      taskFiles: { workerHostId: "laptop", ephemeral: false, sandbox: "modal" },
      artifacts: [],
      moreArtifacts: false,
    });
    expect(sandbox).toContain(
      "  Task files: a modal sandbox from Worker Host laptop (persistent); ephemeral, lost when the sandbox stops\n",
    );
    const branch = await describeTask(
      {
        taskFiles: { workerHostId: "laptop", ephemeral: false },
        artifacts: [],
        moreArtifacts: true,
      },
      {
        patches: [],
        outputs: [],
        workspace: {
          name: "supertag",
          branch: "supertag/o/t",
          delivery: "branch",
          head: "a".repeat(40),
          changedFiles: 2,
        },
      },
    );
    expect(branch).toContain(
      "  Branch supertag/o/t: the Workspace checkout on Worker Host laptop (persistent)\n",
    );
    expect(branch).toContain(
      "  More artifacts are not shown: supertag list artifact --task task-1\n",
    );
  });

  it("reads locations from the catalog: Worklet copies, Volume copies, removed hosts", async () => {
    const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
    const copies: Record<string, readonly { workerHostId: string }[]> = {
      [digest("a")]: [],
      [digest("b")]: [{ workerHostId: "ci-7" }],
      [digest("c")]: [{ workerHostId: "ci-7" }, { workerHostId: "build-1" }],
      [digest("d")]: [{ workerHostId: "gone" }],
    };
    const artifact = (id: string, letters: string) => ({
      id,
      title: id,
      taskId: "task-1",
      attemptId: id,
      entries: [...letters].map((letter) => ({
        path: `${letter}.txt`,
        uri: `supertag-artifact:${digest(letter)}`,
        digest: digest(letter),
        sizeBytes: 1,
      })),
    });
    const store = {
      listTaskAttempts: vi.fn(async () => [
        ...["central", "ephemeral-only", "mixed"].map((id) => ({
          id,
          workerSnapshot: { workerHostId: "ci-7" },
        })),
        { id: "replicated", workerSnapshot: { workerHostId: "build-1" } },
        { id: "lost", workerSnapshot: { workerHostId: "gone" } },
      ]),
      // Capture requires a receipt for every entry. Only central also has a Volume copy.
      hasArtifactUpload: vi.fn(async () => true),
      listCapturedArtifacts: vi.fn(async () => ({
        artifacts: [
          artifact("central", "a"),
          artifact("ephemeral-only", "b"),
          artifact("replicated", "c"),
          artifact("mixed", "ab"),
          artifact("lost", "d"),
        ],
      })),
      listArtifactStorageLocations: vi.fn(async ({ digest: key }: { digest: string }) =>
        (copies[key] ?? []).map((copy) => ({
          ...copy,
          digest: key,
          sizeBytes: 1,
          connectionGeneration: 1,
          inventoryRevision: 1,
          transferBaseUrl: "https://10.0.0.7:9443/private",
          status: "available",
          observedAt: "2026-10-05T00:00:00.000Z",
        })),
      ),
      // Only the shared file is on a Volume; the Control Plane holds no copy of any of them.
      listArtifactVolumeLocations: vi.fn(async ({ digest: key }: { digest: string }) =>
        key === digest("a")
          ? [
              {
                volumeId: "volume-1",
                key: `attempts/central/sha256/${key.slice(7)}`,
                digest: key,
                sizeBytes: 1,
                workerHostId: "ci-7",
                status: "available",
                observedAt: "2026-10-05T00:00:00.000Z",
              },
            ]
          : [],
      ),
      listVolumes: vi.fn(async () => [{ id: "volume-1", name: "team-artifacts" }]),
      listWorkerHosts: vi.fn(async () => [
        { id: "ci-7", ephemeral: true, enrollmentStatus: "active", workerSnapshot: {} },
        { id: "build-1", ephemeral: false, enrollmentStatus: "active", workerSnapshot: {} },
        { id: "gone", ephemeral: true, enrollmentStatus: "revoked", workerSnapshot: {} },
      ]),
    };
    const storage = await taskStorage(
      store as never,
      "task-1",
      { workerSnapshot: { workerHostId: "ci-7" } } as never,
      { provider: "local", placement: "local" },
    );
    expect(store.listCapturedArtifacts).toHaveBeenCalledWith({ taskId: "task-1", limit: 20 });
    expect(JSON.stringify(storage)).not.toContain("10.0.0.7");
    expect(JSON.stringify(storage)).not.toContain("artifacts/sha256");
    expect(storage.taskFiles).toEqual({ workerHostId: "ci-7", ephemeral: true });
    const byId = Object.fromEntries(storage.artifacts.map((item) => [item.artifactId, item]));
    expect(byId["central"]).toMatchObject({
      locations: [{ kind: "volume", volume: "team-artifacts" }],
      ephemeralOnly: false,
    });
    expect(byId["ephemeral-only"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "ci-7", ephemeral: true, removed: false }],
      ephemeralOnly: true,
    });
    // Only the producing host (build-1, persistent) counts; ci-7's identical copy does not.
    expect(byId["replicated"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "build-1", ephemeral: false }],
      ephemeralOnly: false,
    });
    expect(byId["mixed"]).toMatchObject({ files: 2, ephemeralOnly: true });
    expect(byId["lost"]).toMatchObject({
      locations: [{ kind: "worker-host", workerHostId: "gone", removed: true }],
      ephemeralOnly: true,
    });
    expect(storage.moreArtifacts).toBe(false);

    const sandbox = await taskStorage(
      store as never,
      "task-1",
      { workerSnapshot: { workerHostId: "build-1" } } as never,
      { provider: "e2b", placement: "remote" },
    );
    expect(sandbox.taskFiles).toEqual({
      workerHostId: "build-1",
      ephemeral: false,
      sandbox: "e2b",
    });
  });
});

describe("connect worklet", () => {
  it("warns, without refusing, when an ephemeral host would hold the only copy of artifacts", () => {
    // Every Worklet keeps its own copies; the Control Plane keeps none to fall back on.
    expect(workletStorageWarnings({ ephemeral: true })).toEqual([
      EPHEMERAL_LINE,
      EPHEMERAL_ONLY_COPY_WARNING,
    ]);
    expect(EPHEMERAL_ONLY_COPY_WARNING).toMatch(
      /ephemeral Worker Host would hold the only copy of the artifacts/u,
    );
    expect(EPHEMERAL_ONLY_COPY_WARNING).toMatch(/the Control Plane keeps no copy/u);
    expect(EPHEMERAL_ONLY_COPY_WARNING).not.toMatch(/artifact-storage|centralized/u);
    expect(workletStorageWarnings({})).toEqual([]);
  });

  it("learns that the host is ephemeral when its Auth Key joins it, and stores nothing", async () => {
    const state = join(directory, "state");
    const credential = await resolveWorkletCredential({
      controlPlane: "https://supertag.example.com",
      authKey: `stak_${"a".repeat(64)}`,
      hostname: "ci",
      stateDirectory: state,
      fetch: async () =>
        new Response(
          JSON.stringify({
            apiVersion: "supertag/v1",
            kind: "WorkerHostCredential",
            metadata: { workerHostId: "ci-7" },
            credential: { token: "host-token" },
            status: { ephemeral: true, tags: [] },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    });
    expect(credential).toMatchObject({ workerHostId: "ci-7", source: "auth-key", ephemeral: true });
    await expect(readFile(join(state, "worker-hosts", "ci-7.json"))).rejects.toThrow();
  });
});

describe("supertag up", () => {
  it("keeps whether a host service joined as ephemeral with its credential", async () => {
    const path = join(directory, "credential.json");
    await writeWorkerHostCredential(path, {
      version: 1,
      workerHostId: "ci-7",
      token: "host-token",
      ephemeral: true,
    });
    expect(await readWorkerHostCredential(path)).toMatchObject({ ephemeral: true });
    await writeFile(
      path,
      JSON.stringify({ version: 1, workerHostId: "ci-7", token: "t", ephemeral: false }),
      { mode: 0o600 },
    );
    await expect(readWorkerHostCredential(path)).rejects.toThrow(/unsupported format/u);
  });

  it("names the warnings for an ephemeral host service and a remote sandbox one", () => {
    expect(hostServiceStorageWarnings({ name: "laptop" }, false)).toEqual([]);
    expect(hostServiceStorageWarnings({ name: "ci" }, true)).toEqual([
      `Warning: host service ci joined as an ephemeral Worker Host. Ephemeral storage: Task files and artifacts on this host are lost if it stops; the Control Plane keeps no copy of its artifacts.`,
    ]);
    expect(
      hostServiceStorageWarnings({ name: "cloud", environment: { provider: "e2b" } }, false),
    ).toEqual([
      `Warning: host service cloud runs Tasks in e2b sandboxes. Ephemeral storage: Task files in e2b sandboxes are lost when each sandbox stops; artifacts its Tasks capture are kept on this host.`,
    ]);
  });

  it("warns in a dry run for a remote sandbox host service that joined as ephemeral", async () => {
    const config = join(directory, "config");
    await mkdir(config, { recursive: true });
    const file = join(config, "supertag.yaml");
    await writeFile(
      file,
      `services:
  cloud:
    type: host
    control-plane: https://supertag.acme.dev
    harnesses: [codex]
    environment: e2b
`,
    );
    await writeWorkerHostCredential(hostCredentialPath("cloud"), {
      version: 1,
      workerHostId: "cloud-1",
      token: "host-token",
      controlPlane: "https://supertag.acme.dev",
      ephemeral: true,
    });
    const output: string[] = [];
    await bringUp({ files: [file], dryRun: true, write: (text) => output.push(text) });
    const printed = output.join("");
    expect(printed).toContain("start cloud: not running");
    expect(printed).toContain(
      "Warning: host service cloud joined as an ephemeral Worker Host. Ephemeral storage: Task files and artifacts on this host are lost if it stops;",
    );
    expect(printed).toContain(
      "Warning: host service cloud runs Tasks in e2b sandboxes. Ephemeral storage: Task files in e2b sandboxes are lost when each sandbox stops;",
    );
    expect(printed).not.toContain("host-token");
  });
});
