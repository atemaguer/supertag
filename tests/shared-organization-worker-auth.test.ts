import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stageWorkerAuth } from "../examples/shared-organization/worker-auth.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const codex = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: "unrelated-api-key",
  tokens: {
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    id_token: "fixture-id",
    account_id: "fixture-account",
    unwanted: "do-not-copy",
  },
  last_refresh: "2026-09-15T00:00:00Z",
  configuration: "do-not-copy",
};
const claude = {
  claudeAiOauth: {
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expiresAt: 2_000_000_000_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_5x",
    unwanted: "do-not-copy",
  },
  primaryApiKey: "unrelated-api-key",
  mcpOAuth: { unrelated: "do-not-copy" },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "supertag-worker-auth-"));
  directories.push(root);
  return {
    root,
    nativeHome: join(root, "native"),
    homeDirectory: join(root, "worker"),
    environment: {},
  };
}
async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

it.each(["claude", "codex"] as const)(
  "stages only %s subscription fields into a private writable home",
  async (name) => {
    const f = await fixture();
    const sourceFile = join(f.root, "source.json");
    await put(sourceFile, name === "claude" ? claude : codex);
    const before = await readFile(sourceFile, "utf8");
    const result = await stageWorkerAuth({ name, homeDirectory: f.homeDirectory, sourceFile }, f);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("fixture-access");
    expect(content).toContain("fixture-refresh");
    expect(content).not.toContain("do-not-copy");
    expect(content).not.toContain("unrelated-api-key");
    expect(JSON.stringify(result)).not.toContain("fixture-access");
    expect(JSON.stringify(result)).not.toContain("fixture-refresh");
    expect(result).toMatchObject({
      provider: name === "claude" ? "claude-code" : "codex",
      source: "file",
    });
    expect((await stat(f.homeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(result.path))).mode & 0o777).toBe(0o700);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(sourceFile, "utf8")).toBe(before);
    expect(await readdir(f.homeDirectory)).toEqual([name === "claude" ? ".claude" : ".codex"]);
    // Refresh state is writable inside this Worker home, independently of its source.
    await writeFile(result.path, content.replace("fixture-refresh", "worker-refreshed"));
    expect(await readFile(sourceFile, "utf8")).toBe(before);
    await expect(
      stageWorkerAuth({ name, homeDirectory: f.homeDirectory, sourceFile }, f),
    ).resolves.toMatchObject({ source: "staged", path: result.path });
    expect(await readFile(result.path, "utf8")).toContain("worker-refreshed");
  },
);

