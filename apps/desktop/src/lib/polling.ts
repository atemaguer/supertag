import { useEffect } from "react";

/** Reads at once, then every `interval` while the window is visible; once when it is undefined. */
export function usePolling(read: (signal: AbortSignal) => Promise<void>, interval?: number) {
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll(initial = false) {
      if (initial || !document.hidden) await read(controller.signal);
      if (!controller.signal.aborted && interval !== undefined) {
        timer = window.setTimeout(() => void poll(), interval);
      }
    }
    void poll(true);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [read, interval]);
}

export function describe(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "The Gateway request failed.";
}
