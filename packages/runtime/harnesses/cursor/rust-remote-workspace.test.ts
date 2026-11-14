import { create } from "@bufbuild/protobuf";
import {
  HarnessWorkspaceResultSchema,
  WorkspaceGrepMode,
} from "@supertag/worker-sdk/internal/rust-harness";
import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkspaceExecutor } from "./src/rust-adapter/remote-workspace.js";

describe("Cursor remote workspace tools", () => {
  function bridge() {
    return {
      workspace: {
        execute: vi
          .fn()
          .mockResolvedValue(create(HarnessWorkspaceResultSchema, { text: "result" })),
      },
      options: () => ({ headers: { authorization: "Bearer fixture" }, timeoutMs: 5000 }),
    };
  }

  it("uses typed request fields and filters tools against accepted actions", async () => {
    const provider = bridge();
    const workspace = createRemoteWorkspaceExecutor(["files:read", "commands:execute"], provider);
    expect(workspace.tools.map(({ name }) => name)).toEqual(["read", "glob", "grep", "ls"]);
    await expect(workspace.call("command", { command: "pwd" })).rejects.toThrow("not admitted");
    expect(provider.workspace.execute).not.toHaveBeenCalled();
    await expect(
      workspace.call("grep", {
        path: "src",
        pattern: "main",
        output_mode: "count",
        head_limit: 12,
      }),
    ).resolves.toEqual({ text: "result", isError: false });
    expect(provider.workspace.execute).toHaveBeenCalledWith(
      {
        operation: {
          case: "grep",
          value: expect.objectContaining({
            path: "src",
            pattern: "main",
            mode: WorkspaceGrepMode.COUNT,
            headLimit: 12,
          }),
        },
      },
      expect.objectContaining({ timeoutMs: 130_000 }),
    );
  });

  it("settles cancelled calls and forwards neither a background option nor an environment", async () => {
    const provider = bridge();
    provider.workspace.execute.mockImplementation(
      (_, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const workspace = createRemoteWorkspaceExecutor(["files:write", "commands:execute"], provider);
    await expect(
      workspace.call("command", { command: "pwd", run_in_background: true }),
    ).rejects.toThrow("Background commands");
    const command = workspace.call("command", {
      command: "pwd",
      timeout: 1000,
      env: { SECRET: "value" },
    });
    const cancelled = expect(command).rejects.toMatchObject({ name: "AbortError" });
    await workspace.dispose();
    await cancelled;
    expect(provider.workspace.execute).toHaveBeenCalledExactlyOnceWith(
      { operation: { case: "command", value: { command: "pwd", timeoutMs: 1000 } } },
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
    );
    await expect(workspace.call("command", { command: "pwd" })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
