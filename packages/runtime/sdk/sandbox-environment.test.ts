import { describe, expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.ts";
import type { ExecutionEnvironmentSpec } from "./src/index.ts";
import { ProcessOutputBuffer } from "./src/process-supervision.ts";
import {
  type SandboxBackend,
  SandboxExecutionEnvironmentProvider,
  type SandboxInstance,
} from "./src/sandbox-environment.ts";

function fixture(overrides: Partial<SandboxInstance> = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const sandbox: SandboxInstance = {
    id: "custom-1",
    mkdir: async (path) => {
      calls.push(`mkdir:${path}`);
    },
    write: async (path, bytes, options) => {
      if (options.exclusive && files.has(path)) throw new Error("collision");
      files.set(path, bytes);
      calls.push(`write:${path}`);
    },
    read: async (path) => files.get(path) ?? new Uint8Array(),
    makeReadOnly: async (path) => {
      calls.push(`readonly:${path}`);
    },
    start: async (_spec, options) => {
      options.onOutput({ stream: "stdout", text: "hello" });
      return {
        wait: async () => ({ exitCode: 0, stdout: "hello", stderr: "" }),
        terminate: async () => true,
      };
    },
    terminate: vi.fn(async () => true),
    ...overrides,
  };
  const backend: SandboxBackend = {
    capabilities: {
      networkModes: ["none"],
      readOnlyMounts: true,
      boundedSymlinkSafeReads: true,
      streamOutput: true,
    },
    create: vi.fn(async () => sandbox),
  };
  const provider = new SandboxExecutionEnvironmentProvider({ id: "custom", backend });
  return { sandbox, backend, provider, files, calls };
}
function spec(): ExecutionEnvironmentSpec {
  return {
    task: repositoryAttempt("sandbox"),
    profile: {
      ref: { id: "test", revision: "1" },
      workerType: "test",
      harness: { provider: "test" },
      execution: { provider: "custom", lifetime: { scope: "attempt" } },
    },
    plan: {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" },
    },
  };
}
describe("provider-neutral sandbox adapter", () => {
  it("exposes materialization only when the backend supplies the isolation contract", async () => {
    const unsupported = await fixture().provider.provision(spec());
    expect(unsupported.materializeArtifactFiles).toBeUndefined();
    await unsupported.dispose("completed");
    const materialize = vi.fn(async () => {});
    const { provider } = fixture({ materializeArtifactFiles: materialize });
    const env = await provider.provision(spec());
    const directory = `artifact-${"a".repeat(64)}`;
    const input = {
      directory,
      files: [{ path: "research/data.bin", bytes: new Uint8Array([0, 255, 7]) }],
    };
    expect(await env.materializeArtifactFiles?.(input)).toBe(env.resolvePath(directory));
    expect(materialize).toHaveBeenCalledWith({ ...input, directory: env.resolvePath(directory) });
    await expect(
      env.materializeArtifactFiles?.({
        ...input,
        files: [{ path: "../escape", bytes: new Uint8Array() }],
      }),
    ).rejects.toThrow("Invalid artifact");
    expect(materialize).toHaveBeenCalledOnce();
    await env.dispose("completed");
    await expect(env.materializeArtifactFiles?.(input)).rejects.toThrow("disposed");
  });
  it("stages binary files, streams output, and rejects collisions/traversal without a vendor SDK", async () => {
    const { provider } = fixture();
    const env = await provider.provision(spec());
    expect(env.provenance).toEqual({ sandboxId: "custom-1" });
    const plan = {
      ...spec().plan,
      files: [{ path: "input.bin", content: new Uint8Array([0, 255, 7]) }],
    };
    await env.prepare(plan);
    expect(await env.readBytes?.("input.bin")).toEqual(new Uint8Array([0, 255, 7]));
    await expect(env.prepare(plan)).rejects.toThrow("collision");
    expect(() => env.resolvePath("../../outside")).toThrow("escapes");
    const process = await env.spawn({ command: "custom-program", streamOutput: true });
    const chunks = [];
    if (!process.output) throw new Error("Missing output stream");
    for await (const chunk of process.output) chunks.push(chunk);
    expect(chunks).toEqual([{ stream: "stdout", text: "hello" }]);
    expect((await process.wait()).exitCode).toBe(0);
    await env.dispose("completed");
  });
  it("settles cancellation after whole-sandbox termination even when backend process.wait never settles", async () => {
    const { provider, sandbox } = fixture({
      start: async () => ({ wait: () => new Promise(() => {}), terminate: async () => false }),
    });
    const env = await provider.provision(spec());
    const abort = new AbortController();
    const process = await env.spawn({ command: "stubborn" }, abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(process.wait()).rejects.toThrow("cancelled");
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    await env.dispose("cancelled");
    expect(sandbox.terminate).toHaveBeenCalledOnce();
  });
  it.each([false, new Error("backend unreachable")])(
    "surfaces uncertain cleanup instead of ordinary cancellation: %s",
    async (outcome) => {
      const { provider } = fixture({
        start: async () => ({ wait: () => new Promise(() => {}), terminate: async () => false }),
        terminate: async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      });
      const env = await provider.provision(spec());
      const process = await env.spawn({ command: "stubborn" });
      await process.kill();
      await expect(process.wait()).rejects.toMatchObject({ name: "ExecutionCleanupError" });
      await expect(env.dispose("failed")).rejects.toMatchObject({ name: "ExecutionCleanupError" });
    },
  );
  it("bounds a nonsettling sandbox termination and preserves cleanup uncertainty", async () => {
    vi.useFakeTimers();
    try {
      const { provider } = fixture({ terminate: () => new Promise(() => {}) });
      const env = await provider.provision(spec());
      const check = expect(env.dispose("failed")).rejects.toMatchObject({
        name: "ExecutionCleanupError",
      });
      await vi.advanceTimersByTimeAsync(5000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects unsupported policies before provisioning", async () => {
    const { provider, backend } = fixture();
    await expect(
      provider.provision({ ...spec(), plan: { ...spec().plan, network: { mode: "full" } } }),
    ).rejects.toThrow("network policy");
    expect(backend.create).not.toHaveBeenCalled();
  });
});
describe("sandbox process output backpressure", () => {
  const CHUNK = 64 * 1024;
  const text = (index: number) => String(index % 10).repeat(CHUNK);
  it("pauses a backend that awaits onOutput and delivers every chunk in order", async () => {
    const total = 256; // 16 MiB, twice the hard cap.
    let peak = 0;
    const { provider } = fixture({
      start: async (_spec, options) => {
        const produced = (async () => {
          for (let index = 0; index < total; index++)
            await options.onOutput({ stream: index % 2 ? "stderr" : "stdout", text: text(index) });
        })();
        return {
          wait: async () => {
            await produced;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          terminate: async () => true,
        };
      },
    });
    const env = await provider.provision(spec());
    const process = await env.spawn({ command: "chatty", streamOutput: true });
    const output = process.output;
    if (!(output instanceof ProcessOutputBuffer)) throw new Error("Missing output buffer");
    let index = 0;
    for await (const chunk of output) {
      peak = Math.max(peak, output.bufferedBytes + chunk.text.length);
      expect(chunk).toEqual({ stream: index % 2 ? "stderr" : "stdout", text: text(index) });
      index++;
      if (index % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(index).toBe(total);
    expect((await process.wait()).exitCode).toBe(0);
    expect(peak).toBeLessThanOrEqual(output.highWaterBytes + CHUNK);
    await env.dispose("completed");
  });
  it("fails a backend that ignores backpressure only at the hard cap", async () => {
    const { provider } = fixture({
      start: async (_spec, options) => {
        for (let index = 0; index < 160; index++)
          void options.onOutput({ stream: "stdout", text: text(index) });
        return { wait: () => new Promise(() => {}), terminate: async () => true };
      },
    });
    const env = await provider.provision(spec());
    const process = await env.spawn({ command: "flood", streamOutput: true });
    await expect(process.wait()).rejects.toThrow(/8388608-byte hard limit.*could not pause/);
    await env.dispose("failed");
  });
});
