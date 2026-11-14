import { cursorCostFields } from "@supertag/core";
import {
  describeToolCall,
  type ExecutionUsage,
  type HarnessEvent,
  type ToolInput,
} from "@supertag/worker-sdk";
import type { SensitiveValue } from "@supertag/worker-sdk/redaction";

import {
  type CursorWorkspaceCallFrame,
  WORKSPACE_CALL_ID,
  WORKSPACE_TOOL_NAME,
} from "./workspace-frames.js";

export {
  type CursorWorkspaceCallFrame,
  type CursorWorkspaceResultFrame,
  encodeWorkspaceResult,
  parseWorkspaceResult,
} from "./workspace-frames.js";

/** Child output is untrusted even though the child is ours: SDK events can contain model text. */
export class CursorProtocolError extends Error {
  override readonly name = "CursorProtocolError";
}

export type CursorRunnerEvent =
  | Exclude<HarnessEvent, { type: "usage.updated" }>
  | (Extract<HarnessEvent, { type: "usage.updated" }> & { readonly observedModel?: string })
  | { readonly type: "cursor.session"; readonly agentId: string };

export interface CursorResultFrame {
  readonly type: "result";
  readonly status: "finished" | "error" | "cancelled";
  readonly result?: string;
  readonly error?: string;
  readonly model?: string;
  readonly usage?: unknown;
  readonly chargedCents?: number;
}

// The Worker must see enough of a runner diagnostic to redact secrets that only
// the Worker knows before it applies the public 500-character limit.
export const MAX_CURSOR_ERROR_CHARS = 64 * 1024;

export function stripCursorControls(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code > 31 &&
        (code < 127 || code > 159) &&
        (code < 0x200b || code > 0x200f) &&
        (code < 0x2028 || code > 0x202e) &&
        code !== 0x2060 &&
        (code < 0x2066 || code > 0x2069) &&
        code !== 0xfeff
      );
    })
    .join("");
}

/** Mask only known secret bytes in serialized workspace inputs; the input is executable data. */
export function redactCursorExactSecrets(text: string, secrets: readonly SensitiveValue[]): string {
  const values = secrets
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => JSON.stringify(value).slice(1, -1))
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => b.length - a.length);
  return values.reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), text);
}

export type CursorFrame =
  | { readonly type: "agent"; readonly agentId: string }
  | { readonly type: "event"; readonly event: Record<string, unknown> }
  | CursorWorkspaceCallFrame
  | CursorResultFrame
  | { readonly type: "error"; readonly code: string; readonly message?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseCursorFrame(line: string): CursorFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CursorProtocolError("Cursor runner emitted malformed JSON");
  }
  const frame = record(value);
  if (!frame || typeof frame["type"] !== "string")
    throw new CursorProtocolError("Cursor runner emitted an invalid frame");
  if (frame["type"] === "agent" && typeof frame["agentId"] === "string")
    return { type: "agent", agentId: frame["agentId"] };
  if (frame["type"] === "event" && record(frame["event"]))
    return { type: "event", event: frame["event"] as Record<string, unknown> };
  if (
    frame["type"] === "workspace_call" &&
    typeof frame["id"] === "string" &&
    WORKSPACE_CALL_ID.test(frame["id"]) &&
    typeof frame["name"] === "string" &&
    WORKSPACE_TOOL_NAME.test(frame["name"])
  )
    return {
      type: "workspace_call",
      id: frame["id"],
      name: frame["name"],
      input: frame["input"],
    };
  if (
    frame["type"] === "result" &&
    ["finished", "error", "cancelled"].includes(String(frame["status"])) &&
    (frame["error"] === undefined ||
      (typeof frame["error"] === "string" && frame["error"].length <= MAX_CURSOR_ERROR_CHARS))
  )
    return frame as unknown as CursorResultFrame;
  if (
    frame["type"] === "error" &&
    typeof frame["code"] === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(frame["code"]) &&
    (frame["message"] === undefined ||
      (typeof frame["message"] === "string" && frame["message"].length <= MAX_CURSOR_ERROR_CHARS))
  )
    return {
      type: "error",
      code: frame["code"],
      ...(frame["message"] === undefined ? {} : { message: frame["message"] as string }),
    };
  throw new CursorProtocolError("Cursor runner emitted an invalid frame");
}

