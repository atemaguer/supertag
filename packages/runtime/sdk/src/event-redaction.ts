import type { TaskResult } from "@supertag/core";
import type { HarnessEvent, TaskAttemptEvent } from "./index.js";
import { isSensitiveName } from "./redaction.js";

type TextRedactor = (text: string, structural?: boolean) => string;
type Schema =
  | "raw"
  | "structural"
  | "count"
  | "boolean"
  | "currency"
  | "text"
  | Set<string>
  | readonly [Schema]
  | { readonly [key: string]: Schema };

// An enum exemption belongs to a specific schema slot, never to a key name.
const enumeration = (...values: string[]): Set<string> => new Set(values);
const RESULT: Schema = {
  decisions: [{ status: enumeration("accepted", "proposed") }],
  findings: [
    {
      severity: enumeration("high", "medium", "low"),
      status: enumeration("open", "fixed", "accepted"),
    },
  ],
  references: [
    {
      provider: enumeration("github", "lark", "linear", "slack", "teams"),
      resourceType: enumeration(
        "artifact",
        "channel",
        "file",
        "issue",
        "project",
        "pull-request",
        "repository",
        "thread",
      ),
      relationship: enumeration("changed", "inspected", "mentioned", "originated-in", "produced"),
    },
  ],
};
const CALL: Schema = {
  provider: "structural",
  operation: "structural",
  effect: enumeration("read", "write"),
  binding: { kind: enumeration("worker-local", "mcp-http", "mcp-stdio", "native") },
};
const ENVIRONMENT: Schema = {
  provider: "structural",
  placement: enumeration("local", "remote", "managed"),
};
const INPUT: Schema = {
  kind: "structural",
  resource: { provenance: { provider: "structural" } },
};
const EVENT_TYPES = enumeration(
  "usage.updated",
  "agent.updated",
  "command.updated",
  "execution.started",
  "execution.limits.applied",
  "workspace.mcp.resolved",
  "workspace.mounts.copied",
  "runtime-inputs.resolved",
  "output.delta",
  "output.message",
  "progress.updated",
  "input.withdrawn",
  "result",
  "artifact.created",
  "session.updated",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "approval.requested",
  "execution.completed",
  "execution.failed",
  "execution.uncertain",
);
const STRUCTURAL_FIELD =
  /^(?:id|.*Id|.*Ids|actions|scope|digest|revision|version|model|name|key|uri|url|path|paths|reference|references|location|source|at)$|(?:Uri|URI|Url|URL|Path|Paths|Reference|References|Location|Source|Digest)$|[_-](?:id|ids|uri|url|path|paths|reference|references|location|source|digest)$/u;
const STRUCTURAL_KEY =
  /^(?:(?:sourceItem|session|item|sort|idempotency|cursor|resource)Keys?|(?:source_item|session|item|sort|idempotency|cursor|resource)_keys?)$/u;
const COST: Schema = { amountMinor: "count", currency: "currency" };
const USAGE: Schema = {
  inputTokens: "count",
  outputTokens: "count",
  cachedInputTokens: "count",
  cacheWriteTokens: "count",
  reasoningTokens: "count",
  totalTokens: "count",
  complete: "boolean",
  unpricedModel: "text",
  reportedCost: { amountMinor: "count", currency: "currency", estimated: "boolean" },
};

/** The one recursive stored-copy rule, including unknown events and extension fields. */
export function redactDiagnostics(
  value: unknown,
  redact: TextRedactor,
  schema?: Schema,
  key = "",
): unknown {
  if (schema === "raw") return value;
  if (schema instanceof Set) {
    if (typeof value === "string" && schema.has(value)) return value;
    schema = undefined;
  }
  if (schema === "count")
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : "[REDACTED]";
  if (schema === "boolean") return typeof value === "boolean" ? value : "[REDACTED]";
  if (schema === "currency")
    return typeof value === "string" && /^[A-Z]{3}$/u.test(value) ? value : "[REDACTED]";
  // Schema-approved counters are the only exceptions to credential-named keys.
  if (schema === undefined && isSensitiveName(key)) return "[REDACTED]";
  if (schema === "text" && typeof value !== "string") return "[REDACTED]";
  if (typeof value === "string") {
    if (/^supertag-artifact:sha256:[a-f0-9]{64}$/u.test(value)) return value;
    return redact(
      value,
      schema === "structural" || STRUCTURAL_FIELD.test(key) || STRUCTURAL_KEY.test(key),
    );
  }
  if (Array.isArray(value))
    return value.map((item) =>
      redactDiagnostics(item, redact, Array.isArray(schema) ? schema[0] : undefined, key),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redactDiagnostics(
          item,
          redact,
          typeof schema === "object" && !Array.isArray(schema)
            ? (schema as Record<string, Schema>)[name]
            : undefined,
          name,
        ),
      ]),
    );
  return value;
}

/** Execution and effect reconciliation retain the original objects. */
export function redactEventDiagnostics<T extends HarnessEvent | TaskAttemptEvent>(
  event: T,
  redact: TextRedactor,
): T {
  const schema: Record<string, Schema> = {
    // Routing metadata belongs to the envelope, not Worker diagnostic content.
    type: EVENT_TYPES,
    taskId: "raw",
    attemptId: "raw",
    at: "raw",
  };
  switch (event.type) {
    case "tool.call.started":
    case "tool.call.completed":
    case "tool.call.failed":
      schema["call"] = CALL;
      break;
    case "result":
      schema["result"] = RESULT;
      break;
    case "agent.updated":
      schema["agent"] = { status: enumeration("running", "completed", "failed", "interrupted") };
      break;
    case "command.updated":
      schema["command"] = { status: enumeration("running", "completed", "failed") };
      break;
    case "progress.updated":
      schema["progress"] = {
        items: [{ status: enumeration("active", "blocked", "completed", "pending") }],
      };
      break;
    case "output.message":
      schema["message"] = { role: enumeration("teammate") };
      break;
    case "runtime-inputs.resolved":
      schema["manifest"] = {
        executionEnvironment: ENVIRONMENT,
        harnessRuntime: ENVIRONMENT,
        inputs: [INPUT],
        omitted: [INPUT],
      };
      break;
    case "usage.updated":
      schema["usage"] = USAGE;
      break;
    case "execution.limits.applied":
      schema["requested"] = {
        maxNativeAgents: "count",
        maxReportedTokens: "count",
        maxReportedCost: COST,
      };
      schema["applied"] = {
        maxNativeAgents: {
          limit: "count",
          method: enumeration("provider-native", "harness-guard"),
        },
        maxReportedTokens: { limit: "count", method: enumeration("interrupt-on-report") },
        maxReportedCost: { limit: COST, method: enumeration("provider-budget") },
      };
      break;
    case "execution.started":
      schema["workerId"] = "raw";
      break;
    case "input.withdrawn":
      schema["commandId"] = "raw";
      break;
  }
  return redactDiagnostics(event, redact, schema) as T;
}

export function redactResultDiagnostics(result: TaskResult, redact: TextRedactor): TaskResult {
  return redactDiagnostics(result, redact, RESULT) as TaskResult;
}
