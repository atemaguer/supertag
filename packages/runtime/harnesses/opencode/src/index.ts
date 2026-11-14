import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { relative } from "node:path";
import {
  describeToolCall,
  type ExecutionEnvironment,
  type HarnessEvent,
  type ProcessHandle,
  type ToolInput,
} from "@supertag/worker-sdk";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface OpenCodeRunRequest {
  readonly prompt: string;
  readonly executable: string;
  readonly model: string;
  readonly workspace: string;
  readonly timeoutMs: number;
  /** Privileged process configuration; never included in model input or metadata. */
  readonly environment: Readonly<Record<string, string>>;
  readonly toolInputs?: readonly ToolInput[];
}

type OpenCodeAction = "allow" | "deny";
type OpenCodeRule = OpenCodeAction | Readonly<Record<string, OpenCodeAction>>;

/**
 * A Workspace Volume copy the Worker Host staged outside the Task worktree: a canonical
 * directory without wildcard characters, so its OpenCode permission patterns match it exactly.
 */
export interface OpenCodeCopy {
  readonly destination: string;
  readonly readWrite: boolean;
}

/**
 * OpenCode asks `external_directory` with the absolute parent directory of each file outside the
 * worktree, followed by `/*`, and `edit` with the file's path relative to the worktree. The last
 * matching rule wins, and `*` matches across `/`.
 */
export function openCodePermissions(
  actions: readonly string[],
  copies: readonly OpenCodeCopy[] = [],
  worktree?: string,
): Record<string, OpenCodeRule> {
  const allow = (action: string): OpenCodeAction => (actions.includes(action) ? "allow" : "deny");
  const readOnly = copies.filter(({ readWrite }) => !readWrite);
  const edit: OpenCodeRule =
    allow("files:write") === "allow" && readOnly.length > 0 && worktree !== undefined
      ? {
          "*": "allow",
          ...Object.fromEntries(
            readOnly.flatMap(({ destination }) => [
              [`${relative(worktree, destination)}/*`, "deny"],
              [`${destination}/*`, "deny"],
            ]),
          ),
        }
      : allow("files:write");
  return {
    "*": "deny",
    read: allow("files:read"),
    glob: allow("files:read"),
    grep: allow("files:read"),
    edit,
    bash: allow("commands:execute"),
    webfetch: allow("web:fetch"),
    websearch: allow("web:search"),
    task: "deny",
    // Only the Worker Host's copies are reachable outside the worktree.
    external_directory: copies.length
      ? {
          "*": "deny",
          ...Object.fromEntries(copies.map(({ destination }) => [`${destination}/*`, "allow"])),
        }
      : "deny",
    question: "deny",
    skill: "deny",
    lsp: "deny",
  };
}

export interface OpenCodeMcpTool {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly operations: readonly string[];
  readonly audience?: "manager";
}

/** Project only admitted tools and operations into OpenCode's native permission layers. */
export function openCodeConfigurationEnvironment(
  model: string,
  actions: readonly string[],
  tools: readonly OpenCodeMcpTool[],
  disableAuxiliaryProcesses = false,
  copies: readonly OpenCodeCopy[] = [],
  worktree?: string,
): Readonly<Record<string, string>> {
  const admittedPermission = openCodePermissions(actions, copies, worktree);
  const permission: Record<string, unknown> = {
    ...admittedPermission,
    task: { "*": "deny", general: "allow", explore: "allow" },
  };
  const mcp: Record<string, unknown> = Object.create(null);
  const childToolDenials: Record<string, "deny"> = {};
  for (const tool of tools) {
    if (!/^[\w-]+$/u.test(tool.name)) throw new Error("Invalid MCP server name");
    const aliases = new Set([tool.name, tool.name.replace(/[^a-zA-Z0-9_]/gu, "_")]);
    for (const alias of aliases) {
      if (tool.audience === "manager") childToolDenials[`${alias}_*`] = "deny";
      // The Control Plane independently checks execution authority for each invocation.
      for (const operation of tool.operations) permission[`${alias}_${operation}`] = "allow";
    }
    mcp[tool.name] = {
      type: "remote",
      url: tool.url,
      headers: tool.headers,
      enabled: true,
      oauth: false,
    };
  }
  const generalPermission = {
    ...admittedPermission,
    ...childToolDenials,
    ...(tools.some(({ audience }) => audience === "manager")
      ? { bash: "deny", webfetch: "deny", websearch: "deny" }
      : {}),
    task: "deny",
  };
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    share: "disabled",
    autoupdate: false,
    plugin: [],
    // File tools also invoke these integrations outside the bash permission check.
    ...(disableAuxiliaryProcesses ? { formatter: false, lsp: false } : {}),
    mcp,
    permission,
    agent: {
      build: { mode: "primary", permission },
      plan: { disable: true },
      general: {
        mode: "subagent",
        description: "Execute a bounded local subtask without SuperTag coordination authority",
        permission: generalPermission,
      },
      explore: {
        mode: "subagent",
        description: "Inspect the admitted workspace without modifying it",
        permission: { ...generalPermission, edit: "deny", bash: "deny" },
      },
    },
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    // The Task worktree may contain untrusted OpenCode configuration and plugins.
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  };
}

