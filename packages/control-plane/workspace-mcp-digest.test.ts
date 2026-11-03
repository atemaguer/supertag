import type { TaskAttempt } from "@supertag/core";
import type { TaskAttemptEvent } from "@supertag/worker-sdk";
import { expect, it } from "vitest";
import { workspaceMcpDigest, workspaceMcpPin } from "./src/workspace-mcp-digest.js";

it("selects only the host Workspace digest from a runtime input event", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const event = {
    type: "runtime-inputs.resolved",
    manifest: {
      inputs: [
        {
          kind: "workspace",
          resource: { provenance: { provider: "supertag-workspace", mcpServersDigest: digest } },
        },
        {
          kind: "workspace",
          resource: {
            provenance: { provider: "untrusted", mcpServersDigest: `sha256:${"b".repeat(64)}` },
          },
        },
      ],
    },
  } as unknown as TaskAttemptEvent;
  expect(workspaceMcpDigest(event)).toBe(digest);
});

it("reads the digest a Worker reports before starting any Workspace MCP server", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  const event = (value: string) =>
    ({ type: "workspace.mcp.resolved", digest: value }) as unknown as TaskAttemptEvent;
  expect(workspaceMcpDigest(event(digest))).toBe(digest);
  expect(workspaceMcpDigest(event("not-a-digest"))).toBeUndefined();
});

it("pins the digest the Task's first reporting Attempt recorded", () => {
  const attempt = (attemptNumber: number, mcpServersDigest?: string) =>
    ({
      attemptNumber,
      ...(mcpServersDigest === undefined ? {} : { mcpServersDigest }),
    }) as TaskAttempt;
  const first = `sha256:${"1".repeat(64)}`;
  const later = `sha256:${"2".repeat(64)}`;
  expect(workspaceMcpPin([])).toBeUndefined();
  expect(workspaceMcpPin([attempt(3, later), attempt(1), attempt(2, first)])).toBe(first);
});
