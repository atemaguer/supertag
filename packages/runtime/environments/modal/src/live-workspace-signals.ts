import type { LiveWorkspaceLedger } from "./live-workspace-ledger.js";

export function installLiveWorkspaceSignalCleanup(
  processLike: {
    on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void): unknown;
    exit(code: number): never;
  },
  ledger: Pick<LiveWorkspaceLedger, "cleanup" | "settled" | "remaining">,
  log: (message: string) => void,
): void {
  let signals = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    processLike.on(signal, () => {
      signals++;
      const exitCode = signal === "SIGINT" ? 130 : 143;
      if (signals > 1) {
        log(`remaining ${JSON.stringify(ledger.remaining)}`);
        processLike.exit(exitCode);
        return;
      }
      void ledger
        .cleanup()
        // Resources created while cleanup ran are removed before the process exits.
        .finally(() => ledger.settled())
        .catch((error: unknown) => log(String(error)))
        .finally(() => {
          log(`remaining ${JSON.stringify(ledger.remaining)}`);
          processLike.exit(exitCode);
        });
    });
  }
}
