import type { TaskAttempt } from "@supertag/core";
import type { TaskAttemptEvent } from "@supertag/worker-sdk";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/**
 * Only the digest crosses the Worklet boundary; server headers stay on the host. The Worker
 * reports it in `workspace.mcp.resolved` before any server starts, and again in the Attempt's
 * runtime input manifest.
 */
export function workspaceMcpDigest(event: TaskAttemptEvent): string | undefined {
  if (event.type === "workspace.mcp.resolved")
    return typeof event.digest === "string" && DIGEST.test(event.digest) ? event.digest : undefined;
  if (event.type !== "runtime-inputs.resolved") return undefined;
  const digests = event.manifest.inputs.flatMap((input) => {
    if (
      input.kind !== "workspace" ||
      input.resource?.provenance?.["provider"] !== "supertag-workspace"
    )
      return [];
    const digest = input.resource?.provenance?.["mcpServersDigest"];
    return typeof digest === "string" && DIGEST.test(digest) ? [digest] : [];
  });
  if (digests.length > 1) throw new Error("Task Attempt has multiple Workspace MCP digests");
  return digests[0];
}

/** The digest the Task's first reporting Attempt recorded, binding on every later Attempt. */
export function workspaceMcpPin(attempts: readonly TaskAttempt[]): string | undefined {
  return attempts
    .filter((attempt) => attempt.mcpServersDigest !== undefined)
    .toSorted((left, right) => left.attemptNumber - right.attemptNumber)[0]?.mcpServersDigest;
}
