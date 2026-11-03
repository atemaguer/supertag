import {
  ContextResolverRegistry,
  type ExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
} from "@supertag/worker-sdk";
import { describe, expect, it, vi } from "vitest";

const codexFactory = vi.hoisted(() => vi.fn());
vi.mock("@supertag/worker-codex", () => ({ createCodexWorker: codexFactory }));

import {
  assertHostEnvironmentWorkers,
  createHarnessWorker,
  type WorkletHarnessWorker,
} from "./src/worker.ts";

const worker = (harness: WorkletHarnessWorker["harness"]): WorkletHarnessWorker => ({
  harness,
  workerId: harness,
  profileId: harness,
  profileRevision: "1",
});

describe("host environment worker startup", () => {
  for (const harness of ["claude-code", "cursor"] as const) {
    it(`refuses ${harness} unsandboxed commands before startup`, () => {
      expect(() =>
        assertHostEnvironmentWorkers({ provider: "e2b" }, [
          { ...worker(harness), allowUnsandboxedCommands: true },
        ]),
      ).toThrow(new RegExp(`${harness}.*remove allow-unsandboxed-commands`));
    });
  }

  for (const environment of [{ provider: "e2b" }, { provider: "modal", app: "test" }] as const) {
    it(`refuses OpenCode on ${environment.provider} before startup`, () => {
      expect(() => assertHostEnvironmentWorkers(environment, [worker("opencode")])).toThrow(
        `opencode cannot run with ${environment.provider} environment: OpenCode would need provider keys inside the sandbox; use claude-code, codex or cursor, or remove environment`,
      );
    });
  }

  it("accepts a local OpenCode host", () => {
    expect(() => assertHostEnvironmentWorkers(undefined, [worker("opencode")])).not.toThrow();
  });

  it("accepts sandboxed host services", () => {
    expect(() =>
      assertHostEnvironmentWorkers({ provider: "modal", app: "test" }, [
        worker("claude-code"),
        worker("cursor"),
      ]),
    ).not.toThrow();
  });

  it("refuses Codex exec mode with a remote environment before startup", () => {
    expect(() =>
      assertHostEnvironmentWorkers({ provider: "e2b" }, [
        { ...worker("codex"), codexExecutionMode: "exec" },
      ]),
    ).toThrow(/codex-execution-mode.*exec.*environment.*app-server/);
    expect(() =>
      assertHostEnvironmentWorkers({ provider: "modal", app: "test" }, [
        { ...worker("codex"), codexExecutionMode: "app-server" },
        worker("codex"),
      ]),
    ).not.toThrow();
  });

  it("requires a remote execution provider for split host wiring", () => {
    expect(() =>
      createHarnessWorker(worker("claude-code"), {
        splitHostEnvironment: true,
        mcpServers: {},
        checkouts: [],
        worktreeRoot: "/unused",
        shared: {
          workspace: "/unused",
          timeoutMs: 1_000,
          redactValues: [],
          contextResolvers: new ContextResolverRegistry([]),
        },
      }),
    ).toThrow("requires an e2b or Modal execution provider");
  });

  it("selects Codex app-server and a local harness runtime for environment hosts", () => {
    const context = {
      splitHostEnvironment: true,
      executionEnvironment: { id: "remote" } as ExecutionEnvironmentProvider,
      mcpServers: {},
      checkouts: [],
      worktreeRoot: "/unused",
      shared: {
        workspace: "/unused",
        timeoutMs: 1_000,
        redactValues: [],
        contextResolvers: new ContextResolverRegistry([]),
      },
    } as const;
    createHarnessWorker(worker("codex"), context);
    expect(codexFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionMode: "app-server",
        executionEnvironment: context.executionEnvironment,
        harnessRuntime: expect.any(LocalHarnessRuntimeProvider),
      }),
    );
    expect(() =>
      createHarnessWorker({ ...worker("codex"), codexExecutionMode: "exec" }, context),
    ).toThrow(/codex-execution-mode exec.*environment/);
  });
});
