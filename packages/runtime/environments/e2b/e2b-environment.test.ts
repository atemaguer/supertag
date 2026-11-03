import type { ExecutionEnvironmentSpec, HarnessPlan, ProcessSpec } from "@supertag/worker-sdk";
import { describe, expect, it, vi } from "vitest";
import { assertConformance, runEnvironmentConformance } from "../../sdk/src/conformance.ts";
import {
  E2BExecutionEnvironmentProvider,
  type E2BSandboxClient,
  type E2BSandboxFactory,
} from "./src/index.ts";

describe("E2BExecutionEnvironmentProvider", () => {
  it("sends descriptor-safe artifact materialization through sandbox stdin", async () => {
    const mocked = mockSandbox();
    const provider = new E2BExecutionEnvironmentProvider({
      sandboxFactory: { create: async () => mocked.sandbox },
    });
    const env = await provider.provision(executionSpec());
    try {
      const directory = `artifact-${"a".repeat(64)}`;
      expect(
        await env.materializeArtifactFiles?.({
          directory,
          files: [{ path: "data.bin", bytes: new Uint8Array([0, 255]) }],
        }),
      ).toBe(env.resolvePath(directory));
      expect(mocked.run).toHaveBeenCalledWith(
        expect.stringContaining("O_NOFOLLOW"),
        expect.objectContaining({ background: true, stdin: true, timeoutMs: 30000 }),
      );
      expect(mocked.sendStdin).toHaveBeenCalledWith(
        JSON.stringify([{ path: "data.bin", data: "AP8=" }]),
      );
      expect(mocked.closeStdin).toHaveBeenCalledOnce();
    } finally {
      await env.dispose("completed");
    }
  });
  it("keeps native E2B stdin open for interactive exchanges and revokes it on disposal", async () => {
    const mocked = interactiveSandbox();
    const provider = new E2BExecutionEnvironmentProvider({
      sandboxFactory: { create: async () => mocked.sandbox },
    });
    expect(provider.capabilities).toEqual(
      expect.arrayContaining([
        { id: "supertag.process-input-streaming", version: 1 },
        { id: "supertag.process-output-streaming", version: 1 },
      ]),
    );
    const env = await provider.provision(executionSpec());
    try {
      const handle = await env.spawn({ command: "agent", streamInput: true, streamOutput: true });
      if (!handle.write || !handle.endInput || !handle.output)
        throw new Error("Missing duplex input");
      const output = handle.output[Symbol.asyncIterator]();
      await handle.write(new TextEncoder().encode("one\n"));
      expect((await output.next()).value?.text).toBe("response:one\n");
      await handle.write(new TextEncoder().encode("two\n"));
      expect((await output.next()).value?.text).toBe("response:two\n");
      await handle.endInput();
      await expect(handle.wait()).resolves.toMatchObject({
        exitCode: 0,
        stdout: "response:one\nresponse:two\n",
      });
      await expect(handle.write(new Uint8Array([1]))).rejects.toThrow();
      expect(mocked.run).toHaveBeenCalledWith(
        "'agent'",
        expect.objectContaining({ background: true, stdin: true }),
      );

      const pending = await env.spawn({ command: "agent", streamInput: true });
      await env.dispose("cancelled");
      await expect(pending.write?.(new Uint8Array([1]))).rejects.toThrow();
    } finally {
      await env.dispose("completed");
    }
  });
  it("executes the bounded no-follow reader against real files and rejects symlinks and oversized output", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-e2b-read-")));
    const mocked = mockSandbox();
    const execute = promisify(execFile);
    const commands = {
      run: async (command: string, options: { envs?: Record<string, string> } = {}) => {
        try {
          const result = await execute("sh", ["-c", command], {
            env: { ...process.env, ...options.envs },
            maxBuffer: 45 * 1024 * 1024,
          });
          return { exitCode: 0, ...result };
        } catch {
          return { exitCode: 1, stdout: "", stderr: "rejected" };
        }
      },
    };
    const provider = new E2BExecutionEnvironmentProvider({
      rootDirectory: directory,
      sandboxFactory: {
        create: async () => ({ ...mocked.sandbox, commands }) as unknown as E2BSandboxClient,
      },
    });
    const environment = await provider.provision(executionSpec());
    try {
      await mkdir(environment.rootDirectory, { recursive: true });
      await writeFile(environment.resolvePath("data.bin"), new Uint8Array([0, 255, 7]));
      expect(await environment.readBytes?.("data.bin")).toEqual(new Uint8Array([0, 255, 7]));
      await symlink(environment.resolvePath("data.bin"), environment.resolvePath("linked.bin"));
      await expect(environment.readBytes?.("linked.bin")).rejects.toThrow("bounded regular file");
      await writeFile(environment.resolvePath("large.bin"), new Uint8Array(32 * 1024 * 1024 + 1));
      await expect(environment.readBytes?.("large.bin")).rejects.toThrow("bounded regular file");
    } finally {
      await environment.dispose("completed");
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("reads binary artifact bytes without text conversion", async () => {
    const mocked = mockSandbox();
    const bytes = new Uint8Array([0, 255, 128]);
    mocked.files.set(
      "/home/user/supertag-tasks/task-1/attempts/attempt-1/output.bin",
      bytes.buffer,
    );
    const sandbox = mocked.sandbox;
    const provider = new E2BExecutionEnvironmentProvider({
      sandboxFactory: { create: async () => sandbox },
    });
    const environment = await provider.provision(executionSpec());
    try {
      expect(await environment.readBytes?.("output.bin")).toEqual(bytes);
      expect(mocked.run).toHaveBeenCalledWith(
        expect.stringContaining("O_NOFOLLOW"),
        expect.objectContaining({
          envs: expect.objectContaining({
            SUPERTAG_FILE_PATH: environment.resolvePath("output.bin"),
          }),
        }),
      );
      await expect(environment.readBytes?.("../outside")).rejects.toThrow(/escapes/);
    } finally {
      await environment.dispose("completed");
    }
  });
  it("passes the shared remote environment conformance probe with a sandbox factory", async () => {
    const mocked = mockSandbox();
    const provider = new E2BExecutionEnvironmentProvider({
      sandboxFactory: { create: vi.fn(async () => mocked.sandbox) },
    });
    const report = await runEnvironmentConformance({
      provider,
      spec: executionSpec(),
      expectedPlacement: "remote",
    });

    expect(report.passed).toBe(true);
    expect(() => assertConformance(report)).not.toThrow();
    expect(mocked.killSandbox).toHaveBeenCalledOnce();
  });

  it("provisions, prepares, executes, captures output, and disposes a remote sandbox", async () => {
    const mocked = mockSandbox();
    const create = vi.fn(async () => mocked.sandbox);
    const provider = new E2BExecutionEnvironmentProvider({
      template: "supertag-codex",
      rootDirectory: "/workspace/supertag",
      sandboxTimeoutMs: 120_000,
      requestTimeoutMs: 10_000,
      maxOutputCharacters: 5,
      sandboxFactory: { create } satisfies E2BSandboxFactory,
    });
    const spec = executionSpec({
      network: { mode: "allowlist", allowedHosts: ["api.openai.com"] },
      files: [{ path: "instructions/AGENTS.md", content: "Be useful", mode: 0o640 }],
    });

    const environment = await provider.provision(spec);
    await environment.prepare(spec.plan);
    const process: ProcessSpec = {
      command: "agent",
      args: ["run", "hello world", "a'b", "$(unsafe)"],
      environment: { TASK_ID: "task-1", ATTEMPT_ID: "attempt-1" },
      stdin: "question\n",
      timeoutMs: 30_000,
    };
    const handle = await environment.spawn(process);
    await expect(handle.wait()).resolves.toEqual({
      exitCode: 0,
      stdout: "23456",
      stderr: "error",
    });
    await expect(environment.read("instructions/AGENTS.md")).resolves.toBe("Be useful");
    await environment.dispose("completed");
    await environment.dispose("completed");

    expect(environment.id).toBe("e2b:sandbox-1");
    expect(environment.placement).toBe("remote");
    expect(environment.rootDirectory).toBe("/workspace/supertag/task-1/attempts/attempt-1");
    expect(create).toHaveBeenCalledWith({
      template: "supertag-codex",
      timeoutMs: 120_000,
      requestTimeoutMs: 10_000,
      metadata: {
        "supertag.taskId": "task-1",
        "supertag.attemptId": "attempt-1",
        "supertag.tagId": "tag-1",
      },
      network: { allowOut: ["api.openai.com"] },
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("accessToken");
    expect(mocked.makeDir).toHaveBeenCalledWith("/workspace/supertag/task-1/attempts/attempt-1");
    expect(mocked.write).toHaveBeenCalledWith(
      "/workspace/supertag/task-1/attempts/attempt-1/instructions/AGENTS.md",
      new TextEncoder().encode("Be useful").buffer,
    );
    const agentCall = mocked.run.mock.calls.find(([command]) => command.startsWith("'agent'"));
    expect(agentCall?.[0]).toBe(`'agent' 'run' 'hello world' 'a'"'"'b' '$(unsafe)'`);
    expect(agentCall?.[1]).toEqual(
      expect.objectContaining({
        background: true,
        cwd: "/workspace/supertag/task-1/attempts/attempt-1",
        envs: { TASK_ID: "task-1", ATTEMPT_ID: "attempt-1" },
        stdin: true,
        timeoutMs: 30_000,
      }),
    );
    expect(mocked.sendStdin).toHaveBeenCalledWith("question\n");
    expect(mocked.closeStdin).toHaveBeenCalledOnce();
    expect(mocked.killSandbox).toHaveBeenCalledOnce();
  });

  it("fails closed for unsupported lifetimes, empty allowlists, mount schemes, secrets, and traversal", async () => {
    const mocked = mockSandbox();
    const provider = new E2BExecutionEnvironmentProvider({
      sandboxFactory: { create: vi.fn(async () => mocked.sandbox) },
    });

    await expect(
      provider.provision(
        executionSpec({}, { execution: { provider: "e2b", lifetime: { scope: "host" } } }),
      ),
    ).rejects.toThrow(/attempt-scoped/i);
    await expect(
      provider.provision(executionSpec({ network: { mode: "allowlist", allowedHosts: [] } })),
    ).rejects.toThrow(/at least one host/i);

    const mountSpec = executionSpec({
      mounts: [
        {
          source: { uri: "git+https://example.test/repository" },
          destination: "repository",
          readOnly: true,
        },
      ],
    });
    const mountEnvironment = await provider.provision(mountSpec);
    await expect(mountEnvironment.prepare(mountSpec.plan)).rejects.toThrow(/file: resources/i);
    expect(() => mountEnvironment.resolvePath("../../escape")).toThrow(/escapes its root/i);
    await mountEnvironment.dispose("failed");

    const secretSpec = executionSpec({
      secretBindings: [{ secretRef: "openai", target: "OPENAI_API_KEY" }],
    });
    const secretEnvironment = await provider.provision(secretSpec);
    await expect(secretEnvironment.prepare(secretSpec.plan)).rejects.toThrow(/secret bindings/i);
    await secretEnvironment.dispose("failed");
  });

  it("kills a running E2B command when its Task Attempt is cancelled", async () => {
    const mocked = mockSandbox({ wait: new Promise(() => undefined) });
    const provider = new E2BExecutionEnvironmentProvider({
      sandboxFactory: { create: vi.fn(async () => mocked.sandbox) },
    });
    const spec = executionSpec();
    const environment = await provider.provision(spec);
    const controller = new AbortController();
    const process = await environment.spawn({ command: "agent" }, controller.signal);

    controller.abort(new Error("cancelled by test"));

    await expect(process.wait()).rejects.toThrow("cancelled by test");
    expect(mocked.killSandbox).toHaveBeenCalledOnce();
    await environment.dispose("cancelled");
    void process;
  });

  it("stages a workspace and nested skill overlay before making both read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-e2b-workspace-"));
    const repository = join(directory, "repository");
    const skill = join(directory, "code-review");
    await mkdir(join(repository, "src"), { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(join(repository, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(join(skill, "SKILL.md"), "---\nname: code-review\n---\nReview code.\n");
    const mocked = mockSandbox();
    const provider = new E2BExecutionEnvironmentProvider({
      rootDirectory: "/workspace/supertag",
      sandboxFactory: { create: vi.fn(async () => mocked.sandbox) },
    });
    const spec = executionSpec({
      mounts: [
        {
          source: { uri: pathToFileURL(repository).href, digest: "git:abc" },
          destination: "workspace",
          readOnly: true,
        },
        {
          source: { uri: pathToFileURL(skill).href, digest: "sha256:def" },
          destination: "workspace/.agents/skills/code-review",
          readOnly: true,
        },
      ],
    });

    try {
      const environment = await provider.provision(spec);
      await environment.prepare(spec.plan);

      expect(mocked.makeDir).toHaveBeenCalledWith(
        "/workspace/supertag/task-1/attempts/attempt-1/workspace/src",
      );
      expect(mocked.write).toHaveBeenCalledWith(
        "/workspace/supertag/task-1/attempts/attempt-1/workspace/src/index.ts",
        expect.any(ArrayBuffer),
      );
      expect(mocked.write).toHaveBeenCalledWith(
        "/workspace/supertag/task-1/attempts/attempt-1/workspace/.agents/skills/code-review/SKILL.md",
        expect.any(ArrayBuffer),
      );
      expect(
        mocked.run.mock.calls
          .map(([command]) => command)
          .filter((command) => command.startsWith("chmod -R")),
      ).toEqual([
        "chmod -R a-w '/workspace/supertag/task-1/attempts/attempt-1/workspace/.agents/skills/code-review'",
        "chmod -R a-w '/workspace/supertag/task-1/attempts/attempt-1/workspace'",
      ]);
      await environment.dispose("completed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function executionSpec(
  plan: Partial<HarnessPlan> = {},
  profile: Partial<ExecutionEnvironmentSpec["profile"]> = {},
): ExecutionEnvironmentSpec {
  return {
    task: {
      version: 1,
      taskId: "task-1",
      attemptId: "attempt-1",
      tag: { id: "tag-1", name: "Engineering" },
      input: {
        origin: {
          surface: "github",
          accountId: "account-1",
          scope: "repository:supertag",
          sessionKey: "github:issue:1",
          occurredAt: "2026-08-02T00:00:00.000Z",
        },
        messages: [{ id: "message-1", role: "requester", text: "How does this work?" }],
      },
      authorization: {} as ExecutionEnvironmentSpec["task"]["authorization"],
      contextPlan: {} as ExecutionEnvironmentSpec["task"]["contextPlan"],
      execution: {},
      workerProfile: { id: "codex-e2b", revision: "1" },
    },
    profile: {
      ref: { id: "codex-e2b", revision: "1" },
      workerType: "supertag",
      harness: { provider: "codex" },
      execution: { provider: "e2b", lifetime: { scope: "attempt" } },
      ...profile,
    },
    plan: {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" },
      ...plan,
    },
  };
}

function mockSandbox(options: { readonly wait?: Promise<MockCommandResult> } = {}) {
  const files = new Map<string, string | ArrayBuffer>();
  const makeDir = vi.fn(async () => true);
  const write = vi.fn(async (path: string, content: string | ArrayBuffer) => {
    files.set(path, content);
  });
  const read = vi.fn(async (path: string, options?: { format?: string }) => {
    const content = files.get(path);
    if (typeof content === "string")
      return options?.format === "bytes" ? new TextEncoder().encode(content) : content;
    if (content instanceof ArrayBuffer)
      return options?.format === "bytes"
        ? new Uint8Array(content)
        : new TextDecoder().decode(content);
    throw new Error(`Missing mock file ${path}`);
  });
  const sendStdin = vi.fn(async () => undefined);
  const closeStdin = vi.fn(async () => undefined);
  const killCommand = vi.fn(async () => true);
  const result = { exitCode: 0, stdout: "123456", stderr: "error" };
  const run = vi.fn(async (_command: string, commandOptions: MockCommandOptions = {}) => {
    const path = commandOptions.envs?.SUPERTAG_FILE_PATH;
    if (path) {
      if (commandOptions.envs?.SUPERTAG_FILE_LIMIT) {
        const content = files.get(path);
        if (!content) return { ...result, exitCode: 1 };
        return {
          ...result,
          stdout: Buffer.from(
            typeof content === "string" ? content : new Uint8Array(content),
          ).toString("base64"),
        };
      }
      let input = "";
      return {
        pid: 43,
        wait: async () => result,
        kill: killCommand,
        sendStdin: async (value: string) => {
          input += value;
        },
        closeStdin: async () => {
          await write(path, new Uint8Array(Buffer.from(input, "base64")).buffer);
        },
      };
    }
    if (commandOptions.background !== true) return result;
    await commandOptions.onStdout?.("123");
    await commandOptions.onStdout?.("456");
    await commandOptions.onStderr?.("error");
    return {
      pid: 42,
      wait: async () => await (options.wait ?? Promise.resolve(result)),
      kill: killCommand,
      sendStdin,
      closeStdin,
    };
  });
  const killSandbox = vi.fn(async () => true);
  const sandbox = {
    sandboxId: "sandbox-1",
    files: { makeDir, write, read },
    commands: { run },
    kill: killSandbox,
  } as unknown as E2BSandboxClient;
  return {
    sandbox,
    files,
    makeDir,
    write,
    read,
    run,
    sendStdin,
    closeStdin,
    killCommand,
    killSandbox,
  };
}

function interactiveSandbox() {
  const base = mockSandbox();
  const result = { exitCode: 0, stdout: "", stderr: "" };
  const run = vi.fn(async (_command: string, commandOptions: MockCommandOptions = {}) => {
    if (commandOptions.background !== true) return result;
    let closed = false;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    return {
      pid: 42,
      wait: async () => {
        await done;
        return result;
      },
      kill: async () => {
        closed = true;
        complete();
        return true;
      },
      sendStdin: async (value: string | Uint8Array) => {
        if (closed) throw new Error("stdin closed");
        const text = typeof value === "string" ? value : new TextDecoder().decode(value);
        await commandOptions.onStdout?.(`response:${text}`);
      },
      closeStdin: async () => {
        if (closed) return;
        closed = true;
        complete();
      },
    };
  });
  const sandbox = { ...base.sandbox, commands: { run } } as unknown as E2BSandboxClient;
  return { sandbox, run };
}

interface MockCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface MockCommandOptions {
  readonly envs?: Record<string, string>;
  readonly background?: boolean;
  readonly stdin?: boolean;
  readonly onStdout?: (data: string) => void | Promise<void>;
  readonly onStderr?: (data: string) => void | Promise<void>;
}

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
