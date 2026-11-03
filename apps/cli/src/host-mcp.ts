import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { isReservedMcpServerName, MCP_SERVER_NAME, mcpServerLabel } from "@supertag/core";
import type { McpResourceMapping, McpServerDefinition } from "@supertag/worker-sdk";

/**
 * MCP servers a host service provides, from the `mcp` map of a host service in supertag.yaml.
 * An HTTP server has a `url`; its `auth` names where a credential comes from (an environment
 * variable, a file, or a supertag.yaml secret). A stdio server has a `command` the Worker
 * launches and an `env` of references. The file never holds a credential.
 */

function mapping(tools: readonly string[], rule: McpResourceMapping["tools"][string][number]) {
  return { tools: Object.fromEntries(tools.map((tool) => [tool, [rule]])) };
}

/**
 * The official HTTP servers SuperTag knows, by preset name. A preset's `resources` maps tool
 * arguments to resources, so Permission Set grants on its tools can name a `resource`. The
 * Teams server's URL names the Microsoft tenant, so its preset takes a `tenantId`.
 */
export const MCP_PRESETS: McpPresets = {
  github: {
    url: "https://api.githubcopilot.com/mcp/",
    resources: mapping(
      [
        "get_file_contents",
        "issue_read",
        "add_issue_comment",
        "pull_request_read",
        "create_branch",
        "create_pull_request",
        "merge_pull_request",
      ],
      {
        prefix: "repository:",
        separator: "/",
        components: [{ arguments: ["owner"] }, { arguments: ["repo", "repository"] }],
      },
    ),
  },
  slack: {
    url: "https://mcp.slack.com/mcp",
    resources: mapping(["slack_read_channel", "slack_read_thread", "slack_send_message"], {
      prefix: "channel:",
      components: [{ arguments: ["channel_id", "channelId", "channel"] }],
    }),
  },
  linear: {
    url: "https://mcp.linear.app/mcp",
    resources: mapping(["list_issues", "create_issue"], {
      prefix: "team:",
      components: [{ arguments: ["team_id", "teamId", "team"] }],
    }),
  },
  teams: {
    url: (tenantId) =>
      `https://agent365.svc.cloud.microsoft/agents/tenants/${encodeURIComponent(tenantId)}/servers/mcp_TeamsServer`,
    resources: mapping(
      [
        "mcp_graph_teams_listChannelMessages",
        "mcp_graph_teams_postChannelMessage",
        "mcp_graph_teams_replyToChannelMessage",
      ],
      {
        prefix: "team:",
        separator: "/channel:",
        components: [
          { arguments: ["team_id", "teamId"] },
          { arguments: ["channel_id", "channelId"] },
        ],
      },
    ),
  },
};

/**
 * The official stdio servers SuperTag knows. The Lark preset runs the official
 * `@larksuiteoapi/lark-mcp` package that ships with SuperTag; the host gives its App credentials
 * in `env` (`APP_ID`, `APP_SECRET`, and optionally `LARK_DOMAIN`).
 */
export const MCP_STDIO_PRESETS: McpStdioPresets = {
  lark: {
    command: () => [
      process.execPath,
      join(
        dirname(createRequire(import.meta.url).resolve("@larksuiteoapi/lark-mcp/package.json")),
        "dist",
        "cli.js",
      ),
      "mcp",
      "--tool-name-case",
      "snake",
    ],
    resources: {
      tools: {
        im_v1_message_list: [
          {
            prefix: "chat:",
            when: { argument: "params.container_id_type", equals: "chat" },
            components: [{ arguments: ["params.container_id"] }],
          },
        ],
        // Only a chat recipient is checkable; a user or email recipient names no chat resource.
        im_v1_message_create: [
          {
            prefix: "chat:",
            when: { argument: "params.receive_id_type", equals: "chat_id" },
            components: [{ arguments: ["data.receive_id"] }],
          },
        ],
      },
    },
  },
};

export type McpPreset = "github" | "slack" | "linear" | "teams";
export type McpStdioPreset = "lark";

const PRESET_NAMES = "github, slack, linear, teams, or lark";

/** Each HTTP preset's official URL, or a URL from the tenant, and resource mapping. */
export type McpPresets = Readonly<
  Record<
    McpPreset,
    {
      readonly url: string | ((tenantId: string) => string);
      readonly resources?: McpResourceMapping;
    }
  >
>;

