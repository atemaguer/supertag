import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sdk = JSON.parse(
  readFileSync(new URL("../packages/supertag-ai/package.json", import.meta.url), "utf8"),
);

describe("installing the CLI from a checkout", () => {
  it("builds the referenced workspace projects before bundling even when built directly", () => {
    const steps = sdk.scripts.build.split(" && ");
    expect(steps[0]).toBe("pnpm --workspace-root exec tsc --build");
    expect(steps.indexOf("tsup")).toBeGreaterThan(0);
    expect(steps.at(-1)).toBe("node scripts/copy-migrations.mjs");
  });

  it("installs dependencies and builds before creating the global CLI link", () => {
    expect(root.scripts["install:cli"].split(" && ")).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm --filter supertag-ai build",
      "pnpm --filter supertag-ai exec npm link",
    ]);
  });

  it("removes the global package without removing local state or the checkout", () => {
    expect(root.scripts["uninstall:cli"]).toBe("npm uninstall --global supertag-ai");
  });
});
