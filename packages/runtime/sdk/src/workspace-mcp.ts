import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionEnvironment } from "./index.js";

/**
 * Host-private server configuration: HTTP, stdio on the Worker Host, or stdio inside a Task's
 * sandbox. Never include these values in a Task spec, event, or harness configuration: the
 * Worker's policy proxy alone uses them.
 */
export type ResolvedWorkspaceMcpServer =
  | {
      readonly name: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      /**
       * The Worker-owned snapshot of the Task's base commit, so repository-relative commands
       * resolve to committed files that nothing in the Task worktree can change.
       */
      readonly cwd: string;
      /** Only these variables, plus a minimal default environment, reach the server process. */
      readonly env: Readonly<Record<string, string>>;
    }
  | SandboxWorkspaceMcpServer;

/**
 * A stdio server that runs inside a Task's sandbox, through the environment MCP bridge, from the
 * copy of the trusted commit its provider placed at prepare. It gets no host variables: a server
 * whose `env` references one is refused before prepare. The Worker's policy proxy still checks
 * every call against the Task's grants and approvals.
 */
export interface SandboxWorkspaceMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute path of the trusted copy inside the sandbox. */
  readonly cwd: string;
  /** The Task's started sandbox. */
  readonly sandbox: ExecutionEnvironment;
}

/**
 * One selected server as the trusted commit's `.mcp.json` declares it, with no value resolved,
 * so it is safe to give a provider. A stdio server's `env` maps each variable it sets to the host
 * variable it references, such as `SUPERTAG_MCP_TOKEN`. HTTP servers carry only their name: their
 * URL and headers stay with the Worker's policy proxy.
 */
export type WorkspaceMcpServerDefinition =
  | { readonly name: string; readonly transport: "http" }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };

/** The selected servers of one Task's Workspace, as the Worker resolved them. */
export interface WorkspaceMcpResolution {
  /** Host-private: resolved URLs, headers, and environments. */
  readonly servers: readonly ResolvedWorkspaceMcpServer[];
  /** The selected entries as declared, safe for providers. */
  readonly definitions: readonly WorkspaceMcpServerDefinition[];
  readonly digest: string;
}

/**
 * Why a provider that runs Workspace stdio servers inside the Task's sandbox refuses these
 * servers, or undefined. Every `env` entry of a Workspace stdio server references a host
 * variable, and the Task can read and tamper with anything in its sandbox, so a stdio server
 * with any `env` entry is refused, naming the server and its variables (Decision 3).
 */
export function sandboxMcpRefusal(
  provider: string,
  definitions: readonly WorkspaceMcpServerDefinition[],
): string | undefined {
  for (const definition of definitions) {
    if (definition.transport !== "stdio") continue;
    const variables = [...new Set(Object.values(definition.env))].sort();
    if (variables.length > 0)
      return `Workspace MCP server ${definition.name} references host credential ${variables.join(", ")} in its env, but ${provider} runs Workspace stdio servers inside the Task's sandbox, where the Task could read it. Run this Workspace on local-execution, or serve ${definition.name} over HTTP so its credential stays on the Worker Host`;
  }
  return undefined;
}

/**
 * The servers a Task uses when its provider runs stdio servers inside its sandbox: HTTP servers
 * stay as the Worker resolved them, behind the Worker's policy proxy; stdio servers run in
 * `sandbox` from the trusted copy at `directory`, with no host variables. Throws, naming the
 * server, for a stdio server that would need a host variable.
 */
export function sandboxWorkspaceMcpServers(
  resolved: readonly ResolvedWorkspaceMcpServer[],
  placement: {
    readonly provider: string;
    readonly sandbox: ExecutionEnvironment;
    readonly directory: string;
  },
): ResolvedWorkspaceMcpServer[] {
  return resolved.map((server) => {
    if (!("command" in server) || "sandbox" in server) return server;
    const refusal = sandboxMcpRefusal(placement.provider, [
      {
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(Object.keys(server.env).map((key) => [key, key])),
      },
    ]);
    if (refusal !== undefined) throw new Error(refusal);
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      cwd: placement.directory,
      sandbox: placement.sandbox,
    };
  });
}

/**
 * The only variables a repository's `.mcp.json` may reference, following GitHub Copilot's
 * `COPILOT_MCP_` rule. The host opts each value in by name, so a repository can never read the
 * Worker's own credentials, such as `GITHUB_TOKEN`, `SUPERTAG_AUTH_KEY`, or a model API key.
 */
export const WORKSPACE_MCP_VARIABLE_PREFIX = "SUPERTAG_MCP_";

const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

function expand(
  value: string,
  name: string,
  variables: Readonly<Record<string, string | undefined>>,
): string {
  for (const [, key = ""] of value.matchAll(variable))
    if (!key.startsWith(WORKSPACE_MCP_VARIABLE_PREFIX))
      throw new Error(
        `Workspace MCP server ${name} references \${${key}}, but a repository's .mcp.json may reference only variables named ${WORKSPACE_MCP_VARIABLE_PREFIX}*, such as \${${WORKSPACE_MCP_VARIABLE_PREFIX}${key}}. Set that variable on the Worker Host, in its environment or ~/.supertag/.env.`,
      );
  const expanded = value.replace(variable, (_match, key: string) => {
    const resolved = variables[key];
    if (resolved === undefined || resolved === "")
      throw new Error(`MCP server ${name} needs environment variable ${key}`);
    return resolved;
  });
  if (/\$\{[^}]*\}/u.test(expanded))
    throw new Error(`MCP server ${name} has an invalid environment reference`);
  return expanded;
}

