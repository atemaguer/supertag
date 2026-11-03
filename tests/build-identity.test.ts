import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtCheckoutRoots,
  digestCode,
  SUPERTAG_BUILD_IDENTITY,
} from "../apps/cli/src/build-identity.ts";
import { formatRows } from "../apps/cli/src/ps.ts";
import { runningBuildMatches } from "../apps/cli/src/up.ts";

describe("build identity", () => {
  it("changes when installed code changes without a version change", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-build-"));
    try {
      const file = join(root, "cli.js");
      await writeFile(file, "first");
      const first = digestCode([root]);
      await writeFile(file, "second");
      expect(digestCode([root])).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("changes when a built workspace dependency changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-checkout-"));
    try {
      const packageRoot = join(root, "packages/core");
      await mkdir(join(root, "apps/cli/dist"), { recursive: true });
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await writeFile(join(root, "apps/cli/dist/index.js"), "cli");
      await writeFile(join(packageRoot, "package.json"), '{"name":"@supertag/core"}');
      const builtFile = join(packageRoot, "dist/index.js");
      await writeFile(builtFile, "first");
      const roots = builtCheckoutRoots(root);
      const first = digestCode(roots);
      await writeFile(builtFile, "second");
      expect(digestCode(roots)).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restarts a service whose code differs or predates identity reporting", () => {
    const status = { version: "0.2.0-alpha.1", buildIdentity: SUPERTAG_BUILD_IDENTITY } as never;
    expect(runningBuildMatches(status)).toBe(true);
    expect(runningBuildMatches({ ...status, buildIdentity: "old-build" })).toBe(false);
    expect(runningBuildMatches({ ...status, buildIdentity: undefined })).toBe(false);
  });

  it("shows the running service build in ps", () => {
    const row = {
      service: "control-plane",
      type: "control-plane" as const,
      state: "running" as const,
      configured: true,
      pid: 12,
      buildIdentity: "old-build",
    };
    expect(formatRows([row])).toContain("build old-build (differs from CLI)");
  });
});
