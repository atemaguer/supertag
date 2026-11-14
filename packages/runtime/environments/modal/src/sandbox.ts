import {
  listSandboxOutputFiles,
  materializeSandboxArtifactFiles,
  type ProcessOutputChunk,
  type ProcessResult,
  prepareSandboxOutputDirectory,
  type SandboxInstance,
} from "@supertag/worker-sdk";
import { FILE_HELPER } from "./files.js";
import { HTTP_HELPER } from "./http.js";
import type { ModalSandboxClient } from "./index.js";

export function adaptModal(sandbox: ModalSandboxClient): SandboxInstance {
  let termination: Promise<boolean> | undefined;
  const terminate = () =>
    (termination ??= sandbox
      .terminate({ wait: true })
      .then(() => true)
      .catch((error) => {
        termination = undefined;
        throw error;
      }));
  async function file(
    operation: string,
    path: string,
    maximumBytes: number,
    input?: Uint8Array,
    mode?: number,
  ): Promise<Uint8Array> {
    const process = await sandbox.exec(
      ["python3", "-c", FILE_HELPER, operation, path, String(maximumBytes), String(mode ?? 0o600)],
      { mode: "binary", timeoutMs: 30_000 },
    );
    const output = collect(process.stdout, maximumBytes);
    const errors = collect(process.stderr, 8192);
    // Attach failure handlers while stdin is being sent to avoid unhandled rejections.
    const completion = Promise.all([output, errors, process.wait()]);
    void completion.catch(() => {});
    if (input) await process.stdin.writeBytes(input);
    await process.stdin.close();
    const [bytes, , exitCode] = await completion;
    if (exitCode !== 0)
      throw new Error(`Modal ${operation} failed for a bounded, non-symlink file path`);
    return bytes;
  }
  const instance: SandboxInstance = {
    id: sandbox.sandboxId,
    ...(sandbox.nativeMountSymlinkTargets === undefined
      ? {}
      : { nativeMountSymlinkTargets: sandbox.nativeMountSymlinkTargets }),
    prepareOutputDirectory: (root, path) => prepareSandboxOutputDirectory(instance, root, path),
    listOutputFiles: (root, query) => listSandboxOutputFiles(instance, root, query),
    materializeArtifactFiles: (input) => materializeSandboxArtifactFiles(instance, input),
    async requestHttp(port, request, limits, signal) {
      signal.throwIfAborted();
      const process = await sandbox.exec(["python3", "-c", HTTP_HELPER], {
        mode: "binary",
        timeoutMs: limits.timeoutMs,
      });
      const completion = Promise.all([
        collect(process.stdout, 4 * Math.ceil(limits.maxResponseBytes / 3) + 65536),
        collect(process.stderr, 8192),
        process.wait(),
      ]);
      void completion.catch(() => {});
      await process.stdin.writeBytes(
        new TextEncoder().encode(
          JSON.stringify({
            port,
            ...limits,
            path: request.path,
            ...(request.method ? { method: request.method } : {}),
            ...(request.headers ? { headers: request.headers } : {}),
            body: request.body ? Buffer.from(request.body).toString("base64") : "",
          }),
        ),
      );
      await process.stdin.close();
      const [output, , exitCode] = await completion;
      if (exitCode !== 0) throw new Error("Modal scoped HTTP request failed");
      const response = JSON.parse(new TextDecoder().decode(output)) as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      return {
        status: response.status,
        headers: response.headers,
        body: new Uint8Array(Buffer.from(response.body, "base64")),
      };
    },
    mkdir: async (path) => {
      await file("mkdir", path, 0);
    },
    write: async (path, bytes, options) => {
      if (!options.exclusive) throw new Error("Modal staging requires exclusive writes");
      await file("write", path, 0, bytes, options.mode);
    },
    read: (path, options) => file("read", path, options.maximumBytes),
    makeReadOnly: async (path) => {
      await file("readonly", path, 0);
    },
    async start(spec, options) {
      options.signal?.throwIfAborted();
      if (spec.streamInput && spec.stdin !== undefined)
        throw new Error("Choose streamInput or stdin, not both");
      const process = await sandbox.exec([spec.command, ...(spec.args ?? [])], {
        mode: "binary",
        ...(spec.cwd ? { workdir: spec.cwd } : {}),
        ...(spec.environment ? { env: { ...spec.environment } } : {}),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      });
      const stdout = forward(process.stdout, "stdout", options.onOutput);
      const stderr = forward(process.stderr, "stderr", options.onOutput);
      const completion: Promise<ProcessResult> = Promise.all([stdout, stderr, process.wait()]).then(
        ([out, err, exitCode]) => ({ exitCode, stdout: out, stderr: err }),
      );
      void completion.catch(() => {});
      if (spec.stdin !== undefined)
        await process.stdin.writeBytes(new TextEncoder().encode(spec.stdin));
      if (!spec.streamInput) await process.stdin.close();
      return {
        wait: () => completion,
        terminate,
        ...(spec.streamInput
          ? {
              write: (bytes: Uint8Array) => process.stdin.writeBytes(bytes),
              endInput: () => process.stdin.close(),
            }
          : {}),
      };
    },
    terminate,
  };
  return instance;
}
export async function collect(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("Modal file transport exceeded its byte bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
async function forward(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  emit: (chunk: ProcessOutputChunk) => void | Promise<void>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const push = async (text: string) => {
    if (!text) return;
    tail = (tail + text).slice(-32000);
    // Modal output streams are pull-based: not reading propagates backpressure to the sandbox.
    await emit({ stream: name, text });
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await push(decoder.decode(value, { stream: true }));
    }
    await push(decoder.decode());
    return tail;
  } finally {
    reader.releaseLock();
  }
}