/** Each stdio preset's command, resolved where the Worker runs, and resource mapping. */
export type McpStdioPresets = Readonly<
  Record<
    McpStdioPreset,
    { readonly command: () => readonly string[]; readonly resources?: McpResourceMapping }
  >
>;

/** Where a credential comes from. Never the credential itself. */
export type McpCredentialReference =
  | { readonly env: string }
  | { readonly file: string }
  | { readonly secretRef: string };

export type McpAuth =
  | { readonly bearer: McpCredentialReference }
  | { readonly headers: Readonly<Record<string, McpCredentialReference>> }
  | {
      readonly githubApp: {
        readonly appId: number;
        readonly installationId: number;
        readonly privateKey: McpCredentialReference;
      };
    }
  | {
      readonly clientCredentials: {
        readonly clientId: string | McpCredentialReference;
        readonly clientSecret?: McpCredentialReference;
        readonly assertionKey?: McpCredentialReference;
        readonly scope?: string;
        /** The token endpoint to trust when it is not on the server's own origin. */
        readonly tokenUrl?: string;
      };
    }
  | { readonly helper: readonly string[] }
  | {
      readonly oauth:
        | true
        | { readonly refreshToken: McpCredentialReference; readonly tokenUrl?: string };
    };

export const MCP_AUTH_FORMS = [
  "bearer",
  "headers",
  "githubApp",
  "clientCredentials",
  "helper",
  "oauth",
] as const;

/** One HTTP MCP server on a host service. With `preset`, `url` is always the preset's. */
export interface HostHttpMcpServer {
  readonly url: string;
  readonly preset?: McpPreset;
  /** The Microsoft tenant, for the teams preset only. */
  readonly tenantId?: string;
  readonly auth?: McpAuth;
}

/**
 * One stdio MCP server on a host service. The Worker launches `command` for each Task Attempt
 * with `env`, and the harness reaches it only through the per-Task policy proxy.
 */
export interface HostStdioMcpServer {
  /** The executable and its arguments, such as [npx, -y, "@acme/db-mcp"]. */
  readonly command: readonly string[];
  /** With a preset, `command` is always the preset's. */
  readonly preset?: McpStdioPreset;
  /** Each variable's source, never its value; resolved when a Task Attempt starts. */
  readonly env?: Readonly<Record<string, McpCredentialReference>>;
}

export type HostMcpServer = HostHttpMcpServer | HostStdioMcpServer;

export function isStdioHostMcpServer(server: HostMcpServer): server is HostStdioMcpServer {
  return "command" in server;
}

