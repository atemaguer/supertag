import { execFile } from "node:child_process";
import { createPrivateKey, createSign, type KeyObject, randomUUID } from "node:crypto";
import { access, constants, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  type McpServerEnvironment,
  type McpServerHeaders,
  WORKSPACE_MCP_VARIABLE_PREFIX,
} from "@supertag/worker-sdk";
import {
  type HostMcpServer,
  type HostStdioMcpServer,
  isStdioHostMcpServer,
  type McpAuth,
  type McpCredentialReference,
} from "./host-mcp.js";
import {
  FileMcpLoginStore,
  type McpLoginStore,
  mcpLoginAccessToken,
  mcpLoginCommand,
  mcpLoginState,
} from "./mcp-oauth.js";
import { readSecret, type ServicesFile } from "./supertag-yaml.js";

/**
 * Declarative MCP authentication. The Worker's per-Task policy proxy calls the hook this module
 * builds and sends the headers upstream itself; the harness, its shell, and its MCP config only
 * ever see the proxy's loopback URL. Messages here name servers and references, never values.
 */

type Environment = Readonly<Record<string, string | undefined>>;
type Headers = Readonly<Record<string, string>>;

export interface McpAuthSources {
  readonly file: Pick<ServicesFile, "secrets" | "envFile">;
  readonly environment?: Environment;
  /** Logins from supertag mcp login, for `auth: { oauth: true }`; this host's store by default. */
  readonly logins?: McpLoginStore;
}

export interface McpAuthOptions {
  /** Outbound HTTP for token endpoints; tests substitute fake endpoints. */
  readonly fetch?: typeof fetch;
  /** GitHub's REST API, for App installation tokens. */
  readonly githubApiUrl?: string;
  readonly now?: () => number;
  /** Called when an `oauth: true` server's login lapses, so the host stops advertising it. */
  readonly onLoginLapsed?: (server: string) => void;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const HELPER_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * Environment variable names that look like credentials. Helpers a repository declares run
 * without them, as Claude Code runs a project's `headersHelper`; host-declared helpers are
 * trusted and get the host's environment.
 */
export const CREDENTIAL_LIKE_ENV =
  /(TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|COOKIE|SESSION|^SUPERTAG_)/iu;

/**
 * Connection-string variable names, such as `DATABASE_URL`, `MONGO_URL`, `REDIS_URL`, and
 * `SENTRY_DSN`, which usually embed a password even when the value does not show it.
 */
export const CONNECTION_STRING_ENV =
  /(^|_)(DATABASE|DB|MONGO|MONGODB|REDIS|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|AMQP|RABBITMQ|BROKER|CLOUDAMQP|ELASTICSEARCH|MEMCACHE[DS]?)_(URL|URI)$|(^|_)DSN$/iu;

/** A URL value with userinfo, such as `https://user:pass@host`, whatever its variable name. */
const USERINFO_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/iu;

function credentialLikeVariable(name: string, value: string): boolean {
  return (
    CREDENTIAL_LIKE_ENV.test(name) || CONNECTION_STRING_ENV.test(name) || USERINFO_URL.test(value)
  );
}

/** The environment a headers helper runs with. */
export function helperEnvironment(environment: Environment, trusted: boolean): NodeJS.ProcessEnv {
  const entries = Object.entries(environment).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && (trusted || !credentialLikeVariable(entry[0], entry[1])),
  );
  return Object.fromEntries(entries);
}

/**
 * Runs a headers helper: a command that prints one JSON object of header names to string
 * values. `trusted` is true for helpers in the host's supertag.yaml, false for helpers a
 * repository declares.
 */
