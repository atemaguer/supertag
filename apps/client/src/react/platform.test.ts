// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "./platform";
import { usePolling } from "./polling";
import { useWatchRefresh } from "./watch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A front end that shows when `shown` says, and tells its one listener when that changes. */
function frontEnd(shown: boolean) {
  let listener: (() => void) | undefined;
  const platform: Platform = {
    visible: () => shown,
    onVisibilityChange(changed) {
      listener = changed;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    platform,
    listening: () => listener !== undefined,
    show(next: boolean) {
      shown = next;
      listener?.();
    },
  };
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (platform: Platform, child: ReactNode) =>
  act(() => root.render(createElement(PlatformProvider, { value: platform }, child)));

it("refreshes a view only while its front end shows", async () => {
  const screen = frontEnd(false);
  const read = vi.fn(async () => true);
  function View() {
    useWatchRefresh(read, 1_000, undefined, () => false);
    return null;
  }
  render(screen.platform, createElement(View));
  await act(async () => vi.advanceTimersByTimeAsync(2_500));
  expect(read).not.toHaveBeenCalled();
  await act(async () => screen.show(true));
  expect(read).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  expect(screen.listening()).toBe(false);
  root = createRoot(host);
});

it("polls once at once, then only while its front end shows", async () => {
  const screen = frontEnd(false);
  const read = vi.fn(async () => {});
  function View() {
    usePolling(read, 1_000);
    return null;
  }
  render(screen.platform, createElement(View));
  await act(async () => vi.advanceTimersByTimeAsync(2_500));
  expect(read).toHaveBeenCalledTimes(1);
  screen.show(true);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(read).toHaveBeenCalledTimes(2);
});

it("counts a front end without a Platform as always shown", async () => {
  const read = vi.fn(async () => true);
  function View() {
    useWatchRefresh(read, 1_000, undefined, () => false);
    return null;
  }
  act(() => root.render(createElement(View)));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(read).toHaveBeenCalledTimes(1);
});
