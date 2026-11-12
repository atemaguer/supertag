import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { type ClaudeTranscript, readClaudeTranscripts } from "../session-store.js";
import {
  type SessionCheckpoint,
  SessionCheckpointSchema,
  type Task,
} from "./gen/supertag/runtime/v2/runtime_pb.js";

const FORMAT = "claude-agent-sdk-v2";
const MAX_BYTES = 9 * 1024 * 1024;
type Binding = Pick<Task, "tagId" | "sessionId">;
interface Archive {
  version: 1;
  tagId: string;
  sessionId: string;
  nativeSessionId: string;
  transcripts: ClaudeTranscript[];
  totalCostUsd?: number;
}

export function redact(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets)
    if (secret.length >= 8) output = output.split(secret).join("[REDACTED]");
  return output;
}

function digest(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function archive(value: unknown, binding: Binding): Archive {
  if (!value || typeof value !== "object") throw new Error("Invalid Claude checkpoint");
  const item = value as Partial<Archive>;
  if (
    item.version !== 1 ||
    item.tagId !== binding.tagId ||
    item.sessionId !== binding.sessionId ||
    typeof item.nativeSessionId !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(item.nativeSessionId) ||
    (item.totalCostUsd !== undefined && !validUsd(item.totalCostUsd))
  )
    throw new Error("Claude checkpoint belongs to another Session or format");
  const transcripts = readClaudeTranscripts(item.transcripts);
  if (
    !transcripts?.some(
      (entry) =>
        entry.sessionId === item.nativeSessionId &&
        entry.subpath === undefined &&
        entry.entries.some((record) => record.type === "assistant"),
    )
  )
    throw new Error("Claude checkpoint has no complete native transcript");
  return {
    version: 1,
    tagId: binding.tagId,
    sessionId: binding.sessionId,
    nativeSessionId: item.nativeSessionId,
    transcripts,
    ...(item.totalCostUsd !== undefined ? { totalCostUsd: item.totalCostUsd } : {}),
  };
}

export function validUsd(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isSafeInteger(Math.round(value * 100))
  );
}

export function resumedCostUsd(checkpoint: Archive | undefined) {
  // Claude restores the most recent native cost-state for this Session. Its
  // result totals reset when the transcript carries no such record.
  const root = checkpoint?.transcripts.find(
    (entry) => entry.sessionId === checkpoint.nativeSessionId && entry.subpath === undefined,
  );
  const saved = root?.entries.findLast(
    (entry) => entry.type === "cost-state" && entry["sessionId"] === checkpoint?.nativeSessionId,
  );
  if (!saved) return 0;
  const baseline = saved["totalCostUSD"];
  if (
    !validUsd(baseline) ||
    (checkpoint?.totalCostUsd !== undefined && baseline > checkpoint.totalCostUsd)
  )
    throw new Error("Claude checkpoint has unverifiable native cost state");
  return baseline;
}

export function restoreCheckpoint(
  checkpoint: SessionCheckpoint | undefined,
  task: Binding,
  cwd: string,
) {
  if (!checkpoint) return undefined;
  if (
    checkpoint.harness !== "claude-code" ||
    checkpoint.format !== FORMAT ||
    checkpoint.payload.length > MAX_BYTES ||
    digest(checkpoint.payload) !== checkpoint.sha256
  )
    throw new Error("Incompatible or damaged Claude checkpoint; refusing a fresh-session fallback");
  const restored = archive(JSON.parse(Buffer.from(checkpoint.payload).toString("utf8")), task);
  // Only SDK-owned top-level cwd metadata moves. Conversation/tool contents remain verbatim.
  for (const transcript of restored.transcripts)
    for (const entry of transcript.entries)
      if (typeof entry["cwd"] === "string") entry["cwd"] = cwd;
  return restored;
}

export function captureCheckpoint(
  task: Binding,
  nativeSessionId: string,
  transcripts: readonly ClaudeTranscript[],
  secrets: readonly string[],
  totalCostUsd?: number,
) {
  const data = archive(
    {
      version: 1,
      tagId: task.tagId,
      sessionId: task.sessionId,
      nativeSessionId,
      transcripts,
      totalCostUsd,
    },
    task,
  );
  // Redact string values through JSON traversal, so quotes in a secret cannot corrupt the archive.
  const encoded = JSON.stringify(data, (_key, value: unknown) =>
    typeof value === "string" ? redact(value, secrets) : value,
  );
  const payload = Buffer.from(encoded);
  if (payload.length > MAX_BYTES) throw new Error("Claude checkpoint exceeds its portable limit");
  return create(SessionCheckpointSchema, {
    harness: "claude-code",
    format: FORMAT,
    payload,
    sha256: digest(payload),
  });
}
