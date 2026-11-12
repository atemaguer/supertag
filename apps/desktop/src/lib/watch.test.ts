import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchUpdate } from "../gateway";
import { attachWatch, watchFeed, watchReader } from "./watch";

const visible = () => true;
const changed = (update: WatchUpdate) =>
  update.kind === "conversation" && update.tagId === "lead" && update.conversation === "planning";
const planning = { kind: "conversation", tagId: "lead", conversation: "planning" } as const;

afterEach(() => vi.useRealTimers());

describe("Gateway Watch lifecycle", () => {
  it("stops a late registration and ignores its queued frames", async () => {
    let receive: ((update: WatchUpdate) => void) | undefined;
    let registered: ((stop: () => Promise<void>) => void) | undefined;
    const stop = vi.fn(async () => {});
    const publish = vi.fn();
    const close = attachWatch((handler) => {
      receive = handler;
      return new Promise((resolve) => {
        registered = resolve;
      });
    }, publish);
    receive?.({ kind: "ready" });
    close();
    receive?.(planning);
    registered?.(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(publish.mock.calls).toEqual([[{ kind: "ready" }]]);
  });

  it("coalesces scoped notices, replays on resync and polls only during loss", async () => {
    vi.useFakeTimers();
    const feed = watchFeed();
    let finish: ((outcome: boolean) => void) | undefined;
    const read = vi
      .fn(async () => true)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const view = watchReader(read, 100, feed, changed, visible);
    expect(read).toHaveBeenCalledOnce();
    feed.publish({ kind: "ready" });
    feed.publish(planning);
    feed.publish(planning);
    expect(read).toHaveBeenCalledOnce();
    finish?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    feed.publish({ ...planning, conversation: "another" });
    feed.publish({ ...planning, tagId: "someone-else" });
    feed.publish({ kind: "tag" });
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(2);
    feed.publish({ kind: "lost" });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(4);
    feed.publish({ kind: "resync" });
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(5);
    view.close();
    feed.publish(planning);
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("retries failed reads and keeps independent activity polling while Watch is live", async () => {
    vi.useFakeTimers();
    const feed = watchFeed();
    feed.publish({ kind: "ready" });
    const read = vi.fn(async () => true).mockResolvedValueOnce(false);
    const activity = vi.fn(async () => true);
    const view = watchReader(read, 100, feed, changed, visible);
    const unwatched = watchReader(activity, 100, undefined, () => false, visible);
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenCalledTimes(4);
    view.close();
    unwatched.close();
  });

  it("aborts a reader on unmount even while it is waiting for IPC", async () => {
    vi.useFakeTimers();
    const feed = watchFeed();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const read = vi.fn(async (current: AbortSignal) => {
      signal = current;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return true;
    });
    const view = watchReader(read, 100, feed, changed, visible);
    view.close();
    finish?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(signal?.aborted).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });
});
