import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";

describe("Control Plane schema readiness", () => {
  it("refuses to listen before its database schema is current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-schema-readiness-"));
    try {
      await expect(
        startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl: `file:${join(directory, "uninitialized.db")}`,
        }),
      ).rejects.toThrow(/Database schema is uninitialized/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
