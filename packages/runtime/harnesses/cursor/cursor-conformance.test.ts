import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  prepareHarnessFixture,
  runHarnessConformance,
} from "../../../../tests/support/harness-conformance.js";
import { LocalExecutionEnvironmentProvider } from "../../sdk/src/index.js";
import { CursorHarness } from "./src/index.js";

it("passes the shared Harness lifecycle through a real Worker and local environment", async (context) => {
  // LocalExecutionEnvironment confirms process trees with ps on macOS. The restricted
  // coding sandbox denies ps(1), so this host-level fixture needs an unrestricted verifier.
  if (spawnSync("ps", ["-axo", "pid,ppid"]).error?.code === "EPERM") context.skip();
  const directory = await mkdtemp(
    join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-conformance-"),
  );
  try {
    const fixture = await prepareHarnessFixture(directory);
    const harness = new CursorHarness({
      workspace: fixture.source,
      runner: async function* (request) {
        await writeFile(
          join(request.workspace, "overlap.py"),
          "def overlaps(a, b):\n    return a[0] < b[1] and b[0] < a[1]\n",
        );
        yield { type: "cursor.session", agentId: request.agentId };
        yield { type: "output.message", text: "Fixed scheduling overlap", final: true };
      },
    });
    const report = await runHarnessConformance({
      directory,
      harness,
      executionEnvironment: new LocalExecutionEnvironmentProvider(),
      ...fixture,
    });
    expect(report.producerStatus).toBe("completed");
    expect(report.reviewStatus).toBe("completed");
    expect(report.verificationCases).toBe(5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { spawnSync } from "node:child_process";
