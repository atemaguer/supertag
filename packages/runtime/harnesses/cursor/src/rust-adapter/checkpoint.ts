import { createHash } from "node:crypto";
import type { SessionCheckpoint, Task } from "@supertag/worker-sdk/internal/rust-harness";
import {
  type PortableCursorSessionState,
  validatePortableCursorSessionState,
} from "../portable-session-state.js";

const FORMAT = "cursor-sdk-v1";
const MAX_BYTES = 15 * 1024 * 1024;

function binding(task: Task) {
  return {
    tagId: task.tagId,
    sessionId: task.sessionId,
    workspaceId: task.workspace?.workspaceId ?? null,
    mode: "local",
  };
}

function digest(payload: Uint8Array) {
  return createHash("sha256").update(payload).digest("hex");
}

export function restoreCheckpoint(checkpoint: SessionCheckpoint | undefined, task: Task) {
  // A Session can move between harnesses. Only Cursor's own archive can be resumed.
  if (checkpoint?.harness !== "cursor") return undefined;
  if (
    checkpoint.format !== FORMAT ||
    checkpoint.payload.byteLength > MAX_BYTES ||
    digest(checkpoint.payload) !== checkpoint.sha256
  )
    throw new Error("Incompatible or damaged Cursor checkpoint");
  const saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(checkpoint.payload));
  const expected = binding(task);
  if (
    saved?.tagId !== expected.tagId ||
    saved?.sessionId !== expected.sessionId ||
    saved?.mode !== expected.mode ||
    (saved.workspaceId !== null && (typeof saved.workspaceId !== "string" || !saved.workspaceId))
  )
    throw new Error("Cursor checkpoint belongs to another Tag, Session, or execution mode");
  const portable = validatePortableCursorSessionState(saved.portable);
  return saved.workspaceId === expected.workspaceId ? portable : undefined;
}

export function createCheckpoint(task: Task, portable: PortableCursorSessionState) {
  const payload = Buffer.from(JSON.stringify({ ...binding(task), portable }));
  if (payload.byteLength > MAX_BYTES) throw new Error("Cursor checkpoint exceeds its limit");
  return { harness: "cursor", format: FORMAT, payload, sha256: digest(payload) };
}
