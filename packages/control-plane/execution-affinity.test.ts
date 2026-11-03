import { emptyTagContextPlan } from "@supertag/core";
import {
  selectDescriptorExecution,
  type WorkerDescriptor,
  type Worklet,
} from "@supertag/worker-sdk";
import { expect, it } from "vitest";
import { ExecutionAffinityCache } from "./src/execution-affinity.js";

const a = { id: "a", revision: "1" },
  b = { id: "b", revision: "1" };
function fixture() {
  const loads = new Map<string, number>();
  const workers: WorkerDescriptor[] = [a, b].map((profile) => ({
    id: profile.id,
    type: "fixture",
    profiles: [profile],
    maxConcurrency: 2,
    capabilities: [{ id: "research", version: 1 }],
    contextTypes: [],
    profileCapabilities: [
      {
        profile,
        harness: profile.id === "a" ? "codex" : "opencode",
        capabilities: [{ id: "research", version: 1 }],
        contextTypes: [],
      },
    ],
  }));
  const worklet: Worklet = {
    id: "worklet",
    describe: async () => ({ id: "worklet", protocolVersion: 1, host: { id: "host", workers } }),
    selectExecution: async (requirements, context, options) =>
      selectDescriptorExecution(
        workers,
        requirements,
        context,
        options,
        (id) => loads.get(id) ?? 0,
      ),
    execute() {
      throw new Error("Selection must not execute work");
    },
  };
  return { worklet, loads, workers };
}
const plan = emptyTagContextPlan();
it("retains an eligible cached profile despite changing load, but replaces it when full", async () => {
  const f = fixture(),
    cache = new ExecutionAffinityCache();
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(a);
  f.loads.set("a", 1);
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(a);
  expect((await cache.select(f.worklet, "other-tag", {}, plan))?.workerProfile).toEqual(b);
  f.loads.set("a", 2);
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(b);
  f.loads.set("a", 0);
  f.loads.set("b", 1);
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(b);
});
it("separates requirements and rechecks continuity, context, and withdrawn profiles", async () => {
  const f = fixture(),
    cache = new ExecutionAffinityCache();
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(a);
  expect(
    (await cache.select(f.worklet, "tag", { harness: "opencode" }, plan))?.workerProfile,
  ).toEqual(b);
  f.loads.set("b", 2);
  expect(await cache.select(f.worklet, "tag", {}, plan, { compatibleProfile: b })).toBeUndefined();
  f.loads.set("b", 0);
  expect(
    (await cache.select(f.worklet, "tag", {}, plan, { compatibleProfile: b }))?.workerProfile,
  ).toEqual(b);
  expect(
    await cache.select(
      f.worklet,
      "tag",
      {},
      {
        version: 7,
        capturedAt: "now",
        sets: [
          {
            id: "set",
            name: "Required",
            items: [
              {
                id: "item",
                itemKey: "key",
                type: "unsupported",
                version: 1,
                required: true,
                config: {},
              },
            ],
          },
        ],
      },
    ),
  ).toBeUndefined();
  await cache.select(f.worklet, "tag", {}, plan, { compatibleProfile: b });
  f.workers.splice(1, 1);
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(a);
  expect(
    await cache.select(f.worklet, "tag", { requires: [{ id: "unknown", version: 1 }] }, plan),
  ).toBeUndefined();
});
it("expires entries and evicts the least recently used selection", async () => {
  let time = 0;
  const f = fixture(),
    cache = new ExecutionAffinityCache(2, 100, () => time);
  await cache.select(f.worklet, "first", {}, plan);
  await cache.select(f.worklet, "second", {}, plan);
  f.loads.set("a", 1);
  expect((await cache.select(f.worklet, "first", {}, plan))?.workerProfile).toEqual(a);
  await cache.select(f.worklet, "third", {}, plan);
  expect((await cache.select(f.worklet, "second", {}, plan))?.workerProfile).toEqual(b);
  time = 100;
  expect((await cache.select(f.worklet, "first", {}, plan))?.workerProfile).toEqual(b);
  expect(
    (await new ExecutionAffinityCache().select(f.worklet, "first", {}, plan))?.workerProfile,
  ).toEqual(b);
});

it("expires a recently reused hint without extending its lifetime", async () => {
  let time = 0;
  const f = fixture(),
    cache = new ExecutionAffinityCache(2, 100, () => time);
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(a);
  f.loads.set("a", 1);
  time = 99;
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(a);
  time = 100;
  expect((await cache.select(f.worklet, "tag", {}, plan))?.workerProfile).toEqual(b);
});
