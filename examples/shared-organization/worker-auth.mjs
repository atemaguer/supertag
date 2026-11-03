import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const maximumBytes = 64 * 1024;

async function readCredentialFile(path, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes)
      throw new Error("Native credential source must be a regular file no larger than 64 KiB");
    if (privateFile && (metadata.mode & 0o777) !== 0o600)
      throw new Error("Staged Worker credentials must have mode0600");
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) throw new Error("Native credential source exceeds 64 KiB");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function readKeychain(service, account) {
  try {
    const result = await run(
      "security",
      ["find-generic-password", "-a", account, "-w", "-s", service],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: maximumBytes,
      },
    );
    return result.stdout;
  } catch {
    // execFile errors can contain captured stdout; never expose credential output.
    throw new Error("Claude subscription credentials could not be read from macOS Keychain");
  }
}

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function subscriptionCredentials(name, text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maximumBytes)
    throw new Error("Native credential source exceeds 64 KiB");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Native credential source is not valid JSON");
  }
  if (!record(value)) throw new Error("Native credential source must be a JSON object");
  if (name === "codex") {
    if (
      (value.auth_mode !== undefined && value.auth_mode !== "chatgpt") ||
      !record(value.tokens) ||
      !nonempty(value.tokens.access_token)
    )
      throw new Error(
        "Codex Worker requires subscription sign-in; API-key-only credentials are not accepted",
      );
    const tokens = Object.fromEntries(
      ["access_token", "id_token", "refresh_token", "account_id"]
        .filter((key) => nonempty(value.tokens[key]))
        .map((key) => [key, value.tokens[key]]),
    );
    return {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens,
      ...(nonempty(value.last_refresh) ? { last_refresh: value.last_refresh } : {}),
    };
  }
  const oauth = value.claudeAiOauth;
  if (!record(oauth) || !nonempty(oauth.accessToken))
    throw new Error(
      "Claude Worker requires subscription sign-in; API-key-only credentials are not accepted",
    );
  const selected = Object.fromEntries(
    ["accessToken", "refreshToken", "subscriptionType", "rateLimitTier"]
      .filter((key) => nonempty(oauth[key]))
      .map((key) => [key, oauth[key]]),
  );
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt > 0) selected.expiresAt = oauth.expiresAt;
  if (Array.isArray(oauth.scopes) && oauth.scopes.every((scope) => typeof scope === "string"))
    selected.scopes = oauth.scopes;
  return { claudeAiOauth: selected };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Worker credential directory must not be a symlink");
  await chmod(path, 0o700);
}

/** Stage only native subscription auth in an isolated Worker Host home; never copy user config. */
export async function stageWorkerAuth({ name, homeDirectory, sourceFile }, dependencies = {}) {
  if (!["claude", "codex"].includes(name)) throw new Error("Choose claude or codex authentication");
  if (!nonempty(homeDirectory)) throw new Error("Worker home directory is required");
  const environment = dependencies.environment ?? process.env;
  const nativeHome = dependencies.nativeHome ?? homedir();
  const platform = dependencies.platform ?? process.platform;
  const directory = join(resolve(homeDirectory), name === "codex" ? ".codex" : ".claude");
  const destination = join(directory, name === "codex" ? "auth.json" : ".credentials.json");
  const secureStorage = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const claudeDirectory =
    secureStorage !== undefined
      ? secureStorage || join(nativeHome, ".claude")
      : environment.CLAUDE_CONFIG_DIR || join(nativeHome, ".claude");
  const sourcePath =
    sourceFile ??
    (name === "codex"
      ? join(environment.CODEX_HOME || join(nativeHome, ".codex"), "auth.json")
      : join(claudeDirectory, ".credentials.json"));
  if (resolve(sourcePath) === destination)
    throw new Error("Worker credentials must be staged separately from the source login");
  try {
    await lstat(destination);
    for (const path of [resolve(homeDirectory), directory]) {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700)
        throw new Error(
          "Existing Worker credential directories must be private and must not be symlinks",
        );
    }
    const existing = await readCredentialFile(destination, true);
    subscriptionCredentials(name, existing);
    const value = JSON.parse(existing);
    if (
      (name === "codex" && nonempty(value.OPENAI_API_KEY)) ||
      (name === "claude" && Object.keys(value).some((key) => key !== "claudeAiOauth"))
    )
      throw new Error("Staged Worker credentials contain non-subscription authentication");
    return {
      provider: name === "claude" ? "claude-code" : "codex",
      source: "staged",
      path: destination,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let text;
  let source = "file";
  try {
    text = await readCredentialFile(sourcePath);
  } catch (error) {
    if (
      sourceFile !== undefined ||
      name !== "claude" ||
      platform !== "darwin" ||
      error.code !== "ENOENT"
    )
      throw error;
    const configured = secureStorage !== undefined ? secureStorage : environment.CLAUDE_CONFIG_DIR;
    const suffix = configured
      ? `-${createHash("sha256").update(configured.normalize("NFC")).digest("hex").slice(0, 8)}`
      : "";
    const username = environment.USER || (dependencies.username ?? userInfo().username);
    const account = /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user";
    text = await (dependencies.readKeychain ?? readKeychain)(
      `Claude Code-credentials${suffix}`,
      account,
    );
    source = "keychain";
  }
  const content = subscriptionCredentials(name, text);
  await privateDirectory(resolve(homeDirectory));
  await privateDirectory(directory);
  const file = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(content)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return { provider: name === "claude" ? "claude-code" : "codex", source, path: destination };
}
