import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalExecutionEnvironmentProvider } from "../packages/runtime/sdk/src/index.js";
import { runServerHarnessConformance } from "./support/server-harness-conformance.js";

it("controls a supervised server through the Worker and verifies its exported artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "server-harness-"));
  try {
    expect(
      await runServerHarnessConformance(new LocalExecutionEnvironmentProvider(), directory),
    ).toMatchObject({ verifiedAnswer: 42, completed: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
