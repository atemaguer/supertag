import { useEffect } from "react";

export function usePolling(read: (signal: AbortSignal) => Promise<void>, interval: number) {
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll(initial = false) {
      if (initial || !document.hidden) await read(controller.signal);
      if (!controller.signal.aborted) {
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
  return error instanceof Error ? error.message : "The Control Plane request failed.";
}
