import { createHash } from "node:crypto";
import type {
  ArtifactAcquisition,
  ArtifactDiscoveryPage,
  ArtifactHarnessSession,
  CapturedArtifact,
  CapturedArtifactEntry,
  CapturedArtifactFilter,
  JsonRecord,
} from "@supertag/core";
import { validateArtifactHarnessSession, validateArtifactPath } from "@supertag/core";
import { type ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifact-store.js";
import type { ExecutionEnvironment, ResourceRef, ToolInput } from "./index.js";

export type ArtifactCatalogOperation = "find" | "inspect" | "capture" | "acquire" | "settle";
/** Internal catalog boundary; bytes remain in ArtifactStore. */
export interface ArtifactCatalogTransport {
  request<T>(operation: ArtifactCatalogOperation, input: unknown, signal?: AbortSignal): Promise<T>;
}

export class ArtifactRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`Artifact catalog ${operation} failed (${status})`);
    this.name = "ArtifactRequestError";
  }
}

/** A definitive catalog response, distinct from interrupted transfers. */
export class ArtifactHttpError extends ArtifactRequestError {
  constructor(operation: string, status: number) {
    super(operation, status);
    this.message = `Artifact catalog ${operation} failed (HTTP ${status})`;
    this.name = "ArtifactHttpError";
  }
}

export interface ArtifactClientOptions {
  readonly catalogTransport?: ArtifactCatalogTransport;
  readonly controlPlaneUrl: string;
  readonly token: string;
  readonly store: ArtifactStore;
  readonly environment: () => ExecutionEnvironment | undefined;
  /** True only when the provider gives this Attempt an exclusive workspace. */
  readonly exclusiveWorkspace: boolean;
  /** Native identity observed by the Worker, never supplied through an agent tool. */
  readonly harnessSession?: () => ArtifactHarnessSession | undefined;
  readonly signal?: AbortSignal;
}

