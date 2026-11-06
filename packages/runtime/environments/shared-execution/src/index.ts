import { Code, ConnectError } from "@connectrpc/connect";
import { SharedExecutionGrpcClient } from "./grpc-client.js";

export {
  type SharedExecutionGrpcServerOptions,
  startSharedExecutionGrpcServer,
} from "./grpc-server.js";
export { type SharedExecutionServerOptions, startSharedExecutionServer } from "./server.js";

import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type CapabilityIdentifier,
  childPath,
  type EnvironmentGuarantees,
  type EnvironmentPlan,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type ExecutionEnvironmentSpec,
  type LocalResourceFilter,
  localResourceFilter,
  PROCESS_INPUT_STREAMING_CAPABILITY,
  PROCESS_OUTPUT_STREAMING_CAPABILITY,
  type ProcessHandle,
  type ProcessOutputChunk,
  type ProcessResult,
  type ProcessSpec,
} from "@supertag/worker-sdk";

export const SHARED_EXECUTION_CAPABILITY: CapabilityIdentifier = {
  id: "supertag.execution.shared-service",
  version: 1,
};

export interface SharedExecutionEnvironmentProviderOptions {
  readonly baseUrl: string;
  /** Select exactly one transport; requests never fall back after dispatch. */
  readonly transport?: "http" | "grpc";
  /** PEM trust root for a private gRPC endpoint. */
  readonly tlsCa?: string;
  readonly adminToken: string;
  readonly environmentId: string;
  readonly accessTtlMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maximumReadBytes?: number;
  /** Deployment guarantees explicitly asserted by the service operator. */
  readonly guarantees?: EnvironmentGuarantees;
}

const sharedExecutionGuarantees = {
  filesystemIsolation: "none",
  networkPolicy: "none",
  processTreeTermination: true,
  scopedHttp: false,
} as const;

interface AccessGrantResponse {
  accessId: string;
  environmentId: string;
  incarnationId: string;
  expiresAt: string;
  rootDirectory: string;
}

interface AccessGrant extends AccessGrantResponse {
  accessToken: string;
}

interface OperationReceipt {
  operationId: string;
  status: "accepted" | "running" | "completed" | "failed" | "uncertain";
  processId?: string;
  result?: unknown;
  error?: string;
}

interface ProcessSnapshot {
  processId: string;
  status: OperationReceipt["status"];
  chunks: readonly (ProcessOutputChunk & { sequence: number })[];
  nextCursor: number;
  result?: ProcessResult;
  error?: string;
}

export class SharedExecutionEnvironmentProvider implements ExecutionEnvironmentProvider {
  readonly id: string;
  readonly capabilities = [
    SHARED_EXECUTION_CAPABILITY,
    PROCESS_OUTPUT_STREAMING_CAPABILITY,
    PROCESS_INPUT_STREAMING_CAPABILITY,
  ];
  readonly guarantees: EnvironmentGuarantees;
  readonly #options: SharedExecutionEnvironmentProviderOptions;
  readonly #client: SharedExecutionClient;

  constructor(options: SharedExecutionEnvironmentProviderOptions) {
    if (!options.baseUrl || !options.adminToken || !options.environmentId)
      throw new Error("Shared execution provider requires baseUrl, adminToken, and environmentId");
    this.id = `shared-execution:${options.environmentId}`;
    this.#options = options;
    this.guarantees = options.guarantees ?? sharedExecutionGuarantees;
    this.#client = new SharedExecutionClient(
      options.baseUrl,
      options.requestTimeoutMs ?? 10_000,
      options.transport ?? "http",
      options.tlsCa,
    );
  }

  async provision(
    spec: ExecutionEnvironmentSpec,
    signal?: AbortSignal,
  ): Promise<ExecutionEnvironment> {
    if (spec.profile.execution.lifetime.scope !== "attempt")
      throw new Error("Shared execution access is currently Attempt-scoped");
    const grant = await this.#client.issueAccess(
      this.#options.adminToken,
      spec,
      this.#options.accessTtlMs ?? 5 * 60_000,
      signal,
    );
    if (grant.environmentId !== this.#options.environmentId)
      throw new Error("Shared execution service returned the wrong environment");
    return new SharedExecutionEnvironment(
      this.#client,
      grant,
      this.#options.maximumReadBytes ?? 1024 * 1024,
      this.guarantees,
    );
  }
}

