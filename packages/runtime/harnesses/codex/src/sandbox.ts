/**
 * The Codex OS sandbox SuperTag configures for one Task Attempt.
 *
 * Codex's legacy `--sandbox` modes either deny every socket (read-only and
 * workspace-write) or allow the whole network. A command that binds
 * 127.0.0.1, such as a test server, therefore fails with `listen EPERM`.
 * Codex permission profiles add a narrower option: a network section with
 * `allow_local_binding = true` and the managed network proxy in limited mode
 * with no allowed domains. The sandbox then permits loopback bind, accept, and
 * connect, and still denies direct and proxied external traffic.
 *
 * An explicit `--sandbox` (or app-server `sandbox`) overrides
 * `default_permissions`, so the loopback profile replaces it rather than
 * augmenting it.
 */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Name of the Worker-owned Codex permission profile. User config is ignored. */
export const CODEX_PERMISSION_PROFILE = "supertag";

/** What the Codex sandbox allows, recorded as harness provenance. */
export interface CodexSandboxAllowance {
  /**
   * `external` disables Codex's own sandbox; the execution environment
   * enforces filesystem and network isolation instead.
   */
  readonly filesystem: "read-only" | "workspace-write" | "external";
  /**
   * `none` denies every socket, `loopback` allows only 127.0.0.1/localhost,
   * `enabled` allows outbound network (`web:fetch` with `files:write`), and
   * `external` defers to the execution environment's network policy.
   */
  readonly network: "none" | "loopback" | "enabled" | "external";
  /** Set when SuperTag selected the Worker-owned Codex permission profile. */
  readonly permissionProfile?: typeof CODEX_PERMISSION_PROFILE;
}

/**
 * Decide the Codex sandbox from the admitted runtime actions.
 *
 * Only `commands:execute` gains loopback. Filesystem access and every other
 * network decision stay as before: `web:fetch` with `files:write` still
 * enables the network, and Tasks without commands still deny every socket.
 */
export function codexSandboxAllowance(
  sandboxMode: "native" | "external" | undefined,
  actions: readonly string[],
): CodexSandboxAllowance {
  if (sandboxMode === "external") return { filesystem: "external", network: "external" };
  const filesystem = actions.includes("files:write") ? "workspace-write" : "read-only";
  if (filesystem === "workspace-write" && actions.includes("web:fetch"))
    return { filesystem, network: "enabled" };
  if (actions.includes("commands:execute"))
    return { filesystem, network: "loopback", permissionProfile: CODEX_PERMISSION_PROFILE };
  if (filesystem === "workspace-write")
    return { filesystem, network: "none", permissionProfile: CODEX_PERMISSION_PROFILE };
  return { filesystem, network: "none" };
}

/** The legacy `--sandbox` mode, or undefined when a permission profile replaces it. */
export function codexSandboxMode(
  allowance: CodexSandboxAllowance,
): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  if (allowance.permissionProfile !== undefined) return undefined;
  return allowance.filesystem === "external" ? "danger-full-access" : allowance.filesystem;
}

/** Codex configuration that selects the loopback permission profile, as dotted key/value pairs. */
export function codexPermissionProfileConfig(
  allowance: CodexSandboxAllowance,
): Readonly<Record<string, string | boolean>> {
  if (allowance.permissionProfile === undefined) return {};
  const profile = `permissions.${allowance.permissionProfile}`;
  return {
    default_permissions: allowance.permissionProfile,
    [`${profile}.extends`]:
      allowance.filesystem === "workspace-write" ? ":workspace" : ":read-only",
    ...(allowance.network === "loopback"
      ? {
          [`${profile}.network.enabled`]: true,
          // Limited mode with no allowed domains: the managed proxy refuses every
          // external request, and the OS sandbox denies direct external sockets.
          [`${profile}.network.mode`]: "limited",
          [`${profile}.network.allow_local_binding`]: true,
          "features.network_proxy.enabled": true,
        }
      : {}),
  };
}

/** `--config` arguments for {@link codexPermissionProfileConfig}. */
export function codexPermissionProfileArguments(allowance: CodexSandboxAllowance): string[] {
  return Object.entries(codexPermissionProfileConfig(allowance)).flatMap(([key, value]) => [
    "--config",
    `${key}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
  ]);
}

/**
 * `codex exec` arguments that let Codex write `directory` in addition to the workspace.
 * The permission profile ignores `--add-dir`, so under the profile the
 * directory is a profile filesystem entry, as in app-server thread config.
 */
export function codexWritableDirectoryArguments(
  allowance: CodexSandboxAllowance,
  directory: string,
): string[] {
  if (allowance.permissionProfile === undefined) return ["--add-dir", directory];
  return [
    "--config",
    `permissions.${allowance.permissionProfile}.filesystem={ ${JSON.stringify(directory)} = "write" }`,
  ];
}

/** Resolve a Task worktree's common git directory without running repository configuration. */
export async function codexProtectedGitDirectory(workspace: string): Promise<string | undefined> {
  const dotGit = join(workspace, ".git");
  const marker = await readFile(dotGit, "utf8").catch(() => undefined);
  if (marker === undefined) return undefined;
  const match = /^gitdir: (.+)\s*$/u.exec(marker);
  if (!match) return undefined;
  const gitDir = isAbsolute(match[1] as string)
    ? (match[1] as string)
    : resolve(workspace, match[1] as string);
  const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => undefined);
  if (common === undefined) return undefined;
  return realpath(resolve(gitDir, common.trim())).catch(() => undefined);
}

/** A nested read allowance prevents a writable temporary root from granting git config writes. */
export function codexProtectedGitDirectoryArguments(
  allowance: CodexSandboxAllowance,
  commonGitDir: string | undefined,
): string[] {
  if (allowance.permissionProfile === undefined || commonGitDir === undefined) return [];
  return [
    "--config",
    `permissions.${allowance.permissionProfile}.filesystem={ ${JSON.stringify(commonGitDir)} = "read" }`,
  ];
}
