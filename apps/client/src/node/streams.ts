/**
 * What the Watch and conversation follows share: reading one server stream with an idle limit,
 * and waiting out a retry unless stopped.
 */
import { codeOf } from "./errors";
import { Code } from "./sdk";

export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;
/** How long a stream may go without a frame, heartbeats included. */
export const IDLE_MS = 45_000;

/** Where a stream's updates go; `send` is false once nobody receives them. */
export interface Updates<U> {
  send(update: U): boolean;
}

/** The window stopped receiving: the stream ends without retrying. */
export class Closed extends Error {}

/** How one attempt at a stream ended. */
export type Ended = { stopped: true } | { stopped: false; code: Code };

/**
 * Opens `open(signal)` and hands each frame to `frame` until the stream ends, `stop` aborts, or
 * no frame arrives within `idleMs`. A stream that ends cleanly or goes quiet counts as
 * unavailable. No unary deadline is sent: a stream stays open through quiet intervals.
 */
export async function readStream<F>(
  open: (signal: AbortSignal) => AsyncIterable<F>,
  frame: (value: F) => void,
  stop: AbortSignal,
  idleMs: number,
): Promise<Ended> {
  if (stop.aborted) return { stopped: true };
  const attempt = new AbortController();
  const abort = () => attempt.abort();
  stop.addEventListener("abort", abort, { once: true });
  let idle = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      attempt.abort();
    }, idleMs);
  };
  try {
    arm();
    for await (const value of open(attempt.signal)) {
      arm();
      frame(value);
    }
    return { stopped: false, code: Code.Unavailable };
  } catch (error) {
    if (error instanceof Closed) throw error;
    if (stop.aborted) return { stopped: true };
    if (idle) return { stopped: false, code: Code.Unavailable };
    return { stopped: false, code: codeOf(error) };
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
    attempt.abort();
  }
}

/** Waits `ms`, or less if `stop` aborts; true when it was stopped. */
export function pause(ms: number, stop: AbortSignal): Promise<boolean> {
  if (stop.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve(stop.aborted);
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener("abort", done, { once: true });
  });
}

/** Codes a stream does not retry: the credential, the caller's rights, or the request is wrong. */
export function fatal(code: Code): boolean {
  return (
    code === Code.Unauthenticated ||
    code === Code.PermissionDenied ||
    code === Code.Unimplemented ||
    code === Code.InvalidArgument
  );
}
