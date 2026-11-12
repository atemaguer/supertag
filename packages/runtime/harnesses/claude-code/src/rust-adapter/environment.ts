import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

async function ownedDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Adapter directories must be absolute");
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Adapter directory is not privately owned");
  return realpath(path);
}

/** Copy only provider credentials, never user settings, plugins, hooks, or service credentials. */
export async function nativeEnvironment(environment: NodeJS.ProcessEnv) {
  const state = await ownedDirectory(environment["SUPERTAG_ADAPTER_STATE_DIRECTORY"] ?? "");
  const cwd = await realpath(environment["SUPERTAG_WORKSPACE_DIRECTORY"] ?? "");
  if (!(await lstat(cwd)).isDirectory()) throw new Error("Workspace directory is missing");
  const config = join(state, "claude-config");
  const home = join(state, "home");
  const temporary = join(state, "claude-tmp");
  for (const directory of [config, home, temporary]) {
    await mkdir(directory, { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: temporary,
    LANG: "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_AGENT_SDK_CLIENT_APP: "supertag/rust-claude-adapter",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  };
  for (const key of CREDENTIAL_KEYS) if (environment[key]) env[key] = environment[key];
  if (!CREDENTIAL_KEYS.some((key) => env[key])) {
    const sourceHome = await ownedDirectory(environment["HOME"] ?? "");
    const explicit = environment["CLAUDE_SECURESTORAGE_CONFIG_DIR"];
    const source = explicit ? await ownedDirectory(explicit) : join(sourceHome, ".claude");
    if (process.platform === "darwin") {
      // The native SDK reads the current user's Keychain. The empty default keeps its standard
      // service name; a custom source is validated but its settings never enter the new config.
      env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = explicit ? source : "";
      // Native Keychain account lookup requires the actual validated home. Settings and
      // transcripts remain isolated in CLAUDE_CONFIG_DIR and settingSources stays empty.
      env["HOME"] = sourceHome;
      env["USER"] = userInfo().username;
      env["LOGNAME"] = env["USER"];
    } else {
      await ownedDirectory(source);
      const file = await open(
        join(source, ".credentials.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 65536 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("Unsafe Claude credential file");
        const contents = await file.readFile();
        JSON.parse(contents.toString("utf8"));
        const output = await open(join(config, ".credentials.json"), "wx", 0o600);
        try {
          await output.writeFile(contents);
        } finally {
          await output.close();
        }
      } finally {
        await file.close();
      }
    }
  }
  return { env, cwd };
}
