import { describe, expect, it, vi } from "vitest";
import { EventLoopLagMonitor } from "./src/event-loop-lag.js";

describe("event-loop lag monitoring", () => {
  it("warns with the background job that blocked the loop", () => {
    const warn = vi.fn();
    const monitor = new EventLoopLagMonitor(warn);
    monitor.start();
    try {
      monitor.run("job: objective scheduling", () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          activity: "job: objective scheduling",
          lagMs: expect.any(Number),
        }),
      );
      expect(warn.mock.calls[0]?.[0].lagMs).toBeGreaterThan(1_000);
    } finally {
      monitor.stop();
    }
  });

  it("keeps the route across an asynchronous continuation", async () => {
    const warn = vi.fn();
    const monitor = new EventLoopLagMonitor(warn);
    monitor.start();
    try {
      await monitor.run(
        "http: POST /supertag.operator.v1.ResourceService/ApplyManifests",
        async () => {
          await Promise.resolve();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
        },
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          activity: "http: POST /supertag.operator.v1.ResourceService/ApplyManifests",
        }),
      );
    } finally {
      monitor.stop();
    }
  });
});
