import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ProcessHandle, ProcessOutputChunk, ProcessResult, ProcessSpec } from "./index.js";
import { ProcessDescendants } from "./process-descendants.js";

export class ExecutionCleanupError extends Error {
  /** False only when failure cannot leave execution processes writing on the host. */
  readonly hostUnsafe: boolean;

  constructor(message: string, options?: ErrorOptions & { hostUnsafe?: boolean }) {
    super(message, options);
    this.name = "ExecutionCleanupError";
    this.hostUnsafe = options?.hostUnsafe ?? cleanupLeavesHostUnsafe(options?.cause);
  }
}
/** Unknown cleanup failures remain conservative; wrappers preserve explicit safe failures. */
function cleanupLeavesHostUnsafe(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return true;
  seen.add(error);
  try {
    if (error instanceof ExecutionCleanupError) return error.hostUnsafe;
    if (error instanceof AggregateError)
      return (
        error.errors.length === 0 ||
        error.errors.some((cause) => cleanupLeavesHostUnsafe(cause, seen))
      );
    if (error instanceof Error && error.cause !== undefined)
      return cleanupLeavesHostUnsafe(error.cause, seen);
    return true;
  } finally {
    seen.delete(error);
  }
}

export interface ProcessOutputBufferOptions {
  /** Ask the producer to pause once this many unconsumed bytes are buffered. Default 1 MiB. */
  readonly highWaterBytes?: number;
  /** Resume a paused producer once the consumer drains to this many bytes. Default high / 4. */
  readonly lowWaterBytes?: number;
  /** Last-resort bound for producers that cannot pause; push() throws past it. Default high * 8. */
  readonly maximumBytes?: number;
  /** Called once each time buffered output reaches the high-water mark. */
  readonly pause?: () => void;
  /** Called once when a paused buffer drains to the low-water mark or loses its consumer. */
  readonly resume?: () => void;
}

/**
 * Lossless, ordered output queue with backpressure. A producer pauses when push() returns false
 * (or `pause` is called) and continues when drained() settles (or `resume` is called).
 * SDK convenience; language implementations may use their own bounded async queue.
 */
