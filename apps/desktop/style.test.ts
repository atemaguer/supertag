import { readdirSync, readFileSync } from "node:fs";
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

it("keeps the update banner above the page and under dialogs", () => {
  const rule = /\n\.update-banner \{([^}]*)\}/u.exec(css)?.[1] ?? "";
  expect(rule).toContain("position: fixed;");
  // Dialogs sit at z-index 50 (components/ui/dialog.tsx); the banner stays below them.
  const z = Number(/z-index: (\d+);/u.exec(rule)?.[1]);
  expect(z).toBeGreaterThan(0);
  expect(z).toBeLessThan(50);
});

it("styles every class a component names", () => {
  // A deleted block of rules once left the Gateway menu unstyled: transparent, its icons and
  // text unlaid-out. Classes here are named in a component and deliberately have no rule.
  const hooks = new Set(["task-file-view", "palette-row", "shortcuts-dialog", "avatar-monogram"]);
  const directory = new URL("./src/components/", import.meta.url);
  const unstyled: string[] = [];
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".tsx")) continue;
    const source = readFileSync(new URL(file, directory), "utf8");
    for (const [, plain, template] of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/gu)) {
      const names = (plain ?? template ?? "").replace(/\$\{[^}]*\}/gu, " ").split(/\s+/u);
      for (const name of names) {
        if (!name || hooks.has(name)) continue;
        if (!css.includes(`.${name}`)) unstyled.push(`${file}: ${name}`);
      }
    }
  }
  expect(unstyled).toEqual([]);
});

it("keeps the update button its own size in the rail, whose foot is a column", () => {
  const rail = /\.shell\[data-sidebar="rail"\] \.sidebar-foot \.sidebar-update \{([^}]*)\}/u.exec(
    css,
  )?.[1];
  expect(rail).toContain("flex: none");
  expect(rail).toContain("margin-bottom: 0");
});
