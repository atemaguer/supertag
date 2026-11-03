import { createHash } from "node:crypto";
import {
  type CapturedArtifact,
  type CapturedArtifactEntry,
  emptyTagContextPlan,
  type JsonRecord,
  type TagAuthorizationSnapshot,
} from "@supertag/core";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactCatalogTransport } from "./src/artifact-client.js";
import { ArtifactClient, type ArtifactClientOptions } from "./src/artifact-client.js";
import {
  type ArtifactStore,
  collectTaskAttemptEvents,
  connectWorkerMcpClient,
  createWorker,
  type ExecutionEnvironment,
  type Harness,
  type HarnessPlan,
  LocalExecutionEnvironmentProvider,
  type McpClientConnection,
  type TaskAttemptSpec,
  type ToolInput,
} from "./src/index.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const bytes = new Map<string, Uint8Array>();
  const artifacts = new Map<string, CapturedArtifact>();
  const acquisitions = new Map<string, Record<string, unknown>>();
  const seen: { endpoint: string; body: JsonRecord; token: string | null }[] = [];
  const store: ArtifactStore = {
    async put(input) {
      const digest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
      const uri = `supertag-artifact:${digest}`;
      bytes.set(uri, input.bytes.slice());
      return { id: digest, uri, digest };
    },
    get: vi.fn(async (ref) => {
      const value = bytes.get(ref.uri);
      if (!value) throw new Error("Unavailable blob");
      return value.slice();
    }),
  };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url).split("/").at(-1) ?? "";
    // Bytes stay in the Worker Host's store; the Control Plane carries only catalog metadata.
    if (/^[a-f0-9]{64}$/.test(endpoint))
      throw new Error(`Artifact bytes must not go to the Control Plane (${init?.method ?? "GET"})`);
    const body = JSON.parse(String(init?.body ?? "{}")) as JsonRecord;
    seen.push({ endpoint, body, token: new Headers(init?.headers).get("authorization") });
    if (endpoint === "find") return Response.json({ artifacts: [...artifacts.values()] });
    if (endpoint === "capture") {
      const prior = [...artifacts.values()].find(
        (artifact) => artifact.operationId === body["operationId"],
      );
      if (prior) {
        if (JSON.stringify(prior.entries) !== JSON.stringify(body["entries"]))
          return new Response("conflict", { status: 409 });
        return Response.json({ artifact: prior });
      }
      const artifact = {
        ...body,
        id: `art-${artifacts.size + 1}`,
        taskId: "task-producer",
        attemptId: "attempt-producer",
        tagId: "tag",
        sessionId: "session",
        createdAt: "2026-09-15T00:00:00Z",
      } as unknown as CapturedArtifact;
      artifacts.set(artifact.id, artifact);
      return Response.json({ artifact });
    }
    if (endpoint === "inspect")
      return Response.json({ artifact: artifacts.get(body["artifactId"] as string) });
    if (endpoint === "acquire") {
      const artifact = artifacts.get(body["artifactId"] as string);
      if (!artifact) return new Response("denied", { status: 403 });
      const id = String(body["operationId"]);
      const acquisition = acquisitions.get(id) ?? { ...body, id, status: "authorized" };
      acquisitions.set(id, acquisition);
      return Response.json({ artifact, acquisition });
    }
    if (endpoint === "settle") {
      const acquisition = acquisitions.get(String(body["id"]));
      if (!acquisition) return new Response("missing", { status: 404 });
      acquisition["status"] = body["status"];
      return Response.json({ acquisition });
    }
    throw new Error(`Unexpected catalog endpoint ${endpoint}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const inputFiles = new Map<string, Uint8Array>();
  const staged: { directory: string; files: readonly { path: string; bytes: Uint8Array }[] }[] = [];
  const environment = {
    async readBytes(path: string) {
      const value = inputFiles.get(path);
      if (!value) throw new Error("Producer is gone");
      return value;
    },
    async materializeArtifactFiles(input: {
      directory: string;
      files: readonly { path: string; bytes: Uint8Array }[];
    }) {
      if (staged.some((entry) => entry.directory === input.directory)) throw new Error("collision");
      staged.push(input);
      return `/isolated/${input.directory}`;
    },
  } as unknown as ExecutionEnvironment;
  const client = (
    exclusiveWorkspace = true,
    token = "attempt-token",
    harnessSession?: ArtifactClientOptions["harnessSession"],
  ) =>
    new ArtifactClient({
      controlPlaneUrl: "https://control.example",
      token,
      store,
      environment: () => environment,
      exclusiveWorkspace,
      ...(harnessSession ? { harnessSession } : {}),
    });
  return { client, store, inputFiles, staged, seen, fetchMock, artifacts, acquisitions, bytes };
}

it.each([100, 0, 1.5])(
  "rejects invalid discovery limit %s locally with corrective guidance",
  async (limit) => {
    const test = fixture();
    await expect(test.client().find({ limit })).rejects.toThrow(
      "find_artifacts limit must be an integer from 1 through 50; retry with limit: 50 or omit limit",
    );
    expect(test.fetchMock).not.toHaveBeenCalled();
  },
);

it("sends the maximum supported discovery limit and permits the default", async () => {
  const test = fixture();
  const client = test.client();
  await expect(client.find({ limit: 50 })).resolves.toEqual({ artifacts: [] });
  await expect(client.find()).resolves.toEqual({ artifacts: [] });
  expect(test.seen.map(({ body }) => body)).toEqual([{ limit: 50 }, {}]);
});

it("captures immutable files and another host discovers, reads and attaches only selected entries after the producer is gone", async () => {
  const test = fixture();
  test.inputFiles.set("findings.md", new TextEncoder().encode("Original evidence"));
  test.inputFiles.set("private.csv", new TextEncoder().encode("Not requested"));
  const producer = test.client();
  const artifact = await producer.capture({
    operationId: "capture-1",
    title: "Research",
    kind: "research",
    files: [{ path: "findings.md", mediaType: "text/markdown" }, { path: "private.csv" }],
  });
  test.inputFiles.clear();
  const consumer = test.client(true, "consumer-token");
  expect((await consumer.find({ query: "Research" })).artifacts[0]?.id).toBe(artifact.id);
  expect((await consumer.inspect(artifact.id)).attemptId).toBe("attempt-producer");
  expect(
    (await consumer.read({ operationId: "read-1", artifactId: artifact.id, path: "findings.md" }))[
      "content"
    ],
  ).toBe("Original evidence");
  const attached = await consumer.attach({
    operationId: "attach-1",
    artifactId: artifact.id,
    paths: ["findings.md"],
  });
  expect(attached["mode"]).toBe("writable-copy");
  expect(test.staged[0]?.files.map((file) => file.path)).toEqual(["findings.md"]);
  expect(new TextDecoder().decode(test.staged[0]?.files[0]?.bytes)).toBe("Original evidence");
  expect(
    test.seen
      .filter((entry) => entry.endpoint === "acquire")
      .every((entry) => entry.token === "Bearer consumer-token"),
  ).toBe(true);
  expect(test.acquisitions.get("attach-1")?.["status"]).toBe("delivered");
  expect(test.fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
});

it.each(["codex", "claude-code"])(
  "records observed %s identity and freezes it across registration retries",
  async (harnessId) => {
    const test = fixture();
    let native = { harnessId, id: "native-first" };
    const client = test.client(true, "attempt-token", () => native);
    const input = { operationId: "frozen", title: "Report", kind: "report", entries: [] };
    const first = await client.register(input);
    native.id = "mutated";
    native = { harnessId, id: "native-next" };
    await client.register(input);
    expect(first.harnessSession).toEqual({ harnessId, id: "native-first" });
    expect(
      test.seen
        .filter((entry) => entry.endpoint === "capture")
        .map((entry) => entry.body["harnessSession"]),
    ).toEqual([
      { harnessId, id: "native-first" },
      { harnessId, id: "native-first" },
    ]);
    expect((await client.register({ ...input, operationId: "next" })).harnessSession).toEqual(
      native,
    );
  },
);

it("omits unknown identities and ignores caller-supplied provenance", async () => {
  const test = fixture();
  let native: { harnessId: string; id: string } | undefined;
  const client = test.client(true, "attempt-token", () => native);
  const input = {
    operationId: "unknown",
    title: "Report",
    kind: "report",
    entries: [],
    harnessSession: { harnessId: "forged", id: "forged" },
  };
  expect((await client.register(input)).harnessSession).toBeUndefined();
  native = { harnessId: "codex", id: "later" };
  await client.register(input);
  expect(test.seen.every((entry) => entry.body["harnessSession"] === undefined)).toBe(true);
});

it("rejects malformed native provenance before sending a catalog request", async () => {
  const test = fixture();
  const client = test.client(true, "attempt-token", () => ({ harnessId: "codex", id: " " }));
  await expect(
    client.register({ operationId: "bad", title: "Report", kind: "report", entries: [] }),
  ).rejects.toThrow("harnessSession");
  expect(test.seen).toHaveLength(0);
});

it("deduplicates concurrent attachment retries and refuses uncertain replay after client restart", async () => {
  const test = fixture();
  test.inputFiles.set("result.txt", new TextEncoder().encode("result"));
  const client = test.client();
  const artifact = await client.capture({
    operationId: "c",
    title: "result",
    kind: "file",
    files: [{ path: "result.txt" }],
  });
  const input = { operationId: "attach", artifactId: artifact.id, paths: ["result.txt"] };
  const [first, second] = await Promise.all([client.attach(input), client.attach(input)]);
  expect(first).toEqual(second);
  expect(test.staged).toHaveLength(1);
  await expect(test.client().attach(input)).rejects.toThrow("already attempted");
  expect(test.staged).toHaveLength(1);
});

it("fails closed before acquisition when shared execution cannot isolate attachments", async () => {
  const test = fixture();
  await expect(
    test.client(false).attach({ operationId: "attach", artifactId: "art-1", paths: ["x.txt"] }),
  ).rejects.toThrow("shared execution");
  expect(test.seen).toHaveLength(0);
  expect(test.store.get).not.toHaveBeenCalled();
});

it("does not fetch denied content and rejects digest corruption before delivery", async () => {
  const test = fixture();
  await expect(
    test.client().read({ operationId: "denied", artifactId: "missing", path: "x.txt" }),
  ).rejects.toThrow("403");
  expect(test.store.get).not.toHaveBeenCalled();
  test.inputFiles.set("x.txt", new TextEncoder().encode("good"));
  const client = test.client();
  const artifact = await client.capture({
    operationId: "c",
    title: "x",
    kind: "file",
    files: [{ path: "x.txt" }],
  });
  const entry = artifact.entries[0] as CapturedArtifactEntry;
  test.bytes.set(entry.uri, new TextEncoder().encode("evil"));
  await expect(
    client.read({ operationId: "corrupt", artifactId: artifact.id, path: "x.txt" }),
  ).rejects.toThrow("integrity");
  expect(test.acquisitions.get("corrupt")?.["status"]).toBe("failed");
});

it("paginates UTF-8 without corrupting or dropping characters across byte boundaries", async () => {
  const test = fixture();
  test.inputFiles.set("x.txt", new TextEncoder().encode("a🙂b"));
  const client = test.client();
  const artifact = await client.capture({
    operationId: "c",
    title: "x",
    kind: "file",
    files: [{ path: "x.txt" }],
  });
  const first = await client.read({
    operationId: "r1",
    artifactId: artifact.id,
    path: "x.txt",
    limit: 4,
  });
  expect(first).toMatchObject({ content: "a", nextOffset: 1, truncated: true });
  const second = await client.read({
    operationId: "r2",
    artifactId: artifact.id,
    path: "x.txt",
    offset: 1,
    limit: 5,
  });
  expect(second).toMatchObject({ content: "🙂b", nextOffset: 6, truncated: false });
});

it("retries the identical catalog commit after an ambiguous transport failure", async () => {
  const test = fixture();
  test.inputFiles.set("x.txt", new TextEncoder().encode("x"));
  const normal = test.fetchMock.getMockImplementation();
  let failed = false;
  test.fetchMock.mockImplementation(async (url, init) => {
    const response = await normal?.(url, init);
    if (String(url).endsWith("/capture") && !failed) {
      failed = true;
      throw new Error("connection lost after commit");
    }
    return response as Response;
  });
  const artifact = await test.client().capture({
    operationId: "same-operation",
    title: "x",
    kind: "file",
    files: [{ path: "x.txt" }],
  });
  expect(artifact.id).toBe("art-1");
  expect(test.artifacts.size).toBe(1);
  expect(
    test.seen.filter((entry) => entry.endpoint === "capture").map((entry) => entry.body),
  ).toEqual([
    expect.objectContaining({ operationId: "same-operation" }),
    expect.objectContaining({ operationId: "same-operation" }),
  ]);
});

it("uses the current Attempt's injected catalog transport for artifact tools while keeping bytes in the artifact store", async () => {
  const test = fixture();
  const fetch = vi.fn(async () => {
    throw new Error("Artifact capture must not call HTTP");
  });
  vi.stubGlobal("fetch", fetch);
  const captures: Array<{ spec: TaskAttemptSpec; input: JsonRecord }> = [];
  const catalog = vi.fn(
    (spec: TaskAttemptSpec): ArtifactCatalogTransport => ({
      async request<T>(operation, input) {
        expect(operation).toBe("capture");
        const value = input as JsonRecord;
        captures.push({ spec, input: value });
        return {
          artifact: {
            ...value,
            id: `artifact-${spec.attemptId}`,
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            tagId: spec.tag.id,
            createdAt: "2026-09-17T00:00:00Z",
          },
        } as T;
      },
    }),
  );
  const store = vi.fn((_spec: TaskAttemptSpec) => test.store);
  const empty = (): HarnessPlan["execution"] => ({
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  });
  const harness: Harness = {
    id: "files",
    async describe() {
      return {
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "files",
        version: "1",
        inputKinds: ["instruction", "tool"],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
        toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
        mcpClients: [{ client: "worker-host", transports: ["worker-local"] }],
      };
    },
    async plan() {
      return {
        runtime: empty(),
        execution: {
          ...empty(),
          files: [{ path: "findings.md", content: "Catalogs carry metadata; stores carry bytes" }],
        },
      };
    },
    async start(_plan, _environments, context) {
      const input = context.tools.find((tool) => tool.id === "supertag-artifacts");
      if (!input) throw new Error("Missing artifact tools");
      const connection = await connectWorkerMcpClient(input);
      return {
        async *run() {
          const response = (await connection.callTool("capture_artifact", {
            operationId: "capture",
            title: "Evidence",
            kind: "research",
            files: [{ path: "findings.md", mediaType: "text/markdown" }],
          })) as { isError?: boolean };
          expect(response.isError).not.toBe(true);
          yield { type: "output.message", text: "Captured evidence" };
        },
        async close() {},
      };
    },
  };
  const worker = createWorker({
    id: "injected-artifact-catalog",
    profiles: [
      {
        ref: { id: "static", revision: "1" },
        workerType: "files",
        harness: { provider: "files" },
        execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    environments: [new LocalExecutionEnvironmentProvider()],
    artifactCatalogTransport: catalog,
    artifactStore: store,
  });
  for (const number of [1, 2]) {
    const spec: TaskAttemptSpec = {
      ...taskAttemptSpec(),
      taskId: `task-${number}`,
      attemptId: `attempt-${number}`,
      coordination: {
        controlPlaneUrl: "https://control.example",
        token: `credential-${number}`,
        scope: "surface",
      },
    };
    const events = await collectTaskAttemptEvents(worker.execute(spec));
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
    expect(catalog).toHaveBeenCalledWith(spec);
    expect(store).toHaveBeenCalledWith(spec);
  }
  expect(
    captures.map(({ spec }) => [spec.taskId, spec.attemptId, spec.coordination?.token]),
  ).toEqual([
    ["task-1", "attempt-1", "credential-1"],
    ["task-2", "attempt-2", "credential-2"],
  ]);
  for (const { input } of captures) {
    const entry = (input["entries"] as unknown as CapturedArtifactEntry[])[0];
    if (!entry) throw new Error("Missing artifact entry");
    expect(new TextDecoder().decode(await test.store.get(entry))).toBe(
      "Catalogs carry metadata; stores carry bytes",
    );
    expect(JSON.stringify(input)).not.toContain("Catalogs carry metadata; stores carry bytes");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("injects artifact tools into two real Worker lifecycles, records produced files, and revokes handles after cleanup", async () => {
  const test = fixture();
  let capturedId = "";
  let producerInput: ToolInput | undefined;
  let producerConnection: McpClientConnection | undefined;
  const empty = (): HarnessPlan["execution"] => ({
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" },
  });
  const makeHarness = (producer: boolean): Harness => ({
    id: "files",
    async describe() {
      return {
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "files",
        version: "1",
        inputKinds: ["instruction", "tool"],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
        toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
        mcpClients: [{ client: "worker-host", transports: ["worker-local"] }],
      };
    },
    async plan(context) {
      expect(context.tools.some((tool) => tool.id === "supertag-artifacts")).toBe(true);
      const entry = test.artifacts.get(capturedId)?.entries[0];
      if (!producer && !entry) throw new Error("Producer artifact missing");
      return {
        runtime: empty(),
        execution: {
          ...empty(),
          files: producer ? [{ path: "findings.md", content: "Recorded evidence" }] : [],
          mounts: producer
            ? []
            : [
                {
                  source: {
                    ...entry,
                    uri: entry?.uri ?? "",
                    artifactId: capturedId,
                  },
                  destination: "inputs/research/findings.md",
                  readOnly: true,
                },
              ],
        },
      };
    },
    async start(_plan, environments, context) {
      const input = context.tools.find((tool) => tool.id === "supertag-artifacts");
      if (!input) throw new Error("No artifact tools");
      const connection = await connectWorkerMcpClient(input);
      if (producer) {
        producerInput = input;
        producerConnection = connection;
      }
      const call = async (name: string, args: JsonRecord) => {
        const result = (await connection.callTool(name, args)) as {
          isError?: boolean;
          content: { text: string }[];
        };
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
      };
      return {
        get session() {
          return { harnessId: "files", id: producer ? "native-producer" : "native-consumer" };
        },
        async *run() {
          if (producer) {
            const result = await call("capture_artifact", {
              operationId: "tool-capture",
              title: "Research",
              kind: "research",
              files: [{ path: "findings.md", mediaType: "text/markdown" }],
            });
            capturedId = (result["artifact"] as CapturedArtifact).id;
            yield { type: "output.message", text: `Captured ${capturedId}` };
          } else {
            expect(await environments.execution.read("inputs/research/findings.md")).toBe(
              "Recorded evidence",
            );
            expect(
              [...test.acquisitions.values()].some(
                (item) =>
                  item["destination"] === "inputs/research/findings.md" &&
                  item["status"] === "delivered",
              ),
            ).toBe(true);
            const result = await call("read_artifact", {
              operationId: "tool-read",
              artifactId: capturedId,
              path: "findings.md",
            });
            expect(result["content"]).toBe("Recorded evidence");
            const attached = await call("attach_artifact", {
              operationId: "tool-attach",
              artifactId: capturedId,
              paths: ["findings.md"],
            });
            const directory = String(attached["destination"]);
            expect(await environments.execution.read(`${directory}/findings.md`)).toBe(
              "Recorded evidence",
            );
            yield { type: "output.message", text: "Used prior research" };
          }
        },
        async close() {},
      };
    },
  });
  const profile = {
    ref: { id: "static", revision: "1" },
    workerType: "files",
    harness: { provider: "files" },
    execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
  };
  for (const producer of [true, false]) {
    const spec = taskAttemptSpec();
    const events = await collectTaskAttemptEvents(
      createWorker({
        id: producer ? "producer" : "consumer",
        profiles: [profile],
        harnesses: [makeHarness(producer)],
        environments: [new LocalExecutionEnvironmentProvider()],
        // Both Workers run on one Worker Host and share its copies.
        artifactStore: test.store,
      }).execute({
        ...spec,
        taskId: producer ? "task-producer" : "task-consumer",
        attemptId: producer ? "attempt-producer" : "attempt-consumer",
        coordination: {
          controlPlaneUrl: "https://control.example",
          token: producer ? "producer-token" : "consumer-token",
          scope: "surface",
        },
      }),
    );
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
    if (producer)
      expect(events.find((event) => event.type === "result")).toMatchObject({
        result: { artifacts: [{ artifactId: capturedId, paths: ["findings.md"] }] },
      });
  }
  expect(producerInput).toBeDefined();
  expect(test.artifacts.get(capturedId)?.harnessSession).toEqual({
    harnessId: "files",
    id: "native-producer",
  });
  await expect(connectWorkerMcpClient(producerInput as ToolInput)).rejects.toThrow("unavailable");
  await expect(producerConnection?.callTool("find_artifacts", {})).rejects.toThrow("unavailable");
});

function taskAttemptSpec(workerProfile = { id: "static", revision: "1" }): TaskAttemptSpec {
  const capturedAt = "2026-08-02T00:00:00.000Z";
  const authorization: TagAuthorizationSnapshot = {
    version: 5,
    capturedAt,
    tag: { id: "tag-1", name: "Engineering" },
    origin: {
      tagRouteId: "surface-1",
      surfaceAccountId: "account-1",
      provider: "slack",
      scope: "channel:general",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [{ id: "permissions-1", name: "engineering" }],
    resources: [
      {
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:general",
        actions: ["history:read"],
        sources: ["permission-set"],
      },
    ],
    runtimeActions: [],
  };
  return {
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "account-1",
        scope: "channel:general",
        sessionKey: "slack:account-1:general:thread-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "How does this work?" }],
    },
    authorization,
    contextPlan: emptyTagContextPlan(capturedAt),
    execution: {},
    workspacePlan: { version: 1, status: "none" },
    workerProfile,
  };
}

it("fences replay of admitted input delivery and rejects changed manifest content", async () => {
  const test = fixture();
  test.inputFiles.set("research/report.md", new TextEncoder().encode("Research"));
  const artifact = await test.client().capture({
    operationId: "produce",
    title: "Research",
    kind: "report",
    files: [{ path: "research/report.md" }],
  });
  const entry = artifact.entries[0];
  if (!entry) throw new Error("Missing captured entry");
  const input = { ...entry, artifactId: artifact.id };
  const consumer = test.client();
  await consumer.authorizeInput(input, "inputs/research/report.md");
  await consumer.settleInputs("delivered");
  await expect(test.client().authorizeInput(input, "inputs/research/report.md")).rejects.toThrow(
    "cannot be replayed",
  );
  const changed = test.client();
  await expect(
    changed.authorizeInput({ ...input, digest: "sha256:changed" }, "inputs/other/report.md"),
  ).rejects.toThrow("does not match");
  await changed.settleInputs("uncertain");
  expect([...test.acquisitions.values()].map((item) => item["status"])).toEqual([
    "delivered",
    "uncertain",
  ]);
});