class SharedExecutionClient {
  readonly #baseUrl: string;
  readonly #grpc: SharedExecutionGrpcClient | undefined;

  constructor(
    baseUrl: string,
    readonly requestTimeoutMs: number,
    readonly transport: "http" | "grpc",
    tlsCa?: string,
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/u, "");
    this.#grpc =
      transport === "grpc"
        ? new SharedExecutionGrpcClient(baseUrl, requestTimeoutMs, tlsCa)
        : undefined;
  }

  async issueAccess(
    adminToken: string,
    spec: ExecutionEnvironmentSpec,
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<AccessGrant> {
    const accessId = randomUUID();
    const accessToken = `stx_${randomBytes(32).toString("base64url")}`;
    const path = `/v1/accesses/${accessId}`;
    const request = {
      method: "PUT",
      token: adminToken,
      body: {
        taskId: spec.task.taskId,
        attemptId: spec.task.attemptId,
        tagId: spec.task.tag.id,
        accessToken,
        ttlMs,
      },
    };
    const response = await this.#retryTransport(
      () => this.#request<AccessGrantResponse>(path, request, signal),
      signal,
    );
    return { ...response, accessToken };
  }

  async request<T>(
    path: string,
    options: { method?: string; token: string; body?: unknown },
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.#request(path, options, signal);
  }

  async #request<T>(
    path: string,
    options: { method?: string; token: string; body?: unknown },
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#grpc) {
      try {
        return (await this.#grpc.request(path, options, signal)) as T;
      } catch (error) {
        if (
          error instanceof ConnectError &&
          ![Code.Unavailable, Code.DeadlineExceeded, Code.Canceled].includes(error.code)
        ) {
          const status =
            (
              {
                [Code.Unauthenticated]: 401,
                [Code.PermissionDenied]: 403,
                [Code.NotFound]: 404,
                [Code.FailedPrecondition]: 409,
                [Code.ResourceExhausted]: 429,
              } as Record<number, number>
            )[error.code] ?? 400;
          throw new SharedExecutionRequestError(status, error.rawMessage);
        }
        throw error;
      }
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: combined,
    });
    const body = (await boundedJson(response, 2 * 1024 * 1024)) as { error?: string } & T;
    if (!response.ok)
      throw new SharedExecutionRequestError(
        response.status,
        body.error ?? `Shared execution request failed: ${response.status}`,
      );
    return body;
  }

  async *watch(processId: string, token: string): AsyncIterable<ProcessSnapshot> {
    if (this.#grpc) {
      for await (const snapshot of this.#grpc.watch(processId, 0, token))
        yield snapshot as unknown as ProcessSnapshot;
      return;
    }
    let cursor = 0;
    while (true) {
      const snapshot = await this.#request<ProcessSnapshot>(
        `/v1/processes/${encodeURIComponent(processId)}?cursor=${cursor}`,
        { token },
      );
      cursor = snapshot.nextCursor;
      yield snapshot;
      if (!["accepted", "running"].includes(snapshot.status)) return;
      await delay(25);
    }
  }

  async #retryTransport<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || error instanceof SharedExecutionRequestError) throw error;
      return await operation();
    }
  }

  async operation(
    operationId: string,
    token: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OperationReceipt> {
    return await this.#retryTransport(
      () =>
        this.#request<OperationReceipt>(
          `/v1/operations/${encodeURIComponent(operationId)}`,
          { method: "POST", token, body },
          signal,
        ),
      signal,
    );
  }
}

