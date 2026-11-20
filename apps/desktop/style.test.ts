import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("./src/style.css", import.meta.url), "utf8");

it("centres the command palette through the dialog's translate variables, which survive minifying", () => {
  // A built app's minifier dropped a plain `translate` on the palette, and a `transform` added
  // to the dialog's own translate(-50%, -50%): either pinned the palette to the window's top
  // left, while the dev server showed it centred.
  const rule = /\n\.command-palette \{([^}]*)\}/u.exec(css)?.[1] ?? "";
  expect(rule).toContain("--tw-translate-x: -50%;");
  expect(rule).toContain("--tw-translate-y: 0;");
  expect(rule).not.toMatch(/^\s*(translate|transform):/mu);
});

it("keeps the side pane under the top strip out of the window's drag region", () => {
  // A drag region takes clicks whatever is drawn above it, so without this the Task activity
  // and Tag details close buttons, under the top strip, move the window instead.
  expect(css).toMatch(/\.activity-frame \{\n\s+-webkit-app-region: no-drag;/);
});
