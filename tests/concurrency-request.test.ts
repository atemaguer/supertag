import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConcurrencyRequest,
  clearConcurrencyRequests,
  concurrencyRequestPending,
  finishConcurrencyRequest,
  hostSlot,
  type ProcessStatus,
  pendingConcurrencyRequests,
  slotDirectory,
  writeConcurrencyRequest,
} from "../apps/cli/src/local-state.ts";
import { findService, resolveServices, serviceFingerprint } from "../apps/cli/src/supertag-yaml.ts";
import { concurrencyChange } from "../apps/cli/src/up.ts";

describe("concurrency requests", () => {
  let directory: string;
  const previous = process.env["SUPERTAG_STATE_DIR"];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-concurrency-"));
    process.env["SUPERTAG_STATE_DIR"] = directory;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env["SUPERTAG_STATE_DIR"];
    else process.env["SUPERTAG_STATE_DIR"] = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const request = (concurrency: number): ConcurrencyRequest => ({
    concurrency,
    source: "file",
    configuration: `fingerprint-${concurrency}`,
    resolved: { concurrency },
  });

  it("keeps two requests written at once, oldest first, until the host finishes each", async () => {
    const slot = hostSlot("laptop");
    const [five, six] = await Promise.all([
      writeConcurrencyRequest(slot, request(5)),
      writeConcurrencyRequest(slot, request(6)),
    ]);
    expect(five).not.toBe(six);
    const pending = await pendingConcurrencyRequests(slot);
    expect(pending.map((entry) => entry.id)).toEqual([five, six].toSorted());
    expect(pending.map((entry) => entry.request?.concurrency).toSorted()).toEqual([5, 6]);

    // A request written while the host works through the others is not lost.
    await finishConcurrencyRequest(slot, five);
    const seven = await writeConcurrencyRequest(slot, request(7));
    await expect(concurrencyRequestPending(slot, five)).resolves.toBe(false);
    await expect(concurrencyRequestPending(slot, six)).resolves.toBe(true);
    expect((await pendingConcurrencyRequests(slot)).map((entry) => entry.request)).toEqual([
      request(6),
      request(7),
    ]);
    await finishConcurrencyRequest(slot, six);
    await finishConcurrencyRequest(slot, seven);
    expect(await pendingConcurrencyRequests(slot)).toEqual([]);
    expect(await readdir(join(slotDirectory(slot), "concurrency"))).toEqual([]);
  });

  it("clears requests a new host process already started with", async () => {
    const slot = hostSlot("laptop");
    const id = await writeConcurrencyRequest(slot, request(4));
    await clearConcurrencyRequests(slot);
    await expect(concurrencyRequestPending(slot, id)).resolves.toBe(false);
  });
});

describe("concurrencyChange", () => {
  const file = (concurrency: number) =>
    resolveServices(
      [
        {
          path: join(tmpdir(), "supertag.yaml"),
          text: `services:
  control-plane: { type: control-plane }
  laptop: { type: host, harnesses: [codex], concurrency: ${concurrency} }
`,
        },
      ],
      {},
    );

  it("reads the running host's concurrency from its value and source, without a drain", async () => {
    const before = await file(2);
    const running = findService(before, "laptop");
    if (running === undefined) throw new Error("no laptop service");
    const status: ProcessStatus = {
      pid: 1,
      mode: "background",
      state: "ready",
      startedAt: new Date().toISOString(),
      configuration: serviceFingerprint(before, running),
      kind: "host",
      service: "laptop",
      resolved: {},
      concurrency: { value: 2, source: "machine" },
    };
    const after = await file(6);
    const raised = findService(after, "laptop");
    if (raised === undefined) throw new Error("no laptop service");
    expect(concurrencyChange(after, raised, status)).toEqual({ from: 2, to: 6 });
    // Only the source differs: nothing to apply.
    expect(concurrencyChange(before, running, status)).toBeUndefined();
  });
});
