import { useEffect } from "react";
import { usePlatform } from "./platform";

/** Reads at once, then every `interval` while the front end shows; once when it is undefined. */
export function usePolling(read: (signal: AbortSignal) => Promise<void>, interval?: number) {
  const platform = usePlatform();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(initial = false) {
      if (initial || platform.visible()) await read(controller.signal);
      if (!controller.signal.aborted && interval !== undefined) {
        timer = setTimeout(() => void poll(), interval);
      }
    }
    void poll(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [read, interval, platform]);
}
