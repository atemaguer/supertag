import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessDescendants } from "./src/process-descendants.js";
import { spawnOwnedProcess } from "./src/process-supervision.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./src/process-descendants.js", () => ({
  ProcessDescendants: { now: () => "1", start: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["", "x", "attempt-marker", "00000000-0000-0000-0000-000000000000"])(
  "refuses an invalid caller process marker %j before spawning",
  async (marker) => {
    await expect(
      spawnOwnedProcess({
        spec: { command: "fake", environment: { SUPERTAG_INTERNAL_PROCESS_MARKER: marker } },
        cwd: process.cwd(),
        environment: {},
        maximumOutput: 1024,
        record: async () => {},
      }),
    ).rejects.toThrow(/invalid process marker/i);
    expect(spawn).not.toHaveBeenCalled();
  },
);

it("marks open output pipes host-unsafe even after the process group and known descendants exit", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 900_001,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const descendants = {
    scan: vi.fn(async () => {}),
    signalKnown: vi.fn(async () => {}),
    gone: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.mocked(ProcessDescendants.start).mockReturnValue(descendants as unknown as ProcessDescendants);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("No such process group"), { code: "ESRCH" });
  });
  try {
    const handle = await spawnOwnedProcess({
      spec: { command: "fake" },
      cwd: process.cwd(),
      environment: {},
      maximumOutput: 1024,
      record: async () => {},
    });
    const result = expect(handle.wait()).rejects.toMatchObject({
      name: "ExecutionCleanupError",
      message: "Process stopped but output pipe closure could not be confirmed",
      hostUnsafe: true,
    });
    // An escaped pipe holder prevents 'close' even though the launched root exited.
    child.emit("exit", 0, null);
    await Promise.all([result, vi.advanceTimersByTimeAsync(550)]);
    expect(descendants.gone).toHaveBeenCalled();
    expect(descendants.close).toHaveBeenCalledOnce();
  } finally {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
