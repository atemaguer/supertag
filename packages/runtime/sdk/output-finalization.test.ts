import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyTagContextPlan, type TaskResult } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { type ArtifactCatalogTransport, ArtifactRequestError } from "./src/artifact-client.js";
import { type ArtifactStore, FileArtifactStore } from "./src/artifact-store.js";
import type { TaskAttemptSpec } from "./src/index.js";
import {
  OutputFinalizationIntegrityError,
  OutputFinalizationJournal,
  outputSpecDigest,
} from "./src/output-finalization.js";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "supertag-output-finalization-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const result: TaskResult = {
  summary: "finished",
  decisions: [],
  changes: [],
  unresolved: [],
  findings: [],
  references: [],
  artifacts: [],
};
function spec(attemptId = "attempt-1", url = "http://127.0.0.1:1"): TaskAttemptSpec {
  const capturedAt = "2026-09-15T00:00:00.000Z";
  return {
    version: 2,
    taskId: `task-${attemptId}`,
    attemptId,
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "account-1",
        scope: "channel:general",
        sessionKey: "session-1",
        occurredAt: capturedAt,
      },
      messages: [],
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag-1", name: "Engineering" },
      origin: {
        tagRouteId: "route-1",
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:general",
      },
      requester: { id: "user-1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    execution: {},
    workerProfile: { id: "profile-1", revision: "1" },
    coordination: { controlPlaneUrl: url, token: "private-attempt-token" },
  };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function directory(journal: OutputFinalizationJournal, attemptId = "attempt-1") {
  return join(journal.root, hash(attemptId));
}
async function stage(journal: OutputFinalizationJournal, attempt = spec(), text = "report") {
  return journal.stage({
    spec: attempt,
    result,
    files: [{ path: "outputs/report.md", bytes: Buffer.from(text) }],
  });
}
describe("durable output finalization", () => {
  it("recovers frozen outputs through configured storage and metadata transports", async () => {
    const path = await root();
    const initial = new OutputFinalizationJournal("worker", path);
    const record = await stage(initial);
    await initial.confirmCleanup(record);
    const store = new FileArtifactStore(join(path, "distributed-bytes"));
    const seen: unknown[] = [];
    const catalog: ArtifactCatalogTransport = {
      async request<T>(operation, input): Promise<T> {
        expect(operation).toBe("capture");
        seen.push(input);
        return { artifact: { ...(input as object), id: "saved-artifact" } } as T;
      },
    };
    const recovered = new OutputFinalizationJournal("worker", path, {
      store: (attempt) => {
        expect(attempt.attemptId).toBe(record.spec.attemptId);
        return store;
      },
      catalog: (attempt) => {
        expect(attempt.coordination?.token).toBe("private-attempt-token");
        return catalog;
      },
    });
    const saved = await recovered.read("attempt-1");
    if (!saved) throw new Error("Missing saved output");
    const selections = await recovered.publish(saved);
    expect(selections).toEqual([{ artifactId: "saved-artifact", paths: ["outputs/report.md"] }]);
    expect(seen).toHaveLength(1);
    expect(
      Buffer.from(
        await store.get({
          uri: `supertag-artifact:sha256:${hash("report")}`,
          digest: `sha256:${hash("report")}`,
        }),
      ).toString(),
    ).toBe("report");
  });
  it("blocks recovery on a definitive non-HTTP catalog conflict", async () => {
    const path = await root();
    const journal = new OutputFinalizationJournal("worker", path, {
      store: new FileArtifactStore(join(path, "bytes")),
      catalog: () => ({
        async request() {
          throw new ArtifactRequestError("capture", 409);
        },
      }),
    });
    const record = await stage(journal);
    await journal.confirmCleanup(record);
    await expect(journal.publish(record)).rejects.toBeInstanceOf(OutputFinalizationIntegrityError);
    expect((await journal.read("attempt-1"))?.blocked).toBe("catalog_409");
  });

  it("freezes bytes and specification before asynchronous work and recovers from a new instance", async () => {
    const path = await root();
    const journal = new OutputFinalizationJournal("worker", path);
    const bytes = Buffer.from("original");
    const attempt = spec();
    const harnessSession = { harnessId: "codex", id: "native-original" };
    const pending = journal.stage({
      spec: attempt,
      result,
      harnessSession,
      files: [{ path: "outputs/report.md", bytes }],
    });
    bytes.fill(0);
    harnessSession.id = "mutated";
    (attempt.tag as { name: string }).name = "mutated";
    const record = await pending;
    expect(record.spec.tag.name).toBe("Engineering");
    expect(record.harnessSession).toEqual({ harnessId: "codex", id: "native-original" });
    expect(await readFile(join(directory(journal), hash("original")), "utf8")).toBe("original");
    const restarted = new OutputFinalizationJournal("worker", path);
    expect(await restarted.read("attempt-1")).toEqual(record);
    await restarted.confirmCleanup(record);
    expect((await journal.read("attempt-1"))?.cleanupConfirmed).toBe(true);
    await journal.acknowledge("attempt-1", record.specDigest);
    expect(await restarted.read("attempt-1")).toBeUndefined();
  });
  it("preserves the first committed snapshot and rejects a different admitted specification", async () => {
    const journal = new OutputFinalizationJournal("worker", await root());
    const first = await stage(journal);
    expect(await stage(journal, spec(), "changed")).toEqual(first);
    await expect(stage(journal, { ...spec(), taskId: "another-task" })).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
    await expect(journal.acknowledge("attempt-1", first.specDigest)).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
    await journal.confirmCleanup(first);
    await expect(journal.acknowledge("attempt-1", "wrong")).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
    expect((await journal.read("attempt-1"))?.files).toEqual(first.files);
  });
  it("has one immutable winner for concurrent same-Attempt snapshots", async () => {
    const path = await root();
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        stage(new OutputFinalizationJournal("worker", path), spec(), `report-${i}`),
      ),
    );
    expect(new Set(records.map((record) => JSON.stringify(record))).size).toBe(1);
    expect(await new OutputFinalizationJournal("worker", path).read("attempt-1")).toEqual(
      records[0],
    );
  });
  it("isolates 100 concurrent Attempts and worker identities", async () => {
    const path = await root();
    const records = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        stage(new OutputFinalizationJournal("worker", path), spec(`attempt-${i}`), `report-${i}`),
      ),
    );
    const restarted = new OutputFinalizationJournal("worker", path);
    for (let i = 0; i < 100; i++) expect(await restarted.read(`attempt-${i}`)).toEqual(records[i]);
    expect(
      await new OutputFinalizationJournal("other-worker", path).read("attempt-1"),
    ).toBeUndefined();
  });
  it("rejects oversized files, duplicate or escaping output paths before manifest commit", async () => {
    const journal = new OutputFinalizationJournal("worker", await root());
    await expect(
      journal.stage({
        spec: spec(),
        result,
        files: [{ path: "report", bytes: new Uint8Array(32 * 1024 * 1024 + 1) }],
      }),
    ).rejects.toBeInstanceOf(OutputFinalizationIntegrityError);
    for (const files of [
      [{ path: "../escape", bytes: Buffer.from("no") }],
      [
        { path: "x", bytes: Buffer.from("a") },
        { path: "x", bytes: Buffer.from("b") },
      ],
    ])
      await expect(journal.stage({ spec: spec(), result, files })).rejects.toBeInstanceOf(
        OutputFinalizationIntegrityError,
      );
    expect(await journal.read("attempt-1")).toBeUndefined();
  });
  it("rejects manifest tampering and unsafe permissions", async () => {
    const journal = new OutputFinalizationJournal("worker", await root());
    const record = await stage(journal);
    const manifest = join(directory(journal), "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({ ...record, spec: { ...record.spec, taskId: "forged" } }),
    );
    await expect(journal.read("attempt-1")).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
    await writeFile(manifest, JSON.stringify(record));
    await chmod(manifest, 0o644);
    await expect(journal.read("attempt-1")).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
  });
  it("rejects hardlinks, symlinked Attempt directories, and altered frozen bytes", async () => {
    const path = await root();
    const journal = new OutputFinalizationJournal("worker", path, {
      store: new FileArtifactStore(join(path, "host-copies")),
    });
    const record = await stage(journal);
    const manifest = join(directory(journal), "manifest.json");
    const alias = join(journal.root, "alias");
    await link(manifest, alias);
    await expect(journal.read("attempt-1")).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
    await rm(alias);
    await writeFile(join(directory(journal), hash("report")), "forged");
    await expect(journal.publish(record)).rejects.toBeInstanceOf(OutputFinalizationIntegrityError);
    const moved = join(journal.root, "moved");
    await rename(directory(journal), moved);
    await symlink(moved, directory(journal));
    await expect(journal.read("attempt-1")).rejects.toBeInstanceOf(
      OutputFinalizationIntegrityError,
    );
  });
  it("keeps frozen outputs in the journal when no Worker Host artifact storage is configured", async () => {
    const path = await root();
    const requests: string[] = [];
    const catalog = (): ArtifactCatalogTransport => ({
      async request<T>(operation: string, input: unknown): Promise<T> {
        requests.push(operation);
        return { artifact: { ...(input as object), id: "saved-artifact" } } as T;
      },
    });
    const journal = new OutputFinalizationJournal("worker", path, { catalog });
    const record = await stage(journal);
    await expect(journal.publish(record)).rejects.toThrow(
      "Automatic outputs require Worker Host artifact storage",
    );
    expect(requests).toEqual([]);
    const kept = await journal.read("attempt-1");
    expect(kept).toEqual(record);
    expect(kept?.blocked).toBeUndefined();
    expect(await readFile(join(directory(journal), hash("report")), "utf8")).toBe("report");
    // Once the Worker Host has storage, the same frozen output publishes.
    const store = new FileArtifactStore(join(path, "host-copies"));
    const recovered = new OutputFinalizationJournal("worker", path, { store, catalog });
    expect(await recovered.publish(record)).toEqual([
      { artifactId: "saved-artifact", paths: ["outputs/report.md"] },
    ]);
    expect(requests).toEqual(["capture"]);
  });
  it("pins the same specification independent of object key order", () => {
    const original = spec();
    expect(outputSpecDigest(original)).toBe(
      outputSpecDigest(
        Object.fromEntries(Object.entries(original).reverse()) as unknown as TaskAttemptSpec,
      ),
    );
  });
});

