import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WatchUpdate } from "../model/gateway";
import { usePlatform } from "./platform";

type Listener = (update: WatchUpdate) => void;
type Stop = () => Promise<void>;
type Read = (signal: AbortSignal) => Promise<boolean | undefined>;

export interface WatchFeed {
  live(): boolean;
  subscribe(listener: Listener): () => void;
}

export function watchFeed() {
  const listeners = new Set<Listener>();
  let live = false;
  return {
    live: () => live,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(update: WatchUpdate) {
      if (update.kind === "ready" || update.kind === "resync") live = true;
      if (update.kind === "lost") live = false;
      for (const listener of listeners) listener(update);
    },
  };
}

export function attachWatch(start: (receive: Listener) => Promise<Stop>, publish: Listener) {
  let closed = false;
  const watching = start((update) => {
    if (!closed) publish(update);
  });
  void watching.catch(() => {
    if (!closed) publish({ kind: "lost" });
  });
  return () => {
    closed = true;
    // Cleanup can race the IPC registration. Stop only the returned
    // subscription, once it exists, and ignore any queued frames.
    void watching.then((stop) => stop()).catch(() => {});
  };
}

let nextWatchEpoch = 0;

/**
 * Starts a Gateway's Watch for a connection: `(connectionId, watchEpoch, receive)` opens it and
 * resolves to its stop. Each mount gets a new epoch, so the backend tells a restarted watch from
 * a late one.
 */
export type StartWatch = (
  connectionId: string,
  watchEpoch: number,
  receive: Listener,
) => Promise<Stop>;

/** The connection's Watch as a feed, opened with `start`, which must not change per render. */
export function useGatewayWatch(start: StartWatch, connectionId?: string): WatchFeed | undefined {
  const feed = useMemo(() => (connectionId ? watchFeed() : undefined), [connectionId]);
  useEffect(() => {
    if (!connectionId || !feed) return;
    const epoch = ++nextWatchEpoch;
    return attachWatch((receive) => start(connectionId, epoch, receive), feed.publish);
  }, [start, connectionId, feed]);
  return feed;
}

// One reader per mounted view. A burst during a read schedules one more read.
// A stream interruption or a failed read keeps the ordinary polling path armed.
export function watchReader(
  read: Read,
  interval: number,
  feed: WatchFeed | undefined,
  affected: (update: WatchUpdate) => boolean,
  visible: () => boolean,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let dirty = false;
  let retry = false;

  function schedule() {
    clearTimeout(timer);
    if (!controller.signal.aborted && (!feed?.live() || retry)) {
      timer = setTimeout(request, interval);
    }
  }

  async function refresh() {
    if (controller.signal.aborted || busy || !dirty) return;
    if (!visible()) {
      schedule();
      return;
    }
    busy = true;
    dirty = false;
    try {
      retry = (await read(controller.signal)) === false;
    } catch {
      retry = true;
    } finally {
      busy = false;
      if (dirty && !controller.signal.aborted) void refresh();
      else schedule();
    }
  }

  function request() {
    dirty = true;
    clearTimeout(timer);
    void refresh();
  }

  const unsubscribe = feed?.subscribe((update) => {
    if (
      update.kind === "ready" ||
      update.kind === "resync" ||
      update.kind === "lost" ||
      affected(update)
    ) {
      request();
    }
  });
  request();
  return {
    request,
    close() {
      unsubscribe?.();
      controller.abort();
      clearTimeout(timer);
    },
  };
}

/**
 * Keeps `read` current through the watch. A view reads only while the front end shows; with
 * `background`, it reads while hidden too, as notifications need.
 */
export function useWatchRefresh(
  read: Read,
  interval: number,
  feed: WatchFeed | undefined,
  affected: (update: WatchUpdate) => boolean,
  background = false,
) {
  const platform = usePlatform();
  const active = useRef<ReturnType<typeof watchReader> | undefined>(undefined);
  useEffect(() => {
    const reader = watchReader(
      read,
      interval,
      feed,
      affected,
      () => background || platform.visible(),
    );
    active.current = reader;
    const stop = platform.onVisibilityChange(() => {
      if (platform.visible()) reader.request();
    });
    return () => {
      active.current = undefined;
      stop();
      reader.close();
    };
  }, [read, interval, feed, affected, background, platform]);
  return useCallback(() => active.current?.request(), []);
}
