import { useCallback, useEffect, useMemo, useRef } from "react";
import { nativeControlPlane, type WatchUpdate } from "../control-plane";

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

export function useControlPlaneWatch(connectionId?: string): WatchFeed | undefined {
  const feed = useMemo(() => (connectionId ? watchFeed() : undefined), [connectionId]);
  useEffect(() => {
    if (!connectionId || !feed) return;
    const epoch = ++nextWatchEpoch;
    return attachWatch(
      (receive) => nativeControlPlane.watch(connectionId, epoch, receive),
      feed.publish,
    );
  }, [connectionId, feed]);
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

export function useWatchRefresh(
  read: Read,
  interval: number,
  feed: WatchFeed | undefined,
  affected: (update: WatchUpdate) => boolean,
) {
  const active = useRef<ReturnType<typeof watchReader> | undefined>(undefined);
  useEffect(() => {
    const reader = watchReader(read, interval, feed, affected, () => !document.hidden);
    active.current = reader;
    const visible = () => {
      if (!document.hidden) reader.request();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active.current = undefined;
      document.removeEventListener("visibilitychange", visible);
      reader.close();
    };
  }, [read, interval, feed, affected]);
  return useCallback(() => active.current?.request(), []);
}