it("rejects pre-summary ungrouped journals before storage or catalog replay", async () => {
  const journal = new OutputFinalizationJournal("worker", await root());
  const record = await stage(journal);
  const { summary: _summary, ...legacyRecord } = record;
  await writeFile(join(directory(journal), "manifest.json"), JSON.stringify(legacyRecord));
  await expect(journal.read("attempt-1")).rejects.toBeInstanceOf(OutputFinalizationIntegrityError);
  await expect(journal.publish(record)).rejects.toBeInstanceOf(OutputFinalizationIntegrityError);
});

it("recovers upload and lost catalog acknowledgement without changing frozen output", async () => {
  const path = await root();
  const copies = new FileArtifactStore(join(path, "host-copies"));
  let uploads = 0;
  let captures = 0;
  let catalog: { id: string; entries: unknown[] } | undefined;
  const received: string[] = [];
  const controlPlaneRequests: string[] = [];
  // Bytes stay on the Worker Host; its storage is briefly unavailable on the first upload.
  const store: ArtifactStore = {
    async put(input) {
      uploads++;
      if (uploads === 1) throw new Error("Worker Host storage unavailable");
      received.push(Buffer.from(input.bytes).toString("utf8"));
      return await copies.put(input);
    },
    get: (ref) => copies.get(ref),
  };
  const server = createServer(async (request, response) => {
    try {
      controlPlaneRequests.push(`${request.method} ${request.url}`);
      if (request.headers.authorization !== "Bearer private-attempt-token") {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/internal/v1/artifacts/catalog/capture");
      captures++;
      const input = JSON.parse(body.toString("utf8"));
      expect(input.summary).toBe("Files (1):\noutputs/report.md");
      expect(input.harnessSession).toEqual({ harnessId: "claude-code", id: "native-durable" });
      expect(input.operationId).toMatch(/^automatic-task-outputs:[a-f0-9-]{36}$/);
      if (catalog) expect(input.entries).toEqual(catalog.entries);
      else catalog = { id: "captured-output", entries: input.entries };
      // The registration committed, but its first acknowledgement was lost.
      if (captures === 1) {
        response.writeHead(500).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ artifact: catalog }));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  try {
    const journal = new OutputFinalizationJournal("worker", path, { store });
    const record = await journal.stage({
      spec: spec("attempt-1", `http://127.0.0.1:${address.port}`),
      result,
      harnessSession: { harnessId: "claude-code", id: "native-durable" },
      files: [{ path: "outputs/report.md", bytes: Buffer.from("report") }],
    });
    await expect(journal.publish(record)).rejects.toThrow("Worker Host storage unavailable");
    expect(captures).toBe(0);
    await expect(journal.publish(record)).rejects.toThrow("HTTP 500");
    const restarted = new OutputFinalizationJournal("worker", path, { store });
    const restored = await restarted.read("attempt-1");
    if (!restored) throw new Error("Lost frozen output");
    const ready = await restarted.confirmCleanup(restored);
    const events = [];
    for await (const event of restarted.finish(ready)) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "artifact.created",
      "result",
      "execution.completed",
    ]);
    expect(events.find((event) => event.type === "result")).toMatchObject({
      result: { artifacts: [{ artifactId: "captured-output", paths: ["outputs/report.md"] }] },
    });
    expect(events[0]).toMatchObject({
      type: "artifact.created",
      artifact: {
        artifactId: "captured-output",
        path: "outputs/report.md",
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(received).toEqual(["report", "report"]);
    expect(captures).toBe(2);
    expect(uploads).toBe(3);
    expect(controlPlaneRequests).toEqual([
      "POST /internal/v1/artifacts/catalog/capture",
      "POST /internal/v1/artifacts/catalog/capture",
    ]);
    expect(
      Buffer.from(
        await copies.get({
          uri: `supertag-artifact:sha256:${hash("report")}`,
          digest: `sha256:${hash("report")}`,
        }),
      ).toString(),
    ).toBe("report");
    expect(await restarted.read("attempt-1")).toBeDefined();
    await restarted.acknowledge("attempt-1", ready.specDigest);
    expect(await restarted.read("attempt-1")).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([400, 409])(
  "durably blocks catalog HTTP %s without replaying rejected output after restart",
  async (status) => {
    const path = await root();
    const store = new FileArtifactStore(join(path, "host-copies"));
    let calls = 0;
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      calls++;
      methods.push(`${request.method} ${request.url}`);
      for await (const _chunk of request) {
        /* Drain the request before replying. */
      }
      response.writeHead(status).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    try {
      const journal = new OutputFinalizationJournal("worker", path, { store });
      const record = await stage(journal, spec("attempt-1", `http://127.0.0.1:${address.port}`));
      await expect(journal.publish(record)).rejects.toBeInstanceOf(
        OutputFinalizationIntegrityError,
      );
      expect(calls).toBe(1);
      expect(methods).toEqual(["POST /internal/v1/artifacts/catalog/capture"]);
      const restarted = new OutputFinalizationJournal("worker", path, { store });
      const blocked = await restarted.read("attempt-1");
      expect(blocked?.blocked).toBe(`catalog_http_${status}`);
      if (!blocked) throw new Error("Missing blocked output");
      await expect(restarted.publish(blocked)).rejects.toBeInstanceOf(
        OutputFinalizationIntegrityError,
      );
      expect(calls).toBe(1);
      const ready = await restarted.confirmCleanup(blocked);
      await expect(restarted.acknowledge("attempt-1", ready.specDigest)).rejects.toBeInstanceOf(
        OutputFinalizationIntegrityError,
      );
      expect(await restarted.read("attempt-1")).toBeDefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it("validates complete disjoint output groups and freezes caller-owned group metadata", async () => {
  const journal = new OutputFinalizationJournal("worker", await root());
  const files = [{ path: "memories/note.md", bytes: Buffer.from("memory") }];
  const group = {
    id: "memory",
    title: "Memory",
    kind: "harness-memory",
    paths: ["memories/note.md"],
    submit: false,
  };
  for (const groups of [
    [],
    [{ ...group, id: "../escape" }],
    [{ ...group, id: undefined }],
    [{ ...group, paths: ["missing"] }],
    [{ ...group, paths: [] }],
    [{ ...group, paths: ["memories/note.md", "memories/note.md"] }],
    [group, { ...group, id: "other" }],
    [group, group],
    [{ ...group, submit: "false" }],
    [{ ...group, title: " " }],
  ]) {
    await expect(
      journal.stage({ spec: spec(), result, files, groups: groups as (typeof group)[] }),
    ).rejects.toBeInstanceOf(OutputFinalizationIntegrityError);
  }
  const groups = [group];
  const pending = journal.stage({ spec: spec(), result, files, groups });
  group.title = "mutated";
  group.paths[0] = "changed";
  const record = await pending;
  expect(record.groups).toEqual([
    {
      ...group,
      title: "Memory",
      paths: ["memories/note.md"],
      summary: "Files (1):\nmemories/note.md",
    },
  ]);
  expect((await journal.read("attempt-1"))?.groups).toEqual(record.groups);
});

it("bounds filename summaries deterministically without copying instructions or results", async () => {
  const summaries: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    summaries.push(input.summary);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ artifact: { id: "large-output", entries: input.entries } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  try {
    const journalRoot = await root();
    const store = new FileArtifactStore(join(journalRoot, "host-copies"));
    const journal = new OutputFinalizationJournal("worker", journalRoot, { store });
    const attempt = spec("attempt-1", `http://127.0.0.1:${address.port}`);
    const paths = Array.from({ length: 20 }, (_, i) => `outputs/${i}-${"x".repeat(900)}.txt`);
    const record = await journal.stage({
      spec: {
        ...attempt,
        input: {
          ...attempt.input,
          messages: [{ id: "private", role: "requester", text: "Private instruction" }],
        },
      },
      result: { ...result, summary: "Private agent response" },
      files: paths.toReversed().map((path) => ({ path, bytes: Buffer.from("output") })),
    });
    await journal.publish(record);
    await new OutputFinalizationJournal("worker", journalRoot, { store }).publish(record);
    const expected = `Files (20):\n${[...paths].sort().join("\n")}`.slice(0, 16_000);
    expect(summaries).toEqual([expected, expected]);
    expect(summaries[0]).toHaveLength(16_000);
    expect(summaries[0]).not.toContain("Private");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("recovers partially registered groups with stable identities and submits only deliverable groups", async () => {
  const path = await root();
  const nativeSessions: unknown[] = [];
  const captures = new Map<
    string,
    { id: string; title: string; summary: string; kind: string; entries: { path: string }[] }
  >();
  const calls: string[] = [];
  let lostAcknowledgement = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    nativeSessions.push(input.harnessSession);
    calls.push(input.operationId);
    const existing = captures.get(input.operationId);
    const artifact = {
      id: `artifact-${input.kind}`,
      title: input.title,
      summary: input.summary,
      kind: input.kind,
      entries: input.entries,
    };
    if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) {
      response.writeHead(409).end();
      return;
    }
    captures.set(input.operationId, artifact);
    // The second group committed; its acknowledgement was lost after the first succeeded.
    if (input.kind === "generated-media" && !lostAcknowledgement) {
      lostAcknowledgement = true;
      response.writeHead(500).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ artifact }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  try {
    const store = new FileArtifactStore(join(path, "host-copies"));
    const journal = new OutputFinalizationJournal("worker", path, { store });
    const record = await journal.stage({
      spec: spec("attempt-1", `http://127.0.0.1:${address.port}`),
      result,
      harnessSession: { harnessId: "codex", id: "native-group-producer" },
      files: [
        { path: "memories/note.md", bytes: Buffer.from("knowledge") },
        { path: "generated_images/chart.png", bytes: Buffer.from("chart") },
      ],
      groups: [
        {
          id: "memories",
          title: "Codex memories",
          kind: "harness-memory",
          paths: ["memories/note.md"],
          submit: false,
        },
        {
          id: "images",
          title: "Codex generated images",
          kind: "generated-media",
          paths: ["generated_images/chart.png"],
          submit: true,
        },
      ],
    });
    await expect(journal.publish(record)).rejects.toThrow("HTTP 500");
    const restarted = new OutputFinalizationJournal("worker", path, { store });
    const ready = await restarted.confirmCleanup(record);
    const events = [];
    for await (const event of restarted.finish(ready)) events.push(event);
    expect(captures.size).toBe(2);
    expect([...captures.values()].map((artifact) => artifact.summary)).toEqual([
      "Files (1):\nmemories/note.md",
      "Files (1):\ngenerated_images/chart.png",
    ]);
    expect(nativeSessions.length).toBeGreaterThan(2);
    expect(
      nativeSessions.every(
        (session) =>
          JSON.stringify(session) ===
          JSON.stringify({ harnessId: "codex", id: "native-group-producer" }),
      ),
    ).toBe(true);
    expect(calls).toEqual([
      `${record.operationId}:memories`,
      `${record.operationId}:images`,
      `${record.operationId}:memories`,
      `${record.operationId}:images`,
    ]);
    expect(events.find((event) => event.type === "result")).toMatchObject({
      result: {
        artifacts: [
          { artifactId: "artifact-generated-media", paths: ["generated_images/chart.png"] },
        ],
      },
    });
    expect(
      [...captures.values()].find((artifact) => artifact.kind === "harness-memory")?.entries,
    ).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