/** Attempt-authenticated catalog access. Provider credentials never enter tool schemas. */
export class ArtifactClient {
  readonly #base: string;
  readonly #rebind: string;
  #authorization: string;
  #refreshing: Promise<void> | undefined;
  readonly #captured = new Map<string, CapturedArtifact>();
  readonly #captureSessions = new Map<string, ArtifactHarnessSession | undefined>();
  get capturedArtifacts(): readonly CapturedArtifact[] {
    return [...this.#captured.values()];
  }
  readonly #materializations = new Map<string, Promise<JsonRecord>>();
  constructor(readonly options: ArtifactClientOptions) {
    const url = new URL(options.controlPlaneUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("Artifact catalog requires HTTPS outside loopback");
    this.#base = `${url.origin}/internal/v1/artifacts/catalog/`;
    this.#rebind = `${url.origin}/internal/v1/coordination/rebind`;
    this.#authorization = `Bearer ${options.token}`;
  }

  async #post<T>(operation: ArtifactCatalogOperation, input: unknown): Promise<T> {
    if (this.options.catalogTransport)
      return this.options.catalogTransport.request<T>(operation, input, this.options.signal);
    const body = JSON.stringify(input);
    let rebound = false;
    for (let attempt = 0; ; attempt++) {
      this.options.signal?.throwIfAborted();
      const authorization = this.#authorization;
      let response: Response;
      try {
        response = await fetch(`${this.#base}${operation}`, {
          method: "POST",
          body,
          headers: { authorization, "content-type": "application/json" },
          redirect: "error",
          signal: this.options.signal
            ? AbortSignal.any([this.options.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt >= 2 || this.options.signal?.aborted) throw error;
        continue;
      }
      if (response.ok) return (await boundedJson(response)) as T;
      await response.body?.cancel();
      if (response.status === 401 && !rebound) {
        if (authorization === this.#authorization) {
          this.#refreshing ??= this.#refresh(authorization).finally(() => {
            this.#refreshing = undefined;
          });
          await this.#refreshing;
        }
        rebound = true;
        continue;
      }
      if (attempt < 2 && [502, 503, 504].includes(response.status)) continue;
      throw new ArtifactHttpError(operation, response.status);
    }
  }

  async #refresh(authorization: string): Promise<void> {
    const response = await fetch(this.#rebind, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      redirect: "error",
      signal: this.options.signal
        ? AbortSignal.any([this.options.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Artifact authority rebind failed");
    }
    const value = (await boundedJson(response, 8192)) as { token?: unknown };
    if (typeof value.token !== "string" || !value.token || value.token.length > 4096)
      throw new Error("Invalid artifact authority rebind credential");
    this.#authorization = `Bearer ${value.token}`;
  }

  async find(
    input: Pick<CapturedArtifactFilter, "query" | "kind" | "taskId" | "limit" | "cursor"> = {},
  ): Promise<ArtifactDiscoveryPage> {
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
    )
      throw new Error(
        "find_artifacts limit must be an integer from 1 through 50; retry with limit: 50 or omit limit",
      );
    return this.#post("find", input);
  }
  async inspect(artifactId: string): Promise<CapturedArtifact> {
    return (await this.#post<{ artifact: CapturedArtifact }>("inspect", { artifactId })).artifact;
  }
  async register(input: {
    operationId: string;
    title: string;
    summary?: string;
    kind: string;
    entries: readonly CapturedArtifactEntry[];
  }): Promise<CapturedArtifact> {
    if (!this.#captureSessions.has(input.operationId)) {
      const session = this.options.harnessSession?.();
      if (session !== undefined) validateArtifactHarnessSession(session);
      this.#captureSessions.set(input.operationId, session ? { ...session } : undefined);
    }
    const harnessSession = this.#captureSessions.get(input.operationId);
    const artifact = (
      await this.#post<{ artifact: CapturedArtifact }>("capture", {
        operationId: input.operationId,
        title: input.title,
        summary: input.summary,
        kind: input.kind,
        entries: input.entries,
        ...(harnessSession ? { harnessSession } : {}),
      })
    ).artifact;
    this.#captured.set(artifact.id, artifact);
    return artifact;
  }
  async capture(input: {
    operationId: string;
    title: string;
    summary?: string;
    kind: string;
    files: readonly { path: string; mediaType?: string }[];
  }): Promise<CapturedArtifact> {
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100)
      throw new Error("Capture requires 1 through 100 explicit file paths");
    const environment = this.options.environment();
    if (!environment?.readBytes)
      throw new Error("Execution environment does not support binary capture");
    const entries: CapturedArtifactEntry[] = [];
    let totalBytes = 0;
    for (const file of input.files) {
      validateArtifactPath(file.path);
      this.options.signal?.throwIfAborted();
      const bytes = await environment.readBytes(file.path);
      totalBytes += bytes.byteLength;
      if (totalBytes > 64 * 1024 * 1024)
        throw new Error("Artifact capture exceeds 64 MiB total limit");
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact file exceeds limit");
      const ref = await this.options.store.put({
        bytes,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      });
      if (!ref.digest) throw new Error("Artifact store did not return a digest");
      entries.push({
        path: file.path,
        uri: ref.uri,
        digest: ref.digest,
        sizeBytes: bytes.length,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      });
    }
    return this.register({
      operationId: input.operationId,
      title: input.title,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      kind: input.kind,
      entries,
    });
  }
  async #acquire(input: {
    operationId: string;
    artifactId: string;
    paths: readonly string[];
    delivery: "read" | "materialize";
    destination?: string;
  }) {
    return this.#post<{ artifact: CapturedArtifact; acquisition: ArtifactAcquisition }>(
      "acquire",
      input,
    );
  }
  async #settle(id: string, status: "delivered" | "failed" | "uncertain") {
    return this.#post("settle", { id, status });
  }
  async #bytes(artifactId: string, entry: CapturedArtifactEntry): Promise<Uint8Array> {
    const bytes = await this.options.store.get({
      ...entry,
      artifactId,
      path: entry.path,
    });
    if (
      bytes.length !== entry.sizeBytes ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.digest
    )
      throw new Error("Artifact content failed manifest integrity check");
    return bytes;
  }
  readonly #inputAcquisitions = new Set<string>();
  /** Record delivery of an admitted input before its bytes are staged. */
  async authorizeInput(source: ResourceRef, destination: string): Promise<void> {
    if (!source.artifactId || !source.path)
      throw new Error("Artifact input requires catalog identity and path");
    const operationId = `input:${createHash("sha256")
      .update(JSON.stringify([source.artifactId, source.path, destination]))
      .digest("hex")}`;
    const { artifact, acquisition } = await this.#acquire({
      operationId,
      artifactId: source.artifactId,
      paths: [source.path],
      delivery: "materialize",
      destination,
    });
    if (acquisition.status !== "authorized")
      throw new Error("Artifact input delivery cannot be replayed");
    this.#inputAcquisitions.add(acquisition.id);
    const entry = artifact.entries.find((entry) => entry.path === source.path);
    if (!entry || entry.uri !== source.uri || entry.digest !== source.digest)
      throw new Error("Admitted artifact input does not match the catalog manifest");
  }
  async settleInputs(status: "delivered" | "uncertain"): Promise<void> {
    for (const id of this.#inputAcquisitions) {
      await this.#settle(id, status);
      this.#inputAcquisitions.delete(id);
    }
  }
  async read(input: {
    operationId: string;
    artifactId: string;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<JsonRecord> {
    validateArtifactPath(input.path);
    const offset = input.offset ?? 0,
      limit = input.limit ?? 12_000;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64_000
    )
      throw new Error("Read offset and limit must be bounded nonnegative byte counts");
    const { artifact, acquisition } = await this.#acquire({
      operationId: input.operationId,
      artifactId: input.artifactId,
      paths: [input.path],
      delivery: "read",
    });
    try {
      const entry = artifact.entries.find((entry) => entry.path === input.path);
      if (!entry) throw new Error("Artifact file is unavailable");
      if (
        !(
          entry.mediaType?.startsWith("text/") ||
          /\.(txt|md|csv|json|jsonl|yaml|yml|xml|html|ts|js|py|go|rs|sql)$/i.test(entry.path)
        )
      )
        throw new Error("Binary content must be attached to an execution environment");
      const bytes = await this.#bytes(artifact.id, entry);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset, offset + limit),
        { stream: offset + limit < bytes.length },
      );
      const nextOffset = offset + new TextEncoder().encode(content).byteLength;
      if (nextOffset === offset && offset < bytes.length)
        throw new Error("Read limit is too small for the next UTF-8 character");
      // This acknowledges service delivery to the tool adapter, not model comprehension.
      await this.#settle(acquisition.id, "delivered");
      return {
        artifactId: artifact.id,
        acquisitionId: acquisition.id,
        path: entry.path,
        digest: entry.digest,
        content,
        offset,
        nextOffset,
        truncated: nextOffset < bytes.length,
        sizeBytes: bytes.length,
      };
    } catch (error) {
      await this.#settle(acquisition.id, "failed").catch(() => undefined);
      throw error;
    }
  }
  attach(input: {
    operationId: string;
    artifactId: string;
    paths: readonly string[];
  }): Promise<JsonRecord> {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.#materializations.get(fingerprint);
    if (existing) return existing;
    const work = this.#attach(input);
    this.#materializations.set(fingerprint, work);
    return work;
  }
  async #attach(input: {
    operationId: string;
    artifactId: string;
    paths: readonly string[];
  }): Promise<JsonRecord> {
    if (!this.options.exclusiveWorkspace)
      throw new Error(
        "This shared execution environment cannot enforce Attempt-scoped artifact attachment; use read_artifact or an isolated environment",
      );
    const environment = this.options.environment();
    if (!environment?.materializeArtifactFiles)
      throw new Error("Execution environment does not support safe artifact materialization");
    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 100)
      throw new Error("Attach requires explicit selected paths");
    for (const path of input.paths) validateArtifactPath(path);
    const destination = `artifact-${createHash("sha256").update(input.operationId).digest("hex")}`;
    const { artifact, acquisition } = await this.#acquire({
      ...input,
      delivery: "materialize",
      destination,
    });
    if (acquisition.status !== "authorized")
      throw new Error(
        "Artifact attachment was already attempted; do not replay a materialization with uncertain local state",
      );
    let writing = false;
    try {
      const files = [];
      let totalBytes = 0;
      for (const path of input.paths) {
        const entry = artifact.entries.find((entry) => entry.path === path);
        if (!entry) throw new Error("Artifact file is unavailable");
        totalBytes += entry.sizeBytes;
        if (totalBytes > 64 * 1024 * 1024)
          throw new Error("Artifact attachment exceeds 64 MiB total limit");
        files.push({ path: entry.path, bytes: await this.#bytes(artifact.id, entry) });
      }
      this.options.signal?.throwIfAborted();
      writing = true;
      const resolvedDestination = await environment.materializeArtifactFiles({
        directory: destination,
        files,
      });
      await this.#settle(acquisition.id, "delivered");
      return {
        artifactId: artifact.id,
        acquisitionId: acquisition.id,
        destination: resolvedDestination,
        paths: files.map((file) => file.path),
        mode: "writable-copy",
      };
    } catch (error) {
      await this.#settle(acquisition.id, writing ? "uncertain" : "failed").catch(() => undefined);
      throw error;
    }
  }
}