export async function runMcpHeadersHelper(
  server: string,
  command: readonly string[],
  options: { readonly trusted: boolean; readonly environment?: Environment },
): Promise<Headers> {
  const [program, ...args] = command;
  if (program === undefined) throw new Error(`MCP server ${server}: auth helper has no command`);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      program,
      args,
      {
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: helperEnvironment(options.environment ?? process.env, options.trusted),
        windowsHide: true,
      },
      (error, out) => {
        // Never echo helper output: it holds the credential.
        if (error) {
          const code = (error as { code?: unknown }).code;
          reject(
            new Error(
              `MCP server ${server}: auth helper ${program} failed${typeof code === "number" ? ` with exit code ${code}` : ""}`,
            ),
          );
        } else resolve(out);
      },
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`MCP server ${server}: auth helper ${program} must print a JSON object`);
  }
  if (!isRecord(parsed) || Object.values(parsed).some((value) => typeof value !== "string"))
    throw new Error(
      `MCP server ${server}: auth helper ${program} must print a JSON object of header names to string values`,
    );
  return checkedHeaders(server, parsed as Record<string, string>);
}

/**
 * Checks every server's credentials before the host takes Tasks: each reference resolves, each
 * GitHub App key parses, and each helper is executable. Throws one error naming every problem.
 */
