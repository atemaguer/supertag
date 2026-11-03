import { describe, expect, it } from "vitest";
import { lowDiskWarning } from "./src/disk-space.js";
import { formatRows } from "./src/ps.js";

describe("low Worker Host disk warning", () => {
  it("uses five percent on small volumes and ten GiB on large volumes", () => {
    const gib = 1024 ** 3;
    expect(lowDiskWarning({ freeBytes: 4 * gib, totalBytes: 100 * gib })).toContain("below 5 GiB");
    expect(lowDiskWarning({ freeBytes: 6 * gib, totalBytes: 100 * gib })).toBeUndefined();
    expect(lowDiskWarning({ freeBytes: 9 * gib, totalBytes: 500 * gib })).toContain("below 10 GiB");
    expect(lowDiskWarning({ freeBytes: 11 * gib, totalBytes: 500 * gib })).toBeUndefined();
  });

  it("prints a host disk warning in ps", () => {
    expect(
      formatRows([
        {
          service: "host",
          type: "host",
          state: "running",
          configured: true,
          pid: 1,
          diskWarning: "Warning: low disk",
        },
      ]),
    ).toContain("Warning: low disk");
  });
});
