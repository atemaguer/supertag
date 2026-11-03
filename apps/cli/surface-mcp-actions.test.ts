import { describe, expect, it } from "vitest";
import { validateSurfaceActions } from "./src/tag-administration.ts";

describe("GitHub and Slack tool grants", () => {
  it("requires MCP grants for former surface tool actions", () => {
    expect(() => validateSurfaceActions("slack", ["history:read"])).toThrow(
      "Grant tools with target: mcp instead",
    );
    expect(() => validateSurfaceActions("slack", ["messages:send"])).toThrow(
      "Grant tools with target: mcp instead",
    );
    expect(() => validateSurfaceActions("github", ["pull-requests:merge"])).toThrow(
      "Grant tools with target: mcp instead",
    );
  });

  it("keeps the GitHub permissions used for Workspace source and delivery", () => {
    expect(() =>
      validateSurfaceActions("github", ["contents:read", "pull-requests:create"]),
    ).not.toThrow();
  });
});
