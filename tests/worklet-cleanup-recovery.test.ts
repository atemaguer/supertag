import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.js";
import { writeWorkerHostCredential } from "../apps/cli/src/worker-hosts.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  type Worklet,
} from "../packages/runtime/sdk/src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function fixture(executionSpecDigest?: string, components = ["workers", "worker"]) {
  const state = await mkdtemp(join(tmpdir(), "cleanup-recovery-"));
  const directory = join(state, ...components, "attempt-journal");
  const journal = new FileAttemptJournal(directory);
  await journal.initialize();
  await journal.write({
    inspection: {
      workerId: "worker",
      taskId: "task",
      attemptId: "attempt",
      specDigest: "a".repeat(64),
      ...(executionSpecDigest ? { executionSpecDigest } : {}),
      ...(components[0] === "hosts" ? { workerHostId: "laptop-host" } : {}),
      status: "running",
      lastSequence: 0,
    },
    events: [],
  });
  return { state, directory, journal };
}
/** The host service's credential names the Worker Host recorded on the Attempt. */
async function hostCredential(state: string, service = "laptop", workerHostId = "laptop-host") {
  await writeWorkerHostCredential(join(state, "hosts", service, "credential.json"), {
    version: 1,
    workerHostId,
    token: "test-token",
  });
}
it("requires an offline journal and explicit operator confirmation, then persists audited unknown outcome", async () => {
  const f = await fixture();
  vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const args = [
    "recover",
    "worklet",
    "--worker-id",
    "worker",
    "--task",
    "task",
    "--attempt",
    "attempt",
    "--confirm-stopped",
    "--reason",
    "Verified process tree and remote executions stopped",
  ];
  try {
    await expect(main(args)).rejects.toThrow(/owned/);
    await f.journal.close();
    await expect(main(args.filter((x) => x !== "--confirm-stopped"))).rejects.toThrow(
      /confirm-stopped/,
    );
    await expect(main(args.map((x) => (x === "task" ? "wrong-task" : x)))).rejects.toThrow(
      /identity/,
    );
    await expect(main(args)).resolves.toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("Outcome remains unknown");
    const journal = new FileAttemptJournal(f.directory);
    await journal.initialize();
    try {
      expect(journal.inspections()[0]).toMatchObject({ status: "failed", lastSequence: 1 });
      expect(journal.readEvents("attempt")[0]?.event).toMatchObject({
        type: "execution.failed",
        error: {
          name: "InterruptedExecutionOutcomeUnknown",
          message: expect.stringContaining("Verified process tree"),
        },
      });
    } finally {
      await journal.close();
    }
    await expect(main(args)).rejects.toThrow(/terminal/);
  } finally {
    await f.journal.close();
    await rm(f.state, { recursive: true, force: true });
  }
});
it.each([undefined, "b".repeat(64)])(
  "uses dispatched identity %s for cleanup without replaying execution",
  async (executionSpecDigest) => {
    const f = await fixture(executionSpecDigest);
    await f.journal.close();
    const recoverExecutionCleanup = vi.fn(async () => false);
    const execute = vi.fn(() => {
      throw new Error("Must not execute");
    });
    const worklet: Worklet = {
      id: "local",
      execute,
      recoverExecutionCleanup,
      describe: async () => ({
        id: "local",
        protocolVersion: 1,
        host: {
          id: "host",
          workers: [
            {
              id: "worker",
              type: "test",
              profiles: [{ id: "test", revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
            },
          ],
        },
      }),
    };
    let durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(f.directory));
    try {
      // Reopening records why the interrupted receipt is unknown as journal event 1.
      expect(await durable.inspect("attempt")).toMatchObject({
        status: "unknown",
        lastSequence: 1,
        uncertainty: { name: "WorkletInterrupted" },
      });
      recoverExecutionCleanup.mockResolvedValue(true);
      expect(await durable.inspect("attempt")).toMatchObject({ status: "failed", lastSequence: 2 });
      expect(recoverExecutionCleanup).toHaveBeenCalledWith(
        "worker",
        "task",
        "attempt",
        executionSpecDigest ?? "a".repeat(64),
      );
      expect(execute).not.toHaveBeenCalled();
      await durable.close();
      durable = new DurableLocalWorklet(worklet, new FileAttemptJournal(f.directory));
      expect(await durable.inspect("attempt")).toMatchObject({ status: "failed", lastSequence: 2 });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await durable.close();
      await rm(f.state, { recursive: true, force: true });
    }
  },
);

const hostArgs = [
  "recover",
  "worklet",
  "--worker-id",
  "worker",
  "--task",
  "task",
  "--attempt",
  "attempt",
  "--confirm-stopped",
  "--reason",
  "Host service stopped",
];
it("infers the host service whose journal records the Attempt", async () => {
  const f = await fixture(undefined, ["hosts", "laptop"]);
  await f.journal.close();
  await hostCredential(f.state);
  // Another host service's journal that does not record the Attempt is ignored.
  const other = new FileAttemptJournal(join(f.state, "hosts", "other", "attempt-journal"));
  await other.initialize();
  await other.close();
  vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await expect(main(hostArgs)).resolves.toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("Outcome remains unknown");
    const journal = new FileAttemptJournal(f.directory);
    await journal.initialize();
    try {
      expect(journal.inspections()[0]).toMatchObject({ status: "failed" });
    } finally {
      await journal.close();
    }
  } finally {
    await rm(f.state, { recursive: true, force: true });
  }
});
it.each([
  ["laptop-verify-host", true],
  ["laptop-host", false],
])(
  "checks a running host service's Worker Host credential (%s)",
  async (otherHostId, unrelated) => {
    const f = await fixture(undefined, ["hosts", "laptop"]);
    await f.journal.close();
    await hostCredential(f.state);
    const other = new FileAttemptJournal(
      join(f.state, "hosts", "laptop-verify", "attempt-journal"),
    );
    await other.initialize();
    await hostCredential(f.state, "laptop-verify", otherHostId);
    vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
    try {
      if (unrelated) await expect(main(hostArgs)).resolves.toBe(0);
      else
        await expect(main(hostArgs)).rejects.toThrow(
          /hosts\/laptop-verify\/attempt-journal is owned/,
        );
      const journal = new FileAttemptJournal(f.directory);
      await journal.initialize();
      try {
        expect(journal.inspections()[0]).toMatchObject({
          status: unrelated ? "failed" : "running",
        });
      } finally {
        await journal.close();
      }
    } finally {
      await other.close();
      await rm(f.state, { recursive: true, force: true });
    }
  },
);
it("does not follow a symlinked host service directory out of the state directory", async () => {
  const f = await fixture(undefined, ["outside", "laptop"]);
  await f.journal.close();
  await mkdir(join(f.state, "hosts"), { mode: 0o700 });
  await symlink(join(f.state, "outside", "laptop"), join(f.state, "hosts", "laptop"));
  vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
  try {
    await expect(main(hostArgs)).rejects.toThrow(/No attempt journal for Worker worker/);
  } finally {
    await rm(f.state, { recursive: true, force: true });
  }
});
it.each([true, false])(
  "refuses when both the Worker journal and a host journal record the Attempt (credential=%s)",
  async (credential) => {
    const f = await fixture(undefined, ["hosts", "laptop"]);
    await f.journal.close();
    if (credential) await hostCredential(f.state);
    const worker = new FileAttemptJournal(join(f.state, "workers", "worker", "attempt-journal"));
    await worker.initialize();
    await worker.write({
      inspection: {
        workerId: "worker",
        taskId: "task",
        attemptId: "attempt",
        specDigest: "a".repeat(64),
        status: "running",
        lastSequence: 0,
      },
      events: [],
    });
    await worker.close();
    vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
    try {
      await expect(main(hostArgs)).rejects.toThrow(
        "Candidate journals: workers/worker/attempt-journal, hosts/laptop/attempt-journal. Candidate host services: laptop. Select the original Worker Host with --host NAME, or move the stale journal aside, before recovering",
      );
      // Neither journal was changed.
      for (const directory of [
        f.directory,
        join(f.state, "workers", "worker", "attempt-journal"),
      ]) {
        const journal = new FileAttemptJournal(directory);
        await journal.initialize();
        try {
          expect(journal.inspections()[0]).toMatchObject({ status: "running" });
        } finally {
          await journal.close();
        }
      }
    } finally {
      await rm(f.state, { recursive: true, force: true });
    }
  },
);
it("says to stop the host service first when a running host holds a journal, even if a stale one records the Attempt", async () => {
  // The running host service keeps hosts/laptop/attempt-journal open (and locked).
  const f = await fixture(undefined, ["hosts", "laptop"]);
  // A stale foreground Worker journal also records the Attempt and is not locked.
  const stalePath = join(f.state, "workers", "worker", "attempt-journal");
  const stale = new FileAttemptJournal(stalePath);
  await stale.initialize();
  await stale.write({
    inspection: {
      workerId: "worker",
      taskId: "task",
      attemptId: "attempt",
      specDigest: "a".repeat(64),
      status: "running",
      lastSequence: 0,
    },
    events: [],
  });
  await stale.close();
  vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
  try {
    await expect(main(hostArgs)).rejects.toThrow(
      /hosts\/laptop\/attempt-journal is owned by a running process.*Stop the host service first \(supertag down laptop\)/,
    );
    await f.journal.close();
    // Neither journal was changed: the stale copy was not recovered in the live one's place.
    for (const directory of [f.directory, stalePath]) {
      const journal = new FileAttemptJournal(directory);
      await journal.initialize();
      try {
        expect(journal.inspections()[0]).toMatchObject({ status: "running" });
      } finally {
        await journal.close();
      }
    }
  } finally {
    await f.journal.close();
    await rm(f.state, { recursive: true, force: true });
  }
});
it("refuses to write when a journal component is swapped for a symlink while it is opened", async () => {
  const f = await fixture(undefined, ["hosts", "laptop"]);
  await f.journal.close();
  const outside = await mkdtemp(join(tmpdir(), "cleanup-recovery-outside-"));
  const initialize = FileAttemptJournal.prototype.initialize;
  let swapped = false;
  vi.spyOn(FileAttemptJournal.prototype, "initialize").mockImplementation(async function (
    this: FileAttemptJournal,
  ) {
    await initialize.call(this);
    // The command opens the canonical path (tmpdir may itself sit behind a symlink).
    if (!swapped && this.directory.endsWith(join("hosts", "laptop", "attempt-journal"))) {
      swapped = true;
      // Replace hosts/laptop with a symlink to an identical-looking directory elsewhere.
      await rename(join(f.state, "hosts", "laptop"), join(outside, "laptop"));
      await symlink(join(outside, "laptop"), join(f.state, "hosts", "laptop"));
    }
  });
  vi.stubEnv("SUPERTAG_STATE_DIR", f.state);
  try {
    await expect(main(hostArgs)).rejects.toThrow(
      /Journal path hosts\/laptop\/attempt-journal changed while it was opened/,
    );
    expect(swapped).toBe(true);
    vi.mocked(FileAttemptJournal.prototype.initialize).mockRestore();
    const journal = new FileAttemptJournal(join(outside, "laptop", "attempt-journal"));
    await journal.initialize();
    try {
      expect(journal.inspections()[0]).toMatchObject({ status: "running" });
    } finally {
      await journal.close();
    }
  } finally {
    await rm(f.state, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
