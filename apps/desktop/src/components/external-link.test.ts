// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const openExternal = vi.fn(async (_: { url: string }) => {});
Object.defineProperty(window, "supertag", { value: { openExternal }, configurable: true });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("opens web links from a Tag's message in the system browser and shows their host", async () => {
  const { Bubble } = await import("./conversation-entry");
  const { webHost } = await import("./external-link");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(Bubble, {
        text: "See [the run](https://ci.example.com/runs/7) or [write](mailto:ops@example.com).",
        markdown: true,
        className: "tag-message",
      }),
    ),
  );
  const link = host.querySelector("a.message-link") as HTMLAnchorElement;
  expect(link.title).toBe("ci.example.com");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  act(() => link.dispatchEvent(click));
  expect(click.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledWith({ url: "https://ci.example.com/runs/7" });
  // Only web links open; another kind shows as text.
  expect(host.querySelectorAll("a")).toHaveLength(1);
  expect(host.textContent).toContain("write");
  expect(webHost("javascript:alert(1)")).toBeUndefined();
  expect(webHost("http://localhost:8080/x")).toBe("localhost:8080");
  act(() => root.unmount());
  host.remove();
});
