import {
  type harnessClient,
  WorkspaceGrepMode,
  workspaceToolDefinitions,
} from "@supertag/worker-sdk/internal/rust-harness";
import type { CursorSplitExecutor } from "../index.js";

type WorkspaceClient = ReturnType<typeof harnessClient>["workspace"];
type WorkspaceRequest = Parameters<WorkspaceClient["execute"]>[0];

const GREP_MODES = new Map([
  ["content", WorkspaceGrepMode.CONTENT],
  ["files_with_matches", WorkspaceGrepMode.FILES_WITH_MATCHES],
  ["count", WorkspaceGrepMode.COUNT],
]);

function workspaceRequest(name: string, input: unknown): WorkspaceRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Workspace tool arguments must be an object");
  const args = input as Record<string, unknown>;
  const string = (key: string) => {
    const value = args[key];
    if (typeof value !== "string") throw new Error(`Workspace tool requires ${key}`);
    return value;
  };
  const optionalString = (key: string) => (args[key] === undefined ? undefined : string(key));
  const integer = (key: string) => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error(`Workspace tool requires a bounded integer for ${key}`);
    return value;
  };

  switch (name) {
    case "read":
      return {
        operation: {
          case: "read",
          value: { path: string("file_path"), offset: integer("offset"), limit: integer("limit") },
        },
      };
    case "write":
      return {
        operation: {
          case: "write",
          value: { path: string("file_path"), content: string("content") },
        },
      };
    case "edit":
      if (args["replace_all"] !== undefined && typeof args["replace_all"] !== "boolean")
        throw new Error("Workspace edit requires a boolean replace_all");
      return {
        operation: {
          case: "edit",
          value: {
            path: string("file_path"),
            oldText: string("old_string"),
            newText: string("new_string"),
            replaceAll: args["replace_all"] === true,
          },
        },
      };
    case "glob":
      return {
        operation: {
          case: "glob",
          value: { path: optionalString("path"), pattern: string("pattern") },
        },
      };
    case "grep": {
      const outputMode = optionalString("output_mode");
      const mode =
        outputMode === undefined ? WorkspaceGrepMode.UNSPECIFIED : GREP_MODES.get(outputMode);
      if (mode === undefined) throw new Error("Invalid Workspace grep output mode");
      return {
        operation: {
          case: "grep",
          value: {
            path: optionalString("path"),
            pattern: string("pattern"),
            glob: optionalString("glob"),
            mode,
            offset: integer("offset"),
            headLimit: integer("head_limit"),
          },
        },
      };
    }
    case "ls":
      return { operation: { case: "list", value: { path: optionalString("path") } } };
    case "command":
      if (args["run_in_background"] !== undefined && args["run_in_background"] !== false)
        throw new Error("Background commands are unavailable in the Workspace");
      return {
        operation: {
          case: "command",
          value: { command: string("command"), timeoutMs: integer("timeout") },
        },
      };
    default:
      throw new Error("Unknown Workspace tool");
  }
}

export function createRemoteWorkspaceExecutor(
  actions: readonly string[],
  bridge: Pick<ReturnType<typeof harnessClient>, "workspace" | "options">,
): CursorSplitExecutor {
  const filesWrite = actions.includes("files:write");
  const filesRead = actions.includes("files:read");
  const tools = workspaceToolDefinitions.filter(({ name }) => {
    if (name === "command") return filesWrite && actions.includes("commands:execute");
    return name === "write" || name === "edit" ? filesWrite : filesRead;
  });
  const close = new AbortController();
  const calls = new Set<ReturnType<WorkspaceClient["execute"]>>();
  async function dispose() {
    close.abort();
    await Promise.allSettled(calls);
  }
  return {
    tools,
    async call(name, input, signal) {
      close.signal.throwIfAborted();
      if (!tools.some((tool) => tool.name === name))
        throw new Error("Workspace tool is not admitted");
      const call = bridge.workspace.execute(workspaceRequest(name, input), {
        ...bridge.options(),
        timeoutMs: 130_000,
        signal: signal ? AbortSignal.any([signal, close.signal]) : close.signal,
      });
      calls.add(call);
      try {
        const { text, isError } = await call;
        return { text, isError };
      } finally {
        calls.delete(call);
      }
    },
    cancelAll: dispose,
    dispose,
  };
}
