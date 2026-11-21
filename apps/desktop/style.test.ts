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

it("sets Tag names and headings in the display face, and leaves messages and code to Geist", () => {
  const rule = /\n((?:[^{}\n]+,\n)*[^{}\n]+) \{\n\s+font-family: var\(--display\);/u.exec(css);
  const selectors = (rule?.[1] ?? "").split(",\n").map((selector) => selector.trim());
  expect(selectors).toEqual([
    ".lead-name",
    ".tag-row-name",
    ".tag-name",
    ".empty h2",
    ".activity h2",
    '[data-slot="dialog-title"]',
  ]);
  // Only that rule names the display face.
  expect(css.match(/var\(--display\)/gu)).toHaveLength(1);
});

it("marks the open Tag's row with a fill alone, without a border", () => {
  const rule =
    /\n\.lead-tag\[aria-current="true"\],\n\.tag-row\[aria-current="true"\] \{([^}]*)\}/u.exec(
      css,
    )?.[1];
  expect(rule).toContain("background: var(--selected);");
  expect(rule).not.toContain("border");
});

it("pins the update banner to the bottom right corner, above the composer and under dialogs", () => {
  const rule = /\n\.update-banner \{([^}]*)\}/u.exec(css)?.[1] ?? "";
  expect(rule).toContain("position: fixed;");
  expect(rule).toMatch(/^\s+right: 18px;$/mu);
  // The composer is about 86px tall with its footer; the banner clears its send button.
  expect(rule).toMatch(/^\s+bottom: 100px;$/mu);
  // Dialogs sit at z-index 50 (components/ui/dialog.tsx); the banner stays below them.
  const z = Number(/z-index: (\d+);/u.exec(rule)?.[1]);
  expect(z).toBeGreaterThan(0);
  expect(z).toBeLessThan(50);
});