const SERVER_KEYS = ["type", "url", "preset", "tenantId", "auth"] as const;
const STDIO_KEYS = ["type", "command", "preset", "env"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** An HTTP field name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const REFERENCE_FORMS = "{ env: VAR }, { file: PATH }, or { secretRef: NAME }";
const NO_VALUES = "supertag.yaml holds references to credentials, never their values";

export interface McpParseContext {
  readonly problem: (path: readonly string[], message: string) => void;
  /** The directory relative `file` references resolve against. */
  readonly directoryOf: (path: readonly string[]) => string;
  /** Entry names in the file's `secrets`, which `secretRef` may name. */
  readonly secrets: ReadonlySet<string>;
  readonly expandHome: (path: string) => string;
}

/** Parses a host service's `mcp` map, reporting each problem at its key path. */
export function parseHostMcp(
  value: unknown,
  path: readonly string[],
  context: McpParseContext,
): Readonly<Record<string, HostMcpServer>> {
  const servers: Record<string, HostMcpServer> = {};
  if (value === undefined || value === null) return servers;
  if (!isRecord(value)) {
    context.problem(
      path,
      "must map MCP server names to servers, such as github: { preset: github }",
    );
    return servers;
  }
  for (const [name, raw] of Object.entries(value)) {
    if (name.startsWith("x-")) continue;
    const key = [...path, name];
    if (!MCP_SERVER_NAME.test(name)) {
      context.problem(
        key,
        "MCP server names are 1-59 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
      );
      continue;
    }
    if (isReservedMcpServerName(name)) {
      context.problem(key, "MCP server names starting with supertag are reserved");
      continue;
    }
    const server = parseServer(raw, key, context);
    if (server !== undefined) servers[name] = server;
  }
  return servers;
}

function parseServer(
  raw: unknown,
  path: readonly string[],
  context: McpParseContext,
): HostMcpServer | undefined {
  const { problem } = context;
  if (!isRecord(raw)) {
    problem(path, "must be a map with a url or a preset");
    return undefined;
  }
  if (
    "command" in raw ||
    "args" in raw ||
    "env" in raw ||
    raw["type"] === "stdio" ||
    (typeof raw["preset"] === "string" && Object.hasOwn(MCP_STDIO_PRESETS, raw["preset"]))
  )
    return parseStdioServer(raw, path, context);
  let valid = true;
  const fail = (key: readonly string[], message: string) => {
    problem(key, message);
    valid = false;
  };
  for (const key of Object.keys(raw)) {
    if ((SERVER_KEYS as readonly string[]).includes(key) || key.startsWith("x-")) continue;
    if (key === "headers" || key === "oauth")
      fail(
        [...path, key],
        `belongs under auth, such as auth: { ${key === "oauth" ? "oauth: true" : "headers: { X-Api-Key: { env: VAR } }"} }`,
      );
    else fail([...path, key], `unknown field; expected one of ${SERVER_KEYS.join(", ")}`);
  }
  const type = raw["type"];
  if (type !== undefined && type !== null && type !== "http")
    fail([...path, "type"], "must be http; other transports are not supported");
  let preset: McpPreset | undefined;
  const rawPreset = raw["preset"];
  if (rawPreset !== undefined && rawPreset !== null) {
    if (typeof rawPreset === "string" && Object.hasOwn(MCP_PRESETS, rawPreset))
      preset = rawPreset as McpPreset;
    else fail([...path, "preset"], `must be ${PRESET_NAMES}`);
  }
  let tenantId: string | undefined;
  const rawTenant = raw["tenantId"];
  if (preset === "teams") {
    if (typeof rawTenant === "string" && /^[A-Za-z0-9.-]+$/u.test(rawTenant.trim()))
      tenantId = rawTenant.trim();
    else
      fail(
        [...path, "tenantId"],
        "is required for the teams preset: the Microsoft Entra tenant ID or domain",
      );
  } else if (rawTenant !== undefined && rawTenant !== null)
    fail([...path, "tenantId"], "belongs only with preset: teams");
  let url: string | undefined;
  const rawUrl = raw["url"];
  if (rawUrl !== undefined && rawUrl !== null && rawPreset !== undefined && rawPreset !== null) {
    // A preset fixes the official URL its resource mapping was written for.
    fail(
      [...path, "url"],
      `must not be set with a preset; the ${preset ?? "preset"} preset uses its official URL and resource mapping. For another server, drop preset and give url`,
    );
  } else if (rawUrl !== undefined && rawUrl !== null) {
    if (typeof rawUrl === "string" && isHttpUrl(rawUrl)) {
      if (hasUserInfo(rawUrl))
        fail([...path, "url"], `must not hold a user name or password; use auth. ${NO_VALUES}`);
      else if (hasQueryOrFragment(rawUrl))
        fail(
          [...path, "url"],
          "must not contain a query string or fragment; use auth for credentials",
        );
      else url = rawUrl.trim();
    } else fail([...path, "url"], "must be an http(s) URL, such as https://mcp.example.com/mcp");
  } else if (preset !== undefined) {
    const presetUrl = MCP_PRESETS[preset].url;
    if (typeof presetUrl === "string") url = presetUrl;
    else if (tenantId !== undefined) url = presetUrl(tenantId);
  } else if (rawPreset === undefined || rawPreset === null)
    fail(
      path,
      "needs a url, such as https://mcp.example.com/mcp, a preset (github, slack, linear, teams, or lark), or a command for a stdio server",
    );
  let auth: McpAuth | undefined;
  const rawAuth = raw["auth"];
  if (rawAuth !== undefined && rawAuth !== null) {
    auth = parseAuth(rawAuth, [...path, "auth"], context);
    if (auth === undefined) valid = false;
  }
  if (!valid || url === undefined) return undefined;
  return {
    url,
    ...(preset === undefined ? {} : { preset }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(auth === undefined ? {} : { auth }),
  };
}

function parseStdioServer(
  raw: Record<string, unknown>,
  path: readonly string[],
  context: McpParseContext,
): HostStdioMcpServer | undefined {
  let valid = true;
  const fail = (key: readonly string[], message: string) => {
    context.problem(key, message);
    valid = false;
  };
  for (const key of Object.keys(raw)) {
    if ((STDIO_KEYS as readonly string[]).includes(key) || key.startsWith("x-")) continue;
    if (key === "args")
      fail(
        [...path, key],
        'belongs in command, such as command: [npx, -y, "@acme/db-mcp"]; command lists the executable and its arguments',
      );
    else
      fail(
        [...path, key],
        `unknown field for a stdio server; expected one of ${STDIO_KEYS.join(", ")}`,
      );
  }
  const type = raw["type"];
  if (type !== undefined && type !== null && type !== "stdio")
    fail([...path, "type"], "must be stdio for a server with a command");
  const rawPreset = raw["preset"];
  let preset: McpStdioPreset | undefined;
  if (rawPreset !== undefined && rawPreset !== null) {
    if (typeof rawPreset === "string" && Object.hasOwn(MCP_STDIO_PRESETS, rawPreset))
      preset = rawPreset as McpStdioPreset;
    else fail([...path, "preset"], "must be lark for a stdio server");
  }
  const rawCommand = typeof raw["command"] === "string" ? [raw["command"]] : raw["command"];
  let command: string[] | undefined;
  if (preset !== undefined && rawCommand !== undefined && rawCommand !== null)
    fail(
      [...path, "command"],
      `must not be set with a preset; the ${preset} preset runs its official server`,
    );
  else if (preset !== undefined) command = [...MCP_STDIO_PRESETS[preset].command()];
  else if (rawPreset !== undefined && rawPreset !== null) {
    // An invalid preset was already reported.
  } else if (
    !Array.isArray(rawCommand) ||
    rawCommand.length === 0 ||
    rawCommand.some((part) => typeof part !== "string" || !part.trim())
  )
    fail(
      [...path, "command"],
      'must list the executable and its arguments, such as [npx, -y, "@acme/db-mcp"]',
    );
  else if (rawCommand.some((part) => /\$\{/u.test(part as string)))
    fail(
      [...path, "command"],
      "must not reference environment variables; pass credentials to the server in env",
    );
  else {
    const [executable, ...args] = rawCommand as string[];
    command = [context.expandHome((executable as string).trim()), ...args];
  }
  let env: Record<string, McpCredentialReference> | undefined;
  const rawEnv = raw["env"];
  if (rawEnv !== undefined && rawEnv !== null) {
    if (!isRecord(rawEnv)) fail([...path, "env"], "must map variable names to references");
    else {
      env = {};
      for (const [name, value] of Object.entries(rawEnv)) {
        const at = [...path, "env", name];
        if (!ENV_NAME.test(name)) {
          fail(at, "is not a valid environment variable name");
          continue;
        }
        // parseReference never echoes a string value: it is most likely the credential itself.
        const reference = parseReference(value, at, context);
        if (reference === undefined) valid = false;
        else env[name] = reference;
      }
    }
  }
  if (!valid || command === undefined) return undefined;
  return {
    command,
    ...(preset === undefined ? {} : { preset }),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
  };
}

function parseAuth(
  raw: unknown,
  path: readonly string[],
  context: McpParseContext,
): McpAuth | undefined {
  const { problem } = context;
  const forms = `one of ${MCP_AUTH_FORMS.join(", ")}`;
  if (!isRecord(raw)) {
    problem(path, `must be a map with ${forms}`);
    return undefined;
  }
  const keys = Object.keys(raw).filter((key) => !key.startsWith("x-"));
  const unknown = keys.filter((key) => !(MCP_AUTH_FORMS as readonly string[]).includes(key));
  for (const key of unknown) problem([...path, key], `unknown field; expected ${forms}`);
  if (unknown.length > 0) return undefined;
  if (keys.length !== 1) {
    problem(path, `must have exactly ${forms}`);
    return undefined;
  }
  const form = keys[0] as (typeof MCP_AUTH_FORMS)[number];
  const value = raw[form];
  const at = [...path, form];
  let ok = true;
  const fail = (key: readonly string[], message: string) => {
    problem(key, message);
    ok = false;
  };
  const reference = (key: readonly string[], entry: unknown) => {
    const parsed = parseReference(entry, key, context);
    if (parsed === undefined) ok = false;
    return parsed;
  };
  const required = (key: readonly string[], entry: unknown) => {
    if (entry !== undefined && entry !== null) return reference(key, entry);
    fail(key, `is required: ${REFERENCE_FORMS}`);
    return undefined;
  };
  const tokenUrl = (entry: Record<string, unknown>) => {
    const raw = entry["tokenUrl"];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "string" && isHttpUrl(raw) && isSecureOrLoopback(raw)) {
      if (hasUserInfo(raw)) fail([...at, "tokenUrl"], `must not hold a user name or password`);
      else if (new URL(raw.trim()).hash !== "")
        fail([...at, "tokenUrl"], "must not have a fragment");
      else return raw.trim();
      return undefined;
    }
    fail(
      [...at, "tokenUrl"],
      "must be the authorization server's https token endpoint, such as https://auth.example.com/oauth/token",
    );
    return undefined;
  };
  const fields = (entry: Record<string, unknown>, allowed: readonly string[]) => {
    for (const key of Object.keys(entry))
      if (!allowed.includes(key) && !key.startsWith("x-"))
        fail([...at, key], `unknown field; expected one of ${allowed.join(", ")}`);
  };
  switch (form) {
    case "bearer": {
      const token = reference(at, value);
      return ok && token !== undefined ? { bearer: token } : undefined;
    }
    case "headers": {
      if (!isRecord(value) || Object.keys(value).length === 0) {
        problem(at, "must map header names to references, such as X-Api-Key: { env: VAR }");
        return undefined;
      }
      const headers: Record<string, McpCredentialReference> = {};
      for (const [name, entry] of Object.entries(value)) {
        if (!HEADER_NAME.test(name)) {
          fail([...at, name], "is not a valid HTTP header name");
          continue;
        }
        const parsed = reference([...at, name], entry);
        if (parsed !== undefined) headers[name] = parsed;
      }
      return ok ? { headers } : undefined;
    }
    case "githubApp": {
      if (!isRecord(value)) {
        problem(at, "must be { appId, installationId, privateKey: { file: PATH } }");
        return undefined;
      }
      fields(value, ["appId", "installationId", "privateKey"]);
      const appId = positiveInteger(value["appId"]);
      const installationId = positiveInteger(value["installationId"]);
      if (appId === undefined) fail([...at, "appId"], "must be the GitHub App's numeric ID");
      if (installationId === undefined)
        fail([...at, "installationId"], "must be the App installation's numeric ID");
      const privateKey = required([...at, "privateKey"], value["privateKey"]);
      return ok && appId !== undefined && installationId !== undefined && privateKey !== undefined
        ? { githubApp: { appId, installationId, privateKey } }
        : undefined;
    }
    case "clientCredentials": {
      if (!isRecord(value)) {
        problem(at, "must be { clientId, clientSecret or assertionKey, scope, tokenUrl }");
        return undefined;
      }
      fields(value, ["clientId", "clientSecret", "assertionKey", "scope", "tokenUrl"]);
      const endpoint = tokenUrl(value);
      const rawClientId = value["clientId"];
      let clientId: string | McpCredentialReference | undefined;
      if (typeof rawClientId === "string" && rawClientId.trim()) clientId = rawClientId.trim();
      else if (rawClientId === undefined || rawClientId === null)
        fail([...at, "clientId"], `is required: the client ID, or ${REFERENCE_FORMS}`);
      else clientId = reference([...at, "clientId"], rawClientId);
      const has = (key: string) => value[key] !== undefined && value[key] !== null;
      if (has("clientSecret") === has("assertionKey"))
        fail(at, "needs exactly one of clientSecret or assertionKey");
      const clientSecret = has("clientSecret")
        ? reference([...at, "clientSecret"], value["clientSecret"])
        : undefined;
      const assertionKey = has("assertionKey")
        ? reference([...at, "assertionKey"], value["assertionKey"])
        : undefined;
      const scope = value["scope"];
      if (scope !== undefined && scope !== null && (typeof scope !== "string" || !scope.trim()))
        fail([...at, "scope"], "must be a space-separated list of scopes");
      if (!ok || clientId === undefined) return undefined;
      return {
        clientCredentials: {
          clientId,
          ...(clientSecret === undefined ? {} : { clientSecret }),
          ...(assertionKey === undefined ? {} : { assertionKey }),
          ...(typeof scope === "string" ? { scope: scope.trim() } : {}),
          ...(endpoint === undefined ? {} : { tokenUrl: endpoint }),
        },
      };
    }
    case "helper": {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((part) => typeof part !== "string" || !part)
      ) {
        problem(at, "must list a command and its arguments, such as [/opt/bin/mcp-token, vendor]");
        return undefined;
      }
      const [command, ...args] = value as string[];
      return { helper: [context.expandHome(command as string), ...args] };
    }
    case "oauth": {
      if (value === true) return { oauth: true };
      if (!isRecord(value)) {
        problem(at, "must be true, for supertag mcp login, or { refreshToken: { env: VAR } }");
        return undefined;
      }
      fields(value, ["refreshToken", "tokenUrl"]);
      const refreshToken = required([...at, "refreshToken"], value["refreshToken"]);
      const endpoint = tokenUrl(value);
      return ok && refreshToken !== undefined
        ? { oauth: { refreshToken, ...(endpoint === undefined ? {} : { tokenUrl: endpoint }) } }
        : undefined;
    }
  }
}

function parseReference(
  value: unknown,
  path: readonly string[],
  context: McpParseContext,
): McpCredentialReference | undefined {
  const { problem } = context;
  // Never echo the value: a literal here is most likely the credential itself.
  if (!isRecord(value)) {
    problem(path, `must be a reference: ${REFERENCE_FORMS}; ${NO_VALUES}`);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    problem(path, `must have exactly one of env, file, or secretRef`);
    return undefined;
  }
  const [key] = keys;
  const entry = value[key as string];
  if (key === "env") {
    if (typeof entry === "string" && ENV_NAME.test(entry)) return { env: entry };
    problem([...path, "env"], "must be an environment variable name, such as SENTRY_TOKEN");
    return undefined;
  }
  if (key === "file") {
    if (typeof entry === "string" && entry.trim())
      return {
        file: resolve(context.directoryOf([...path, "file"]), context.expandHome(entry.trim())),
      };
    problem([...path, "file"], "must be a file path");
    return undefined;
  }
  if (key === "secretRef") {
    if (typeof entry === "string" && context.secrets.has(entry)) return { secretRef: entry };
    problem([...path, "secretRef"], "must name an entry in secrets");
    return undefined;
  }
  problem([...path, key as string], `unknown field; expected ${REFERENCE_FORMS}`);
  return undefined;
}

/**
 * The servers a host's Workers serve to `target: mcp` grants, with each preset's resource
 * mapping, so the policy proxy can check `resource` grants on preset tools. Servers without a
 * preset have no mapping. Authentication headers come from the Worker's `mcpHeaders` hook.
 */
export function hostMcpToolServers(
  servers: Readonly<Record<string, HostMcpServer>>,
  presets: McpPresets = MCP_PRESETS,
  stdioPresets: McpStdioPresets = MCP_STDIO_PRESETS,
): Record<string, McpServerDefinition> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]): [string, McpServerDefinition] => {
      // The environment comes from the Worker's `mcpEnvironment` hook, at each Task Attempt.
      if (isStdioHostMcpServer(server)) {
        const [command, ...args] = server.command;
        const resources =
          server.preset === undefined ? undefined : stdioPresets[server.preset].resources;
        return [
          name,
          { command: command as string, args, ...(resources === undefined ? {} : { resources }) },
        ];
      }
      const resources = server.preset === undefined ? undefined : presets[server.preset].resources;
      return [name, { url: server.url, ...(resources === undefined ? {} : { resources }) }];
    }),
  );
}

