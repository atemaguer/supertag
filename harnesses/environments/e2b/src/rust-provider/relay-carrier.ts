/**
 * The egress relay's carrier on E2B: one background root command whose standard input and output
 * carry the relay's line protocol (see `egress-relay.ts` in the worker SDK).
 *
 * E2B's SDK fits with two adjustments. Every `sendStdin` is its own request, so lines that queue
 * while one is in flight go out together in the next. And the SDK's command handle keeps every
 * byte of standard output it ever delivered, in a private `_stdout`, for the command's result:
 * over a relay's lifetime that is all the Task sent. The carrier empties it after each chunk; a
 * handle without that field (a changed SDK) is refused before the relay is used, and a byte
 * budget ends the relay should releasing ever stop working unnoticed.
 *
 * Proven against a test double that runs the real relay program, never against live E2B.
 */
import { shellQuote } from "../sandbox.js";

/** The most the carrier sends in one `sendStdin`. */
export const RELAY_STDIN_BATCH_BYTES = 1 << 20;
/** The relay's standard output a carrier takes before it ends the relay: a backstop. */
export const RELAY_OUTPUT_BUDGET_BYTES = 1 << 30;

/** What the carrier uses of the SDK's command handle. */
export interface RelayCommandHandle {
  sendStdin(data: string): Promise<void>;
  kill(): Promise<unknown>;
  wait(): Promise<unknown>;
}

/** The options the carrier passes to `Commands.run`. */
export interface RelayRunOptions {
  readonly cwd: string;
  readonly user: "root";
  readonly background: true;
  readonly stdin: true;
  readonly timeoutMs: 0;
  onStdout(this: unknown, text: string): void;
  onStderr(this: unknown, text: string): void;
}

/** `Commands.run` in its background form. */
export type RelayRun = (command: string, options: RelayRunOptions) => Promise<RelayCommandHandle>;

export interface RelayCommand {
  write(text: string): Promise<void>;
  kill(): Promise<void>;
  /** Settles when the command ended, for any reason. */
  readonly ended: Promise<void>;
}

/** Whether `handle` keeps its output where the carrier can release it. */
export function releasableOutput(handle: unknown): boolean {
  const retained = handle as { _stdout?: unknown; _stderr?: unknown } | null;
  return typeof retained?._stdout === "string" && typeof retained._stderr === "string";
}

/** Empties what the handle kept of its output; the SDK calls the callbacks with it as `this`. */
function release(handle: unknown): void {
  if (!releasableOutput(handle)) return;
  const retained = handle as { _stdout: string; _stderr: string };
  retained._stdout = "";
  retained._stderr = "";
}

/**
 * Sends text in order, at most one request at a time: what is written while one is in flight
 * goes out together, up to `maxBytes`, in the next. A write resolves once its text is taken
 * into a batch, and waits while the next batch is full, so the caller's own backpressure holds.
 * After a failed send, every write rejects.
 */
export function batchedWriter(
  send: (text: string) => Promise<void>,
  maxBytes = RELAY_STDIN_BATCH_BYTES,
): (text: string) => Promise<void> {
  let next: string[] = [];
  let nextBytes = 0;
  let sending = false;
  let failure: unknown;
  let room = Promise.withResolvers<void>();
  const wake = () => {
    room.resolve();
    room = Promise.withResolvers<void>();
  };
  async function pump(): Promise<void> {
    sending = true;
    try {
      while (next.length > 0) {
        const batch = next.join("");
        next = [];
        nextBytes = 0;
        wake();
        await send(batch);
      }
    } catch (error) {
      failure = error ?? new Error("Relay input failed");
    } finally {
      sending = false;
      wake();
    }
  }
  return async (text) => {
    for (;;) {
      if (failure !== undefined) throw failure;
      if (nextBytes === 0 || nextBytes + text.length <= maxBytes) break;
      await room.promise;
    }
    next.push(text);
    nextBytes += text.length;
    if (!sending) void pump();
  };
}

/** Starts `argv` as a background root command that carries the relay. */
export async function startE2BRelayCommand(
  run: RelayRun,
  argv: readonly string[],
  onStdout: (text: string) => void,
  limits: { readonly outputBudget?: number; readonly batchBytes?: number } = {},
): Promise<RelayCommand> {
  const budget = limits.outputBudget ?? RELAY_OUTPUT_BUDGET_BYTES;
  let received = 0;
  let spent = false;
  let handle: RelayCommandHandle | undefined;
  const ended = Promise.withResolvers<void>();
  const kill = async () => {
    await handle?.kill();
  };
  handle = await run(argv.map(shellQuote).join(" "), {
    cwd: "/tmp",
    user: "root",
    background: true,
    stdin: true,
    // The relay lives as long as the sandbox: no command timeout.
    timeoutMs: 0,
    onStdout(text) {
      release(this);
      if (spent) return;
      received += text.length;
      if (received > budget) {
        spent = true;
        void kill().catch(() => undefined);
        ended.resolve();
        return;
      }
      onStdout(text);
    },
    onStderr() {
      release(this);
    },
  });
  if (!releasableOutput(handle)) {
    await handle.kill().catch(() => undefined);
    throw new Error("The E2B command handle no longer releases its output; the relay is refused");
  }
  void handle.wait().then(
    () => ended.resolve(),
    () => ended.resolve(),
  );
  const command = handle;
  return {
    write: batchedWriter((text) => command.sendStdin(text), limits.batchBytes),
    kill,
    ended: ended.promise,
  };
}
