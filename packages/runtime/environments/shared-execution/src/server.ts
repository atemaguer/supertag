import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chown, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

type OperationStatus = "accepted" | "running" | "completed" | "failed" | "uncertain";
type ProcessChunk = { sequence: number; stream: "stdout" | "stderr"; text: string };
type ProcessResult = { exitCode: number | null; signal?: string; stdout: string; stderr: string };

interface AccessRecord {
  id: string;
  tokenHash: string;
  requestFingerprint: string;
  taskId: string;
  attemptId: string;
  tagId: string;
  incarnationId: string;
  expiresAt: string;
  revokedAt?: string;
}

interface OperationRecord {
  id: string;
  accessId: string;
  fingerprint: string;
  kind: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  processId?: string;
  result?: unknown;
  error?: string;
  chunks?: ProcessChunk[];
}

interface DurableState {
  version: 1;
  environmentId: string;
  incarnationId: string;
  accesses: Record<string, AccessRecord>;
  operations: Record<string, OperationRecord>;
}

interface RuntimeProcess {
  child: ChildProcess;
  accessId: string;
  operationId: string;
  streamInput: boolean;
  inputClosed: boolean;
  inputTail: Promise<void>;
  stdout: string;
  stderr: string;
  outputBytes: number;
  outputLimitExceeded: boolean;
  decoders: Record<"stdout" | "stderr", StringDecoder>;
  timeout?: NodeJS.Timeout;
  releaseRequested?: boolean;
}

/** Internal request adapter shared by the HTTP and gRPC frontends. */
export interface SharedExecutionRequest {
  method: string;
  url: string;
  headers: { authorization?: string };
  body?: Record<string, unknown>;
}
export interface SharedExecutionResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface SharedExecutionServerOptions {
  rootDirectory: string;
  statePath: string;
  environmentId: string;
  incarnationId?: string;
  adminToken: string;
  host?: string;
  port?: number;
  maximumOutputBytes?: number;
  maximumConcurrentProcesses?: number;
  processUid?: number;
  processGid?: number;
}

