import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type ProcessInventory,
  platformProcessInventory,
} from "@supertag/worker-sdk/internal/process-inventory";
import { expect, it, vi } from "vitest";
import { watchStoppedRunner } from "./src/stop-watchdog.js";

function fixture() {
  const input = new PassThrough();
  const signal = vi.fn(async () => {});
  const inventory = { signal } as unknown as ProcessInventory;
  const ready = vi.fn();
  return { input, inventory, signal, ready };
}

it("resumes the same runner identity when a crashed Worker closes the control pipe", async () => {
  const f = fixture();
  const watching = watchStoppedRunner(f.input, f.inventory, 1234, "original-start", f.ready);
  expect(f.ready).toHaveBeenCalledOnce();
  f.input.end(); // The kernel closes the pipe this way when the Worker dies.
  await watching;
  expect(f.signal).toHaveBeenCalledExactlyOnceWith(1234, "original-start", "SIGCONT");
});

it("resumes the runner when an inventory scan outlives its stop lease", async () => {
  const f = fixture();
  const watching = watchStoppedRunner(f.input, f.inventory, 1234, "original-start", f.ready, 5);
  await vi.waitFor(() => expect(f.signal).toHaveBeenCalled());
  expect(f.signal).toHaveBeenCalledExactlyOnceWith(1234, "original-start", "SIGCONT");
  f.input.end("done\n");
  await watching;
});

it("does not signal the runner after normal Worker release", async () => {
  const f = fixture();
  const watching = watchStoppedRunner(f.input, f.inventory, 1234, "original-start", f.ready);
  f.input.end("done\n");
  await watching;
  expect(f.signal).not.toHaveBeenCalled();
});

const realInventory = platformProcessInventory();
const inventoryAvailable = await realInventory.snapshot({}).then(
  () => true,
  () => false,
);

it.skipIf(!inventoryAvailable)(
  "continues a real stopped runner after its Worker pipe closes",
  async () => {
    const runner = spawn(
      process.execPath,
      ["-e", "setInterval(() => process.stdout.write('tick\\n'), 30)"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let ticks = 0;
    runner.stdout.on("data", (chunk: Buffer) => {
      ticks += (chunk.toString().match(/tick\n/gu) ?? []).length;
    });
    let helper: ReturnType<typeof spawn> | undefined;
    try {
      if (!runner.pid) throw new Error("Runner PID unavailable");
      await vi.waitFor(() => expect(ticks).toBeGreaterThan(0), { timeout: 3_000 });
      const started = await realInventory.started(runner.pid);
      if (!started) throw new Error("Runner start identity unavailable");
      helper = spawn(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          fileURLToPath(import.meta.resolve("tsx")),
          fileURLToPath(new URL("./src/stop-watchdog-main.ts", import.meta.url)),
          String(runner.pid),
          started,
        ],
        { detached: true, stdio: ["pipe", "pipe", "ignore"] },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Watchdog startup timed out")), 2_000);
        helper?.stdout.once("data", (chunk: Buffer) => {
          clearTimeout(timer);
          if (chunk.toString() === "ready\n") resolve();
          else reject(new Error("Watchdog did not arm"));
        });
        helper?.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Watchdog exited before arming"));
        });
      });
      await realInventory.signal(runner.pid, started, "SIGSTOP");
      const stoppedAt = ticks;
      helper.stdin.end(); // Simulate Worker death: its watchdog control pipe closes.
      await vi.waitFor(() => expect(ticks).toBeGreaterThan(stoppedAt), { timeout: 3_000 });
    } finally {
      if (runner.pid) {
        const started = await realInventory.started(runner.pid).catch(() => undefined);
        if (started) {
          await realInventory.signal(runner.pid, started, "SIGCONT").catch(() => undefined);
          await realInventory.signal(runner.pid, started, "SIGKILL").catch(() => undefined);
        }
      }
      helper?.kill("SIGKILL");
      runner.kill("SIGKILL");
    }
  },
);