/** https://cursor.com/docs/sdk/typescript.md#token-usage */
export function cursorUsage(value: unknown, model: string, chargedCents?: number): ExecutionUsage {
  const usage = record(value);
  const count = (key: string) => {
    const number = usage?.[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
      throw new CursorProtocolError(`Cursor reported invalid ${key}`);
    return number;
  };
  const inputTokens = count("inputTokens");
  const outputTokens = count("outputTokens");
  const cachedInputTokens = count("cacheReadTokens");
  const cacheWriteTokens = count("cacheWriteTokens");
  const totalTokens = count("totalTokens");
  if (totalTokens !== inputTokens + outputTokens + cachedInputTokens + cacheWriteTokens)
    throw new CursorProtocolError("Cursor reported inconsistent token totals");
  const reasoningTokens = usage?.["reasoningTokens"];
  if (
    reasoningTokens !== undefined &&
    (typeof reasoningTokens !== "number" ||
      !Number.isSafeInteger(reasoningTokens) ||
      reasoningTokens < 0 ||
      reasoningTokens > outputTokens)
  )
    throw new CursorProtocolError("Cursor reported invalid reasoningTokens");
  const exactCost =
    chargedCents !== undefined && Number.isSafeInteger(chargedCents) && chargedCents >= 0
      ? chargedCents
      : undefined;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    totalTokens,
    complete: true,
    ...(exactCost === undefined
      ? cursorCostFields(model, {
          inputTokens,
          outputTokens,
          cacheReadTokens: cachedInputTokens,
          cacheWriteTokens,
          totalTokens,
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        })
      : { reportedCost: { amountMinor: exactCost, currency: "USD" } }),
  };
}

function toolCall(input: ToolInput, operationName: string, id: string) {
  return describeToolCall([input], {
    id,
    binding: { kind: input.binding.kind, name: input.binding.name },
    operation: operationName,
  });
}

/**
 * Map every stable SDKMessage envelope, while treating tool args/results as unknown.
 * https://cursor.com/docs/sdk/typescript.md#stream-events
 */
export function mapCursorEvent(
  raw: Record<string, unknown>,
  toolInputs: readonly ToolInput[] = [],
  model = "auto",
): readonly HarnessEvent[] {
  const type = raw["type"];
  switch (type) {
    case "system":
      return [{ type: "progress.updated", progress: { summary: "Cursor started" } }];
    case "user":
      return [{ type: "progress.updated", progress: { summary: "Cursor received the Task" } }];
    case "assistant": {
      const content = record(raw["message"])?.["content"];
      if (!Array.isArray(content)) return [];
      return content.flatMap((block): HarnessEvent[] => {
        const item = record(block);
        return item?.["type"] === "text" && typeof item["text"] === "string"
          ? [{ type: "output.message", text: item["text"] }]
          : [];
      });
    }
    case "thinking":
      return [{ type: "progress.updated", progress: { summary: "Cursor is reasoning" } }];
    case "tool_call": {
      const name = raw["name"];
      const id = raw["call_id"];
      const status = raw["status"];
      if (typeof name !== "string" || typeof id !== "string")
        throw new CursorProtocolError("Cursor reported an invalid tool call");
      const matched = toolInputs.flatMap((input) =>
        input.capability.operations.flatMap((operation) => {
          const names = [
            `${input.binding.name}_${operation.name}`,
            `mcp__${input.binding.name}__${operation.name}`,
          ];
          return names.includes(name) ? [{ input, operation: operation.name }] : [];
        }),
      )[0];
      if (matched) {
        const call = toolCall(matched.input, matched.operation, id);
        if (status === "running") return [{ type: "tool.call.started", call }];
        if (status === "completed") return [{ type: "tool.call.completed", call }];
        if (status === "error")
          return [{ type: "tool.call.failed", call, error: { message: "Cursor tool failed" } }];
      }
      if (/shell|terminal|command/iu.test(name)) {
        const command = {
          id,
          command: "Cursor shell command",
          status:
            status === "error"
              ? ("failed" as const)
              : status === "completed"
                ? ("completed" as const)
                : ("running" as const),
        };
        return [{ type: "command.updated", command }];
      }
      return [
        { type: "progress.updated", progress: { summary: `Cursor ${String(status)} a tool` } },
      ];
    }
    case "status":
      return [
        {
          type: "progress.updated",
          progress: { summary: `Cursor ${String(raw["status"] ?? "running")}` },
        },
      ];
    case "task":
      return [
        {
          type: "progress.updated",
          progress: {
            summary:
              typeof raw["text"] === "string"
                ? raw["text"].slice(0, 240)
                : `Cursor task ${String(raw["status"] ?? "updated")}`,
          },
        },
      ];
    case "request":
      // The headless SDK has no SuperTag approval callback. Refuse a request instead of
      // pretending it was approved. https://cursor.com/docs/sdk/typescript.md#stream-events
      throw new CursorProtocolError(
        "Cursor requested interactive approval; this Task cannot grant it",
      );
    case "usage":
      return [{ type: "usage.updated", usage: cursorUsage(raw["usage"], model) }];
    default:
      throw new CursorProtocolError("Cursor reported an unknown SDK event");
  }
}
