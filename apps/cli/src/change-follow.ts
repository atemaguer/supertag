import { Code, ConnectError } from "@connectrpc/connect";
import type { WatchChange, WatchKind } from "@supertag/operator-api";
import type { eventClient } from "./operator-client.js";

type EventClient = Pick<ReturnType<typeof eventClient>, "watch">;

/** What a reread asks for next: stop following, reread after `retryMs` anyway, or wait. */
export type RefreshResult = "stop" | "poll" | undefined;

export interface ChangeFollowOptions {
  readonly kinds: readonly WatchKind[];
  readonly signal: AbortSignal;
  /** Whether a change notice can alter what `refresh` shows; every notice when omitted. */
  readonly matches?: (change: WatchChange) => boolean;
  /**
   * Rereads what the follower shows. It runs once the stream is open, then after each matching
   * change or resynchronization, never twice at once; changes that arrive while it runs make one
   * more reread. A failure it throws ends the follow.
   */
  readonly refresh: () => Promise<RefreshResult>;
  /** Receives a line when the stream breaks and reconnects. */
  readonly warn?: (text: string) => void;
  /** How long to wait before reconnecting, and before a reread `refresh` asked to poll. */
  readonly retryMs?: number;
}

/**
 * Follows changes with `EventService.Watch` instead of polling: the stream says when something
 * changed, and `refresh` rereads it. A broken stream reconnects from its resume token, so no
 * change is missed; one that cannot resume rereads everything.
 */
export async function followChanges(events: EventClient, options: ChangeFollowOptions) {
  const retryMs = options.retryMs ?? 1_000;
  const stream = new AbortController();
  const stop = () => stream.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  let pending = false;
  let wake: (() => void) | undefined;
  const changed = () => {
    pending = true;
    wake?.();
  };
  let failure: { readonly error: unknown } | undefined;

  const rereading = (async () => {
    while (!stream.signal.aborted) {
      if (!pending) {
        await new Promise<void>((resolve) => {
          const done = () => {
            stream.signal.removeEventListener("abort", done);
            wake = undefined;
            resolve();
          };
          wake = done;
          stream.signal.addEventListener("abort", done, { once: true });
        });
        continue;
      }
      pending = false;
      let result: RefreshResult;
      try {
        result = await options.refresh();
      } catch (error) {
        failure = { error };
        stream.abort();
        return;
      }
      if (result === "stop") {
        stream.abort();
        return;
      }
      if (result === "poll")
        void pause(stream.signal, retryMs).then(() => {
          if (!stream.signal.aborted) changed();
        });
    }
  })();

  let resumeToken = "";
  try {
    while (!stream.signal.aborted) {
      try {
        for await (const event of events.watch(
          { kinds: [...options.kinds], resumeToken },
          { signal: stream.signal, timeoutMs: 0 },
        )) {
          const first = resumeToken === "";
          resumeToken = event.resumeToken;
          if (event.event.case === "change") {
            if (options.matches?.(event.event.value) ?? true) changed();
          } else if (event.event.case === "resync" || first) changed();
        }
      } catch (error) {
        if (stream.signal.aborted) break;
        if (
          error instanceof ConnectError &&
          [Code.Unauthenticated, Code.PermissionDenied, Code.Unimplemented].includes(error.code)
        )
          throw error;
        if (error instanceof ConnectError && error.code === Code.InvalidArgument) resumeToken = "";
        options.warn?.(
          `The change stream broke and reconnects: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      await pause(stream.signal, retryMs);
    }
  } finally {
    stream.abort();
    options.signal.removeEventListener("abort", stop);
    await rereading;
  }
  if (failure !== undefined) throw failure.error;
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
