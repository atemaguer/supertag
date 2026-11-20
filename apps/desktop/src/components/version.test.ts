// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import packageJson from "../../package.json";
import { APP_VERSION, VersionLabel, versionText } from "./version";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function label(props: Parameters<typeof VersionLabel>[0]) {
  act(() => root.render(createElement(VersionLabel, props)));
  const element = host.querySelector(".sidebar-version") as HTMLElement;
  const shown = element.querySelector("[aria-hidden]") as HTMLElement;
  return { element, shown };
}

it("names the app's release from its package", () => {
  expect(APP_VERSION).toBe(packageJson.version);
});

it("names only the app's release when the Gateway runs the same one", () => {
  const { element, shown } = label({
    app: "0.3.4",
    gateway: { build: "0.3.4", protocol: 7 },
    wide: true,
  });
  expect(shown.textContent).toBe("SuperTag 0.3.4");
  expect(element.title).toBe("SuperTag 0.3.4\nGateway 0.3.4\nProtocol 7");
  expect(element.querySelector(".visually-hidden")?.textContent).toBe(
    "SuperTag 0.3.4, Gateway 0.3.4, Protocol 7",
  );
});

it("names the Gateway's release when it differs", () => {
  const gateway = { build: "0.3.3", protocol: 7 };
  const { element, shown } = label({ app: "0.3.4", gateway, wide: true });
  expect(shown.textContent).toBe("SuperTag 0.3.4 · Gateway 0.3.3");
  expect(element.title).toBe("SuperTag 0.3.4\nGateway 0.3.3\nProtocol 7");
  // The rail has room for the two numbers only, one a line.
  const rail = label({ app: "0.3.4", gateway, wide: false });
  expect([...rail.shown.children].map((line) => line.textContent)).toEqual(["0.3.4", "0.3.3"]);
});

it("names only the app's release while disconnected", () => {
  const { element, shown } = label({ app: "0.3.4", wide: true });
  expect(shown.textContent).toBe("SuperTag 0.3.4");
  expect(element.title).toBe("SuperTag 0.3.4\nNot connected to a Gateway");
  expect(label({ app: "0.3.4", wide: false }).shown.textContent).toBe("0.3.4");
});

it("leaves out a protocol version that was never agreed", () => {
  expect(versionText("0.3.4", { build: "unknown", protocol: 0 }).detail).toBe(
    "SuperTag 0.3.4\nGateway unknown",
  );
});
