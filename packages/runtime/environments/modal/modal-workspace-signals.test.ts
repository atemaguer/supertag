import { describe, expect, it, vi } from "vitest";
import { installLiveWorkspaceSignalCleanup } from "./src/live-workspace-signals.ts";

describe("live Modal cleanup signals", () => {
  it("runs cleanup once and exits 130 after SIGINT", async () => {
    const handlers = new Map<string, () => void>();
    const exit = vi.fn((_code: number): never => {
      return undefined as never;
    });
    const log = vi.fn();
    const cleanup = vi.fn(async () => {});
    installLiveWorkspaceSignalCleanup(
      {
        on: (signal, handler) => {
          handlers.set(signal, handler);
        },
        exit,
      },
      { cleanup, settled: async () => {}, remaining: { sandboxes: [], images: [] } },
      log,
    );
    handlers.get("SIGINT")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("prints remaining IDs and exits 143 on a second signal", () => {
    const handlers = new Map<string, () => void>();
    const exit = vi.fn((_code: number): never => {
      return undefined as never;
    });
    const log = vi.fn();
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    installLiveWorkspaceSignalCleanup(
      {
        on: (signal, handler) => {
          handlers.set(signal, handler);
        },
        exit,
      },
      { cleanup, settled: async () => {}, remaining: { sandboxes: ["sb-1"], images: ["im-1"] } },
      log,
    );
    handlers.get("SIGTERM")?.();
    handlers.get("SIGHUP")?.();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(143);
    expect(log).toHaveBeenCalledWith('remaining {"sandboxes":["sb-1"],"images":["im-1"]}');
  });
});
