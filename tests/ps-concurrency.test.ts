import { describe, expect, it } from "vitest";
import { formatRows, hostConcurrency } from "../apps/cli/src/ps.ts";
import { serviceFingerprint } from "../apps/cli/src/supertag-yaml.ts";

describe("supertag ps concurrency", () => {
  it("shows each host's per-harness concurrency and where it came from", () => {
    const host = {
      service: "laptop",
      type: "host" as const,
      state: "stopped" as const,
      configured: true,
    };
    expect(formatRows([{ ...host, concurrency: { value: 6, source: "machine" } }])).toContain(
      "  concurrency 6 per harness (from this machine)\n",
    );
    expect(formatRows([{ ...host, concurrency: { value: 3, source: "file" } }])).toContain(
      "  concurrency 3 per harness (from supertag.yaml)\n",
    );
  });

  it("shows a running host's applied concurrency rather than the file's proposed value", () => {
    const service = { type: "host", concurrency: 8, concurrencySource: "file" } as never;
    expect(hostConcurrency({ concurrency: { value: 6, source: "machine" } }, service)).toEqual({
      concurrency: { value: 6, source: "machine" },
    });
    expect(hostConcurrency(undefined, service)).toEqual({
      concurrency: { value: 8, source: "file" },
    });
  });

  it("keeps the fingerprint when only the source of an equal value changes", () => {
    const file = { name: "t", services: [] } as never;
    const host = {
      type: "host",
      name: "laptop",
      controlPlane: { url: "http://x" },
      concurrency: 6,
    };
    const a = serviceFingerprint(file, { ...host, concurrencySource: "machine" } as never);
    expect(serviceFingerprint(file, { ...host, concurrencySource: "file" } as never)).toBe(a);
    expect(
      serviceFingerprint(file, { ...host, concurrency: 7, concurrencySource: "file" } as never),
    ).not.toBe(a);
  });
});
