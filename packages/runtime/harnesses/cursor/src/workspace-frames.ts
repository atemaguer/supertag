/**
 * Stdio frames for split execution. This module imports nothing heavy because the runner child
 * loads it: the runner must not pull in the Worker SDK just to answer a workspace call.
 */

/**
 * Runner -> Worker request for one workspace tool call in split execution. The Worker runs it
 * through its executor and answers with a {@link CursorWorkspaceResultFrame} on the runner's stdin.
 */
export interface CursorWorkspaceCallFrame {
  readonly type: "workspace_call";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** Worker -> runner answer for a {@link CursorWorkspaceCallFrame}; one answer per id. */
export interface CursorWorkspaceResultFrame {
  readonly type: "workspace_result";
  readonly id: string;
  readonly text: string;
  readonly isError: boolean;
}

export const WORKSPACE_CALL_ID = /^[\w-]{1,64}$/u;
export const WORKSPACE_TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

/** One line for the runner's stdin; the Worker writes it after the executor settles. */
export function encodeWorkspaceResult(frame: Omit<CursorWorkspaceResultFrame, "type">): string {
  return `${JSON.stringify({ type: "workspace_result", ...frame })}\n`;
}

/** The runner's stdin is ours, but a malformed answer must not settle an unrelated call. */
export function parseWorkspaceResult(frame: Record<string, unknown>): CursorWorkspaceResultFrame {
  if (
    frame["type"] !== "workspace_result" ||
    typeof frame["id"] !== "string" ||
    !WORKSPACE_CALL_ID.test(frame["id"]) ||
    typeof frame["text"] !== "string" ||
    typeof frame["isError"] !== "boolean"
  )
    throw new Error("Cursor Worker sent an invalid workspace result");
  return {
    type: "workspace_result",
    id: frame["id"],
    text: frame["text"],
    isError: frame["isError"],
  };
}
