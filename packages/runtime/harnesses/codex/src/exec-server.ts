import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  ExecutionCleanupError,
  type ExecutionEnvironment,
  type ProcessHandle,
} from "@supertag/worker-sdk";
import { WebSocket, WebSocketServer } from "ws";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_CHARACTERS = 8_000;
const EXEC_SERVER_SHUTDOWN_GRACE_MS = 5_000;

export interface CodexExecServerBridgeOptions {
  readonly environment: ExecutionEnvironment;
  readonly command: string;
  readonly expectedVersion: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly scratchDirectory?: string;
}

export interface CodexExecServerBridge {
  readonly environmentId: string;
  readonly url: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  /** Mark the app-server connection as intentionally closing before its process is stopped. */
  expectClose(): void;
  close(): Promise<void>;
}

/**
 * Exposes one environment-owned Codex exec-server to one local app-server.
 * The bridge only translates WebSocket message framing to the exec-server's
 * JSONL stdio transport; filesystem and process semantics stay provider-owned.
 */
export async function startCodexExecServerBridge(
  options: CodexExecServerBridgeOptions,
): Promise<CodexExecServerBridge> {
  options.signal?.throwIfAborted();
  const observedVersion = await codexVersion(
    options.environment,
    options.command,
    options.timeoutMs,
    options.signal,
  );
  if (observedVersion !== options.expectedVersion)
    throw new Error(
      `Codex exec-server version ${observedVersion} does not match app-server ${options.expectedVersion}`,
    );

  const process = await options.environment.spawn(
    {
      command: options.command,
      args: ["exec-server", "--listen", "stdio://"],
      cwd: options.environment.rootDirectory,
      environment: options.scratchDirectory
        ? { SUPERTAG_SCRATCH_DIR: options.scratchDirectory }
        : {},
      replaceEnvironment: true,
      streamInput: true,
      streamOutput: true,
      timeoutMs: options.timeoutMs,
    },
    options.signal,
  );
  if (!process.output || !process.write || !process.endInput) {
    process.kill();
    await process.wait().catch(() => undefined);
    throw new Error("Codex exec-server requires environment-owned streaming input and output");
  }

  const token = randomBytes(32).toString("base64url");
  const path = `/codex-exec/${token}`;
  const server = createServer((_, response) => {
    response.writeHead(404).end();
  });
  const sockets = new Set<WebSocket>();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let accepted = false;
  let closing = false;
  let closed = false;
  let failure: Error | undefined;
  let diagnostics = "";
  let stdout = "";
  let initializeId: string | number | undefined;
  let writeChain = Promise.resolve();
  let active: WebSocket | undefined;

  const fail = (error: unknown) => {
    if (closing) return;
    failure ??= error instanceof Error ? error : new Error("Codex exec-server bridge failed");
    for (const socket of sockets) socket.close(1011, "Codex execution environment disconnected");
  };
  server.on("upgrade", (request, socket, head) => {
    if (closing || closed || accepted || request.url !== path) {
      socket.destroy();
      return;
    }
    accepted = true;
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.add(webSocket);
      active = webSocket;
      webSocket.on("message", (data, binary) => {
        if (binary) {
          fail(new Error("Codex exec-server bridge rejects binary WebSocket frames"));
          return;
        }
        const frame = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        if (frame.byteLength > MAX_FRAME_BYTES || frame.includes(0x0a)) {
          fail(new Error("Codex exec-server bridge received an invalid JSON-RPC frame"));
          return;
        }
        try {
          const message = JSON.parse(frame.toString("utf8")) as Record<string, unknown>;
          if (message["method"] === "initialize") {
            if (initializeId !== undefined)
              throw new Error("Codex exec-server received duplicate initialization");
            if (typeof message["id"] !== "string" && typeof message["id"] !== "number")
              throw new Error("Codex exec-server initialization has no identity");
            initializeId = message["id"];
          }
        } catch (error) {
          fail(error);
          return;
        }
        writeChain = writeChain
          .then(() => process.write?.(Buffer.concat([frame, Buffer.from("\n")])))
          .then(() => undefined)
          .catch(fail);
      });
      webSocket.on("error", fail);
      webSocket.on("close", () => {
        sockets.delete(webSocket);
        if (!closing) fail(new Error("Codex app-server disconnected from its exec-server"));
      });
    });
  });
  server.on("error", fail);

  const outputDone = pumpOutput(process, {
    stdout(text) {
      stdout += text;
      if (Buffer.byteLength(stdout) > MAX_FRAME_BYTES * 2) {
        fail(new Error("Codex exec-server emitted an oversized or unterminated frame"));
        return;
      }
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
          fail(new Error("Codex exec-server emitted an oversized JSON-RPC frame"));
          return;
        }
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message["id"] === initializeId) {
            const result =
              message["result"] && typeof message["result"] === "object"
                ? (message["result"] as Record<string, unknown>)
                : undefined;
            if (typeof result?.["sessionId"] !== "string" || !result["sessionId"])
              throw new Error("Codex exec-server did not report its session identity");
            provenance["execServerSessionId"] = result["sessionId"];
          }
        } catch (error) {
          fail(error);
          return;
        }
        if (!active || active.readyState !== WebSocket.OPEN) {
          fail(new Error("Codex exec-server emitted output before app-server connected"));
          return;
        }
        active.send(line, (error) => {
          if (error) fail(error);
        });
      }
    },
    stderr(text) {
      diagnostics = `${diagnostics}${text}`.slice(-MAX_DIAGNOSTIC_CHARACTERS);
    },
  }).then(() => {
    if (!closing) fail(new Error("Codex exec-server output closed unexpectedly"));
  }, fail);
  const processDone = process.wait().then(
    (result) => {
      if (!closing)
        fail(
          new Error(
            `Codex exec-server exited unexpectedly${result.exitCode === null ? "" : ` (${result.exitCode})`}${diagnostics ? `: ${diagnostics.trim()}` : ""}`,
          ),
        );
      return true;
    },
    (error: unknown) => {
      fail(error);
      return false;
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error("Codex execution cancelled"));
      options.signal?.addEventListener("abort", abort, { once: true });
      server.listen(0, "127.0.0.1", () => {
        options.signal?.removeEventListener("abort", abort);
        resolve();
      });
    });
  } catch (error) {
    closed = true;
    process.kill();
    await Promise.allSettled([processDone, outputDone]);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Codex bridge has no TCP address");
  const environmentId = `supertag-${randomUUID()}`;
  const provenance: Record<string, unknown> = {
    protocol: "codex-exec-server",
    protocolVersion: 1,
    environmentId,
    executionEnvironmentId: options.environment.id,
    execServerVersion: observedVersion,
    transport: "stdio-websocket-bridge",
  };

  return {
    environmentId,
    url: `ws://127.0.0.1:${address.port}${path}`,
    provenance,
    expectClose() {
      closing = true;
    },
    async close() {
      if (closed) {
        if (failure) throw failure;
        return;
      }
      closing = true;
      closed = true;
      for (const socket of sockets) socket.close(1000, "Execution complete");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeChain.catch(() => undefined);
      const finished = Promise.all([processDone, outputDone]).then(([exited]) => exited);
      // EOF shuts down Codex's stdio server. On some providers, kill() tears
      // down the entire sandbox, which is still needed for Workspace delivery.
      void process.endInput?.().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exited = await Promise.race([
          finished,
          new Promise<false>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              Math.min(EXEC_SERVER_SHUTDOWN_GRACE_MS, options.timeoutMs),
            );
          }),
        ]);
        if (!exited) {
          process.kill();
          if (!(await finished))
            throw new ExecutionCleanupError("Codex exec-server exit could not be confirmed");
        }
      } finally {
        clearTimeout(timer);
      }
      if (failure) throw failure;
    },
  };
}

async function codexVersion(
  environment: ExecutionEnvironment,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const process = await environment.spawn(
    {
      command,
      args: ["--version"],
      cwd: environment.rootDirectory,
      replaceEnvironment: true,
      timeoutMs: Math.min(10_000, timeoutMs),
    },
    signal,
  );
  const result = await process.wait();
  const match = /^codex-cli\s+(\S+)\s*$/u.exec(result.stdout.trim());
  if (result.exitCode !== 0 || !match?.[1])
    throw new Error("Could not verify Codex exec-server version");
  return match[1];
}

async function pumpOutput(
  process: ProcessHandle,
  consumer: { stdout(text: string): void; stderr(text: string): void },
): Promise<void> {
  if (!process.output) throw new Error("Codex exec-server output is unavailable");
  for await (const chunk of process.output) consumer[chunk.stream](chunk.text);
}
