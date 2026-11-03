import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runWorkletRecoveryCommand } from "../apps/cli/src/worker.js";
import { writeWorkerHostCredential } from "../apps/cli/src/worker-hosts.js";
import { FileAttemptJournal } from "../packages/runtime/sdk/src/durable-worklet.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function state(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recover-host-"));
  directories.push(directory);
  vi.stubEnv("SUPERTAG_STATE_DIR", directory);
  return directory;
}

async function host(
  directory: string,
  service: string,
  credentialHost: string,
  recordedHost: string,
) {
  const root = join(directory, "hosts", service);
  await mkdir(root, { recursive: true });
  await writeWorkerHostCredential(join(root, "credential.json"), {
    version: 1,
    workerHostId: credentialHost,
    token: "test-token",
  });
  const journal = new FileAttemptJournal(join(root, "attempt-journal"));
  await journal.initialize();
  journal.putInspection({
    attemptId: "attempt-1",
    taskId: "task-1",
    workerId: "worker-1",
    workerHostId: recordedHost,
    specDigest: "digest",
    status: "unknown",
    lastSequence: 0,
  });
  await journal.close();
  return journal;
}

const args = [
  "--worker-id",
  "worker-1",
  "--task",
  "task-1",
  "--attempt",
  "attempt-1",
  "--confirm-stopped",
  "--reason",
  "stopped",
];

it("selects the host service whose credential matches the Attempt's recorded Worker Host", async () => {
  const directory = await state();
  const stale = await host(directory, "other", "other-host", "target-host");
  const target = await host(directory, "target", "target-host", "target-host");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runWorkletRecoveryCommand(args);
  await stale.initialize();
  await target.initialize();
  expect(stale.inspections()[0]?.status).toBe("unknown");
  expect(target.inspections()[0]?.status).toBe("failed");
  await stale.close();
  await target.close();
});

it("refuses when two host services both match their recorded Worker Host", async () => {
  const directory = await state();
  await host(directory, "alpha", "alpha-host", "alpha-host");
  await host(directory, "beta", "beta-host", "beta-host");
  await expect(runWorkletRecoveryCommand(args)).rejects.toThrow(/alpha.*beta/);
});

it("names candidate host services and --host when ambiguous", async () => {
  const directory = await state();
  await host(directory, "alpha", "alpha-host", "alpha-host");
  await host(directory, "beta", "beta-host", "beta-host");
  await expect(runWorkletRecoveryCommand(args)).rejects.toThrow(
    /Candidate host services: alpha, beta\. .*--host NAME/,
  );
});

it("recovers the host service selected with --host", async () => {
  const directory = await state();
  const alpha = await host(directory, "alpha", "alpha-host", "alpha-host");
  const beta = await host(directory, "beta", "beta-host", "beta-host");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runWorkletRecoveryCommand([...args, "--host", "beta"]);
  await alpha.initialize();
  await beta.initialize();
  expect(alpha.inspections()[0]?.status).toBe("unknown");
  expect(beta.inspections()[0]?.status).toBe("failed");
  await alpha.close();
  await beta.close();
});

it("rejects an unknown --host and lists candidate host services", async () => {
  const directory = await state();
  await host(directory, "alpha", "alpha-host", "alpha-host");
  await host(directory, "beta", "beta-host", "beta-host");
  await expect(runWorkletRecoveryCommand([...args, "--host", "gamma"])).rejects.toThrow(
    "Unknown host service gamma. Candidate host services: alpha, beta",
  );
});
