import { parseArgs } from "node:util";
import { type HostHttpMcpServer, isStdioHostMcpServer } from "./host-mcp.js";
import { checkHostMcpCredentials } from "./host-mcp-auth.js";
import {
  exportedRefreshToken,
  FileMcpLoginStore,
  type McpLoginFlowOptions,
  type McpLoginStore,
  mcpLoginCommand,
  mcpLoginState,
  runMcpLoginFlow,
} from "./mcp-oauth.js";
import { loadServicesFile, type ServicesFile } from "./supertag-yaml.js";

/** Test seams: the file, the login store, and the browser flow's network and browser. */
export interface McpCommandOptions extends McpLoginFlowOptions {
  readonly file?: ServicesFile;
  readonly logins?: McpLoginStore;
  readonly stdout?: (text: string) => void;
}

export function mcpHelp(): string {
  return `Usage:
  supertag mcp list
  supertag mcp login NAME [--export]

MCP servers this machine's host services provide, from the mcp map of each host service in
~/.supertag/supertag.yaml.

  list             Show each server, its auth form, and whether its credentials are ready.
                   Never prints a credential.
  login NAME       Log in to an auth: { oauth: true } server in the browser (OAuth with PKCE).
                   SuperTag stores the tokens in this host's credential store and refreshes them.
  --export         Run the same browser login, store nothing, and print the refresh token once,
                   for auth: { oauth: { refreshToken: { env: VAR } } } on a remote host.
`;
}

export async function runMcpCommand(
  args: readonly string[],
  options: McpCommandOptions = {},
): Promise<number> {
  const out = options.stdout ?? ((text: string) => process.stdout.write(text));
  const [action, ...rest] = args;
  if (action === undefined || action === "--help" || action === "-h" || rest.includes("--help")) {
    out(mcpHelp());
    return action === undefined ? 1 : 0;
  }
  const file = options.file ?? (await loadServicesFile());
  const logins = options.logins ?? new FileMcpLoginStore();
  if (action === "list") {
    parseArgs({ args: rest, options: {}, strict: true, allowPositionals: false });
    out(await formatMcpList(file, logins));
    return 0;
  }
  if (action === "login") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { export: { type: "boolean", default: false } },
      strict: true,
      allowPositionals: true,
    });
    const [name, ...extra] = positionals;
    if (name === undefined || extra.length > 0)
      throw new Error("Usage: supertag mcp login NAME [--export]");
    const server = loginServer(file, name, values.export === true);
    const login = await runMcpLoginFlow(name, server.url, options);
    if (values.export === true) {
      const variable = `${name.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}_MCP_REFRESH_TOKEN`;
      out(
        `${exportedRefreshToken(login)}\n` +
          `Store this value as a secret on the remote host, such as ${variable}, and set auth: { oauth: { refreshToken: { env: ${variable} } } }. It is not stored here and is not shown again.\n`,
      );
      return 0;
    }
    await logins.write(name, login);
    out(`Logged in to MCP server ${name}. SuperTag refreshes the login on this host.\n`);
    return 0;
  }
  throw new Error(`Unknown mcp action ${JSON.stringify(action)}; expected list or login`);
}

/** The one URL a server name has across this file's host services. */
function loginServer(file: ServicesFile, name: string, exporting: boolean): HostHttpMcpServer {
  const all = hostServers(file).filter((entry) => entry.name === name);
  if (all.some((entry) => isStdioHostMcpServer(entry.server)))
    throw new Error(
      `MCP server ${name} is a stdio server, so it has no login; the Worker starts it with its env`,
    );
  const declared = all.flatMap((entry) =>
    isStdioHostMcpServer(entry.server) ? [] : [{ ...entry, server: entry.server }],
  );
  if (declared.length === 0)
    throw new Error(
      `No host service in supertag.yaml declares MCP server ${name}; add it under the host service's mcp map, such as ${name}: { url: https://..., auth: { oauth: true } }`,
    );
  const urls = new Set(declared.map((entry) => entry.server.url));
  if (urls.size > 1)
    throw new Error(
      `MCP server ${name} has different URLs in host services ${declared.map((entry) => entry.service).join(", ")}; give them one URL or different names`,
    );
  const server = declared[0]?.server as HostHttpMcpServer;
  const auth = server.auth;
  const oauth = auth !== undefined && "oauth" in auth;
  if (exporting ? !oauth : !(oauth && auth.oauth === true))
    throw new Error(
      exporting
        ? `MCP server ${name} does not use OAuth; --export needs auth: { oauth: true } or auth: { oauth: { refreshToken: ... } }`
        : `MCP server ${name} does not use auth: { oauth: true }, so it has no login to store; declare it with auth: { oauth: true } to log in`,
    );
  return server;
}

function hostServers(file: ServicesFile) {
  return file.services.flatMap((service) =>
    service.type === "host"
      ? Object.entries(service.mcp).map(([name, server]) => ({
          service: service.name,
          name,
          server,
        }))
      : [],
  );
}

/** `supertag mcp list`: one row per server. Shows references and states, never values. */
export async function formatMcpList(
  file: ServicesFile,
  logins: McpLoginStore,
  now = Date.now(),
): Promise<string> {
  const rows: string[][] = [];
  for (const { service, name, server } of hostServers(file)) {
    if (isStdioHostMcpServer(server)) {
      // Only the executable: arguments are not shown.
      const state = await checkHostMcpCredentials({ [name]: server }, { file, logins }).then(
        () => "ready",
        (error: unknown) =>
          `missing: ${(error instanceof Error ? error.message : String(error)).split("\n").slice(1).join("; ").trim()}`,
      );
      rows.push([service, name, `stdio: ${server.command[0]}`, "env", state]);
      continue;
    }
    const auth = server.auth;
    let kind = "none";
    let state = "ready";
    if (auth !== undefined) {
      kind = Object.keys(auth)[0] as string;
      if ("oauth" in auth && auth.oauth === true) {
        kind = "oauth login";
        const login = mcpLoginState(
          await logins.read(name).catch(() => undefined),
          server.url,
          now,
        );
        state =
          login.state === "logged-in"
            ? `logged in${login.expiresAt === undefined ? "" : `, expires ${login.expiresAt}`}`
            : login.state === "lapsed"
              ? `login lapsed; run ${mcpLoginCommand(name)}`
              : `not logged in; run ${mcpLoginCommand(name)}`;
      } else {
        if ("oauth" in auth) kind = "oauth refresh token";
        state = await checkHostMcpCredentials({ [name]: server }, { file, logins }).then(
          () => "ready",
          (error: unknown) =>
            `missing: ${(error instanceof Error ? error.message : String(error)).split("\n").slice(1).join("; ").trim()}`,
        );
      }
    }
    rows.push([service, name, server.url, kind, state]);
  }
  if (rows.length === 0)
    return "No host service in supertag.yaml declares MCP servers. Add them under a host service's mcp map.\n";
  const header = ["SERVICE", "SERVER", "URL", "AUTH", "STATE"];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] as string).length)),
  );
  const line = (row: readonly string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ");
  return `${[header, ...rows].map(line).join("\n")}\n`;
}
