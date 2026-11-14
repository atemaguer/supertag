import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  SessionCheckpointSchema,
  SharedExecutionAccessSummarySchema,
  TaskSchema,
  WorkspaceSpecSchema,
} from "@supertag/worker-sdk/internal/rust-harness";
import { describe, expect, it } from "vitest";
import type { PortableCursorSessionState } from "./src/portable-session-state.js";
import { createCheckpoint, restoreCheckpoint } from "./src/rust-adapter/checkpoint.js";

const task = create(TaskSchema, {
  tagId: "tag",
  sessionId: "session",
  workspace: { workspaceId: "checkout", baseCommit: "initial" },
});
const portable: PortableCursorSessionState = {
  version: 1,
  agentId: "agent-example",
  files: [
    {
      name: "agents.ndjson",
      text: '{"agentId":"agent-example","cwd":"/previous/checkout"}\n',
    },
    { name: "runs.ndjson", text: "" },
    { name: "run_events.ndjson", text: "" },
    { name: "checkpoints.ndjson", text: "" },
  ],
};
const checkpoint = create(SessionCheckpointSchema, createCheckpoint(task, portable));

describe("Cursor checkpoints in the Rust runtime", () => {
  it("resumes fixed-root state only for the same provider incarnation", () => {
    const sharedTask = { ...task, workspace: undefined };
    const shared = create(SharedExecutionAccessSummarySchema, {
      environmentId: "shared",
      incarnationId: "00000000-0000-4000-8000-000000000001",
    });
    const saved = create(
      SessionCheckpointSchema,
      createCheckpoint(sharedTask, portable, "remote", shared),
    );
    expect(restoreCheckpoint(saved, sharedTask, "remote", shared)).toEqual(portable);
    expect(
      restoreCheckpoint(saved, sharedTask, "remote", {
        ...shared,
        incarnationId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toBeUndefined();
    expect(restoreCheckpoint(saved, sharedTask, "remote")).toBeUndefined();
  });

  it("resumes the authorized Workspace across checkouts and uses replay when the Workspace changes", () => {
    expect(
      restoreCheckpoint(checkpoint, {
        ...task,
        workspace: create(WorkspaceSpecSchema, { workspaceId: "checkout", baseCommit: "later" }),
      }),
    ).toEqual(portable);
    expect(
      restoreCheckpoint(checkpoint, {
        ...task,
        workspace: create(WorkspaceSpecSchema, { workspaceId: "another" }),
      }),
    ).toBeUndefined();
    expect(restoreCheckpoint({ ...checkpoint, harness: "claude-code" }, task)).toBeUndefined();
  });

  it("refuses corruption, a foreign Tag or Session, and mismatched execution mode", () => {
    expect(() => restoreCheckpoint({ ...checkpoint, sha256: "bad" }, task)).toThrow(
      "Incompatible or damaged Cursor checkpoint",
    );
    for (const scope of [{ tagId: "another" }, { sessionId: "another" }])
      expect(() => restoreCheckpoint(checkpoint, { ...task, ...scope })).toThrow(
        "Cursor checkpoint belongs to another",
      );
    const payload = Buffer.from(
      JSON.stringify({ tagId: task.tagId, sessionId: task.sessionId, mode: "remote", portable }),
    );
    const forged = {
      ...checkpoint,
      payload,
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
    expect(() => restoreCheckpoint(forged, task)).toThrow("Cursor checkpoint belongs to another");
  });
});
