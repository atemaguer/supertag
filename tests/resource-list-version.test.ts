import { expect, it } from "vitest";
import { resourceList } from "../apps/cli/src/control-plane-resources.ts";

it("invalidates list watches when a non-maximal item changes or disappears", () => {
  const item = (id: string, version: string) => ({
    metadata: { id, resourceVersion: version, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  });
  const original = resourceList([item("task-a", "aaa"), item("task-b", "zzz")]);
  const updated = resourceList([item("task-a", "bbb"), item("task-b", "zzz")]);
  const removed = resourceList([item("task-b", "zzz")]);
  expect(updated.metadata.resourceVersion).not.toBe(original.metadata.resourceVersion);
  expect(removed.metadata.resourceVersion).not.toBe(updated.metadata.resourceVersion);
  expect(resourceList([item("task-a", "aaa"), item("task-b", "zzz")])).toEqual(original);
});
