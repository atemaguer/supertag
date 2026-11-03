import { expect, it } from "vitest";
import { parseWorkspaceSpec } from "./src/workspace.js";

it("accepts an explicit Workspace MCP allowlist and rejects duplicate or malformed names", () => {
  expect(parseWorkspaceSpec({ mcp: ["sentry", "internal-db"] })).toEqual({
    mcp: ["sentry", "internal-db"],
    delivery: "branch",
  });
  expect(() => parseWorkspaceSpec({ mcp: ["sentry", "sentry"] })).toThrow(/distinct server names/u);
  expect(() => parseWorkspaceSpec({ mcp: ["../server"] })).toThrow(/distinct server names/u);
  expect(() => parseWorkspaceSpec({ mcp: "sentry" })).toThrow(/distinct server names/u);
});

it("Workspace Skills require distinct safe names", () => {
  expect(parseWorkspaceSpec({ skills: ["docs-conventions"] }).skills).toEqual(["docs-conventions"]);
  expect(() => parseWorkspaceSpec({ skills: ["docs", "docs"] })).toThrow(/distinct Skill names/u);
  expect(() => parseWorkspaceSpec({ skills: ["../outside"] })).toThrow(/distinct Skill names/u);
});

it("validates a GitHub Skill catalog without accepting credential-bearing URLs or unsafe paths", () => {
  const catalog = {
    repository: "acme/skills",
    path: "catalog/agents",
    revision: "main",
    skills: ["review"],
  };
  expect(parseWorkspaceSpec({ skillCatalog: catalog }).skillCatalog).toEqual(catalog);
  expect(() =>
    parseWorkspaceSpec({
      skillCatalog: { ...catalog, repository: "https://user:token@github.com/acme/skills" },
    }),
  ).toThrow(/OWNER\/REPO/u);
  expect(() => parseWorkspaceSpec({ skillCatalog: { ...catalog, path: "../private" } })).toThrow(
    /relative directory/u,
  );
  expect(() => parseWorkspaceSpec({ skillCatalog: { ...catalog, revision: "bad ref" } })).toThrow(
    /revision/u,
  );
  expect(() =>
    parseWorkspaceSpec({ skillCatalog: { ...catalog, skills: ["review", "review"] } }),
  ).toThrow(/distinct Skill names/u);
  expect(() => parseWorkspaceSpec({ skills: ["review"], skillCatalog: catalog })).toThrow(
    /distinct across/u,
  );
});