it.each(["claude", "codex"] as const)(
  "rejects %s API-key-only auth without creating a Worker home",
  async (name) => {
    const f = await fixture();
    const sourceFile = join(f.root, "source.json");
    await put(
      sourceFile,
      name === "codex"
        ? { auth_mode: "apikey", OPENAI_API_KEY: "fixture-api-key" }
        : { primaryApiKey: "fixture-api-key" },
    );
    await expect(
      stageWorkerAuth({ name, homeDirectory: f.homeDirectory, sourceFile }, f),
    ).rejects.toThrow("API-key-only");
    await expect(stat(f.homeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("uses the native CODEX_HOME override without copying its configuration", async () => {
  const f = await fixture();
  const configured = join(f.root, "configured-codex");
  await put(join(configured, "auth.json"), codex);
  await writeFile(join(configured, "config.toml"), "unrelated configuration");
  const result = await stageWorkerAuth(
    { name: "codex", homeDirectory: f.homeDirectory },
    { ...f, environment: { CODEX_HOME: configured } },
  );
  expect(await readdir(dirname(result.path))).toEqual(["auth.json"]);
});

it.each(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const)(
  "reads Claude file auth from %s",
  async (key) => {
    const f = await fixture();
    const configured = join(f.root, "configured-claude");
    await put(join(configured, ".credentials.json"), claude);
    const keychain = vi.fn();
    const result = await stageWorkerAuth(
      { name: "claude", homeDirectory: f.homeDirectory },
      { ...f, platform: "darwin", environment: { [key]: configured }, readKeychain: keychain },
    );
    expect(result.source).toBe("file");
    expect(keychain).not.toHaveBeenCalled();
  },
);

it("uses the default Claude credential store when the secure-storage override is explicitly empty", async () => {
  const f = await fixture();
  await put(join(f.nativeHome, ".claude", ".credentials.json"), claude);
  const result = await stageWorkerAuth(
    { name: "claude", homeDirectory: f.homeDirectory },
    {
      ...f,
      environment: {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
        CLAUDE_CONFIG_DIR: join(f.root, "ignored-attempt-dir"),
      },
    },
  );
  expect(result.source).toBe("file");
});

it.each([undefined, "/private/custom-claude"])(
  "reads only the selected macOS Keychain entry when the file is absent (%s)",
  async (configured) => {
    const f = await fixture();
    const keychain = vi.fn(async () => JSON.stringify(claude));
    const result = await stageWorkerAuth(
      { name: "claude", homeDirectory: f.homeDirectory },
      {
        ...f,
        platform: "darwin",
        environment: {
          USER: "fixture-user",
          ...(configured ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: configured } : {}),
        },
        readKeychain: keychain,
      },
    );
    const suffix = configured
      ? `-${createHash("sha256").update(configured).digest("hex").slice(0, 8)}`
      : "";
    expect(keychain).toHaveBeenCalledExactlyOnceWith(
      `Claude Code-credentials${suffix}`,
      "fixture-user",
    );
    expect(result.source).toBe("keychain");
    expect(await readFile(result.path, "utf8")).toContain("fixture-access");
  },
);

it("does not fall back to Keychain when an explicitly selected file is missing", async () => {
  const f = await fixture();
  const keychain = vi.fn();
  await expect(
    stageWorkerAuth(
      { name: "claude", homeDirectory: f.homeDirectory, sourceFile: join(f.root, "missing") },
      { ...f, platform: "darwin", readKeychain: keychain },
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(keychain).not.toHaveBeenCalled();
});

it("does not call macOS Keychain on Linux", async () => {
  const f = await fixture();
  const keychain = vi.fn();
  await expect(
    stageWorkerAuth(
      { name: "claude", homeDirectory: f.homeDirectory },
      { ...f, platform: "linux", readKeychain: keychain },
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(keychain).not.toHaveBeenCalled();
});

it("does not echo invalid credential JSON in errors", async () => {
  const f = await fixture();
  const sourceFile = join(f.root, "broken");
  await writeFile(sourceFile, '{"accessToken":"secret-that-must-not-appear"');
  const error = await stageWorkerAuth(
    { name: "claude", homeDirectory: f.homeDirectory, sourceFile },
    f,
  ).catch((error) => error);
  expect(error.message).toBe("Native credential source is not valid JSON");
  expect(JSON.stringify(error)).not.toContain("secret-that-must-not-appear");
});

it("rejects symlink credential sources and does not replace the native login", async () => {
  const f = await fixture();
  const original = join(f.nativeHome, ".codex", "auth.json");
  await put(original, codex);
  const linked = join(f.root, "linked.json");
  await symlink(original, linked);
  await expect(
    stageWorkerAuth({ name: "codex", homeDirectory: f.homeDirectory, sourceFile: linked }, f),
  ).rejects.toThrow();
  await expect(stageWorkerAuth({ name: "codex", homeDirectory: f.nativeHome }, f)).rejects.toThrow(
    "separately from the source login",
  );
  expect(JSON.parse(await readFile(original, "utf8"))).toEqual(codex);
});

it("rejects an existing symlink as the destination Worker home", async () => {
  const f = await fixture();
  const sourceFile = join(f.root, "source.json");
  await put(sourceFile, codex);
  const unrelated = join(f.root, "unrelated");
  await mkdir(unrelated);
  await symlink(unrelated, f.homeDirectory);
  await expect(
    stageWorkerAuth({ name: "codex", homeDirectory: f.homeDirectory, sourceFile }, f),
  ).rejects.toThrow("symlink");
  expect(await readdir(unrelated)).toEqual([]);
});

it.each(["loose-mode", "api-key", "invalid-json", "symlink"] as const)(
  "rejects unsafe staged credentials on retry: %s",
  async (problem) => {
    const f = await fixture();
    const sourceFile = join(f.root, "source.json");
    await put(sourceFile, codex);
    const staged = await stageWorkerAuth(
      { name: "codex", homeDirectory: f.homeDirectory, sourceFile },
      f,
    );
    if (problem === "loose-mode") await chmod(staged.path, 0o644);
    if (problem === "api-key") await writeFile(staged.path, JSON.stringify(codex));
    if (problem === "invalid-json") await writeFile(staged.path, "invalid");
    if (problem === "symlink") {
      await rm(staged.path);
      await symlink(sourceFile, staged.path);
    }
    await expect(
      stageWorkerAuth({ name: "codex", homeDirectory: f.homeDirectory, sourceFile }, f),
    ).rejects.toThrow();
  },
);
