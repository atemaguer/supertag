import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LocalUpgradeOffer, restartStatus } from "./local-upgrade";
import { EmptyWorkspace } from "./workspace";

const upgrade = { running: "0.3.0", version: "0.3.1" };

it("offers to restart an older local SuperTag with the app's version", () => {
  const html = renderToStaticMarkup(
    createElement(LocalUpgradeOffer, { upgrade, onRestart: () => {} }),
  );
  expect(html).toContain("This machine runs SuperTag 0.3.0, but this app is 0.3.1.");
  expect(html).toContain("Restart SuperTag with 0.3.1</button>");
  expect(html).not.toContain('role="alert"');
});

it("shows each restart step, then what the CLI printed when it failed", () => {
  expect(restartStatus("stopping", upgrade)).toBe("Stopping SuperTag 0.3.0…");
  expect(restartStatus("starting", upgrade)).toBe("Starting SuperTag 0.3.1…");
  const running = renderToStaticMarkup(
    createElement(LocalUpgradeOffer, { upgrade, step: "starting", onRestart: () => {} }),
  );
  expect(running).toContain('role="status">Starting SuperTag 0.3.1…');
  expect(running).not.toContain("<button");
  const failed = renderToStaticMarkup(
    createElement(LocalUpgradeOffer, {
      upgrade,
      error: "Could not start SuperTag:\nError: no Node\nLogs: /tmp/state/logs",
      onRestart: () => {},
    }),
  );
  expect(failed).toContain('role="alert">Could not start SuperTag:\nError: no Node');
  expect(failed).toContain("Restart SuperTag with 0.3.1</button>");
});

it("puts the restart offer in place of Connect to Local", () => {
  const offer = createElement(LocalUpgradeOffer, { upgrade, onRestart: () => {} });
  const html = renderToStaticMarkup(
    createElement(EmptyWorkspace, { onLocal: () => {}, localUpgrade: offer }),
  );
  expect(html).toContain("Restart SuperTag with 0.3.1");
  expect(html).not.toContain("Connect to Local");
  const plain = renderToStaticMarkup(createElement(EmptyWorkspace, { onLocal: () => {} }));
  expect(plain).toContain("Connect to Local");
});
