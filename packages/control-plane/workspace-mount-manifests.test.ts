import { mountManifestDigest } from "@supertag/core";
import type { TaskAttemptEvent } from "@supertag/worker-sdk";
import { expect, it } from "vitest";
import {
  workspaceLiveMounts,
  workspaceMountManifests,
  workspaceMountOutputFailure,
  workspaceMountOutputManifests,
} from "./src/workspace-mount-manifests.js";

const source = "s3://datasets/prefix/";
const objects = [{ key: "a.csv", size: 1024, etag: '"abc"' }];
const manifest = {
  volume: "datasets",
  source,
  path: "/mnt/datasets",
  strategy: "copy",
  access: "read-only",
  objectCount: 1,
  totalBytes: 1024,
  digest: mountManifestDigest(source, objects),
  copiedAt: "2026-10-04T00:00:00.000Z",
  objects,
};
const event = (mounts: unknown) =>
  ({
    type: "workspace.mounts.copied",
    taskId: "task",
    attemptId: "attempt",
    at: "2026-10-04T00:00:00.000Z",
    mounts,
  }) as unknown as TaskAttemptEvent;

it("returns the manifests a copied-mounts event reports", () => {
  expect(workspaceMountManifests(event([manifest]))).toEqual([manifest]);
});

it("records nothing for other events or manifests that fail validation", () => {
  expect(
    workspaceMountManifests({
      type: "workspace.mcp.resolved",
      taskId: "task",
      attemptId: "attempt",
      at: "2026-10-04T00:00:00.000Z",
      digest: `sha256:${"a".repeat(64)}`,
    }),
  ).toBeUndefined();
  expect(
    workspaceMountManifests(event([{ ...manifest, digest: `sha256:${"0".repeat(64)}` }])),
  ).toBeUndefined();
  expect(workspaceMountManifests(event("not-an-array"))).toBeUndefined();
});

it("separates live attachment evidence and refuses invalid raw events before journaling", () => {
  const live = {
    volume: "datasets",
    source,
    prefix: "prefix/",
    path: "/mnt/datasets",
    strategy: "mount",
    access: "read-only",
    attachedAt: "2026-10-06T14:00:00.000Z",
  };
  const attached = (mounts: unknown) =>
    ({ ...event(mounts), type: "workspace.mounts.attached" }) as TaskAttemptEvent;
  expect(workspaceLiveMounts(attached([live]))).toEqual([live]);
  expect(workspaceLiveMounts(attached([{ ...live, access: "read-write" }]))).toEqual([
    { ...live, access: "read-write" },
  ]);
  expect(workspaceMountManifests(attached([live]))).toBeUndefined();
  expect(workspaceLiveMounts(event([manifest]))).toBeUndefined();
  expect(() => workspaceLiveMounts(attached([{ ...live, credential: "secret" }]))).toThrow();
  expect(() => workspaceLiveMounts(attached([manifest]))).toThrow();
});

it("extracts output evidence and a failure reason naming its mount and failed key", () => {
  const output = {
    volume: "datasets",
    source,
    path: "/mnt/datasets",
    status: "partial",
    uploadedAt: "2026-10-07T00:00:00Z",
    objects: [],
    skipped: 0,
    error: { key: "bad.csv", reason: "upload failed" },
    notAttempted: ["bad.csv"],
  };
  const written = { ...event([output]), type: "workspace.mounts.written" } as TaskAttemptEvent;
  expect(workspaceMountOutputManifests(written)).toEqual([output]);
  expect(workspaceMountOutputFailure([written])).toMatch(/datasets.*bad.csv.*upload failed/u);
});