/**
 * Reads the selected servers from `.mcp.json` in `checkout`, which must be a Worker-owned
 * snapshot of the Task's base commit. References may name only `SUPERTAG_MCP_*` variables, whose
 * values come from `variables`.
 */
export async function resolveWorkspaceMcpServers(
  checkout: string,
  names: readonly string[],
  variables: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WorkspaceMcpResolution> {
  const path = join(checkout, ".mcp.json");
  let raw: string;
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > 1024 * 1024)
      throw new Error("must be a regular file no larger than 1 MiB");
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Workspace MCP configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(`Workspace MCP configuration ${path} is not valid JSON`);
  }
  if (!isRecord(document) || !isRecord(document["mcpServers"]))
    throw new Error(`Workspace MCP configuration ${path} must contain mcpServers`);
  const declared = document["mcpServers"];
  const selected: Array<Record<string, unknown> & { name: string }> = [];
  const servers: ResolvedWorkspaceMcpServer[] = [];
  const definitions: WorkspaceMcpServerDefinition[] = [];
  for (const name of names) {
    if (!Object.hasOwn(declared, name))
      throw new Error(`Workspace MCP server ${name} is not defined in ${path}`);
    const entry = declared[name];
    if (!isRecord(entry)) throw new Error(`Workspace MCP server ${name} is not defined in ${path}`);
    if (entry["command"] !== undefined || entry["type"] === "stdio") {
      const server = stdioServer(name, entry, checkout, variables);
      selected.push(server.selected);
      servers.push(server.resolved);
      definitions.push(server.definition);
      continue;
    }
    if (entry["type"] !== undefined && entry["type"] !== "http")
      throw new Error(`Workspace MCP server ${name} must have type http or stdio`);
    if (typeof entry["url"] !== "string")
      throw new Error(`Workspace MCP server ${name} needs a URL`);
    const url = expand(entry["url"], name, variables);
    if (hasControlCharacters(url))
      throw new Error(`Workspace MCP server ${name} URL contains control characters`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Workspace MCP server ${name} has an invalid URL`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error(
        `Workspace MCP server ${name} needs an HTTP URL without embedded credentials`,
      );
    const rawHeaders = entry["headers"] ?? {};
    if (
      !isRecord(rawHeaders) ||
      Object.entries(rawHeaders).some(
        ([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) || typeof value !== "string",
      )
    )
      throw new Error(`Workspace MCP server ${name} headers must map names to strings`);
    const headerEntries = Object.entries(rawHeaders as Record<string, string>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (headerEntries.some(([, value]) => !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.test(value)))
      throw new Error(`Workspace MCP server ${name} headers must reference environment variables`);
    const headers = Object.fromEntries(
      headerEntries.map(([key, value]) => [key, expand(value, name, variables)]),
    );
    if (Object.values(headers).some(hasControlCharacters))
      throw new Error(`Workspace MCP server ${name} headers contain control characters`);
    selected.push({ name, url: entry["url"], headers: Object.fromEntries(headerEntries) });
    servers.push({ name, url, headers });
    definitions.push({ name, transport: "http" });
  }
  selected.sort((a, b) => a.name.localeCompare(b.name));
  definitions.sort((a, b) => a.name.localeCompare(b.name));
  return {
    servers,
    definitions,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(selected)).digest("hex")}`,
  };
}

/**
 * A stdio entry in the Claude Code `.mcp.json` shape: `command`, optional `args`, and optional
 * `env`. `${SUPERTAG_MCP_*}` references expand only in `env`, from the host's variables, so a
 * credential never appears in a process argument list.
 */
function stdioServer(
  name: string,
  entry: Record<string, unknown>,
  checkout: string,
  variables: Readonly<Record<string, string | undefined>>,
): {
  readonly selected: Record<string, unknown> & { name: string };
  readonly resolved: ResolvedWorkspaceMcpServer;
  readonly definition: WorkspaceMcpServerDefinition;
} {
  const command = entry["command"];
  if (typeof command !== "string" || command.trim() === "" || hasControlCharacters(command))
    throw new Error(`Workspace MCP server ${name} needs a command`);
  const rawArgs = entry["args"] ?? [];
  if (
    !Array.isArray(rawArgs) ||
    rawArgs.some((arg) => typeof arg !== "string" || hasControlCharacters(arg))
  )
    throw new Error(`Workspace MCP server ${name} args must be a list of strings`);
  const args = rawArgs as string[];
  if ([command, ...args].some((part) => /\$\{[^}]*\}/u.test(part)))
    throw new Error(
      `Workspace MCP server ${name} command and args must not reference environment variables; put credentials in env`,
    );
  const rawEnv = entry["env"] ?? {};
  if (
    !isRecord(rawEnv) ||
    Object.entries(rawEnv).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
        typeof value !== "string" ||
        !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value),
    )
  )
    throw new Error(
      `Workspace MCP server ${name} env must map variable names to references like \${SUPERTAG_MCP_NAME}; literal values are not allowed`,
    );
  const envEntries = Object.entries(rawEnv as Record<string, string>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const env = Object.fromEntries(
    envEntries.map(([key, value]) => [key, expand(value, name, variables)]),
  );
  if (Object.values(env).some(hasControlCharacters))
    throw new Error(`Workspace MCP server ${name} env contains control characters`);
  return {
    selected: { name, command, args, env: Object.fromEntries(envEntries) },
    resolved: { name, command, args, cwd: checkout, env },
    definition: {
      name,
      transport: "stdio",
      command,
      args: [...args],
      // Each value is exactly one `${NAME}` reference; keep the referenced name only.
      env: Object.fromEntries(envEntries.map(([key, value]) => [key, value.slice(2, -1)])),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