export async function checkHostMcpCredentials(
  servers: Readonly<Record<string, HostMcpServer>>,
  sources: McpAuthSources,
): Promise<void> {
  const problems: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (isStdioHostMcpServer(server)) {
      try {
        await checkExecutable(name, server.command[0] as string, sources, "command");
      } catch (error) {
        problems.push(errorMessage(error));
      }
      try {
        await stdioEnvironment(name, server, sources);
      } catch (error) {
        problems.push(errorMessage(error));
      }
      continue;
    }
    const auth = server.auth;
    if (auth === undefined) continue;
    try {
      await checkAuth(name, server.url, auth, sources);
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  if (problems.length > 0)
    throw new Error(
      `MCP server credentials are missing, so this host takes no Tasks:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
    );
}

async function checkAuth(
  name: string,
  url: string,
  auth: McpAuth,
  sources: McpAuthSources,
): Promise<void> {
  if ("bearer" in auth) await readReference(name, "auth.bearer", auth.bearer, sources);
  else if ("headers" in auth)
    for (const [header, reference] of Object.entries(auth.headers))
      await readReference(name, `auth.headers.${header}`, reference, sources);
  else if ("githubApp" in auth)
    privateKey(
      name,
      "auth.githubApp.privateKey",
      await readReference(name, "auth.githubApp.privateKey", auth.githubApp.privateKey, sources),
    );
  else if ("clientCredentials" in auth) {
    const { clientId, clientSecret, assertionKey } = auth.clientCredentials;
    if (typeof clientId !== "string")
      await readReference(name, "auth.clientCredentials.clientId", clientId, sources);
    if (clientSecret !== undefined)
      await readReference(name, "auth.clientCredentials.clientSecret", clientSecret, sources);
    if (assertionKey !== undefined)
      privateKey(
        name,
        "auth.clientCredentials.assertionKey",
        await readReference(name, "auth.clientCredentials.assertionKey", assertionKey, sources),
      );
  } else if ("helper" in auth) await checkExecutable(name, auth.helper[0] as string, sources);
  else if (auth.oauth === true) {
    // A lapsed login holds Tasks that need the server; only a host that never logged in fails.
    const login = await (sources.logins ?? new FileMcpLoginStore()).read(name);
    if (mcpLoginState(login, url, Date.now()).state === "missing")
      throw new Error(
        `MCP server ${name} uses auth: { oauth: true } but is not logged in on this host. Run ${mcpLoginCommand(name)} here, or run ${mcpLoginCommand(name)} --export on a machine with a browser and set auth: { oauth: { refreshToken: { env: VAR } } } with its output`,
      );
  } else await readReference(name, "auth.oauth.refreshToken", auth.oauth.refreshToken, sources);
}

/**
 * Resolves a stdio server's `env` references. The Worker passes the result only to the server
 * process it launches. A missing reference fails here, before the host takes Tasks.
 */
async function stdioEnvironment(
  name: string,
  server: HostStdioMcpServer,
  sources: McpAuthSources,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [variable, reference] of Object.entries(server.env ?? {}))
    resolved[variable] = await readReference(name, `env.${variable}`, reference, sources);
  return resolved;
}

/** Builds the Worker's `mcpEnvironment` hook for a host service's stdio servers. */
export function createHostMcpEnvironment(
  servers: Readonly<Record<string, HostMcpServer>>,
  sources: McpAuthSources,
): McpServerEnvironment {
  return async ({ server: name }) => {
    const server = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (server === undefined || !isStdioHostMcpServer(server)) return {};
    return stdioEnvironment(name, server, sources);
  };
}

/**
 * The values a Workspace `.mcp.json` may reference: only `SUPERTAG_MCP_*` variables, from the
 * environment or the services file's env_file, such as `~/.supertag/.env`. The environment wins.
 * Host service servers are trusted and keep reading any variable through their own references.
 */
export function workspaceMcpVariables({
  file,
  environment = process.env,
}: McpAuthSources): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const source of [file.envFile, environment])
    for (const [name, value] of Object.entries(source))
      if (name.startsWith(WORKSPACE_MCP_VARIABLE_PREFIX) && value !== undefined && value !== "")
        variables[name] = value;
  return variables;
}

/** Builds the Worker's `mcpHeaders` hook for a host service's servers. */
export function createHostMcpHeaders(
  servers: Readonly<Record<string, HostMcpServer>>,
  sources: McpAuthSources,
  options: McpAuthOptions = {},
): McpServerHeaders {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const githubApiUrl = (options.githubApiUrl ?? "https://api.github.com").replace(/\/+$/u, "");
  const endpoints = new Map<string, Promise<string>>();
  const oauthTokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();
  const rotatedRefreshTokens = new Map<string, string>();
  const oauthRefreshes = new Map<string, Promise<string>>();
  const logins = sources.logins ?? new FileMcpLoginStore();
  const loginRefreshes = new Map<
    string,
    { readonly forced: boolean; readonly token: Promise<string> }
  >();
  const tokenEndpointOf = (name: string, url: string, configured: string | undefined) => {
    if (configured !== undefined) return Promise.resolve(configured);
    let endpoint = endpoints.get(name);
    if (endpoint === undefined) {
      endpoint = discoverTokenEndpoint(name, url, http);
      endpoints.set(name, endpoint);
      endpoint.catch(() => endpoints.delete(name));
    }
    return endpoint;
  };
  return async ({ server: name, url, refresh }) => {
    const server = Object.hasOwn(servers, name) ? servers[name] : undefined;
    const auth = server === undefined || isStdioHostMcpServer(server) ? undefined : server.auth;
    if (auth === undefined) return {};
    if ("bearer" in auth)
      return bearer(name, await readReference(name, "auth.bearer", auth.bearer, sources));
    if ("headers" in auth) {
      const headers: Record<string, string> = {};
      for (const [header, reference] of Object.entries(auth.headers))
        headers[header] = await readReference(name, `auth.headers.${header}`, reference, sources);
      return checkedHeaders(name, headers);
    }
    if ("githubApp" in auth) {
      // A fresh installation token for every Task Attempt and every refetch.
      const { appId, installationId } = auth.githubApp;
      const key = privateKey(
        name,
        "auth.githubApp.privateKey",
        await readReference(name, "auth.githubApp.privateKey", auth.githubApp.privateKey, sources),
      );
      const issuedAt = Math.floor(now() / 1000) - 60;
      const jwt = signJwt({ iat: issuedAt, exp: issuedAt + 540, iss: String(appId) }, key);
      const what = "GitHub App installation token";
      const response = await tokenRequest(
        http,
        name,
        what,
        `${githubApiUrl}/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "user-agent": "supertag",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      const body = await tokenResponse(name, what, response);
      if (typeof body["token"] !== "string" || !body["token"])
        throw new Error(`MCP server ${name}: GitHub returned no installation token`);
      return bearer(name, body["token"]);
    }
    if ("clientCredentials" in auth) {
      const config = auth.clientCredentials;
      const clientId =
        typeof config.clientId === "string"
          ? config.clientId
          : await readReference(name, "auth.clientCredentials.clientId", config.clientId, sources);
      const endpoint = await tokenEndpointOf(name, url, config.tokenUrl);
      const form = new URLSearchParams({ grant_type: "client_credentials", resource: url });
      if (config.scope !== undefined) form.set("scope", config.scope);
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      };
      if (config.clientSecret !== undefined) {
        const secret = await readReference(
          name,
          "auth.clientCredentials.clientSecret",
          config.clientSecret,
          sources,
        );
        headers["authorization"] =
          `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
      } else {
        const key = privateKey(
          name,
          "auth.clientCredentials.assertionKey",
          await readReference(
            name,
            "auth.clientCredentials.assertionKey",
            config.assertionKey as McpCredentialReference,
            sources,
          ),
        );
        const issuedAt = Math.floor(now() / 1000);
        form.set("client_id", clientId);
        form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
        form.set(
          "client_assertion",
          signJwt(
            {
              iss: clientId,
              sub: clientId,
              aud: endpoint,
              iat: issuedAt,
              exp: issuedAt + 300,
              jti: randomUUID(),
            },
            key,
          ),
        );
      }
      const response = await tokenRequest(http, name, "token", endpoint, {
        method: "POST",
        headers,
        body: form,
      });
      return bearer(name, accessToken(name, await tokenResponse(name, "token", response)));
    }
    if ("helper" in auth)
      return runMcpHeadersHelper(name, auth.helper, {
        trusted: true,
        ...(sources.environment === undefined ? {} : { environment: sources.environment }),
      });
    if (auth.oauth === true) {
      // One refresh at a time per server, so a rotating refresh token is used once. A forced
      // refresh (after a 401 or 403) joins an in-flight forced refresh, which started after the
      // refused token was issued; it waits out an ordinary one, which may only return that token.
      const force = refresh === true;
      for (;;) {
        const pending = loginRefreshes.get(name);
        if (pending === undefined) break;
        if (pending.forced || !force) return bearer(name, await pending.token);
        await pending.token.catch(() => undefined);
      }
      const entry = {
        forced: force,
        token: mcpLoginAccessToken(name, url, {
          store: logins,
          fetch: http,
          now,
          force,
          ...(options.onLoginLapsed === undefined ? {} : { onLapsed: options.onLoginLapsed }),
        }),
      };
      loginRefreshes.set(name, entry);
      try {
        return bearer(name, await entry.token);
      } finally {
        if (loginRefreshes.get(name) === entry) loginRefreshes.delete(name);
      }
    }
    const cached = oauthTokens.get(name);
    if (!refresh && cached !== undefined && cached.expiresAt > now() + 60_000)
      return bearer(name, cached.token);
    // One refresh at a time per server, so a rotating refresh token is used once.
    const pendingRefresh = oauthRefreshes.get(name);
    if (pendingRefresh !== undefined) return bearer(name, await pendingRefresh);
    const oauth = auth.oauth;
    const refreshing = (async () => {
      const stored = parseRefreshToken(
        await readReference(name, "auth.oauth.refreshToken", oauth.refreshToken, sources),
      );
      const refreshToken = rotatedRefreshTokens.get(name) ?? stored.refreshToken;
      const endpoint = await tokenEndpointOf(name, url, oauth.tokenUrl);
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        resource: url,
      });
      if (stored.clientId !== undefined) form.set("client_id", stored.clientId);
      if (stored.clientSecret !== undefined) form.set("client_secret", stored.clientSecret);
      const response = await tokenRequest(http, name, "token refresh", endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form,
      });
      const body = await tokenResponse(name, "token refresh", response);
      const token = accessToken(name, body);
      if (typeof body["refresh_token"] === "string" && body["refresh_token"])
        rotatedRefreshTokens.set(name, body["refresh_token"]);
      const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 300;
      oauthTokens.set(name, { token, expiresAt: now() + expiresIn * 1000 });
      return token;
    })();
    oauthRefreshes.set(name, refreshing);
    try {
      return bearer(name, await refreshing);
    } finally {
      if (oauthRefreshes.get(name) === refreshing) oauthRefreshes.delete(name);
    }
  };
}

/**
 * A refresh token reference holds the token itself, or a JSON object with `refresh_token`
 * and optionally `client_id` and `client_secret`, as `supertag mcp login --export` prints. The token endpoint is never read from it: it comes from
 * supertag.yaml's `tokenUrl` or the server's own origin.
 */
function parseRefreshToken(value: string): {
  readonly refreshToken: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
} {
  if (!value.startsWith("{")) return { refreshToken: value };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { refreshToken: value };
  }
  if (!isRecord(parsed) || typeof parsed["refresh_token"] !== "string")
    return { refreshToken: value };
  return {
    refreshToken: parsed["refresh_token"],
    ...(typeof parsed["client_id"] === "string" ? { clientId: parsed["client_id"] } : {}),
    ...(typeof parsed["client_secret"] === "string"
      ? { clientSecret: parsed["client_secret"] }
      : {}),
  };
}

/** The OAuth endpoints an MCP server's authorization server publishes. */
export interface McpOAuthMetadata {
  /** Pinned to the MCP server's own origin. */
  readonly tokenEndpoint: string;
  readonly authorizationEndpoint?: string;
  readonly registrationEndpoint?: string;
  /** From the server's protected resource metadata, when it lists any. */
  readonly scopes?: readonly string[];
}

/**
 * Finds the authorization server's token endpoint from the MCP server's OAuth protected
 * resource metadata (RFC 9728) and the server's metadata (RFC 8414), as MCP authorization does.
 * Metadata is advertised by the server, so its endpoint is trusted with client secrets and
 * refresh tokens only on the MCP server's own origin; any other origin must be configured as
 * `tokenUrl` in supertag.yaml. The refusal never repeats the advertised URL.
 */
async function discoverTokenEndpoint(
  name: string,
  serverUrl: string,
  http: typeof fetch,
): Promise<string> {
  return (await discoverMcpOAuthMetadata(name, serverUrl, http)).tokenEndpoint;
}

/**
 * Reads an MCP server's OAuth metadata. The token endpoint must be on the server's own origin;
 * the authorization and registration endpoints must be https (or loopback http).
 */
export async function discoverMcpOAuthMetadata(
  name: string,
  serverUrl: string,
  http: typeof fetch,
): Promise<McpOAuthMetadata> {
  const server = new URL(serverUrl);
  const path = server.pathname === "/" ? "" : server.pathname.replace(/\/+$/u, "");
  const resource =
    (await metadata(
      http,
      new URL(`/.well-known/oauth-protected-resource${path}`, server.origin).href,
    )) ??
    (await metadata(http, new URL("/.well-known/oauth-protected-resource", server.origin).href));
  const issuer = Array.isArray(resource?.["authorization_servers"])
    ? resource["authorization_servers"].find((entry): entry is string => typeof entry === "string")
    : undefined;
  if (issuer === undefined || !isSafeEndpoint(issuer))
    throw new Error(
      `MCP server ${name} publishes no OAuth protected resource metadata naming an authorization server`,
    );
  const issuerUrl = new URL(issuer);
  const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/+$/u, "");
  const server_ =
    (await metadata(
      http,
      new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuerUrl.origin).href,
    )) ??
    (await metadata(
      http,
      new URL(`/.well-known/openid-configuration${issuerPath}`, issuerUrl.origin).href,
    ));
  const endpoint = server_?.["token_endpoint"];
  if (typeof endpoint !== "string" || !isSafeEndpoint(endpoint))
    throw new Error(`MCP server ${name}: its authorization server publishes no token endpoint`);
  if (new URL(endpoint).origin !== server.origin)
    throw new Error(
      `MCP server ${name}: its OAuth metadata names a token endpoint on another origin than the server; set the authorization server's token endpoint as tokenUrl under its auth in supertag.yaml to trust it`,
    );
  const optional = (key: string) => {
    const value = server_?.[key];
    return typeof value === "string" && isSafeEndpoint(value) ? value : undefined;
  };
  const authorizationEndpoint = optional("authorization_endpoint");
  const registrationEndpoint = optional("registration_endpoint");
  const scopes = Array.isArray(resource?.["scopes_supported"])
    ? resource["scopes_supported"].filter(
        (scope): scope is string =>
          typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope),
      )
    : [];
  return {
    tokenEndpoint: endpoint,
    ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
    ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
    ...(scopes.length === 0 ? {} : { scopes }),
  };
}

