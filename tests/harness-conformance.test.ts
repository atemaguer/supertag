import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  type Harness,
  LocalExecutionEnvironmentProvider,
} from "../packages/runtime/sdk/src/index.js";
import { prepareHarnessFixture, runHarnessConformance } from "./support/harness-conformance.js";

it.each([true, false])(
  "verifies exported code independently of Harness claims (valid=%s)",
  async (valid) => {
    // A word password also occurs in the artifact URI scheme. Diagnostic redaction
    // must not corrupt the reference passed from the producer to the reviewer.
    vi.stubEnv(
      "SUPERTAG_POSTGRES_URL",
      "postgresql://supertag:supertag@127.0.0.1:55432/supertag_test",
    );
    const directory = await mkdtemp(join(tmpdir(), "harness-conformance-"));
    try {
      const fixture = await prepareHarnessFixture(directory);
      const harness: Harness = {
        id: "fixture",
        async describe() {
          return {
            sessions: { resume: false, export: false, scope: "none" as const },
            id: this.id,
            version: "1",
            inputKinds: ["workspace"],
            streaming: true,
            cancellation: true,
            sessionPersistence: "none",
          };
        },
        async plan(context) {
          if (!context.workspace) throw new Error("Missing pinned workspace");
          return {
            runtime: emptyEnvironmentPlan(),
            execution: {
              ...emptyEnvironmentPlan(),
              mounts: [
                { source: context.workspace.source, destination: "workspace", readOnly: false },
              ],
            },
          };
        },
        async start(_plan, environments) {
          const environment = environments.execution;
          return {
            async *run(signal) {
              const process = await environment.spawn(
                {
                  command: "python3",
                  args: [
                    "-c",
                    valid
                      ? "p='overlap.py';s=open(p).read();open(p,'w').write(s.replace('<=','<'))"
                      : "open('test_overlap.py','w').write('print(\\\"all tests pass\\\")')",
                  ],
                  cwd: environment.resolvePath("workspace"),
                  timeoutMs: 5000,
                },
                signal,
              );
              if ((await process.wait()).exitCode !== 0) throw new Error("Fixture edit failed");
              yield { type: "output.message" as const, text: "All tests pass" };
            },
            async close() {},
          };
        },
      };
      const execution = runHarnessConformance({
        directory,
        ...fixture,
        harness,
        executionEnvironment: new LocalExecutionEnvironmentProvider(),
      });
      if (valid)
        expect(await execution).toMatchObject({
          producerStatus: "completed",
          reviewStatus: "completed",
          verificationCases: 5,
        });
      else await expect(execution).rejects.toThrow("Independent artifact verification failed");
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function emptyEnvironmentPlan() {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
}
