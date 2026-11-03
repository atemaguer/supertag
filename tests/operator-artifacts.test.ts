import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runArtifactCommand, unreachableReport } from "../apps/cli/src/artifacts.js";
import {
  ControlPlaneApiServer,
  type ControlPlaneApiServerDependencies,
} from "../apps/cli/src/control-plane-api.js";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import type { AnyArtifactTransferGrantClaims } from "../packages/core/src/index.js";
import {
  FileArtifactStore,
  signArtifactTransferGrant,
  verifyArtifactTransferGrant,
  WorkletArtifactTransferServer,
} from "../packages/runtime/sdk/src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const keys = generateKeyPairSync("ed25519");
async function fixture(
  copies: {
    readonly publicUrl?: string;
    readonly localHost?: boolean;
    readonly operatorAddress?: string | null;
    readonly hosts?: readonly { workerHostId: string; transferBaseUrl: string }[];
    readonly volumes?: readonly { volumeId: string; key: string; workerHostId?: string }[];
  } = {},
) {
  const content = Buffer.from("verified artifact\n");
  const entry = {
    path: "outputs/evidence.txt",
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    sizeBytes: content.length,
  };
  const artifact = {
    id: "artifact/one",
    createdAt: new Date().toISOString(),
    taskId: "task-one",
    attemptId: "attempt-one",
    entries: [entry],
  };
  const signed: AnyArtifactTransferGrantClaims[] = [];
  const store = {
    hasArtifactUpload: vi.fn(async () => true),
    recordAuditEntry: vi.fn(async () => undefined),
    listCapturedArtifacts: vi.fn(async () => ({ artifacts: [artifact], nextCursor: "next" })),
    findCapturedArtifact: vi.fn(async (id: string) => (id === artifact.id ? artifact : undefined)),
    listTaskAttempts: vi.fn(async () => [
      { id: "attempt-one", workerSnapshot: { workerHostId: "producer-host" } },
    ]),
    listWorkerHosts: vi.fn(async () => [
      { id: "producer-host", ephemeral: true, enrollmentStatus: "active" },
    ]),
    listVolumes: vi.fn(async () => [
      { id: "volume-1", name: "team", source: "s3://team/artifacts", credential: "team-key" },
    ]),
    listArtifactStorageLocations: vi.fn(async () =>
      (copies.hosts ?? []).map((host) => ({ ...host, status: "available" })),
    ),
    listArtifactVolumeLocations: vi.fn(async () =>
      (copies.volumes ?? []).map((volume) => ({
        workerHostId: "producer-host",
        ...volume,
        status: "available",
      })),
    ),
  };
  const api = new ControlPlaneApiServer({
    publicUrl: copies.publicUrl ?? "http://127.0.0.1:3434",
    adminToken: "administrator",
    coordinationOperatorCredentials: [
      { operatorId: "coordinator", token: "coordination-only", actions: ["*"] },
    ],
    controlPlane: { objectives: {} },
    workletApi: {
      start() {},
      async stop() {},
      isHostConnectionLoopback: () => copies.localHost === true,
    },
    artifactTransfers: {
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      sign: (claims: AnyArtifactTransferGrantClaims) => {
        signed.push(claims);
        return signArtifactTransferGrant(claims, keys.privateKey);
      },
    },
    store,
  } as unknown as ControlPlaneApiServerDependencies);
  api.start();
  const server = createServer((request, response) => {
    if (copies.operatorAddress !== undefined)
      Object.defineProperty(request.socket, "remoteAddress", {
        value: copies.operatorAddress ?? undefined,
      });
    void api
      .handle(request, response, new URL(request.url ?? "/", "http://localhost"))
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  cleanup.push(async () => {
    await api.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const origin = `http://127.0.0.1:${address.port}`,
    path = `/api/v1/artifacts/${encodeURIComponent(artifact.id)}`;
  return {
    origin,
    path,
    store,
    entry,
    artifact,
    content,
    signed,
    client: new ControlPlaneClient({ url: origin, token: "administrator" }),
    get: (route: string) =>
      fetch(origin + route, { headers: { authorization: "Bearer administrator" } }),
  };
}
it("authenticates every operator artifact route before metadata access", async () => {
  const f = await fixture();
  for (const path of ["/api/v1/artifacts", f.path])
    for (const token of [undefined, "wrong"]) {
      const response = await fetch(f.origin + path, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  expect(f.store.listCapturedArtifacts).not.toHaveBeenCalled();
  expect(f.store.findCapturedArtifact).not.toHaveBeenCalled();
  const list = await f.get("/api/v1/artifacts?task=task-one&limit=2&cursor=previous");
  expect(await list.json()).toMatchObject({
    kind: "ArtifactList",
    metadata: { nextCursor: "next" },
  });
  expect(f.store.listCapturedArtifacts).toHaveBeenCalledWith({
    taskId: "task-one",
    limit: 2,
    cursor: "previous",
  });
  expect(await (await f.get(f.path)).json()).toMatchObject({
    kind: "Artifact",
    metadata: { id: f.artifact.id },
  });
});
it("serves no artifact bytes: the content route is gone", async () => {
  const f = await fixture();
  for (const path of [
    `${f.path}/content?path=${encodeURIComponent(f.entry.path)}`,
    `${f.path}/content`,
  ]) {
    const response = await f.get(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("application/octet-stream");
    expect(Buffer.from(await response.arrayBuffer()).includes(f.content)).toBe(false);
  }
});
it("reports where the copies are when this machine can reach none, and writes nothing", async () => {
  const f = await fixture({
    volumes: [
      {
        volumeId: "volume-1",
        key: `attempts/attempt-one/sha256/${createHash("sha256").update("verified artifact\n").digest("hex")}`,
      },
    ],
  });
  const dir = await mkdtemp(join(tmpdir(), "operator-artifact-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const destination = join(dir, "download");
  await expect(
    runArtifactCommand(
      f.client,
      "download",
      [f.artifact.id, "--path", f.entry.path, "--out", destination],
      {
        readVolumeCredential: async (name) => {
          throw new Error(`No volume-credentials entry on this machine maps ${name}`);
        },
      },
    ),
  ).rejects.toThrow(
    [
      `This machine can reach no copy of artifact ${f.artifact.id} file ${f.entry.path}, and the Control Plane keeps none.`,
      "Copies are held by Worker Host producer-host, Volume team.",
      "- Volume team: this machine's supertag.yaml maps no volume-credentials entry team-key",
    ].join("\n"),
  );
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    runArtifactCommand(f.client, "download", [
      f.artifact.id,
      "--path",
      "../outside",
      "--out",
      join(dir, "must-not-exist"),
    ]),
  ).rejects.toThrow("exact");
  await expect(stat(join(dir, "must-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("downloads from the serving Worker Host with a short-lived grant for this file and operator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-artifact-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const hostStore = new FileArtifactStore(join(dir, "host"));
  const content = Buffer.from("verified artifact\n");
  await hostStore.put({ bytes: content });
  const server = new WorkletArtifactTransferServer({
    workerHostId: "producer-host",
    store: hostStore,
    verificationKey: keys.publicKey,
  });
  const transferBaseUrl = await server.listen();
  cleanup.push(() => server.close());
  const f = await fixture({
    localHost: true,
    hosts: [{ workerHostId: "producer-host", transferBaseUrl }],
  });
  const destination = join(dir, "download");
  expect(
    await runArtifactCommand(f.client, "download", [
      f.artifact.id,
      "--path",
      f.entry.path,
      "--out",
      destination,
    ]),
  ).toBe(
    `Saved ${f.entry.path} (${f.entry.sizeBytes} bytes, digest verified) to ${destination}.\n`,
  );
  expect(await readFile(destination)).toEqual(content);
  const [claims] = f.signed;
  expect(f.signed).toHaveLength(1);
  expect(claims).toMatchObject({
    artifactId: f.artifact.id,
    path: f.entry.path,
    digest: f.entry.digest,
    sizeBytes: f.entry.sizeBytes,
    sourceWorkerHostId: "producer-host",
    recipientOperatorId: "control-plane-break-glass",
  });
  if (!claims) throw new Error("No grant was signed");
  expect(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt)).toBe(60_000);
  // The grant names one operator and carries no Task Attempt to impersonate.
  expect(claims).not.toHaveProperty("recipientWorkerHostId");
  expect(claims).not.toHaveProperty("attemptId");
});

it("refuses a copy whose bytes do not match the catalog, and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-artifact-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture({
    hosts: [{ workerHostId: "producer-host", transferBaseUrl: "https://producer.example" }],
  });
  const tampered = Buffer.from("tampered artifact\n");
  const destination = join(dir, "download");
  await expect(
    runArtifactCommand(
      f.client,
      "download",
      [f.artifact.id, "--path", f.entry.path, "--out", destination],
      {
        fetch: (async () =>
          new Response(tampered, {
            headers: {
              "content-length": String(tampered.length),
              "x-supertag-artifact-digest": f.entry.digest,
            },
          })) as typeof fetch,
      },
    ),
  ).rejects.toThrow(/Worker Host producer-host: its transfer endpoint could not be read/u);
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps artifact metadata and download grants from coordination-only credentials", async () => {
  const f = await fixture({
    hosts: [{ workerHostId: "producer-host", transferBaseUrl: "http://127.0.0.1:9" }],
  });
  for (const [method, path] of [
    ["GET", "/api/v1/artifacts"],
    ["GET", f.path],
    ["POST", `${f.path}/download`],
  ] as const) {
    const response = await fetch(f.origin + path, {
      method,
      headers: { authorization: "Bearer coordination-only", "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ path: f.entry.path }) } : {}),
    });
    expect(response.status, path).toBe(403);
    await response.arrayBuffer();
  }
  const unauthenticated = await fetch(`${f.origin}${f.path}/download`, {
    method: "POST",
    body: JSON.stringify({ path: f.entry.path }),
  });
  expect(unauthenticated.status).toBe(401);
  await unauthenticated.arrayBuffer();
  expect(f.signed).toEqual([]);
  expect(f.store.findCapturedArtifact).not.toHaveBeenCalled();
});

it("resolves locations, never bytes, and lists where each copy is", async () => {
  const f = await fixture({
    hosts: [{ workerHostId: "producer-host", transferBaseUrl: "https://producer.example" }],
  });
  const response = await fetch(`${f.origin}${f.path}/download`, {
    method: "POST",
    headers: { authorization: "Bearer administrator", "content-type": "application/json" },
    body: JSON.stringify({ path: f.entry.path }),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text.includes(f.content.toString())).toBe(false);
  const resolved = JSON.parse(text) as { locations: { transferUrl: string; grant: string }[] };
  expect(resolved.locations[0]?.transferUrl).toBe(
    `https://producer.example/v1/artifacts/${f.entry.digest.slice("sha256:".length)}`,
  );
  // The serving host accepts the grant only for this file.
  expect(() =>
    verifyArtifactTransferGrant(resolved.locations[0]?.grant ?? "", keys.publicKey, {
      sourceWorkerHostId: "producer-host",
      digest: `sha256:${"0".repeat(64)}`,
    }),
  ).toThrow("does not match");
  const unknownPath = await fetch(`${f.origin}${f.path}/download`, {
    method: "POST",
    headers: { authorization: "Bearer administrator", "content-type": "application/json" },
    body: JSON.stringify({ path: "outputs/other.txt" }),
  });
  expect(unknownPath.status).toBe(404);
  await unknownPath.arrayBuffer();
  const list = (await (await f.get("/api/v1/artifacts")).json()) as {
    items: { status: unknown }[];
  };
  // Held only on an ephemeral host without a Volume: flagged.
  expect(list.items[0]?.status).toEqual({
    locations: [
      { kind: "worker-host", workerHostId: "producer-host", ephemeral: true, removed: false },
    ],
    ephemeralOnly: true,
  });
});

it("points unreachable downloads to describe task", () => {
  expect(
    unreachableReport("artifact", "file", { workerHostIds: ["host"], volumes: [] }, []),
  ).toContain("supertag describe task");
});

it.each([
  "http://127.0.0.1:9",
  "https://localhost:9",
  "http://[::1]:9",
  "http://[::ffff:127.0.0.1]:9",
  "http://[::ffff:0:0]:9",
  "http://localhost.localdomain:9",
  "http://ip6-localhost:9",
])(
  "does not offer a serving host's loopback endpoint to an operator: %s",
  async (transferBaseUrl) => {
    const f = await fixture({ hosts: [{ workerHostId: "producer-host", transferBaseUrl }] });
    const resolved = await f.client.request(`${f.path}/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: f.entry.path }),
    });
    expect(resolved).toMatchObject({
      locations: [],
      holders: { workerHostIds: ["producer-host"] },
    });
    expect(f.signed).toEqual([]);
  },
);

it("lists an endpoint-free producing host and flags its ephemeral copy", async () => {
  const f = await fixture();
  const list = await (await f.get("/api/v1/artifacts")).json();
  expect(list.items[0].status).toEqual({
    locations: [
      { kind: "worker-host", workerHostId: "producer-host", ephemeral: true, removed: false },
    ],
    ephemeralOnly: true,
  });
});

it("lists only locations that downloads can serve for the producing Attempt", async () => {
  const f = await fixture({
    hosts: [
      { workerHostId: "producer-host", transferBaseUrl: "https://producer.example" },
      { workerHostId: "unrelated-host", transferBaseUrl: "https://unrelated.example" },
    ],
    volumes: [{ volumeId: "volume-1", key: "private/key", workerHostId: "unrelated-host" }],
  });
  for (const route of ["/api/v1/artifacts", f.path]) {
    const body = await (await f.get(route)).json();
    const resource = route === f.path ? body : body.items[0];
    expect(resource.status).toEqual({
      locations: [
        { kind: "worker-host", workerHostId: "producer-host", ephemeral: true, removed: false },
      ],
      ephemeralOnly: true,
    });
  }
});

it.each(["192.0.2.1", null])(
  "ignores forwarded loopback claims from an operator peer %s",
  async (operatorAddress) => {
    const f = await fixture({
      localHost: true,
      operatorAddress,
      hosts: [{ workerHostId: "producer-host", transferBaseUrl: "http://127.0.0.1:9" }],
    });
    const response = await fetch(`${f.origin}${f.path}/download`, {
      method: "POST",
      headers: {
        authorization: "Bearer administrator",
        "content-type": "application/json",
        forwarded: "for=127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
        host: "localhost",
      },
      body: JSON.stringify({ path: f.entry.path }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ locations: [] });
    expect(f.signed).toEqual([]);
  },
);

it("withholds loopback endpoints behind a same-server public proxy", async () => {
  const f = await fixture({
    publicUrl: "https://supertag.example",
    localHost: true,
    operatorAddress: "127.0.0.1",
    hosts: [{ workerHostId: "producer-host", transferBaseUrl: "http://127.0.0.1:9" }],
  });
  const resolved = await f.client.request(`${f.path}/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: f.entry.path }),
  });
  expect(resolved).toMatchObject({ locations: [] });
  expect(f.signed).toEqual([]);
});