export class ProcessOutputBuffer implements AsyncIterable<ProcessOutputChunk> {
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
  readonly maximumBytes: number;
  #queue: ProcessOutputChunk[] = [];
  #bytes = 0;
  #paused = false;
  #done = false;
  #abandoned = false;
  #error: unknown;
  #wake: (() => void) | undefined;
  #drained: { promise: Promise<void>; resolve(): void } | undefined;
  readonly #pause: (() => void) | undefined;
  readonly #resume: (() => void) | undefined;
  constructor(options: ProcessOutputBufferOptions = {}) {
    this.highWaterBytes = options.highWaterBytes ?? 1024 * 1024;
    this.lowWaterBytes = options.lowWaterBytes ?? Math.floor(this.highWaterBytes / 4);
    this.maximumBytes = options.maximumBytes ?? this.highWaterBytes * 8;
    if (
      !(this.lowWaterBytes >= 0) ||
      !(this.lowWaterBytes < this.highWaterBytes) ||
      !(this.highWaterBytes < this.maximumBytes)
    )
      throw new Error("Process output marks must satisfy low < high < maximum");
    this.#pause = options.pause;
    this.#resume = options.resume;
  }
  /** Unconsumed bytes currently buffered. */
  get bufferedBytes(): number {
    return this.#bytes;
  }
  /** True while the producer is asked to pause. */
  get paused(): boolean {
    return this.#paused;
  }
  /** Enqueue output in order; false asks the producer to pause until drained(). */
  push(chunk: ProcessOutputChunk): boolean {
    if (this.#done || this.#abandoned) return true;
    const bytes = Buffer.byteLength(chunk.text);
    if (this.#bytes + bytes > this.maximumBytes)
      throw new Error(
        `Process output exceeded its ${this.maximumBytes}-byte hard limit of unconsumed output: the producer could not pause at the ${this.highWaterBytes}-byte high-water mark`,
      );
    this.#bytes += bytes;
    this.#queue.push(chunk);
    this.#wake?.();
    if (!this.#paused && this.#bytes >= this.highWaterBytes) {
      this.#paused = true;
      this.#pause?.();
    }
    return !this.#paused;
  }
  /** Settles once a paused buffer drains to the low-water mark, closes, or loses its consumer. */
  drained(): Promise<void> {
    if (!this.#paused) return Promise.resolve();
    if (!this.#drained) {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      this.#drained = { promise, resolve };
    }
    return this.#drained.promise;
  }
  /** Ends the stream; the consumer still receives every chunk already buffered. */
  close(error?: unknown): void {
    if (this.#done) return;
    this.#done = true;
    this.#error = error;
    this.#release(false);
    this.#wake?.();
  }
  #release(resume: boolean): void {
    const wasPaused = this.#paused;
    const drained = this.#drained;
    this.#paused = false;
    this.#drained = undefined;
    if (wasPaused && resume) this.#resume?.();
    drained?.resolve();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<ProcessOutputChunk> {
    let finished = false;
    try {
      while (true) {
        const chunk = this.#queue.shift();
        if (chunk) {
          this.#bytes -= Buffer.byteLength(chunk.text);
          if (this.#paused && this.#bytes <= this.lowWaterBytes) this.#release(true);
          yield chunk;
          continue;
        }
        if (this.#done) {
          finished = true;
          if (this.#error) throw this.#error;
          return;
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
      }
    } finally {
      // A consumer that stops reading must not leave its producer paused forever.
      if (!finished) {
        this.#abandoned = true;
        this.#queue = [];
        this.#bytes = 0;
        this.#release(true);
      }
    }
  }
}

/** Serial, bounded stdin writes; process shutdown revokes pending and future operations. */
export class ProcessInputWriter {
  #tail: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #queuedWrites = 0;
  #closing = false;
  #end: Promise<void> | undefined;
  #failure: unknown;
  #reject!: (error: unknown) => void;
  readonly #revoked: Promise<never>;
  constructor(readonly sink: { write(bytes: Uint8Array): Promise<void>; end(): Promise<void> }) {
    this.#revoked = new Promise<never>((_resolve, reject) => {
      this.#reject = reject;
    });
    void this.#revoked.catch(() => {});
  }
  write(bytes: Uint8Array): Promise<void> {
    if (this.#failure || this.#closing)
      return Promise.reject(this.#failure ?? new Error("Process input is closed"));
    if (!(bytes instanceof Uint8Array))
      return Promise.reject(new Error("Process input must be bytes"));
    if (bytes.byteLength === 0) return Promise.resolve();
    if (this.#queuedBytes + bytes.byteLength > 1024 * 1024 || this.#queuedWrites >= 128)
      return Promise.reject(new Error("Process input exceeded bounded queue capacity"));
    const snapshot = new Uint8Array(bytes);
    this.#queuedBytes += snapshot.byteLength;
    this.#queuedWrites++;
    const run = this.#tail
      .then(async () => {
        if (this.#failure) throw this.#failure;
        await Promise.race([this.sink.write(snapshot), this.#revoked]);
      })
      .catch((error) => {
        this.revoke(error);
        throw error;
      })
      .finally(() => {
        this.#queuedBytes -= snapshot.byteLength;
        this.#queuedWrites--;
      });
    this.#tail = run.catch(() => {});
    return run;
  }
  end(): Promise<void> {
    if (this.#end) return this.#end;
    if (this.#failure) return Promise.reject(this.#failure);
    this.#closing = true;
    this.#end = this.#tail
      .then(async () => {
        if (this.#failure) throw this.#failure;
        await Promise.race([this.sink.end(), this.#revoked]);
      })
      .catch((error) => {
        this.revoke(error);
        throw error;
      });
    void this.#end.catch(() => {});
    return this.#end;
  }
  revoke(error: unknown = new Error("Process input is closed")): void {
    if (this.#failure) return;
    this.#failure = error || new Error("Process input is closed");
    this.#reject(this.#failure);
  }
}

export async function spawnOwnedProcess(input: {
  spec: ProcessSpec;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  /** An enclosing guardian already owns this process group. */
  inheritProcessGroup?: boolean;
  maximumOutput: number;
  record(pid: number | undefined): Promise<void>;
}): Promise<ProcessHandle & { stop(): Promise<void> }> {
  input.signal?.throwIfAborted();
  if (input.spec.streamInput && input.spec.stdin !== undefined)
    throw new Error("Choose streamInput or stdin, not both");
  if (process.platform === "win32")
    throw new Error(
      "Local process supervision requires POSIX process groups; use a managed environment on Windows",
    );
  // Harnesses that inventory the same tree may supply their own random marker.
  const suppliedMarker = input.spec.environment?.["SUPERTAG_INTERNAL_PROCESS_MARKER"];
  if (
    suppliedMarker !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(suppliedMarker)
  )
    throw new Error("Invalid process marker");
  const processMarker = suppliedMarker ?? randomUUID();
  // Before the spawn: a root that exits before its first scan still bounds what it left.
  const since = ProcessDescendants.now();
  const child = spawn(input.spec.command, [...(input.spec.args ?? [])], {
    cwd: input.cwd,
    env: {
      ...input.environment,
      ...input.spec.environment,
      SUPERTAG_INTERNAL_PROCESS_MARKER: processMarker,
    },
    detached: !input.inheritProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const descendants = child.pid
    ? ProcessDescendants.start(child.pid, processMarker, since)
    : undefined;
  // A slow consumer pauses both pipes, so the child blocks on write instead of being killed.
  // Once the tree is confirmed gone, only bounded pipe contents remain: drain them freely.
  let pipesReleased = false;
  const readPipes = () => {
    child.stdout.resume();
    child.stderr.resume();
  };
  const releasePipes = () => {
    pipesReleased = true;
    readPipes();
  };
  const output = input.spec.streamOutput
    ? new ProcessOutputBuffer({
        pause: () => {
          if (pipesReleased) return;
          child.stdout.pause();
          child.stderr.pause();
        },
        resume: readPipes,
      })
    : undefined;
  const writer = input.spec.streamInput
    ? new ProcessInputWriter({
        write: (bytes) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
          ),
        end: () =>
          new Promise<void>((resolve, reject) => {
            child.stdin.once("error", reject);
            child.stdin.end(() => {
              child.stdin.removeListener("error", reject);
              resolve();
            });
          }),
      })
    : undefined;
  let stdout = "",
    stderr = "",
    stopped: Promise<void> | undefined,
    failure: unknown;
  let result: ProcessResult | undefined;
  const processBoundaryGone = () => {
    if (!child.pid) return true;
    if (input.inheritProcessGroup) return child.exitCode !== null || child.signalCode !== null;
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const send = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (input.inheritProcessGroup) {
      if (!processBoundaryGone()) child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const untilGone = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (processBoundaryGone() && (await descendants?.gone()) !== false) return true;
      await delay(20);
    }
    return processBoundaryGone() && (await descendants?.gone()) !== false;
  };
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      try {
        writer?.revoke();
        // Observe parentage before terminating the launcher, which may orphan a new session.
        let inspectionFailure: unknown;
        try {
          await descendants?.scan();
        } catch (error) {
          inspectionFailure = error;
        }
        send("SIGTERM");
        try {
          await descendants?.signalKnown("SIGTERM");
          if (!inspectionFailure && (await untilGone(500))) return;
        } catch (error) {
          inspectionFailure ??= error;
        }
        if (inspectionFailure) await delay(500);
        send("SIGKILL");
        try {
          await descendants?.signalKnown("SIGKILL");
          if (!inspectionFailure && (await untilGone(1500))) return;
        } catch (error) {
          inspectionFailure ??= error;
        }
        throw new ExecutionCleanupError("Process tree termination could not be confirmed", {
          cause: inspectionFailure,
        });
      } finally {
        // Signals reach a child blocked on a paused pipe; afterwards its remaining output must
        // flow so `close` can deliver it. A writer that escaped termination meets the hard cap.
        releasePipes();
        await descendants?.close();
      }
    })());
  const fail = (error: unknown) => {
    failure ??= error;
    void stop().catch((error) => {
      failure = error;
    });
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  for (const stream of ["stdout", "stderr"] as const)
    child[stream].on("data", (text: string) => {
      if (stream === "stdout") stdout = (stdout + text).slice(-input.maximumOutput);
      else stderr = (stderr + text).slice(-input.maximumOutput);
      try {
        output?.push({ stream, text });
      } catch (error) {
        fail(error);
      }
    });
  let exitResolve!: () => void;
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  child.once("error", (error) => {
    failure = error;
    exitResolve();
  });
  child.once("close", (exitCode, signal) => {
    result = { exitCode, ...(signal ? { signal } : {}), stdout, stderr };
    exitResolve();
  });
  // Root exit does not authorize leaving descendants running after the invocation.
  child.once("exit", () => {
    void stop().catch((error) => {
      failure = error;
    });
  });
  child.stdin.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(error);
  });
  const abort = () => fail(input.signal?.reason ?? new Error("Process cancelled"));
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    input.spec.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => fail(new Error(`Process exceeded its ${input.spec.timeoutMs}ms execution limit`)),
          input.spec.timeoutMs,
        );
  timer?.unref();
  if (!input.spec.streamInput) child.stdin.end(input.spec.stdin);
  const waited = (async () => {
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          // Cancellation's stop promise settles even if inherited pipes never close.
          const check = setInterval(() => {
            if (stopped) {
              clearInterval(check);
              void stopped.finally(resolve).catch(() => {});
            }
          }, 25);
          void exited.then(() => clearInterval(check));
        }),
      ]);
      if (stopped) await stopped;
      if (!processBoundaryGone() || (await descendants?.gone()) === false) await stop();
      if (failure) throw failure;
      if (!result) {
        // An escaped descendant may still hold an output pipe after its group is gone.
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              closeTimer = setTimeout(
                () =>
                  reject(
                    new ExecutionCleanupError(
                      "Process stopped but output pipe closure could not be confirmed",
                    ),
                  ),
                500,
              );
            }),
          ]);
        } finally {
          clearTimeout(closeTimer);
        }
      }
      if (!result) throw new Error("Process exited without a result");
      return { ...result, stdout, stderr };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      writer?.revoke(failure ?? new Error("Process exited"));
      output?.close(failure);
    }
  })();
  void waited.catch(() => {});
  try {
    await input.record(child.pid);
  } catch (error) {
    await stop();
    throw error;
  }
  if (input.signal?.aborted) abort();
  return {
    ...(child.pid ? { pid: child.pid } : {}),
    ...(output ? { output } : {}),
    ...(writer
      ? { write: (bytes: Uint8Array) => writer.write(bytes), endInput: () => writer.end() }
      : {}),
    wait: () => waited,
    stop,
    kill(signal = "SIGTERM") {
      if (signal === "SIGKILL") send(signal);
      fail(new Error("Process terminated"));
    },
  };
}
