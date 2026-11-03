import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ProcessInventory } from "@supertag/worker-sdk/internal/process-inventory";

/** A separate process must own the deadline: a Worker timer dies with the Worker. */
export const STOP_LEASE_MS = 5_000;

/** Run in the watchdog process. EOF means its Worker died before releasing the stop lease. */
export async function watchStoppedRunner(
  input: NodeJS.ReadableStream,
  inventory: ProcessInventory,
  pid: number,
  started: string,
  ready: () => void,
  leaseMs = STOP_LEASE_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let received = "";
    // Keep trying after the deadline. The Worker may enter SIGSTOP after the
    // first lease expires if its own signal call stalls.
    const tick = () => {
      if (done) return;
      void inventory.signal(pid, started, "SIGCONT").catch(() => undefined);
      timer = setTimeout(tick, 1_000);
    };
    const finish = (resume: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      void (resume ? inventory.signal(pid, started, "SIGCONT") : Promise.resolve()).then(
        () => resolve(),
        reject,
      );
    };
    const onData = (chunk: Buffer | string) => {
      received += chunk.toString();
      if (received.includes("done\n")) finish(false);
      else if (received.length > 32) finish(true);
    };
    const onEnd = () => finish(true);
    const onError = () => finish(true);
    let timer = setTimeout(tick, leaseMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    ready();
  });
}

/** Arm and acknowledge the watchdog before SIGSTOP can be sent. */
export async function armCursorStopWatchdog(
  pid: number,
  started: string,
): Promise<(continued: boolean) => Promise<void>> {
  // A separate entry, so a bundler's shared chunk never hides the process entry point.
  // The packaged CLI ships it as dist/stop-watchdog-main.js beside its chunks.
  const js = fileURLToPath(new URL("./stop-watchdog-main.js", import.meta.url));
  const ts = fileURLToPath(new URL("./stop-watchdog-main.ts", import.meta.url));
  const compiled = await access(js).then(
    () => true,
    () => false,
  );
  const child = spawn(
    process.execPath,
    compiled
      ? [js, String(pid), started]
      : [
          "--conditions=development",
          "--import",
          fileURLToPath(import.meta.resolve("tsx")),
          ts,
          String(pid),
          started,
        ],
    {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      // Credentials from the Worker must never enter the watchdog environment.
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp" },
    },
  );
  child.stdin.on("error", () => {}); // The lease may already have ended.
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onData = (chunk: Buffer) => {
        if (chunk.toString() === "ready\n") finish();
        else finish(new Error("Cursor stop watchdog sent an invalid acknowledgment"));
      };
      const onError = () => finish(new Error("Cursor stop watchdog could not start"));
      const onExit = () => finish(new Error("Cursor stop watchdog exited before acknowledgment"));
      const timer = setTimeout(
        () => finish(new Error("Cursor stop watchdog startup timed out")),
        2_000,
      );
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return async (continued) => {
    // An unsuccessful Worker SIGCONT must leave the watchdog responsible for resuming.
    child.stdin.end(continued ? "done\n" : undefined);
    await new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (child.exitCode === 0) resolve();
        else reject(new Error("Cursor stop watchdog exited unsuccessfully"));
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Cursor stop watchdog did not exit"));
      }, 2_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Cursor stop watchdog exited unsuccessfully"));
      });
    });
  };
}