/** The `mcp:NAME` placement labels for a host's servers, sorted. */
export function mcpServerLabels(servers: Readonly<Record<string, HostMcpServer>>): string[] {
  return Object.keys(servers).map(mcpServerLabel).sort();
}

/** The file form of a host's servers, for `supertag config`. References are safe to show. */
export function hostMcpValue(
  servers: Readonly<Record<string, HostMcpServer>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      isStdioHostMcpServer(server)
        ? {
            // A preset's command is fixed, so the printed file names only the preset.
            ...(server.preset === undefined
              ? { command: [...server.command] }
              : { preset: server.preset }),
            ...(server.env === undefined ? {} : { env: structuredClone(server.env) }),
          }
        : {
            // A preset's URL is fixed, so the printed file names only the preset and reads back.
            ...(server.preset === undefined ? { url: server.url } : { preset: server.preset }),
            ...(server.tenantId === undefined ? {} : { tenantId: server.tenantId }),
            ...(server.auth === undefined
              ? {}
              : {
                  auth:
                    "helper" in server.auth
                      ? { helper: ["<redacted>"] }
                      : structuredClone(server.auth),
                }),
          },
    ]),
  );
}

function positiveInteger(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\/\S+$/u.test(value.trim())) return false;
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

function isSecureOrLoopback(value: string): boolean {
  const url = new URL(value.trim());
  return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function hasUserInfo(value: string): boolean {
  const url = new URL(value.trim());
  return url.username !== "" || url.password !== "";
}

function hasQueryOrFragment(value: string): boolean {
  const url = new URL(value.trim());
  return url.search !== "" || url.hash !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
