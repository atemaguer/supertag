import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { spawnOwnedProcess } from "@supertag/worker-sdk/internal/rust-harness";
import type { OpenCodeCompletionPart } from "../index.js";

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
export const MAX_RESULT_BYTES = 262_144;
export const NATIVE_INSPECTION_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function verifiedCompletionParts(
  snapshot: string,
  sessionId: string,
): OpenCodeCompletionPart[] {
  const exported = record(JSON.parse(snapshot));
  const messages = exported?.["messages"];
  const last = Array.isArray(messages) ? record(messages.at(-1)) : undefined;
  const info = record(last?.["info"]);
  const messageId = info?.["id"];
  const completed = record(info?.["time"])?.["completed"];
  const parts = last?.["parts"];
  if (
    record(exported?.["info"])?.["id"] !== sessionId ||
    info?.["sessionID"] !== sessionId ||
    info["role"] !== "assistant" ||
    info["finish"] !== "stop" ||
    info["error"] !== undefined ||
    typeof completed !== "number" ||
    !Number.isSafeInteger(completed) ||
    completed <= 0 ||
    typeof messageId !== "string" ||
    !/^msg_[A-Za-z0-9]{1,120}$/u.test(messageId) ||
    !Array.isArray(parts)
  )
    throw new Error("OpenCode did not verify a completed native response");

  const textParts: OpenCodeCompletionPart[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  let nonempty = false;
  for (const value of parts) {
    const part = record(value);
    if (part?.["type"] !== "text") continue;
    const id = part["id"];
    const text = part["text"];
    if (
      part["sessionID"] !== sessionId ||
      part["messageID"] !== messageId ||
      typeof id !== "string" ||
      !/^prt_[A-Za-z0-9]{1,120}$/u.test(id) ||
      ids.has(id) ||
      typeof text !== "string"
    )
      throw new Error("OpenCode export contains an invalid response part");
    ids.add(id);
    bytes += Buffer.byteLength(text) + (textParts.length ? 1 : 0);
    if (bytes > MAX_RESULT_BYTES) throw new Error("OpenCode exported response exceeds its limit");
    textParts.push({ id, text });
    nonempty ||= Boolean(text.trim());
  }
  if (!nonempty) throw new Error("OpenCode export has no final text");
  return textParts;
}

/** Read exact Session evidence from disposable native state without invoking a provider. */
export async function exportOpenCodeCompletion(
  executable: string,
  scratch: string,
  privateEnvironment: Readonly<Record<string, string>>,
  sessionId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const cwd = await mkdtemp(join(scratch, "opencode-export-"));
  const process = await spawnOwnedProcess({
    spec: {
      command: executable,
      args: ["--pure", "export", sessionId],
      timeoutMs: NATIVE_INSPECTION_TIMEOUT_MS,
      streamOutput: true,
    },
    cwd,
    environment: {
      ...privateEnvironment,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    },
    signal,
    inheritProcessGroup: true,
    maximumOutput: 64,
    // The Rust guardian already owns the process group that includes this command.
    record: async () => {},
  });
  try {
    if (!process.output) throw new Error("OpenCode export requires process output streaming");
    const chunks: string[] = [];
    let bytes = 0;
    for await (const { stream, text } of process.output) {
      signal.throwIfAborted();
      if (stream !== "stdout") continue;
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_EXPORT_BYTES) throw new Error("OpenCode export exceeds its limit");
      chunks.push(text);
    }
    const status = await process.wait();
    signal.throwIfAborted();
    if (status.exitCode !== 0 || status.signal) throw new Error("OpenCode export failed");
    return verifiedCompletionParts(chunks.join(""), sessionId);
  } finally {
    process.kill();
    await process.wait();
  }
}