class SharedExecutionEnvironment implements ExecutionEnvironment {
  readonly id: string;
  readonly placement = "remote" as const;
  readonly guarantees;
  readonly provenance;
  readonly rootDirectory: string;
  readonly #environmentVariables: Record<string, string> = {};
  #closing = false;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    readonly client: SharedExecutionClient,
    readonly grant: AccessGrant,
    readonly maximumReadBytes: number,
    guarantees: EnvironmentGuarantees,
  ) {
    this.id = `${grant.environmentId}:${grant.incarnationId}:${grant.accessId}`;
    this.rootDirectory = grant.rootDirectory;
    this.guarantees = guarantees;
    this.provenance = {
      environmentId: grant.environmentId,
      incarnationId: grant.incarnationId,
      accessId: grant.accessId,
      expiresAt: grant.expiresAt,
      transport: client.transport,
    };
  }

  async prepare(plan: EnvironmentPlan): Promise<void> {
    this.#assertOpen();
    if (plan.mounts.some((mount) => mount.readOnly))
      throw new Error("Shared execution cannot enforce read-only source mounts");
    if (plan.secretBindings.length)
      throw new Error("Shared execution requires a service-owned Secret Resolver");
    if (plan.network.mode !== "unrestricted" && this.guarantees.networkPolicy !== "enforced")
      throw new Error("Shared execution cannot yet enforce per-access network policy");
    Object.assign(this.#environmentVariables, plan.environmentVariables);
    for (const mount of plan.mounts) {
      const source = new URL(mount.source.uri);
      if (source.protocol !== "file:")
        throw new Error("Shared execution source mounts must use file: resources");
      const path = fileURLToPath(source);
      await this.#stageLocalSource(path, mount.destination, await localResourceFilter(path), "");
    }
    for (const file of plan.files) {
      const expected = Buffer.from(file.content);
      await this.#operation({
        kind: "file.stage",
        path: file.path,
        contentBase64: expected.toString("base64"),
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      });
      // Shared workspaces retain prior input copies. Reuse only the exact admitted bytes;
      // never silently preserve a modified input or overwrite another access's changes.
      const actual = await this.readBytes(file.path);
      if (!expected.equals(actual))
        throw new Error(`Shared execution staged file differs from required input: ${file.path}`);
    }
  }

  async #stageLocalSource(
    source: string,
    destination: string,
    include: LocalResourceFilter | undefined,
    path: string,
  ): Promise<void> {
    if (include !== undefined && !include(path)) return;
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink())
      throw new Error("Shared execution staging rejects symbolic links");
    if (metadata.isDirectory()) {
      for (const child of await readdir(source))
        await this.#stageLocalSource(
          join(source, child),
          posix.join(destination, child),
          include,
          childPath(path, child),
        );
      return;
    }
    if (!metadata.isFile() || metadata.size > this.maximumReadBytes)
      throw new Error("Shared execution staging requires bounded regular files");
    await this.#operation({
      kind: "file.stage",
      path: destination,
      contentBase64: (await readFile(source)).toString("base64"),
      mode: metadata.mode & 0o777,
    });
  }

  resolvePath(path: string): string {
    this.#assertOpen();
    const target = posix.resolve(this.rootDirectory, path);
    if (target !== this.rootDirectory && !target.startsWith(`${this.rootDirectory}/`))
      throw new Error("Environment path escapes its root");
    return target;
  }

  async read(path: string): Promise<string> {
    return Buffer.from(await this.readBytes(path)).toString("utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const receipt = await this.#operation({
      kind: "file.read",
      path,
      maximumBytes: this.maximumReadBytes,
    });
    const result = record(receipt.result);
    return new Uint8Array(Buffer.from(text(result["contentBase64"], "contentBase64"), "base64"));
  }

  async spawn(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessHandle> {
    this.#assertOpen();
    if (spec.streamInput && spec.stdin !== undefined)
      throw new Error("Choose streamInput or stdin, not both");
    const receipt = await this.#operation(
      {
        kind: "process.start",
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? this.rootDirectory,
        environment: spec.replaceEnvironment
          ? { ...spec.environment }
          : { ...this.#environmentVariables, ...spec.environment },
        ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
        ...(spec.streamInput ? { streamInput: true } : {}),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      },
      signal,
    );
    if (!receipt.processId) throw new Error("Shared execution did not return a process ID");
    const handle = new SharedProcessHandle(
      this,
      receipt.processId,
      Boolean(spec.streamOutput),
      Boolean(spec.streamInput),
    );
    if (signal) {
      // The signal usually spans a whole Attempt. Stop listening once this process finishes, so
      // an abort signals only live processes rather than every process the Attempt ever ran.
      const abort = () => handle.kill();
      if (signal.aborted) handle.kill();
      else {
        signal.addEventListener("abort", abort, { once: true });
        handle.onSettled(() => signal.removeEventListener("abort", abort));
      }
    }
    return handle;
  }

  watch(processId: string): AsyncIterable<ProcessSnapshot> {
    return this.client.watch(processId, this.grant.accessToken);
  }

  async snapshot(processId: string, cursor: number): Promise<ProcessSnapshot> {
    return await this.client.request<ProcessSnapshot>(
      `/v1/processes/${encodeURIComponent(processId)}?cursor=${cursor}`,
      { token: this.grant.accessToken },
    );
  }

  async signal(processId: string, signal: NodeJS.Signals): Promise<void> {
    await this.#operation({ kind: "process.signal", processId, signal });
  }

  async writeInput(processId: string, bytes: Uint8Array): Promise<void> {
    await this.#operation({
      kind: "process.input.write",
      processId,
      contentBase64: Buffer.from(bytes).toString("base64"),
    });
  }

  async closeInput(processId: string): Promise<void> {
    await this.#operation({ kind: "process.input.close", processId });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#closing = true;
    this.#disposePromise ??= this.client
      .request(`/v1/accesses/${encodeURIComponent(this.grant.accessId)}`, {
        method: "POST",
        token: this.grant.accessToken,
      })
      .then(() => {
        this.#disposed = true;
      })
      .finally(() => {
        this.#disposePromise = undefined;
      });
    await this.#disposePromise;
  }

  async #operation(body: Record<string, unknown>, signal?: AbortSignal): Promise<OperationReceipt> {
    this.#assertOpen();
    const receipt = await this.client.operation(randomUUID(), this.grant.accessToken, body, signal);
    if (receipt.status === "failed" || receipt.status === "uncertain")
      throw new Error(receipt.error ?? `Environment operation ${receipt.status}`);
    return receipt;
  }

  #assertOpen(): void {
    if (this.#closing || this.#disposed) throw new Error("Shared execution access is closed");
  }
}

