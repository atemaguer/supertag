import { createHash } from "node:crypto";
import type {
  SessionCheckpoint,
  SharedExecutionAccessSummary,
  Task,
} from "@supertag/worker-sdk/internal/rust-harness";
import {
  type PortableCursorSessionState,
  validatePortableCursorSessionState,
} from "../portable-session-state.js";

const FORMAT = "cursor-sdk-v1";
const MAX_BYTES = 15 * 1024 * 1024;

type WorkspaceMode = "local" | "remote";

function binding(task: Task, mode: WorkspaceMode, shared?: SharedExecutionAccessSummary) {
  return {
    tagId: task.tagId,
    sessionId: task.sessionId,
    workspaceId: task.workspace?.workspaceId ?? null,
    mode,
    sharedEnvironmentId: shared?.environmentId,
    sharedIncarnationId: shared?.incarnationId,
  };
}

function digest(payload: Uint8Array) {
  return createHash("sha256").update(payload).digest("hex");
}

export function restoreCheckpoint(
  checkpoint: SessionCheckpoint | undefined,
  task: Task,
  mode: WorkspaceMode = "local",
  shared?: SharedExecutionAccessSummary,
) {
  // A Session can move between harnesses. Only Cursor's own archive can be resumed.
  if (checkpoint?.harness !== "cursor") return undefined;
  if (
    checkpoint.format !== FORMAT ||
    checkpoint.payload.byteLength > MAX_BYTES ||
    digest(checkpoint.payload) !== checkpoint.sha256
  )
    throw new Error("Incompatible or damaged Cursor checkpoint");
  const saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(checkpoint.payload));
  const expected = binding(task, mode, shared);
  if (
    saved?.tagId !== expected.tagId ||
    saved?.sessionId !== expected.sessionId ||
    (saved?.mode !== "local" && saved?.mode !== "remote") ||
    (saved.workspaceId !== null && (typeof saved.workspaceId !== "string" || !saved.workspaceId))
  )
    throw new Error("Cursor checkpoint belongs to another Tag, Session, or execution mode");
  const portable = validatePortableCursorSessionState(saved.portable);
  return saved.workspaceId === expected.workspaceId &&
    saved.mode === mode &&
    saved.sharedEnvironmentId === expected.sharedEnvironmentId &&
    saved.sharedIncarnationId === expected.sharedIncarnationId
    ? portable
    : undefined;
}

export function createCheckpoint(
  task: Task,
  portable: PortableCursorSessionState,
  mode: WorkspaceMode = "local",
  shared?: SharedExecutionAccessSummary,
) {
  const payload = Buffer.from(JSON.stringify({ ...binding(task, mode, shared), portable }));
  if (payload.byteLength > MAX_BYTES) throw new Error("Cursor checkpoint exceeds its limit");
  return { harness: "cursor", format: FORMAT, payload, sha256: digest(payload) };
}
