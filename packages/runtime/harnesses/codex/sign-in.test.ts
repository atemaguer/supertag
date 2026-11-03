import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Codex, Thread } from "@openai/codex-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCodexSignIn } from "./src/sign-in.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-signin-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function client(run = vi.fn().mockResolvedValue({ finalResponse: "OK" })) {
  const startThread = vi.fn(() => ({ run }) as unknown as Thread);
  const createCodex = vi.fn((_: ConstructorParameters<typeof Codex>[0]) => ({ startThread }));
  return { run, startThread, createCodex };
}

describe("Codex bundled SDK sign-in probe", () => {
  it("requires a model response and uses an isolated home with no unrelated credentials", async () => {
    const fake = client();
    await expect(
      checkCodexSignIn({
        createCodex: fake.createCodex,
        environment: {
          HOME: directory,
          OPENAI_API_KEY: "test-secret",
          UNRELATED_SECRET: "never-pass",
        },
      }),
    ).resolves.toBe(true);
    const options = fake.createCodex.mock.calls[0]?.[0];
    expect(options?.apiKey).toBe("test-secret");
    expect(options?.env).not.toHaveProperty("UNRELATED_SECRET");
    expect(fake.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: "read-only",
        approvalPolicy: "never",
        webSearchMode: "disabled",
      }),
    );
    await expect(stat(options?.env?.["CODEX_HOME"] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("matches Task credential precedence: CODEX_API_KEY, selected auth file, then OPENAI_API_KEY", async () => {
    const source = join(directory, "selected");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), '{"OPENAI_API_KEY":"file-key"}');
    const environment = {
      HOME: directory,
      CODEX_HOME: source,
      CODEX_API_KEY: "preferred",
      OPENAI_API_KEY: "fallback",
    };
    const fake = client();
    await expect(checkCodexSignIn({ createCodex: fake.createCodex, environment })).resolves.toBe(
      true,
    );
    expect(fake.createCodex.mock.calls[0]?.[0]?.apiKey).toBe("preferred");
    await expect(
      checkCodexSignIn({
        createCodex: fake.createCodex,
        environment: { ...environment, CODEX_API_KEY: undefined },
      }),
    ).resolves.toBe(true);
    expect(fake.createCodex).toHaveBeenCalledOnce();
  });

  it("never runs an SDK turn that could rotate a file-backed refresh token", async () => {
    const source = join(directory, ".codex");
    await mkdir(source);
    const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refresh" } });
    await writeFile(join(source, "auth.json"), auth);
    const fake = client();
    await expect(
      checkCodexSignIn({ createCodex: fake.createCodex, environment: { HOME: directory } }),
    ).resolves.toBe(true);
    expect(fake.createCodex).not.toHaveBeenCalled();
    expect(await readFile(join(source, "auth.json"), "utf8")).toBe(auth);
  });

  it("does not trust an existing stale auth file or expose SDK errors", async () => {
    await mkdir(join(directory, ".codex"));
    await writeFile(join(directory, ".codex", "auth.json"), "{}");
    const fake = client(vi.fn().mockRejectedValue(new Error("invalid credential test-secret")));
    await expect(
      checkCodexSignIn({ createCodex: fake.createCodex, environment: { HOME: directory } }),
    ).resolves.toBe(false);
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.createCodex).not.toHaveBeenCalled();
  });

  it("refuses missing credentials before launching the SDK", async () => {
    const fake = client();
    await expect(
      checkCodexSignIn({ createCodex: fake.createCodex, environment: { HOME: directory } }),
    ).resolves.toBe(false);
    expect(fake.createCodex).not.toHaveBeenCalled();
  });

  it("cancels timed out SDK requests", async () => {
    const fake = client(
      vi.fn(async (_prompt, options) => {
        if (options.signal.aborted) throw new Error("already aborted");
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("aborted test-secret");
      }),
    );
    await expect(
      checkCodexSignIn({
        createCodex: fake.createCodex,
        environment: { CODEX_API_KEY: "test-secret" },
        timeoutMs: 10,
      }),
    ).resolves.toBe(false);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("removes the probe home on %s", async (signal) => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = client(
      vi.fn(async (_prompt, options) => {
        started?.();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("aborted");
      }),
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const probe = checkCodexSignIn({
        createCodex: fake.createCodex,
        environment: { CODEX_API_KEY: "test-secret" },
      });
      await ready;
      const home = fake.createCodex.mock.calls[0]?.[0]?.env?.["CODEX_HOME"] ?? "";
      process.emit(signal);
      await probe;
      await vi.waitFor(async () => expect(await stat(home).catch(() => undefined)).toBeUndefined());
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, signal));
    } finally {
      kill.mockRestore();
    }
  });
});
