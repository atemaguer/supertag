import { delimiter, dirname, join } from "node:path";
import type { HarnessRuntime, ProcessHandle } from "@supertag/worker-sdk";
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
  runtime: HarnessRuntime,
  workspace: string,
  home: string,
  timeoutMs: number,
): CursorSplitExecutor {
  const lifetime = new AbortController();
  const active = new Set<Promise<ProcessHandle>>();
  const cancelAll = async () => {
    lifetime.abort();
    const started = await Promise.allSettled(active);
    await Promise.all(
      started.flatMap((item) =>
        item.status === "fulfilled" ? [item.value.wait().then(() => undefined)] : [],
      ),
    );
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
      const started = runtime.spawn(
        {
          // A login shell can replace PATH with a system Node or load operator startup files.
          command: "/bin/sh",
          args: ["-c", command],
          cwd: workspace,
          environment: {
            PATH: [dirname(process.execPath), process.env["PATH"]].filter(Boolean).join(delimiter),
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
      );
      active.add(started);
      try {
        const result = await (await started).wait();
        const isError = result.exitCode !== 0;
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          text: `${isError ? `Exit ${result.exitCode ?? result.signal ?? "unknown"}:\n` : ""}${output || "(no output)"}`,
          isError,
        };
      } finally {
        active.delete(started);
      }
    },
    cancelAll,
    dispose: cancelAll,
  };
}