class SharedProcessHandle implements ProcessHandle {
  readonly output?: AsyncIterable<ProcessOutputChunk>;
  readonly write?: (bytes: Uint8Array) => Promise<void>;
  readonly endInput?: () => Promise<void>;
  #settled = false;
  readonly #settledCallbacks: Array<() => void> = [];

  constructor(
    readonly environment: SharedExecutionEnvironment,
    readonly processId: string,
    streamOutput: boolean,
    streamInput: boolean,
  ) {
    if (streamOutput) this.output = this.#output();
    if (streamInput) {
      let inputTail = Promise.resolve();
      let inputClosed = false;
      let closePromise: Promise<void> | undefined;
      const schedule = (operation: () => Promise<void>) => {
        const pending = inputTail.then(operation);
        inputTail = pending.catch(() => undefined);
        return pending;
      };
      this.write = async (bytes) => {
        if (inputClosed) throw new Error("Shared execution process input is closed");
        const copy = new Uint8Array(bytes);
        await schedule(() => this.environment.writeInput(this.processId, copy));
      };
      this.endInput = () => {
        if (closePromise) return closePromise;
        inputClosed = true;
        closePromise = schedule(() => this.environment.closeInput(this.processId));
        return closePromise;
      };
    }
  }

  /** Runs once the process is known to have finished; immediately if it already has. */
  onSettled(callback: () => void): void {
    if (this.#settled) callback();
    else this.#settledCallbacks.push(callback);
  }

  #settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    for (const callback of this.#settledCallbacks.splice(0)) callback();
  }

  async wait(): Promise<ProcessResult> {
    for await (const snapshot of this.environment.watch(this.processId)) {
      if (snapshot.status === "completed" && snapshot.result) {
        this.#settle();
        return snapshot.result;
      }
      if (snapshot.status === "failed" || snapshot.status === "uncertain") {
        // An uncertain process may still be running; keep it signalable.
        if (snapshot.status === "failed") this.#settle();
        throw new Error(snapshot.error ?? `Remote process ${snapshot.status}`);
      }
    }
    throw new Error("Process stream ended without a terminal receipt");
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    // A finished process has nothing to signal, and each signal is a persisted operation.
    if (this.#settled) return;
    void this.environment.signal(this.processId, signal).catch(() => {});
  }

  async *#output(): AsyncIterable<ProcessOutputChunk> {
    for await (const snapshot of this.environment.watch(this.processId)) {
      for (const chunk of snapshot.chunks) yield { stream: chunk.stream, text: chunk.text };
      if (snapshot.status === "completed") {
        this.#settle();
        return;
      }
      if (snapshot.status === "failed" || snapshot.status === "uncertain") {
        if (snapshot.status === "failed") this.#settle();
        throw new Error(snapshot.error ?? `Remote process ${snapshot.status}`);
      }
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Shared execution returned an invalid result");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Shared execution result lacks ${name}`);
  return value;
}

class SharedExecutionRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maximumBytes) throw new Error("Shared execution response exceeds limit");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("Shared execution response exceeds limit");
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return JSON.parse(bytes.toString("utf8") || "{}");
}
