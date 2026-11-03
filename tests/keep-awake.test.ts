import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  KeepAwake,
  type KeepAwakeHold,
  keepAwakeCommand,
  MAX_KEEP_AWAKE_RESTARTS,
} from "../apps/cli/src/keep-awake.ts";
import { formatRows } from "../apps/cli/src/ps.ts";

/** A stand-in child process: tests never start caffeinate or systemd-inhibit. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function harness(platform: NodeJS.Platform) {
  const spawned: { command: string; args: readonly string[]; child: FakeChild }[] = [];
  const changes: (KeepAwakeHold | undefined)[] = [];
  const unavailable: string[] = [];
  const awake = new KeepAwake({
    platform,
    pid: 4242,
    now: () => new Date("2026-10-02T12:00:00.000Z"),
    spawn: (command, args) => {
      const child = new FakeChild();
      spawned.push({ command, args, child });
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    onChange: (hold) => changes.push(hold),
    onUnavailable: (message) => unavailable.push(message),
  });
  return { awake, spawned, changes, unavailable };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("keep awake", () => {
  it("uses caffeinate -i on macOS and systemd-inhibit on Linux, tied to the host process", () => {
    expect(keepAwakeCommand("darwin", 7)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "7"],
      label: "caffeinate -i",
    });
    expect(keepAwakeCommand("linux", 7)).toMatchObject({
      command: "systemd-inhibit",
      args: expect.arrayContaining(["--what=idle:sleep", "--mode=block", "--pid=7"]),
    });
    expect(keepAwakeCommand("win32", 7)).toBeUndefined();
  });

  it("holds while Task Attempts run and releases when idle", async () => {
    const { awake, spawned, changes } = harness("darwin");
    awake.update(1);
    awake.update(2);
    await tick();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ command: "caffeinate", args: ["-i", "-w", "4242"] });
    expect(awake.hold).toEqual({ tool: "caffeinate -i", since: "2026-10-02T12:00:00.000Z" });
    awake.update(1);
    expect(spawned[0]?.child.kills).toEqual([]);
    awake.update(0);
    await tick();
    expect(spawned[0]?.child.kills).toEqual(["SIGTERM"]);
    expect(awake.hold).toBeUndefined();
    expect(changes).toEqual([
      { tool: "caffeinate -i", since: "2026-10-02T12:00:00.000Z" },
      undefined,
    ]);
    awake.update(1);
    await tick();
    expect(spawned).toHaveLength(2);
    awake.release();
  });

  it("does nothing on other platforms", async () => {
    const { awake, spawned } = harness("win32");
    awake.update(1);
    await tick();
    expect(spawned).toEqual([]);
    expect(awake.hold).toBeUndefined();
  });

  it("reports once when the OS command is missing and stops trying", async () => {
    const { awake, spawned, unavailable } = harness("linux");
    awake.update(1);
    spawned[0]?.child.emit("error", new Error("spawn systemd-inhibit ENOENT"));
    await tick();
    expect(awake.hold).toBeUndefined();
    awake.update(0);
    awake.update(1);
    expect(spawned).toHaveLength(1);
    expect(unavailable).toEqual([
      expect.stringContaining("Cannot keep the machine awake with systemd-inhibit"),
    ]);
  });

  it("restarts the OS command when it exits on its own while Task Attempts run", async () => {
    const { awake, spawned } = harness("darwin");
    awake.update(1);
    await tick();
    spawned[0]?.child.emit("exit", 1, null);
    expect(spawned).toHaveLength(2);
    await tick();
    expect(awake.hold).toEqual({ tool: "caffeinate -i", since: "2026-10-02T12:00:00.000Z" });
  });

  it("stops restarting after a bounded number of unexpected exits", async () => {
    const { awake, spawned } = harness("darwin");
    awake.update(1);
    for (let i = 0; i <= MAX_KEEP_AWAKE_RESTARTS; i += 1) {
      await tick();
      spawned.at(-1)?.child.emit("exit", 1, null);
    }
    expect(spawned).toHaveLength(MAX_KEEP_AWAKE_RESTARTS + 1);
    expect(awake.hold).toBeUndefined();
  });

  it("does not restart after the OS command is missing", async () => {
    const { awake, spawned, unavailable } = harness("darwin");
    awake.update(1);
    spawned[0]?.child.emit(
      "error",
      Object.assign(new Error("spawn caffeinate ENOENT"), { code: "ENOENT" }),
    );
    spawned[0]?.child.emit("exit", -2, null);
    await tick();
    expect(spawned).toHaveLength(1);
    expect(unavailable).toHaveLength(1);
    expect(awake.hold).toBeUndefined();
  });

  it("does not restart after release", async () => {
    const { awake, spawned } = harness("darwin");
    awake.update(1);
    await tick();
    awake.update(0);
    await tick();
    expect(spawned).toHaveLength(1);
  });

  it("supertag ps shows the hold", () => {
    const text = formatRows([
      {
        service: "studio",
        type: "host",
        state: "running",
        configured: true,
        pid: 10,
        workerHostId: "studio",
        attempts: 1,
        keepAwake: { tool: "caffeinate -i", since: "2026-10-02T12:00:00.000Z" },
      },
    ]);
    expect(text).toContain(
      "Task Attempts running: 1; keeping the machine awake (caffeinate -i) since 2026-10-02T12:00:00.000Z",
    );
  });
});