export interface OpenCodeCompletionPart {
  readonly id: string;
  readonly text: string;
}

type RecoverOpenCodeCompletion = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<readonly OpenCodeCompletionPart[]>;

export async function* runOpenCode(
  request: OpenCodeRunRequest,
  environment: Pick<ExecutionEnvironment, "spawn">,
  signal?: AbortSignal,
  recoverCompletion?: RecoverOpenCodeCompletion,
): AsyncIterable<HarnessEvent> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
  cancellation.throwIfAborted();
  let handle: ProcessHandle | undefined;
  const completion: { sessionId?: string; latestStepHasText: boolean } = {
    latestStepHasText: false,
  };
  const streamedParts = new Map<string, string>();
  const anonymousText = new Set<string>();
  try {
    handle = await environment.spawn(
      {
        command: request.executable,
        args: ["run", "--format", "json", "--model", request.model, "--agent", "build", "--pure"],
        cwd: request.workspace,
        environment: request.environment,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        streamOutput: true,
      },
      cancellation,
    );
    if (!handle.output) throw new Error("OpenCode requires environment process output streaming");
    let pending = "",
      responseBytes = 0,
      textSeen = false,
      finished = false;
    const parse = (line: string): HarnessEvent | undefined => {
      if (!line.trim()) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new Error("OpenCode emitted malformed JSON");
      }
      if (!raw || typeof raw !== "object") throw new Error("Invalid OpenCode event");
      const record = raw as Record<string, unknown>;
      if (record["type"] === "error") throw new Error("OpenCode session failed");
      const part = record["part"] as Record<string, unknown> | undefined;
      if (recoverCompletion) {
        if (
          Array.isArray(raw) ||
          typeof record["type"] !== "string" ||
          (record["type"] === "text" && typeof part?.["text"] !== "string") ||
          (record["type"] === "step_finish" && typeof part?.["reason"] !== "string")
        )
          throw new Error("Invalid OpenCode event");
        for (const identity of [record["sessionID"], part?.["sessionID"]]) {
          if (identity === undefined) continue;
          if (typeof identity !== "string" || !/^ses_[A-Za-z0-9]{1,120}$/u.test(identity))
            throw new Error("Invalid OpenCode Session identity");
          if (completion.sessionId !== undefined && identity !== completion.sessionId)
            throw new Error("OpenCode stream mixed Session identities");
          completion.sessionId = identity;
        }
      }
      if (record["type"] === "step_start") {
        finished = false;
        completion.latestStepHasText = false;
      }
      if (record["type"] === "step_finish") finished = part?.["reason"] === "stop";
      if (
        record["type"] === "tool_use" &&
        typeof part?.["tool"] === "string" &&
        typeof part["callID"] === "string"
      ) {
        const toolName = part["tool"];
        const input = request.toolInputs?.find((tool) =>
          tool.capability.operations.some(
            (operation) =>
              toolName === `${tool.binding.name}_${operation.name}` ||
              toolName === `${tool.binding.name.replace(/[^a-zA-Z0-9_]/gu, "_")}_${operation.name}`,
          ),
        );
        if (input) {
          const operation = input.capability.operations.find((operation) =>
            toolName.endsWith(`_${operation.name}`),
          );
          if (!operation) throw new Error("Unknown OpenCode MCP operation");
          const call = describeToolCall([input], {
            id: part["callID"],
            binding: { kind: input.binding.kind, name: input.binding.name },
            operation: operation.name,
          });
          const state = part["state"] as Record<string, unknown> | undefined;
          if (state?.["status"] === "error")
            return {
              type: "tool.call.failed",
              call,
              error: { message: "OpenCode MCP operation failed" },
            };
          if (state?.["status"] === "completed") return { type: "tool.call.completed", call };
        }
      }
      if (record["type"] === "text" && typeof part?.["text"] === "string") {
        const text = part["text"];
        responseBytes += Buffer.byteLength(text);
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("OpenCode response exceeds limit");
        textSeen ||= Boolean(text.trim());
        if (recoverCompletion && text) {
          completion.latestStepHasText ||= Boolean(text.trim());
          const id = part["id"];
          if (typeof id === "string" && /^prt_[A-Za-z0-9]{1,120}$/u.test(id)) {
            const previous = streamedParts.get(id);
            if (previous !== undefined && previous !== text)
              throw new Error("OpenCode stream changed a completed text part");
            streamedParts.set(id, text);
          } else anonymousText.add(text);
          if (streamedParts.size + anonymousText.size > 4096)
            throw new Error("OpenCode response has too many text parts");
        }
        return { type: "output.message", text };
      }
    };
    for await (const chunk of handle.output) {
      cancellation.throwIfAborted();
      if (chunk.stream !== "stdout") continue;
      pending += chunk.text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES)
          throw new Error("OpenCode event exceeds limit");
        const event = parse(line);
        if (event) yield event;
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES)
        throw new Error("OpenCode event exceeds limit");
    }
    if (pending.trim()) {
      const event = parse(pending);
      if (event) yield event;
    }
    const result = await handle.wait();
    cancellation.throwIfAborted();
    if (result.exitCode !== 0 || result.signal) throw new Error("OpenCode process failed");
    if (finished && (recoverCompletion ? completion.latestStepHasText : textSeen)) return;
  } finally {
    if (handle) {
      handle.kill();
      // The environment owns termination escalation; do not release the Worker
      // until it confirms process cleanup, including on parse/cancellation errors.
      await handle.wait();
    }
  }
  if (!recoverCompletion || !completion.sessionId)
    throw new Error("OpenCode ended without a complete final response");
  const recovered = await recoverCompletion(completion.sessionId, cancellation);
  cancellation.throwIfAborted();
  for (const { id, text } of recovered) {
    const previous = streamedParts.get(id);
    if (previous !== undefined && previous !== text)
      throw new Error("OpenCode export changed a streamed text part");
    if (previous === undefined && !anonymousText.has(text)) yield { type: "output.message", text };
  }
}

export async function readProviderApiKey(
  path: string,
  provider: string,
  privateFile = false,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error("OpenCode auth source must be a regular file no larger than 1 MiB");
    if (
      privateFile &&
      ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    )
      throw new Error("OpenCode auth source must be privately owned");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > 1024 * 1024) throw new Error("OpenCode auth source exceeds 1 MiB");
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    } catch {
      throw new Error("Invalid OpenCode auth JSON");
    }
    const credential =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)[provider]
        : undefined;
    if (!credential || typeof credential !== "object")
      throw new Error("OpenCode auth source has no credential for the selected provider");
    const record = credential as Record<string, unknown>;
    if (record["type"] !== "api" || typeof record["key"] !== "string" || !record["key"].trim())
      throw new Error(
        "OpenCode authFile supports only nonempty API credentials; OAuth is not supported",
      );
    return record["key"];
  } finally {
    await file.close();
  }
}