const string = { type: "string", minLength: 1 };
const schema = (properties: JsonRecord, required: string[]): JsonRecord => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export function artifactToolInput(handle: string): ToolInput {
  const operations = [
    {
      name: "find_artifacts",
      effect: "read" as const,
      actions: ["artifacts.find"],
      inputSchema: schema(
        {
          query: string,
          kind: string,
          taskId: string,
          cursor: string,
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        [],
      ),
    },
    {
      name: "inspect_artifact",
      effect: "read" as const,
      actions: ["artifacts.inspect"],
      inputSchema: schema({ artifactId: string }, ["artifactId"]),
    },
    {
      name: "read_artifact",
      effect: "read" as const,
      actions: ["artifacts.read"],
      inputSchema: schema(
        {
          operationId: string,
          artifactId: string,
          path: string,
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 64000 },
        },
        ["operationId", "artifactId", "path"],
      ),
    },
    {
      name: "attach_artifact",
      effect: "write" as const,
      actions: ["artifacts.attach"],
      inputSchema: schema(
        {
          operationId: string,
          artifactId: string,
          paths: { type: "array", items: string, minItems: 1, maxItems: 100 },
        },
        ["operationId", "artifactId", "paths"],
      ),
    },
    {
      name: "capture_artifact",
      effect: "write" as const,
      actions: ["artifacts.capture"],
      inputSchema: schema(
        {
          operationId: string,
          title: string,
          summary: string,
          kind: string,
          files: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: schema({ path: string, mediaType: string }, ["path"]),
          },
        },
        ["operationId", "title", "kind", "files"],
      ),
    },
  ];
  return {
    id: "supertag-artifacts",
    kind: "tool",
    required: true,
    audience: "manager",
    capability: {
      id: "supertag-artifacts",
      provider: "supertag",
      authorization: { provider: "supertag", resources: [] },
      operations,
    },
    binding: { kind: "worker-local", name: "supertag-artifacts", handle },
  };
}

export async function invokeArtifactTool(
  client: ArtifactClient,
  name: string,
  args: JsonRecord,
): Promise<unknown> {
  switch (name) {
    case "find_artifacts":
      return client.find(args as CapturedArtifactFilter);
    case "inspect_artifact":
      return { artifact: await client.inspect(args["artifactId"] as string) };
    case "read_artifact":
      return client.read(args as unknown as Parameters<ArtifactClient["read"]>[0]);
    case "attach_artifact":
      return client.attach(args as unknown as Parameters<ArtifactClient["attach"]>[0]);
    case "capture_artifact":
      return {
        artifact: await client.capture(args as unknown as Parameters<ArtifactClient["capture"]>[0]),
        consistency: "individual-file-copies",
      };
    default:
      throw new Error("Unknown artifact tool");
  }
}

async function boundedJson(response: Response, maximumBytes = 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Artifact catalog returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new Error("Artifact catalog response exceeds limit");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
