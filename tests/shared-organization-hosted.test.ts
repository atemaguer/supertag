import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeInSandbox,
  installedCodexVersion,
  readMcpEvidence,
  startModal,
  stopModal,
} from "../examples/shared-organization/execution.mjs";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(options: { installExitCode?: number; tunnelUrl?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-hosted-example-"));
  directories.push(directory);
  for (const name of ["supertag-ai.tgz", "execution-service.mjs", "mcp-fixture.cjs"])
    await writeFile(join(directory, name), `fixture ${name}`);
  const state: Record<string, unknown> = { provider: "modal", stateDirectory: directory };
  const saved: Record<string, unknown>[] = [];
  const events: string[] = [];
  const save = vi.fn(async (value) => {
    saved.push(structuredClone(value));
    events.push(`saved:${value.modalSandboxId ?? "image"}`);
  });
  const image = { imageId: "im-fixture" };
  const builder = {
    dockerfileCommands: vi.fn((_commands) => builder),
    build: vi.fn(async () => image),
  };
  const process = {
    wait: vi.fn(async () => options.installExitCode ?? 0),
    stdout: { readText: vi.fn(async () => "fixture stdout") },
    stderr: { readText: vi.fn(async () => "fixture stderr") },
  };
  const sandbox = {
    sandboxId: "sb-owned-fixture",
    detach: vi.fn(() => {
      events.push("detached");
    }),
    filesystem: {
      writeBytes: vi.fn(async (_bytes, _path) => {
        events.push("uploaded");
      }),
      readBytes: vi.fn(async (path: string) => Buffer.from(`evidence from ${path}`)),
      readText: vi.fn(async () => '{"actor":"claude-code","committed":true}\n'),
    },
    exec: vi.fn(async (_args, _options) => process),
    tunnels: vi.fn(async () => ({
      8787: { url: options.tunnelUrl ?? "https://fixture.example.test" },
    })),
    terminate: vi.fn(async (_options) => {
      events.push("terminated");
    }),
  };
  const client = {
    apps: { fromName: vi.fn(async (_name, _options) => ({ appId: "ap-fixture" })) },
    images: { fromRegistry: vi.fn((_name) => builder) },
    sandboxes: {
      create: vi.fn(async (_app, _image, _options) => {
        events.push("created");
        return sandbox;
      }),
      fromId: vi.fn(async (_id) => sandbox),
    },
    close: vi.fn(async () => {}),
  };
  const createClient = vi.fn(async () => client);
  const startOptions = {
    build: directory,
    codexVersion: "0.114.0",
    token: "execution-fixture-secret",
    mcpToken: "mcp-fixture-secret",
    save,
    createClient,
  };
  return {
    directory,
    state,
    saved,
    events,
    save,
    image,
    builder,
    sandbox,
    client,
    createClient,
    startOptions,
  };
}

describe("hosted shared organization lifecycle", () => {
  it("records the owned sandbox before uploads and confines credentials to service environment", async () => {
    const fixture_ = await fixture();
    await startModal(fixture_.state, fixture_.startOptions);
    expect(fixture_.events.slice(0, 4)).toEqual([
      "saved:image",
      "created",
      "saved:sb-owned-fixture",
      "uploaded",
    ]);
    expect(fixture_.client.sandboxes.create).toHaveBeenCalledExactlyOnceWith(
      { appId: "ap-fixture" },
      fixture_.image,
      expect.objectContaining({
        command: ["sleep", "infinity"],
        encryptedPorts: [8787],
        timeoutMs: 1_200_000,
      }),
    );
    expect(fixture_.sandbox.filesystem.writeBytes.mock.calls.map(([, path]) => path)).toEqual([
      "/app/supertag-ai.tgz",
      "/app/execution-service.mjs",
      "/app/mcp-fixture.cjs",
    ]);
    expect(fixture_.sandbox.exec).toHaveBeenCalledWith(
      ["npm", "install", "--omit=dev", "/app/supertag-ai.tgz"],
      expect.objectContaining({ workdir: "/app", timeoutMs: 180_000 }),
    );
    const service = fixture_.sandbox.exec.mock.calls.find(([, options]) => options?.env);
    expect(service?.[0]).toEqual([
      "sh",
      "-c",
      "exec node /app/execution-service.mjs >/state/execution-service.log 2>&1",
    ]);
    expect(service?.[1].env).toEqual({
      SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: fixture_.startOptions.token,
      SUPERTAG_EXAMPLE_MCP_TOKEN: fixture_.startOptions.mcpToken,
    });
    const exposed = JSON.stringify({
      state: fixture_.saved,
      build: fixture_.builder.dockerfileCommands.mock.calls,
      provisioning: fixture_.client.sandboxes.create.mock.calls,
      commands: fixture_.sandbox.exec.mock.calls.map(([args]) => args),
      uploads: fixture_.sandbox.filesystem.writeBytes.mock.calls,
    });
    expect(exposed).not.toContain(fixture_.startOptions.token);
    expect(exposed).not.toContain(fixture_.startOptions.mcpToken);
    expect(fixture_.state.executionUrl).toBe("https://fixture.example.test");
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it.each(["latest", "0.114.0; echo injected", "$(echo injected)"])(
    "rejects a non-exact Codex image version before provider calls: %s",
    async (codexVersion) => {
      const fixture_ = await fixture();
      await expect(
        startModal(fixture_.state, { ...fixture_.startOptions, codexVersion }),
      ).rejects.toThrow("exact Codex version");
      expect(fixture_.createClient).not.toHaveBeenCalled();
    },
  );

  it("retains a cleanup target after package installation fails", async () => {
    const fixture_ = await fixture({ installExitCode: 1 });
    await expect(startModal(fixture_.state, fixture_.startOptions)).rejects.toThrow(
      "Installing the public package",
    );
    expect(fixture_.saved.at(-1)?.modalSandboxId).toBe("sb-owned-fixture");
    expect(fixture_.sandbox.exec).toHaveBeenCalledTimes(1);
    expect(fixture_.state.executionUrl).toBeUndefined();
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("terminates a sandbox immediately if recording its ID fails", async () => {
    const fixture_ = await fixture();
    const persistenceError = new Error("Private state write failed");
    await expect(
      startModal(fixture_.state, {
        ...fixture_.startOptions,
        save: async (state) => {
          if (state.modalSandboxId) throw persistenceError;
        },
      }),
    ).rejects.toBe(persistenceError);
    expect(fixture_.sandbox.terminate).toHaveBeenCalledExactlyOnceWith({ wait: true });
    expect(fixture_.sandbox.filesystem.writeBytes).not.toHaveBeenCalled();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("reports both failed registration and unconfirmed termination of an unrecorded sandbox", async () => {
    const fixture_ = await fixture();
    const persistenceError = new Error("Private state write failed");
    const cleanupError = new Error("Provider termination failed");
    fixture_.sandbox.terminate.mockRejectedValue(cleanupError);
    const result = await startModal(fixture_.state, {
      ...fixture_.startOptions,
      save: async (state) => {
        if (state.modalSandboxId) throw persistenceError;
      },
    }).catch((error) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([persistenceError, cleanupError]);
    expect(result.message).toContain("sb-owned-fixture");
    expect(fixture_.sandbox.filesystem.writeBytes).not.toHaveBeenCalled();
  });

  it("does not save an insecure hosted tunnel as a usable endpoint", async () => {
    const fixture_ = await fixture({ tunnelUrl: "http://fixture.example.test" });
    await expect(startModal(fixture_.state, fixture_.startOptions)).rejects.toThrow(
      "requires HTTPS",
    );
    expect(fixture_.saved.every((snapshot) => snapshot.executionUrl === undefined)).toBe(true);
    expect(fixture_.saved.at(-1)?.modalSandboxId).toBe("sb-owned-fixture");
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("terminates exactly its sandbox and preserves private evidence without deleting shared images", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.state.modalImageId = fixture_.image.imageId;
    await stopModal(fixture_.state, { createClient: fixture_.createClient });
    expect(fixture_.client.sandboxes.fromId).toHaveBeenCalledExactlyOnceWith("sb-owned-fixture");
    expect(fixture_.sandbox.terminate).toHaveBeenCalledExactlyOnceWith({ wait: true });
    expect(fixture_.state.modalTerminated).toEqual(expect.any(String));
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.images.fromRegistry).not.toHaveBeenCalled();
    const evidence = join(fixture_.directory, "hosted-evidence");
    expect((await stat(evidence)).mode & 0o777).toBe(0o700);
    for (const name of ["csv-summary.mjs", "review.md"]) {
      expect((await stat(join(evidence, name))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(evidence, name), "utf8")).toBe(
        `evidence from /data/workspace/${name}`,
      );
    }
    await stopModal(fixture_.state, { createClient: fixture_.createClient });
    expect(fixture_.sandbox.terminate).toHaveBeenCalledOnce();
    expect(fixture_.createClient).toHaveBeenCalledOnce();
  });

  it("still terminates when generated evidence is missing", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.sandbox.filesystem.readBytes.mockRejectedValue(new Error("No output exists"));
    await stopModal(fixture_.state, { createClient: fixture_.createClient });
    expect(fixture_.sandbox.terminate).toHaveBeenCalledOnce();
    expect(fixture_.state.modalTerminated).toEqual(expect.any(String));
    await expect(
      readFile(join(fixture_.directory, "hosted-evidence", "review.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves termination unconfirmed when the provider does not confirm it", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.sandbox.terminate.mockRejectedValue(new Error("Termination not confirmed"));
    await expect(
      stopModal(fixture_.state, { createClient: fixture_.createClient }),
    ).rejects.toThrow("Termination not confirmed");
    expect(fixture_.state.modalTerminated).toBeUndefined();
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("does not mask a failed sandbox termination with a client-close failure", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    const terminationError = new Error("Termination not confirmed");
    fixture_.sandbox.terminate.mockRejectedValue(terminationError);
    fixture_.client.close.mockRejectedValue(new Error("Client close failed"));
    await expect(stopModal(fixture_.state, { createClient: fixture_.createClient })).rejects.toBe(
      terminationError,
    );
    expect(fixture_.state.modalTerminated).toBeUndefined();
  });

  it("does not let stalled optional evidence reads prevent sandbox termination", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.sandbox.filesystem.readBytes.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const stopped = stopModal(fixture_.state, { createClient: fixture_.createClient });
    await vi.waitFor(() => expect(fixture_.sandbox.filesystem.readBytes).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(6_001);
    await stopped;
    expect(fixture_.sandbox.terminate).toHaveBeenCalledOnce();
    expect(fixture_.state.modalTerminated).toEqual(expect.any(String));
  });

  it("executes generated verification code through the workload identity with an empty environment", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    const source = 'throw new Error("must execute only in the sandbox")';
    await expect(
      executeInSandbox(fixture_.state, source, { createClient: fixture_.createClient }),
    ).resolves.toBe("fixture stdout");
    expect(fixture_.sandbox.exec).toHaveBeenCalledExactlyOnceWith(
      [
        "runuser",
        "-u",
        "workload",
        "--",
        "env",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "node",
        "--input-type=module",
        "-e",
        source,
      ],
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(fixture_.client.sandboxes.fromId).toHaveBeenCalledExactlyOnceWith("sb-owned-fixture");
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("reads backend MCP evidence through the provider channel, without executing generated code", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    await expect(
      readMcpEvidence(fixture_.state, { createClient: fixture_.createClient }),
    ).resolves.toEqual([{ actor: "claude-code", committed: true }]);
    expect(fixture_.sandbox.filesystem.readText).toHaveBeenCalledExactlyOnceWith(
      "/state/example-mcp/calls.jsonl",
    );
    expect(fixture_.sandbox.exec).not.toHaveBeenCalled();
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("does not accept a corrupt MCP ledger as observed evidence", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.sandbox.filesystem.readText.mockResolvedValue('{"actor":"claude-code"');
    await expect(
      readMcpEvidence(fixture_.state, { createClient: fixture_.createClient }),
    ).rejects.toThrow();
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("reports a stalled sandbox lookup without claiming termination", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.client.sandboxes.fromId.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const failure = expect(
      stopModal(fixture_.state, { createClient: fixture_.createClient }),
    ).rejects.toThrow("Modal sandbox lookup timed out; outcome is uncertain");
    await vi.advanceTimersByTimeAsync(5_001);
    await failure;
    expect(fixture_.sandbox.terminate).not.toHaveBeenCalled();
    expect(fixture_.sandbox.detach).not.toHaveBeenCalled();
    expect(fixture_.state.modalTerminated).toBeUndefined();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("bounds an operator MCP evidence read without inventing empty evidence", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.sandbox.filesystem.readText.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const failure = expect(
      readMcpEvidence(fixture_.state, { createClient: fixture_.createClient }),
    ).rejects.toThrow("MCP evidence read timed out; outcome is uncertain");
    await vi.advanceTimersByTimeAsync(5_001);
    await failure;
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
  });

  it("records unavailable MCP evidence while still terminating its sandbox", async () => {
    const fixture_ = await fixture();
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    fixture_.state.mcp = true;
    fixture_.sandbox.filesystem.readText.mockRejectedValue(new Error("Ledger unavailable"));
    await stopModal(fixture_.state, { createClient: fixture_.createClient });
    expect(fixture_.state.mcpEvidenceUnavailable).toBe(true);
    expect(fixture_.state.modalTerminated).toEqual(expect.any(String));
    await expect(
      readFile(join(fixture_.directory, "hosted-evidence", "mcp-calls.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detaches the sandbox after generated verification code fails", async () => {
    const fixture_ = await fixture({ installExitCode: 1 });
    fixture_.state.modalSandboxId = fixture_.sandbox.sandboxId;
    await expect(
      executeInSandbox(fixture_.state, "throw new Error('invalid result')", {
        createClient: fixture_.createClient,
      }),
    ).rejects.toThrow("Sandbox command failed");
    expect(fixture_.sandbox.detach).toHaveBeenCalledOnce();
    expect(fixture_.client.close).toHaveBeenCalledOnce();
    expect(fixture_.sandbox.detach.mock.invocationCallOrder[0]).toBeLessThan(
      fixture_.client.close.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("installed example Codex version", () => {
  it("uses the public package's pinned SDK version without invoking a PATH CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-codex-version-"));
    directories.push(directory);
    const manifest = join(directory, "package.json");
    await writeFile(
      manifest,
      JSON.stringify({
        dependencies: { "@openai/codex-sdk": "0.146.0" },
        version: "0.2.0-alpha.1",
      }),
    );
    const prior = process.env.PATH;
    process.env.PATH = "/nonexistent-example-codex-path";
    try {
      await expect(installedCodexVersion(manifest)).resolves.toBe("0.146.0");
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
  });
  it.each([undefined, "^0.146.0", "latest", "0.146.0;echo bad"])(
    "rejects an unpinned SDK dependency (%s)",
    async (version) => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-codex-version-"));
      directories.push(directory);
      const manifest = join(directory, "package.json");
      await writeFile(manifest, JSON.stringify({ dependencies: { "@openai/codex-sdk": version } }));
      await expect(installedCodexVersion(manifest)).rejects.toThrow(
        "pin an exact Codex SDK version",
      );
    },
  );
});