export async function startSharedExecutionServer(options: SharedExecutionServerOptions) {
  if (!options.adminToken || options.adminToken.length < 16)
    throw new Error("Shared execution admin token must contain at least 16 characters");
  if ((options.processUid === undefined) !== (options.processGid === undefined))
    throw new Error("Shared execution process UID and GID must be configured together");
  for (const [name, value] of [
    ["processUid", options.processUid],
    ["processGid", options.processGid],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`${name} must be a positive integer`);
  }
  await mkdir(resolve(options.rootDirectory), { recursive: true });
  const rootDirectory = await realpath(resolve(options.rootDirectory));
  if (options.processUid !== undefined && options.processGid !== undefined)
    await chown(rootDirectory, options.processUid, options.processGid);
  await mkdir(dirname(options.statePath), { recursive: true });
  const state = await loadState(options.statePath, options.environmentId, options.incarnationId);
  for (const operation of Object.values(state.operations)) {
    if (operation.status === "accepted" || operation.status === "running") {
      operation.status = "uncertain";
      operation.error = "Execution service restarted before operation completion was observed";
      operation.updatedAt = new Date().toISOString();
    }
  }
  let saveTail = Promise.resolve();
  let pendingSave: Promise<void> | undefined;
  // Every change is durable once the returned promise resolves. While a write is in flight, later
  // changes share one follow-up write that snapshots state when it starts, rather than queueing a
  // full rewrite each; a burst of operations otherwise serializes hundreds of large writes.
  const persist = () => {
    if (pendingSave) return pendingSave;
    const next = saveTail.then(() => {
      pendingSave = undefined;
      return atomicWrite(options.statePath, JSON.stringify(state));
    });
    pendingSave = next;
    saveTail = next;
    return next;
  };
  await persist();
  let closing = false;
  const processes = new Map<string, RuntimeProcess>();
  const operationExecutions = new Map<string, Promise<void>>();
  const maximumOutputBytes = options.maximumOutputBytes ?? 1024 * 1024;
  const maximumConcurrentProcesses = options.maximumConcurrentProcesses ?? 8;

  const server = createServer(async (request, response) => {
    try {
      const result = await dispatch({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {},
        ...(["POST", "PUT"].includes(request.method ?? "")
          ? { body: await jsonBody(request) }
          : {}),
      });
      send(response, result.status, result.body);
    } catch (error) {
      send(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  async function dispatch(request: SharedExecutionRequest): Promise<SharedExecutionResponse> {
    try {
      if (closing) throw new HttpError(503, "Execution service is closing");
      return await route(request);
    } catch (error) {
      return {
        status: error instanceof HttpError ? error.status : 500,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  async function route(request: SharedExecutionRequest): Promise<SharedExecutionResponse> {
    const url = new URL(request.url ?? "/", "http://shared-execution.invalid");
    if (request.method === "GET" && url.pathname === "/healthz") {
      return reply(200, {
        environmentId: state.environmentId,
        incarnationId: state.incarnationId,
        activeProcesses: processes.size,
        maximumConcurrentProcesses,
      });
    }
    const accessMatch = /^\/v1\/accesses\/([^/]+)$/u.exec(url.pathname);
    if (accessMatch && request.method === "PUT") {
      requireAdmin(request, options.adminToken);
      const body = request.body ?? {};
      for (const field of ["taskId", "attemptId", "tagId", "accessToken"])
        if (typeof body[field] !== "string" || !body[field])
          throw new HttpError(400, `${field} required`);
      const id = decodeURIComponent(accessMatch[1] ?? "");
      if (!id || id.length > 200) throw new HttpError(400, "Invalid access ID");
      const token = String(body["accessToken"]);
      if (Buffer.byteLength(token) < 32)
        throw new HttpError(400, "Environment access token is too short");
      const ttlMs = number(body["ttlMs"], "ttlMs", 1000, 24 * 60 * 60 * 1000);
      const requestFingerprint = hash(
        canonical({
          taskId: body["taskId"],
          attemptId: body["attemptId"],
          tagId: body["tagId"],
          ttlMs,
          tokenHash: hash(token),
        }),
      );
      const existing = state.accesses[id];
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint)
          throw new HttpError(409, "Access ID was reused with different input");
        await persist();
        return reply(200, accessResponse(existing, state.environmentId, rootDirectory));
      }
      const record: AccessRecord = {
        id,
        tokenHash: hash(token),
        requestFingerprint,
        taskId: String(body["taskId"]),
        attemptId: String(body["attemptId"]),
        tagId: String(body["tagId"]),
        incarnationId: state.incarnationId,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      state.accesses[id] = record;
      await persist();
      return reply(201, accessResponse(record, state.environmentId, rootDirectory));
    }
    const revokeMatch = accessMatch;
    if (revokeMatch && request.method === "DELETE") {
      requireAdmin(request, options.adminToken);
      const access = state.accesses[decodeURIComponent(revokeMatch[1] ?? "")];
      if (!access) throw new HttpError(404, "Unknown environment access");
      await revoke(access, "revoked");
      return reply(200, { status: "revoked", accessId: access.id });
    }
    if (revokeMatch && request.method === "POST") {
      // Expiry removes execution authority, not the ability to release this exact access.
      const access = authenticateAccess(request);
      if (access.id !== decodeURIComponent(revokeMatch[1] ?? ""))
        throw new HttpError(403, "Access may release only itself");
      await revoke(access, "released");
      return reply(200, { status: "released", accessId: access.id });
    }
    const operationMatch = /^\/v1\/operations\/([^/]+)$/u.exec(url.pathname);
    if (operationMatch && request.method === "GET") {
      const access = authorize(request);
      const operation = state.operations[decodeURIComponent(operationMatch[1] ?? "")];
      if (!operation)
        throw new HttpError(
          404,
          "Unknown operation; absence is not proof an unacknowledged request was never accepted",
        );
      if (operation.accessId !== access.id)
        throw new HttpError(403, "Operation belongs to another access");
      const receipt = operationResponse(operation);
      await persist();
      return reply(200, receipt);
    }
    if (operationMatch && request.method === "POST") {
      const access = authorize(request);
      const operationId = decodeURIComponent(operationMatch[1] ?? "");
      if (!operationId || operationId.length > 200)
        throw new HttpError(400, "Invalid operation ID");
      const rawBody = request.body ?? {};
      // Protobuf repeated/map fields materialize these defaults on decode.
      const body =
        rawBody["kind"] === "process.start"
          ? {
              ...rawBody,
              args: rawBody["args"] === undefined ? [] : rawBody["args"],
              environment: rawBody["environment"] ?? {},
            }
          : rawBody;
      const fingerprint = hash(canonical(body));
      const existing = state.operations[operationId];
      if (existing) {
        if (existing.accessId !== access.id)
          throw new HttpError(403, "Operation belongs to another access");
        if (existing.fingerprint !== fingerprint)
          throw new HttpError(409, "Operation ID was reused with different input");
        const inFlight = operationExecutions.get(operationId);
        if (existing.status === "accepted" && inFlight) await inFlight;
        const receipt = operationResponse(existing);
        await persist();
        return reply(200, receipt);
      }
      const kind = String(body["kind"] ?? "");
      const reservedProcesses = Object.values(state.operations).filter(
        (item) => item.kind === "process.start" && ["accepted", "running"].includes(item.status),
      ).length;
      if (kind === "process.start" && reservedProcesses >= maximumConcurrentProcesses)
        throw new HttpError(429, "Environment process concurrency limit reached");
      const now = new Date().toISOString();
      const operation: OperationRecord = {
        id: operationId,
        accessId: access.id,
        fingerprint,
        kind,
        status: "accepted",
        createdAt: now,
        updatedAt: now,
      };
      state.operations[operationId] = operation;
      const execution = (async () => {
        await persist();
        await executeOperation(operation, access, body);
      })();
      operationExecutions.set(operationId, execution);
      try {
        await execution;
      } finally {
        operationExecutions.delete(operationId);
      }
      return reply(200, operationResponse(operation));
    }
    const processMatch = /^\/v1\/processes\/([^/]+)$/u.exec(url.pathname);
    if (processMatch && request.method === "GET") {
      const access = authorize(request);
      const processId = decodeURIComponent(processMatch[1] ?? "");
      const operation = Object.values(state.operations).find(
        (item) => item.processId === processId && item.kind === "process.start",
      );
      if (!operation) throw new HttpError(404, "Unknown process");
      if (operation.accessId !== access.id)
        throw new HttpError(403, "Process belongs to another access");
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const latest = operation.chunks?.at(-1)?.sequence ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > latest)
        throw new HttpError(409, "Process cursor is outside the journal");
      const chunks: ProcessChunk[] = [];
      let pageBytes = 0;
      for (const chunk of operation.chunks ?? []) {
        if (chunk.sequence <= cursor) continue;
        const bytes = Buffer.byteLength(chunk.text);
        if (chunks.length && (chunks.length >= 256 || pageBytes + bytes > 256 * 1024)) break;
        chunks.push(chunk);
        pageBytes += bytes;
      }
      // Older journals can contain larger chunks. Deliver one intact, then send
      // the terminal result on the next page so output is never silently skipped.
      const more =
        chunks.length > 0 && (chunks.at(-1)?.sequence !== latest || pageBytes > 256 * 1024);
      const snapshot = {
        processId,
        status: more ? "running" : operation.status,
        chunks,
        nextCursor: chunks.at(-1)?.sequence ?? cursor,
        ...(more || operation.result === undefined ? {} : { result: operation.result }),
        ...(operation.error === undefined ? {} : { error: operation.error }),
      };
      await persist();
      return reply(200, snapshot);
    }
    throw new HttpError(404, "Unknown shared execution endpoint");
  }

  function authenticateAccess(request: SharedExecutionRequest): AccessRecord {
    const token = bearer(request);
    const tokenHash = hash(token);
    const access = Object.values(state.accesses).find((item) =>
      safeEqual(item.tokenHash, tokenHash),
    );
    if (!access) throw new HttpError(401, "Invalid environment access token");
    if (access.incarnationId !== state.incarnationId)
      throw new HttpError(409, "Environment incarnation was replaced");
    return access;
  }

  function authorize(request: SharedExecutionRequest): AccessRecord {
    const access = authenticateAccess(request);
    if (access.revokedAt) throw new HttpError(401, "Environment access was revoked");
    if (Date.parse(access.expiresAt) <= Date.now())
      throw new HttpError(401, "Environment access expired");
    return access;
  }

  async function executeOperation(
    operation: OperationRecord,
    access: AccessRecord,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (operation.kind === "file.write" || operation.kind === "file.stage") {
        const target = await safePath(rootDirectory, String(body["path"] ?? ""), true);
        const content = Buffer.from(String(body["contentBase64"] ?? ""), "base64");
        if (content.byteLength > maximumOutputBytes) throw new HttpError(413, "File exceeds limit");
        await mkdir(dirname(target), { recursive: true });
        if (options.processUid !== undefined && options.processGid !== undefined)
          await chown(dirname(target), options.processUid, options.processGid);
        await assertNoSymlink(rootDirectory, target);
        let created = true;
        try {
          await writeFile(target, content, {
            flag: body["exclusive"] === false ? "w" : "wx",
            mode: typeof body["mode"] === "number" ? body["mode"] : 0o600,
          });
        } catch (error) {
          if (
            operation.kind !== "file.stage" ||
            !(error instanceof Error && "code" in error && error.code === "EEXIST")
          )
            throw error;
          const existing = await lstat(target);
          if (existing.isSymbolicLink() || !existing.isFile())
            throw new HttpError(400, "Staged destination must be a regular file");
          created = false;
        }
        if (created && options.processUid !== undefined && options.processGid !== undefined)
          await chown(target, options.processUid, options.processGid);
        operation.result = { bytes: created ? content.byteLength : 0, created };
        operation.status = "completed";
      } else if (operation.kind === "file.read") {
        const maximumBytes = number(body["maximumBytes"], "maximumBytes", 1, maximumOutputBytes);
        const target = await safePath(rootDirectory, String(body["path"] ?? ""), false);
        const stat = await lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes)
          throw new HttpError(400, "Expected a bounded regular file");
        const content = await readFile(target);
        operation.result = { contentBase64: content.toString("base64"), bytes: content.byteLength };
        operation.status = "completed";
      } else if (operation.kind === "process.start") {
        await startProcess(operation, access, body);
      } else if (operation.kind === "process.input.write") {
        const processId = String(body["processId"] ?? "");
        const runtime = ownedRunningProcess(processId, access);
        if (!runtime.streamInput)
          throw new HttpError(409, "Process was not started with streaming input");
        if (runtime.inputClosed) throw new HttpError(409, "Process input is closed");
        const content = base64(body["contentBase64"], "contentBase64", maximumOutputBytes);
        await queueProcessInput(runtime, () => writeProcessInput(runtime.child, content));
        operation.result = { bytes: content.byteLength };
        operation.status = "completed";
      } else if (operation.kind === "process.input.close") {
        const processId = String(body["processId"] ?? "");
        const runtime = ownedRunningProcess(processId, access);
        if (!runtime.streamInput)
          throw new HttpError(409, "Process was not started with streaming input");
        if (!runtime.inputClosed) {
          runtime.inputClosed = true;
          await queueProcessInput(runtime, () => closeProcessInput(runtime.child));
        }
        operation.result = { closed: true };
        operation.status = "completed";
      } else if (operation.kind === "process.signal") {
        const processId = String(body["processId"] ?? "");
        const runtime = processes.get(processId);
        const owner = Object.values(state.operations).find((item) => item.processId === processId);
        if (!owner || owner.accessId !== access.id)
          throw new HttpError(403, "Process belongs to another access");
        if (runtime) signalGroup(runtime.child.pid, String(body["signal"] ?? "SIGTERM"));
        operation.result = { signalled: Boolean(runtime) };
        operation.status = "completed";
      } else {
        throw new HttpError(400, "Unsupported environment operation");
      }
    } catch (error) {
      operation.status = "failed";
      operation.error = error instanceof Error ? error.message : String(error);
      operation.updatedAt = new Date().toISOString();
      await persist();
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, operation.error);
    }
    operation.updatedAt = new Date().toISOString();
    await persist();
  }

  async function startProcess(
    operation: OperationRecord,
    access: AccessRecord,
    body: Record<string, unknown>,
  ): Promise<void> {
    const command = String(body["command"] ?? "");
    if (!command) throw new HttpError(400, "Process command required");
    if (body["streamInput"] !== undefined && typeof body["streamInput"] !== "boolean")
      throw new HttpError(400, "streamInput must be boolean");
    const streamInput = body["streamInput"] === true;
    if (body["stdin"] !== undefined && typeof body["stdin"] !== "string")
      throw new HttpError(400, "stdin must be a string");
    if (streamInput && body["stdin"] !== undefined)
      throw new HttpError(400, "Choose streamInput or stdin, not both");
    const timeoutMs =
      body["timeoutMs"] === undefined
        ? undefined
        : number(body["timeoutMs"], "timeoutMs", 1, 24 * 60 * 60 * 1000);
    const args = arrayOfStrings(body["args"]);
    const cwd = await safePath(rootDirectory, String(body["cwd"] ?? rootDirectory), false);
    if (closing || access.revokedAt || Date.parse(access.expiresAt) <= Date.now())
      throw new HttpError(409, "Execution access is no longer active");
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { ...safeProcessEnvironment(rootDirectory), ...stringRecord(body["environment"]) },
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.processUid === undefined
        ? {}
        : { uid: options.processUid, gid: options.processGid }),
    });
    child.stdin?.on("error", () => {});
    const processId = randomUUID();
    const runtime: RuntimeProcess = {
      child,
      accessId: access.id,
      operationId: operation.id,
      streamInput,
      inputClosed: !streamInput,
      inputTail: Promise.resolve(),
      stdout: "",
      stderr: "",
      outputBytes: 0,
      outputLimitExceeded: false,
      decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
    };
    processes.set(processId, runtime);
    operation.processId = processId;
    operation.status = "running";
    operation.chunks = [];
    operation.updatedAt = new Date().toISOString();
    // Register output and completion listeners before any asynchronous persistence.
    // Short commands can exit while the state write is still in flight.
    const append = (stream: "stdout" | "stderr", bytes: Buffer, final = false) => {
      if (runtime.outputLimitExceeded) return;
      // Decode across chunk boundaries and bound retained UTF-8, including replacement characters.
      const decoded = final
        ? runtime.decoders[stream].end(bytes)
        : runtime.decoders[stream].write(bytes);
      const encoded = Buffer.from(decoded, "utf8");
      const remaining = Math.max(0, maximumOutputBytes - runtime.outputBytes);
      const accepted = encoded.subarray(0, remaining);
      const text = new StringDecoder("utf8").write(accepted);
      runtime.outputBytes += Buffer.byteLength(text);
      runtime[stream] += text;
      if (text)
        operation.chunks?.push({ sequence: (operation.chunks?.length ?? 0) + 1, stream, text });
      if (accepted.byteLength < encoded.byteLength) {
        runtime.outputLimitExceeded = true;
        operation.error = "Process output exceeded bound";
        try {
          signalGroup(child.pid, "SIGKILL");
        } catch (error) {
          operation.error += `; process termination failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      operation.updatedAt = new Date().toISOString();
      void persist();
    };
    child.stdout?.on("data", (bytes: Buffer) => append("stdout", bytes));
    child.stderr?.on("data", (bytes: Buffer) => append("stderr", bytes));
    child.stdout?.once("end", () => append("stdout", Buffer.alloc(0), true));
    child.stderr?.once("end", () => append("stderr", Buffer.alloc(0), true));
    child.once("error", (error) => finishProcess(processId, null, undefined, error.message));
    child.once("close", (code, signal) => finishProcess(processId, code, signal ?? undefined));
    if (typeof body["stdin"] === "string") child.stdin?.end(String(body["stdin"]));
    else if (!streamInput) child.stdin?.end();
    if (timeoutMs !== undefined) {
      runtime.timeout = setTimeout(() => {
        operation.error = "Process timed out";
        signalGroup(child.pid, "SIGTERM");
        setTimeout(() => signalGroup(child.pid, "SIGKILL"), 500).unref();
      }, timeoutMs);
      runtime.timeout.unref();
    }
    await persist();
  }

  function ownedRunningProcess(processId: string, access: AccessRecord): RuntimeProcess {
    const owner = Object.values(state.operations).find(
      (item) => item.processId === processId && item.kind === "process.start",
    );
    if (!owner) throw new HttpError(404, "Unknown process");
    if (owner.accessId !== access.id) throw new HttpError(403, "Process belongs to another access");
    const runtime = processes.get(processId);
    if (!runtime) throw new HttpError(409, "Process is not running");
    if (runtime.accessId !== access.id)
      throw new HttpError(500, "Process ownership state is inconsistent");
    return runtime;
  }

  function finishProcess(
    processId: string,
    exitCode: number | null,
    signal?: NodeJS.Signals,
    error?: string,
  ): void {
    const runtime = processes.get(processId);
    if (!runtime) return;
    processes.delete(processId);
    if (runtime.timeout) clearTimeout(runtime.timeout);
    const operation = state.operations[runtime.operationId];
    if (!operation) return;
    const result: ProcessResult = {
      exitCode,
      ...(signal ? { signal } : {}),
      stdout: runtime.stdout,
      stderr: runtime.stderr,
    };
    operation.result = result;
    operation.status = operation.error || error ? "failed" : "completed";
    if (operation.error === undefined && error !== undefined) operation.error = error;
    operation.updatedAt = new Date().toISOString();
    void persist();
  }

  async function revoke(access: AccessRecord, reason: string): Promise<void> {
    if (!access.revokedAt) access.revokedAt = new Date().toISOString();
    for (const runtime of processes.values()) {
      if (runtime.accessId === access.id && !runtime.releaseRequested) {
        const operation = state.operations[runtime.operationId];
        if (operation) operation.error = `Environment access ${reason}`;
        signalGroup(runtime.child.pid, "SIGTERM");
        runtime.releaseRequested = true;
        setTimeout(() => signalGroup(runtime.child.pid, "SIGKILL"), 500).unref();
      }
    }
    await persist();
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Shared execution server has no port");
  return {
    dispatch,
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    environmentId: state.environmentId,
    incarnationId: state.incarnationId,
    close: async () => {
      closing = true;
      const completions = [...processes.values()].map(
        (runtime) =>
          new Promise<void>((resolveClose) => {
            runtime.child.once("close", () => resolveClose());
            signalGroup(runtime.child.pid, "SIGKILL");
          }),
      );
      await Promise.allSettled([...operationExecutions.values(), ...completions]);
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await saveTail;
    },
  };
}

function reply(status: number, body: object): SharedExecutionResponse {
  return { status, body: body as Record<string, unknown> };
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function loadState(
  path: string,
  environmentId: string,
  incarnationId?: string,
): Promise<DurableState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DurableState;
    if (parsed.version !== 1 || parsed.environmentId !== environmentId)
      throw new Error("Shared execution state does not match configured environment");
    if (incarnationId !== undefined) parsed.incarnationId = incarnationId;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: 1,
      environmentId,
      incarnationId: incarnationId ?? randomUUID(),
      accesses: {},
      operations: {},
    };
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "Request body exceeds limit");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "JSON object required");
  return value as Record<string, unknown>;
}

function requireAdmin(request: Pick<SharedExecutionRequest, "headers">, expected: string): void {
  if (!safeEqual(bearer(request), expected)) throw new HttpError(401, "Invalid admin token");
}

function bearer(request: Pick<SharedExecutionRequest, "headers">): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new HttpError(401, "Bearer token required");
  return value.slice(7);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function safePath(root: string, value: string, allowMissing: boolean): Promise<string> {
  const target = resolve(root, isAbsolute(value) ? relative(root, value) : value);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new HttpError(400, "Path escapes environment root");
  await assertNoSymlink(root, allowMissing ? dirname(target) : target);
  if (!allowMissing) {
    const resolved = await realpath(target);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
      throw new HttpError(400, "Path resolves outside environment root");
  }
  return target;
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new HttpError(400, "Symbolic links are denied");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function queueProcessInput(
  runtime: RuntimeProcess,
  operation: () => Promise<void>,
): Promise<void> {
  const pending = runtime.inputTail.then(operation);
  runtime.inputTail = pending.catch(() => undefined);
  await pending;
}

function writeProcessInput(child: ChildProcess, content: Buffer): Promise<void> {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable)
    return Promise.reject(new HttpError(409, "Process input is unavailable"));
  return new Promise<void>((resolveWrite, rejectWrite) => {
    stdin.write(content, (error) => {
      if (error) rejectWrite(new HttpError(409, "Process input write failed"));
      else resolveWrite();
    });
  });
}

function closeProcessInput(child: ChildProcess): Promise<void> {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable)
    return Promise.reject(new HttpError(409, "Process input is unavailable"));
  return new Promise<void>((resolveClose, rejectClose) => {
    stdin.end((error?: Error | null) => {
      if (error) rejectClose(new HttpError(409, "Process input close failed"));
      else resolveClose();
    });
  });
}

function signalGroup(pid: number | undefined, signal: string): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal as NodeJS.Signals);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function base64(value: unknown, name: string, maximumBytes: number): Buffer {
  if (typeof value !== "string") throw new HttpError(400, `${name} must be base64`);
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) throw new HttpError(400, `${name} must be base64`);
  if (content.byteLength > maximumBytes) throw new HttpError(413, "Process input exceeds limit");
  return content;
}

function arrayOfStrings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new HttpError(400, "Expected string array");
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Expected string record");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string"))
    throw new HttpError(400, "Expected string record");
  return Object.fromEntries(entries) as Record<string, string>;
}

function number(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new HttpError(400, `${name} is outside its allowed range`);
  return value;
}

function operationResponse(operation: OperationRecord) {
  return {
    operationId: operation.id,
    status: operation.status,
    ...(operation.processId ? { processId: operation.processId } : {}),
    ...(operation.result === undefined ? {} : { result: operation.result }),
    ...(operation.error === undefined ? {} : { error: operation.error }),
  };
}

function accessResponse(access: AccessRecord, environmentId: string, rootDirectory: string) {
  return {
    accessId: access.id,
    environmentId,
    incarnationId: access.incarnationId,
    expiresAt: access.expiresAt,
    rootDirectory,
  };
}

function safeProcessEnvironment(rootDirectory: string): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, HOME: rootDirectory, TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" };
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** Explicit standalone entry; importing or bundling the library never starts a listener. */
export async function runSharedExecutionServerFromEnvironment(): Promise<void> {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const processUid = optionalInteger("SUPERTAG_SHARED_EXECUTION_PROCESS_UID");
  const processGid = optionalInteger("SUPERTAG_SHARED_EXECUTION_PROCESS_GID");
  const running = await startSharedExecutionServer({
    rootDirectory: process.env["SUPERTAG_SHARED_EXECUTION_ROOT"] ?? "/data",
    statePath: process.env["SUPERTAG_SHARED_EXECUTION_STATE"] ?? "/state/state.json",
    environmentId: process.env["SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID"] ?? "shared",
    ...(process.env["SUPERTAG_SHARED_EXECUTION_INCARNATION_ID"]
      ? { incarnationId: process.env["SUPERTAG_SHARED_EXECUTION_INCARNATION_ID"] }
      : {}),
    adminToken: required("SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"),
    host: process.env["SUPERTAG_SHARED_EXECUTION_HOST"] ?? "0.0.0.0",
    port: Number(process.env["SUPERTAG_SHARED_EXECUTION_PORT"] ?? "8787"),
    maximumConcurrentProcesses: Number(
      process.env["SUPERTAG_SHARED_EXECUTION_MAX_PROCESSES"] ?? "8",
    ),
    ...(processUid === undefined ? {} : { processUid }),
    ...(processGid === undefined ? {} : { processGid }),
  });
  process.stdout.write(`${JSON.stringify({ type: "ready", ...running })}\n`);
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : Number(value);
}
