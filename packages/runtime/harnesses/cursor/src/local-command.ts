import { delimiter, dirname, join } from "node:path";
import {
  ExecutionCleanupError,
  type HarnessRuntime,
  type ProcessResult,
} from "@supertag/worker-sdk";
import type { CursorSplitExecutor } from "./index.js";
import type { CursorSplitToolDefinition } from "./mcp-custom-tools.js";

const COMMAND: CursorSplitToolDefinition = {
  name: "command",
  description: "Run a foreground shell command from the workspace root on the Worker Host.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1 } },
    required: ["command"],
    additionalProperties: false,
  },
};

/** The caller grants shell access separately from Cursor's native tool allowlist. */
export function localCursorCommand(
  runtime: Pick<HarnessRuntime, "spawn">,
  workspace: string,
  home: string,
  timeoutMs: number,
): CursorSplitExecutor {
  const lifetime = new AbortController();
  const active = new Set<Promise<ProcessResult>>();
  const cancelAll = async () => {
    lifetime.abort();
    for (const result of await Promise.allSettled(active)) {
      // The local supervisor rejects on cancellation even after it confirms the process exited.
      if (result.status === "rejected" && result.reason instanceof ExecutionCleanupError)
        throw result.reason;
    }
  };
  return {
    tools: [COMMAND],
    async call(name, input, signal) {
      if (name !== COMMAND.name || !input || typeof input !== "object")
        throw new Error("Invalid Cursor command call");
      const { command, timeout } = input as Record<string, unknown>;
      if (typeof command !== "string" || !command.trim() || command.includes("\0"))
        throw new Error("A non-empty shell command is required");
      if (
        timeout !== undefined &&
        (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1)
      )
        throw new Error("Command timeout must be a positive integer in milliseconds");
      const stop = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      stop.throwIfAborted();
      const running = runtime
        .spawn(
          {
            // A login shell can replace PATH with a system Node or load operator startup files.
            command: "/bin/sh",
            args: ["-c", command],
            cwd: workspace,
            environment: {
              PATH: [dirname(process.execPath), process.env["PATH"]]
                .filter(Boolean)
                .join(delimiter),
              HOME: home,
              XDG_CACHE_HOME: join(home, "cache"),
              XDG_CONFIG_HOME: join(home, "config"),
              XDG_DATA_HOME: join(home, "data"),
              COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
              CI: "true",
            },
            replaceEnvironment: true,
            timeoutMs: Math.min(typeof timeout === "number" ? timeout : timeoutMs, timeoutMs),
          },
          stop,
        )
        .then((handle) => handle.wait());
      active.add(running);
      try {
        const result = await running;
        const isError = result.exitCode !== 0;
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          text: `${isError ? `Exit ${result.exitCode ?? result.signal ?? "unknown"}:\n` : ""}${output || "(no output)"}`,
          isError,
        };
      } finally {
        active.delete(running);
      }
    },
    cancelAll,
    dispose: cancelAll,
  };
}
