import { expect, it } from "vitest";
import type { TaskEvent } from "../core/src/index.js";
import { deliveredCommitsResult, drainDeliveryEvidence } from "./src/delivered-commits.js";
import { workspaceMountOutputFailure } from "./src/workspace-mount-manifests.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const progress = (head: string, attemptId = "current"): TaskEvent => ({
  id: `event-${head}`,
  taskId: "task",
  attemptId,
  sequence: 1,
  type: "progress.updated",
  payload: {
    type: "progress.updated",
    progress: {
      summary: "Committed workspace app changes to supertag/o/t",
      items: [
        { id: "workspace-branch", text: "Branch: supertag/o/t", status: "completed" },
        { id: "workspace-base", text: `Base: ${BASE}`, status: "completed" },
        { id: "workspace-head", text: `Head: ${head}`, status: "completed" },
        { id: "workspace-changed-files", text: "Changed files: 3", status: "completed" },
      ],
    },
  },
  createdAt: new Date().toISOString(),
});

it("records commits a failed Attempt delivered to its Task branch", () => {
  const fallback = { error: "Execution timed out" };
  expect(deliveredCommitsResult([progress(HEAD)], "current", fallback)).toEqual({
    ...fallback,
    deliveredCommits: {
      attemptId: "current",
      branch: "supertag/o/t",
      base: BASE,
      head: HEAD,
      changedFiles: 3,
    },
  });
});

it("keeps the delivered git commit in a failed partial-upload result", () => {
  const mounts = [
    {
      volume: "data",
      source: "file:///data",
      path: "/mnt/data",
      status: "partial" as const,
      uploadedAt: "2026-10-07T00:00:00Z",
      objects: [{ key: "first", size: 1, sha256: `sha256:${"a".repeat(64)}` }],
      skipped: 0,
      error: { key: "second", reason: "upload failed" },
      notAttempted: ["second"],
    },
  ];
  const failure = workspaceMountOutputFailure([
    {
      type: "workspace.mounts.written",
      taskId: "task",
      attemptId: "current",
      at: "2026-10-07T00:00:00Z",
      mounts,
    },
  ]);
  expect(failure).toMatch(/data.*second.*upload failed/u);
  expect(deliveredCommitsResult([progress(HEAD)], "current", { error: failure })).toMatchObject({
    error: failure,
    deliveredCommits: { head: HEAD },
  });
});

it("leaves a failure without new commits, or from another Attempt, unchanged", () => {
  const fallback = { error: "Execution timed out" };
  expect(deliveredCommitsResult([progress(BASE)], "current", fallback)).toBe(fallback);
  expect(deliveredCommitsResult([progress(HEAD, "old")], "current", fallback)).toBe(fallback);
  expect(deliveredCommitsResult([], "current", fallback)).toBe(fallback);
});

it("keeps commits an earlier record proved when a later record shows none", () => {
  const fallback = { error: "Execution timed out" };
  expect(
    deliveredCommitsResult([progress(HEAD), progress(BASE)], "current", fallback),
  ).toMatchObject({ deliveredCommits: { head: HEAD } });
});

it("recovers delivery progress an aborted observer never persisted", async () => {
  // The observer's signal aborted before the Worker journaled its failure-cleanup commit.
  const observer = new AbortController();
  observer.abort();
  const journal = [
    { sequence: 1, event: { type: "execution.started", taskId: "task", attemptId: "current" } },
    { sequence: 2, event: { ...progress(HEAD).payload, taskId: "task", attemptId: "current" } },
    { sequence: 3, event: { type: "execution.failed", taskId: "task", attemptId: "current" } },
  ];
  const durable = {
    async *events(attemptId: string, after = 0, signal?: AbortSignal) {
      expect(attemptId).toBe("current");
      expect(signal?.aborted).toBe(false);
      for (const entry of journal) if (entry.sequence > after) yield entry as never;
    },
  };
  const persisted: TaskEvent[] = [];
  const fallback = { error: "Execution authority cancelled" };
  expect(deliveredCommitsResult(persisted, "current", fallback)).toEqual(fallback);
  const evidence = await drainDeliveryEvidence(durable, "current");
  expect(deliveredCommitsResult([...persisted, ...evidence], "current", fallback)).toEqual({
    ...fallback,
    deliveredCommits: {
      attemptId: "current",
      branch: "supertag/o/t",
      base: BASE,
      head: HEAD,
      changedFiles: 3,
    },
  });
});

it("settles with what it read when the journal is unavailable", async () => {
  const durable = {
    // biome-ignore lint/correctness/useYield: the journal fails before yielding
    async *events(): AsyncIterable<never> {
      throw new Error("Worker Host disconnected");
    },
  };
  await expect(drainDeliveryEvidence(durable, "current")).resolves.toEqual([]);
});
