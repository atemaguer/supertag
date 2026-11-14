import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TaskProgress } from "@supertag/worker-sdk";

/**
 * Task progress from Claude Code's own messages, shared by the TypeScript Worker and the Rust
 * harness bridge: background task lifecycle as a bounded checklist, and API retries.
 */
export type ClaudeProgressItem = NonNullable<TaskProgress["items"]>[number];

export function claudeTaskProgress(
  message: SDKMessage,
  items: Map<string, ClaudeProgressItem>,
): TaskProgress | undefined {
  if (message.type !== "system" || !("subtype" in message)) return undefined;
  if (message.subtype === "task_started") {
    if (message.skip_transcript === true) return undefined;
    items.set(message.task_id, {
      id: message.task_id,
      text: boundedClaudeProgressText(message.description),
      status: "active",
    });
  } else if (message.subtype === "task_progress") {
    const existing = items.get(message.task_id);
    items.set(message.task_id, {
      id: message.task_id,
      text: boundedClaudeProgressText(message.description || existing?.text || "Working"),
      status: "active",
    });
  } else if (message.subtype === "task_updated") {
    const existing = items.get(message.task_id);
    if (existing === undefined) return undefined;
    items.set(message.task_id, {
      ...existing,
      ...(message.patch.description === undefined
        ? {}
        : { text: boundedClaudeProgressText(message.patch.description) }),
      ...(message.patch.status === undefined
        ? {}
        : { status: claudeProgressStatus(message.patch.status) }),
    });
  } else if (message.subtype === "task_notification") {
    const existing = items.get(message.task_id);
    if (message.skip_transcript === true && existing === undefined) return undefined;
    items.set(message.task_id, {
      id: message.task_id,
      text: boundedClaudeProgressText(existing?.text ?? message.summary),
      status: message.status === "completed" ? "completed" : "blocked",
    });
  } else {
    return undefined;
  }
  const snapshot = [...items.values()].slice(0, 8);
  return {
    summary: snapshot.every((item) => item.status === "completed")
      ? "Finishing up"
      : "Working through the plan",
    items: snapshot,
  };
}

function claudeProgressStatus(
  status: "completed" | "failed" | "killed" | "paused" | "pending" | "running",
): ClaudeProgressItem["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "killed" || status === "paused") return "blocked";
  return status === "running" ? "active" : "pending";
}

function boundedClaudeProgressText(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160) || "Working";
}

/**
 * The Claude Code CLI owns retries of retryable API errors (overloaded, 5xx, connection) inside one
 * request, before that request produces output, and reports each as an `api_retry` system message.
 * SuperTag records each one as Task progress instead of replaying the whole query, which could repeat
 * tool calls. The CLI decides which errors are retryable; rate and usage limits end the turn.
 */
export function claudeApiRetryProgress(message: SDKMessage): TaskProgress | undefined {
  if (message.type !== "system" || !("subtype" in message) || message.subtype !== "api_retry")
    return undefined;
  const status = message.error_status === null ? "" : `, HTTP ${message.error_status}`;
  return {
    summary: `Provider request failed (${message.error}${status}); Claude Code is retrying request ${message.attempt} of ${message.max_retries} after ${message.retry_delay_ms} ms.`,
  };
}