const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

/**
 * Sends one token request without following redirects: the request carries a client secret,
 * assertion, refresh token, or App JWT, and a redirect would resend it somewhere else.
 */
export async function tokenRequest(
  http: typeof fetch,
  name: string,
  what: string,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const response = await http(endpoint, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (
    response.type === "opaqueredirect" ||
    (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `MCP server ${name}: the ${what} request was redirected; SuperTag does not follow redirects for token requests`,
    );
  }
  return response;
}

async function metadata(
  http: typeof fetch,
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await http(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const body = (await response.json()) as unknown;
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

export async function tokenResponse(
  name: string,
  what: string,
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    // The body may echo submitted credentials; report the status only.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`MCP server ${name}: ${what} request failed with HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`MCP server ${name}: ${what} response is not JSON`);
  }
  if (!isRecord(body)) throw new Error(`MCP server ${name}: ${what} response is not an object`);
  return body;
}

export function accessToken(name: string, body: Record<string, unknown>): string {
  const token = body["access_token"];
  if (typeof token !== "string" || !token)
    throw new Error(`MCP server ${name}: the token response has no access_token`);
  const type = body["token_type"];
  if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer"))
    throw new Error(`MCP server ${name}: the token response is not a bearer token`);
  return token;
}

async function readReference(
  server: string,
  field: string,
  reference: McpCredentialReference,
  { file, environment = process.env }: McpAuthSources,
): Promise<string> {
  const at = `MCP server ${server} ${field}`;
  if ("env" in reference) {
    const value = (environment[reference.env] ?? file.envFile[reference.env])?.trim();
    if (!value)
      throw new Error(
        `${at} reads ${reference.env}, which is not set in the environment or an env_file`,
      );
    return value;
  }
  if ("file" in reference) {
    const value = await readFile(reference.file, "utf8").catch(() => {
      throw new Error(`${at} reads ${reference.file}, which cannot be read`);
    });
    if (!value.trim()) throw new Error(`${at} reads ${reference.file}, which is empty`);
    return value.trim();
  }
  try {
    return await readSecret(file, reference.secretRef, environment);
  } catch (error) {
    throw new Error(`${at}: ${errorMessage(error)}`);
  }
}

async function checkExecutable(
  server: string,
  program: string,
  { environment = process.env }: McpAuthSources,
  field = "auth.helper",
): Promise<void> {
  const candidates =
    isAbsolute(program) || program.includes("/")
      ? [program]
      : (environment["PATH"] ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, program));
  for (const candidate of candidates)
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return;
  throw new Error(`MCP server ${server} ${field} runs ${program}, which is not executable`);
}

function privateKey(server: string, field: string, pem: string): KeyObject {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ec") throw new Error();
    return key;
  } catch {
    throw new Error(`MCP server ${server} ${field} is not an RSA or EC private key in PEM form`);
  }
}

function signJwt(payload: Record<string, unknown>, key: KeyObject): string {
  const ec = key.asymmetricKeyType === "ec";
  const header = { alg: ec ? "ES256" : "RS256", typ: "JWT" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign(ec ? { key, dsaEncoding: "ieee-p1363" } : key)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function bearer(server: string, token: string): Headers {
  return checkedHeaders(server, { Authorization: `Bearer ${token}` });
}

function checkedHeaders(server: string, headers: Record<string, string>): Headers {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name))
      throw new Error(`MCP server ${server}: ${JSON.stringify(name)} is not a valid header name`);
    if (/[\r\n\0]/u.test(value))
      throw new Error(`MCP server ${server}: header ${name} holds a line break or null byte`);
  }
  return { ...headers };
}

export function isSafeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
