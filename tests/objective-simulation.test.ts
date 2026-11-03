import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runObjectiveSimulation } from "./support/objective-simulation.js";

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const artifactRoot = process.env["SUPERTAG_SIMULATION_OUTPUT_DIR"] ?? tmpdir();
await mkdir(artifactRoot, { recursive: true });

it("simulates 100 distinct agents through the real objective runtime without model providers", async () => {
  const outputDirectory = await mkdtemp(join(artifactRoot, "supertag-100-agents-"));
  const report = await runObjectiveSimulation({
    agents: 100,
    seed: 42,
    hosts: 3,
    concurrency: 4,
    outputDirectory,
  });
  expect(
    report.passed,
    `${report.error ?? "Invariant failed"}; artifacts: ${outputDirectory}`,
  ).toBe(true);
  expect(report.agentsExecuted).toBe(100);
  expect(report.providerCalls).toBe(0);
  expect(report.restarts).toBe(1);
  expect(report.peakConcurrency).toBeGreaterThan(1);
}, 300_000);

it("reproduces normalized outcomes for the same seed and exercises local evidence", async () => {
  const firstDirectory = await mkdtemp(join(artifactRoot, "supertag-simulation-repeat-"));
  const secondDirectory = await mkdtemp(join(artifactRoot, "supertag-simulation-repeat-"));
  const options = { agents: 20, seed: 7, hosts: 2, concurrency: 3, processMode: "local" as const };
  const first = await runObjectiveSimulation({ ...options, outputDirectory: firstDirectory });
  const second = await runObjectiveSimulation({ ...options, outputDirectory: secondDirectory });
  expect(first.passed, `${first.error}; ${firstDirectory}`).toBe(true);
  expect(second.passed, `${second.error}; ${secondDirectory}`).toBe(true);
  expect(first.workloadDigest).toBe(second.workloadDigest);
  expect(first.localProcesses).toBe(19);
  expect(second.localProcesses).toBe(19);
  expect(JSON.parse(await readFile(join(firstDirectory, "outcomes.json"), "utf8"))).toEqual(
    JSON.parse(await readFile(join(secondDirectory, "outcomes.json"), "utf8")),
  );
}, 300_000);

it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
  "rejects an invalid simulation timeout (%s)",
  async (timeoutMs) => {
    await expect(
      runObjectiveSimulation({ outputDirectory: "/unused-invalid-simulation", timeoutMs }),
    ).rejects.toThrow("timeoutMs");
  },
);
