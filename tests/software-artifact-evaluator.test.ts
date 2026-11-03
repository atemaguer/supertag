import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileArtifactStore } from "./support/file-artifact-store.js";
import { evaluateSchedulingArtifact } from "./support/software-artifact-evaluator.js";

it("rejects wrong scheduling code regardless of a passing review and verifies correct symmetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "software-evaluation-test-"));
  try {
    const store = new FileArtifactStore(directory);
    const lyingReview = { passed: true };
    const wrong = await store.put({
      bytes: Buffer.from("module.exports=(a,b)=>a.start<=b.end&&b.start<=a.end"),
      name: "schedule.cjs",
    });
    const rejected = await evaluateSchedulingArtifact(store, wrong);
    expect(lyingReview.passed).toBe(true);
    expect(rejected.passed).toBe(false);
    expect(rejected.checks.find((check) => check.name === "adjacent")?.passed).toBe(false);
    const correct = await store.put({
      bytes: Buffer.from("module.exports=(a,b)=>a.start<b.end&&b.start<a.end"),
      name: "schedule.cjs",
    });
    const accepted = await evaluateSchedulingArtifact(store, correct);
    expect(accepted.passed).toBe(true);
    expect(accepted.assertions).toBe(10);
    expect(accepted.checks).toHaveLength(5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
