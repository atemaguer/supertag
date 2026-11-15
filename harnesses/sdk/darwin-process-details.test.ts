import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { availableParallelism } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  DARWIN_DETAILS_ATTEMPTS,
  DARWIN_DETAILS_BATCH,
  type DarwinHelperRunner,
  DarwinProcessDetailsError,
  darwinDetailsTimeout,
  darwinProcessDetails,
} from "./src/darwin-process-details.js";

/** An `execFile` rejection, whose message embeds the whole command line. */
function helperFailure(fields: {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stderr?: string;
}): Error {
  return Object.assign(new Error("Command failed: /usr/bin/perl -T -e use strict; use warnings;"), {
    code: null,
    signal: null,
    killed: false,
    stderr: "",
    stdout: "",
    ...fields,
  });
}

function fakeRunner(...outcomes: (string | Error)[]) {
  const run = vi.fn<DarwinHelperRunner>(async () => {
    const outcome = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    if (outcome instanceof Error) throw outcome;
    return { stdout: outcome ?? "", stderr: "" };
  });
  const delay = vi.fn(async (_ms: number) => {});
  return { run, delay };
}

const one = [{ pid: 101, inspectMarker: true }];

describe("helper failures", () => {
  it("retries a timed-out helper and reports the timeout without the script", async () => {
    const fake = fakeRunner(helperFailure({ signal: "SIGTERM", killed: true }));
    const failure = await darwinProcessDetails(one, "m", fake).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DarwinProcessDetailsError);
    expect(fake.run).toHaveBeenCalledTimes(DARWIN_DETAILS_ATTEMPTS);
    expect(fake.delay.mock.calls).toEqual([[100], [400]]);
    const message = (failure as Error).message;
    expect(message).toContain("after 3 attempts");
    expect(message).toContain("exit code none, signal SIGTERM, timed out yes");
    expect(message).not.toContain("use strict");
  });

  it("reports perl's exit code and the start of its stderr", async () => {
    const fake = fakeRunner(
      helperFailure({ code: 255, stderr: `kern.argmax failed${"x".repeat(900)}` }),
    );
    const message = String(
      await darwinProcessDetails(one, "m", fake).catch((e: Error) => e.message),
    );
    expect(message).toContain(
      "exit code 255, signal none, timed out no, stderr: kern.argmax failed",
    );
    const stderr = /stderr: (x|k[^;)]*)/.exec(message)?.[0] ?? "";
    expect(stderr.length).toBeLessThanOrEqual("stderr: ".length + 500);
  });

  it("fails closed on an errno line that does not mean gone or denied", async () => {
    const fake = fakeRunner("101 error procargs 5\n");
    await expect(darwinProcessDetails(one, "m", fake)).rejects.toThrow("PID 101 procargs EIO (5)");
    expect(fake.run).toHaveBeenCalledTimes(DARWIN_DETAILS_ATTEMPTS);
  });

  it("reports output over the buffer bound", async () => {
    const fake = fakeRunner(
      helperFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: "SIGTERM", killed: true }),
    );
    await expect(darwinProcessDetails(one, "m", fake)).rejects.toThrow(
      "timed out no, output exceeded the buffer",
    );
  });

  it("rejects a line for a PID it did not request", async () => {
    const fake = fakeRunner("101 101 0\n999 gone\n");
    await expect(darwinProcessDetails(one, "m", fake)).rejects.toThrow(
      'Invalid macOS process details line: "999 gone"',
    );
  });

  it("recovers from a transient failure on retry", async () => {
    const fake = fakeRunner(
      helperFailure({ code: 255, stderr: "kern.argmax failed errno=12" }),
      "101 error getsid 12\n",
      "101 101 1\n",
    );
    await expect(darwinProcessDetails(one, "m", fake)).resolves.toEqual(
      new Map([[101, { session: 101, marked: true }]]),
    );
    expect(fake.run).toHaveBeenCalledTimes(3);
  });

  it("sizes batches, timeouts, and output bounds by batch length", async () => {
    const processes = Array.from({ length: DARWIN_DETAILS_BATCH + 10 }, (_, index) => ({
      pid: index + 1,
      inspectMarker: false,
    }));
    const run = vi.fn<DarwinHelperRunner>(async (_file, args) => ({
      stdout: args
        .slice(5)
        .map((item) => `${item.split(":")[0]} gone\n`)
        .join(""),
      stderr: "",
    }));
    const details = await darwinProcessDetails(processes, undefined, { run });
    expect(details.size).toBe(processes.length);
    expect([...details.values()].every((detail) => detail === null)).toBe(true);
    expect(run.mock.calls.map(([, args, options]) => [args.length - 5, options.timeout])).toEqual([
      [DARWIN_DETAILS_BATCH, darwinDetailsTimeout(DARWIN_DETAILS_BATCH)],
      [10, darwinDetailsTimeout(10)],
    ]);
  });
});

