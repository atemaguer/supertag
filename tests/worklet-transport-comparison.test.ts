import { expect, it } from "vitest";
import { runTransportComparison } from "./support/worklet-transport-comparison.js";

it("completes and recovers the same durable workload over WebSocket and gRPC", async () => {
  const report = await runTransportComparison({
    iterations: 8,
    warmup: 2,
    reconnects: 2,
    deadlineMs: 5000,
  });
  expect(report.measurements.map((measurement) => measurement.transport)).toEqual([
    "websocket",
    "grpc",
  ]);
  for (const measurement of report.measurements) {
    expect(measurement).toMatchObject({
      protocolVersion: 18,
      completed: 8,
      duplicateExecutions: 0,
      completion: { samples: 8 },
      reconnect: { samples: 2 },
    });
    expect(measurement.connectionMs).toBeGreaterThanOrEqual(0);
    expect(measurement.completion.p50Ms).toBeGreaterThanOrEqual(0);
    expect(measurement.completion.p95Ms).toBeGreaterThanOrEqual(measurement.completion.p50Ms);
    expect(measurement.reconnect.p95Ms).toBeGreaterThanOrEqual(measurement.reconnect.p50Ms);
    expect(measurement.rss.peakBytes).toBeGreaterThanOrEqual(measurement.rss.startBytes);
  }
}, 30_000);