it.skipIf(process.platform !== "darwin")(
  "reads real macOS sessions and accepts only a whole environment marker entry",
  async () => {
    const marker = randomUUID();
    const needle = `SUPERTAG_INTERNAL_PROCESS_MARKER=${marker}`;
    const environment = { ...process.env };
    delete environment.SUPERTAG_INTERNAL_PROCESS_MARKER;
    const children = [
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", needle], {
        detached: true,
        stdio: "ignore",
        env: environment,
      }),
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: { ...environment, SUPERTAG_INTERNAL_PROCESS_MARKER: marker },
      }),
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: { ...environment, OTHER: `before ${needle} after` },
      }),
      spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore", env: environment }),
    ];
    const exited = children.map((child) => once(child, "exit"));
    try {
      const processes = children.map((child) => {
        if (!child.pid) throw new Error("Child did not start");
        return { pid: child.pid, inspectMarker: true };
      });
      const result = await darwinProcessDetails(processes, marker);
      for (const { pid } of processes) expect(result.get(pid)?.session).toBe(pid);
      expect(processes.map(({ pid }) => result.get(pid)?.marked)).toEqual([
        false,
        true,
        false,
        false,
      ]);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(exited);
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "reads the launcher's session for a reparented Apple binary in a job-control group",
  async () => {
    const root = spawn(
      "/bin/bash",
      ["-c", "set -m; (/bin/sleep 30 </dev/null >/dev/null 2>&1 & echo $!); read -r finish"],
      { detached: true, stdio: ["pipe", "pipe", "inherit"] },
    );
    const exited = once(root, "exit");
    let orphan = 0;
    // Capture the PID even if an assertion fails later, so teardown always kills it.
    root.stdout.on("data", (chunk: Buffer) => {
      orphan = Number(chunk.toString().trim());
    });
    try {
      await once(root.stdout, "data", { signal: AbortSignal.timeout(5000) });
      expect(orphan).toBeGreaterThan(1);
      if (!root.pid) throw new Error("Root did not start");
      const details = await darwinProcessDetails([
        { pid: root.pid, inspectMarker: false },
        { pid: orphan, inspectMarker: false },
      ]);
      expect(details.get(root.pid)?.session).toBe(root.pid);
      expect(details.get(orphan)?.session).toBe(root.pid);
    } finally {
      root.kill("SIGKILL");
      await exited;
      if (orphan > 1) {
        try {
          process.kill(orphan, "SIGKILL");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "reads every current process, also under CPU load and process churn",
  { timeout: 120_000 },
  async () => {
    const listed = () =>
      execFileSync("/bin/ps", ["-axo", "pid="])
        .toString()
        .split("\n")
        .map(Number)
        .filter((pid) => pid > 0)
        .map((pid) => ({ pid, inspectMarker: true }));
    const idle = await darwinProcessDetails(listed(), randomUUID());
    expect(idle.get(process.pid)).toEqual({ session: expect.any(Number), marked: false });
    expect(idle.get(1)).toEqual({ session: 1, marked: false });

    const load = [
      ...Array.from({ length: availableParallelism() * 2 }, () =>
        spawn("/bin/sh", ["-c", "exec yes > /dev/null"], { stdio: "ignore" }),
      ),
      // Short-lived processes exit mid-scan and free PIDs for reuse; one zombie stays unreaped.
      spawn("/bin/sh", ["-c", "while :; do /bin/sleep 0.01 & /usr/bin/true; wait; done"], {
        stdio: "ignore",
      }),
      spawn("/usr/bin/perl", ["-e", "if (fork() == 0) { exit 0 } sleep 600"], { stdio: "ignore" }),
    ];
    const exited = load.map((child) => once(child, "exit"));
    try {
      for (let round = 0; round < 10; round++) {
        const processes = listed();
        // PIDs just past the newest one start or stay absent during the scan.
        const newest = Math.max(...processes.map(({ pid }) => pid));
        for (let pid = newest + 1; pid < newest + 32; pid++)
          processes.push({ pid, inspectMarker: true });
        const details = await darwinProcessDetails(processes, randomUUID());
        expect(details.get(process.pid)).not.toBeNull();
      }
    } finally {
      for (const child of load) child.kill("SIGKILL");
      await Promise.all(exited);
    }
  },
);
