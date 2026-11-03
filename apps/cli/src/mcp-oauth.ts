import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialValue } from "@supertag/core";
import { FileCredentialStore } from "@supertag/store";
import type { HostMcpServer } from "./host-mcp.js";
import {
  accessToken,
  discoverMcpOAuthMetadata,
  isSafeEndpoint,
  tokenRequest,
  tokenResponse,
} from "./host-mcp-auth.js";

/**
 * Interactive OAuth for MCP servers declared with `auth: { oauth: true }`. `supertag mcp login`
 * runs the MCP authorization flow (authorization code with PKCE, a loopback redirect, and dynamic
 * client registration when the server offers it) and stores the tokens in this host's credential
 * store. The per-Task policy proxy refreshes them; the harness never sees them.
 */

/** One server's stored login. Every field is a string because the credential store holds strings. */
export interface McpLogin {
  /** The MCP server URL the login is for; a different URL needs a new login. */
  readonly url: string;
  /** The token endpoint the login used, pinned to the server's origin when it was discovered. */
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly accessToken?: string;
  /** Epoch milliseconds when the access token expires. */
  readonly accessTokenExpiresAt?: number;
  /** Epoch milliseconds when the refresh token expires, when the server said. */
  readonly refreshTokenExpiresAt?: number;
  readonly loggedInAt: string;
  /** Set when the authorization server refused the refresh token: the login lapsed. */
  readonly lapsedAt?: string;
}

/** The state `supertag mcp list` shows; never a token. */
export type McpLoginState =
  | { readonly state: "logged-in"; readonly expiresAt?: string }
  | { readonly state: "lapsed"; readonly since: string }
  | { readonly state: "missing" };

export interface McpLoginStore {
  read(server: string): Promise<McpLogin | undefined>;
  write(server: string, login: McpLogin): Promise<void>;
  /**
   * Writes the login only when the stored one passes `expected`, atomically with the check.
   * Returns whether it wrote.
   */
  writeIf(
    server: string,
    login: McpLogin,
    expected: (current: McpLogin | undefined) => boolean,
  ): Promise<boolean>;
}

const CREDENTIAL_PREFIX = "mcp-oauth/";

/** The command that logs a server in, for messages and the operator inbox. */
export function mcpLoginCommand(server: string): string {
  return `supertag mcp login ${server}`;
}

/** Logins in this host's credential store (`~/.supertag/credentials.json`). */
export class FileMcpLoginStore implements McpLoginStore {
  readonly #store: FileCredentialStore;

  constructor(path?: string) {
    this.#store =
      path === undefined
        ? new FileCredentialStore("operator")
        : new FileCredentialStore("operator", path);
  }

  async read(server: string): Promise<McpLogin | undefined> {
    const value = await this.#store.resolve(`${CREDENTIAL_PREFIX}${server}`);
    return value === undefined ? undefined : decodeLogin(value);
  }

  async write(server: string, login: McpLogin): Promise<void> {
    await this.#store.store(`${CREDENTIAL_PREFIX}${server}`, encodeLogin(login));
  }

  async writeIf(
    server: string,
    login: McpLogin,
    expected: (current: McpLogin | undefined) => boolean,
  ): Promise<boolean> {
    return this.#store.storeIf(`${CREDENTIAL_PREFIX}${server}`, encodeLogin(login), (current) =>
      expected(current === undefined ? undefined : decodeLogin(current)),
    );
  }
}

/** Whether two stored logins are the same login: same server URL, token endpoint, and client. */
function sameLoginIdentity(a: McpLogin, b: McpLogin): boolean {
  return a.url === b.url && a.tokenEndpoint === b.tokenEndpoint && a.clientId === b.clientId;
}

/**
 * Whether the stored login is still exactly the one a refresh read: the same identity, refresh
 * token, access token, and login generation. A new `mcp login` that got the same client and
 * refresh token back still has another `loggedInAt`, so a stale refresh never overwrites it.
 */
function isUnchangedLogin(stored: McpLogin | undefined, login: McpLogin): stored is McpLogin {
  return (
    stored !== undefined &&
    sameLoginIdentity(stored, login) &&
    stored.refreshToken === login.refreshToken &&
    stored.loggedInAt === login.loggedInAt &&
    stored.accessToken === login.accessToken
  );
}

function encodeLogin(login: McpLogin): CredentialValue {
  return Object.fromEntries(
    Object.entries(login)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function decodeLogin(value: CredentialValue): McpLogin | undefined {
  const { url, tokenEndpoint, clientId, refreshToken, loggedInAt } = value;
  if (!url || !tokenEndpoint || !clientId || !refreshToken || !loggedInAt) return undefined;
  const number = (key: string) => {
    const raw = value[key];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const accessTokenExpiresAt = number("accessTokenExpiresAt");
  const refreshTokenExpiresAt = number("refreshTokenExpiresAt");
  return {
    url,
    tokenEndpoint,
    clientId,
    refreshToken,
    loggedInAt,
    ...(value["clientSecret"] ? { clientSecret: value["clientSecret"] } : {}),
    ...(value["accessToken"] ? { accessToken: value["accessToken"] } : {}),
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
    ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
    ...(value["lapsedAt"] ? { lapsedAt: value["lapsedAt"] } : {}),
  };
}

/** A server's login state for a URL. A login for another URL counts as missing. */
export function mcpLoginState(
  login: McpLogin | undefined,
  url: string,
  now = Date.now(),
): McpLoginState {
  if (login === undefined || login.url !== url) return { state: "missing" };
  if (login.lapsedAt !== undefined) return { state: "lapsed", since: login.lapsedAt };
  if (login.refreshTokenExpiresAt !== undefined && login.refreshTokenExpiresAt <= now)
    return { state: "lapsed", since: new Date(login.refreshTokenExpiresAt).toISOString() };
  return login.refreshTokenExpiresAt === undefined
    ? { state: "logged-in" }
    : { state: "logged-in", expiresAt: new Date(login.refreshTokenExpiresAt).toISOString() };
}

/** The `auth: { oauth: true }` servers whose stored login lapsed. Unreadable stores count as none. */
export async function lapsedMcpLogins(
  servers: Readonly<Record<string, HostMcpServer>>,
  store: McpLoginStore,
  now = Date.now(),
): Promise<ReadonlySet<string>> {
  const lapsed = new Set<string>();
  for (const [name, server] of Object.entries(servers)) {
    if (
      !("auth" in server) ||
      server.auth === undefined ||
      !("oauth" in server.auth) ||
      server.auth.oauth !== true
    )
      continue;
    const login = await store.read(name).catch(() => undefined);
    if (mcpLoginState(login, server.url, now).state !== "logged-in") lapsed.add(name);
  }
  return lapsed;
}

/** Raised when the authorization server refuses a stored login; the operator must log in again. */
export class McpLoginLapsedError extends Error {
  readonly server: string;

  constructor(server: string) {
    super(
      `MCP server ${server}: its login lapsed; run ${mcpLoginCommand(server)} on this host to log in again`,
    );
    this.server = server;
  }
}

export interface McpLoginRefreshOptions {
  readonly store: McpLoginStore;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Called once when the authorization server refuses the login. */
  readonly onLapsed?: (server: string) => void;
}

/**
 * The access token for a logged-in server: the stored one while it is valid, else a refreshed
 * one. The refresh goes only to the token endpoint the login recorded, which must still be on
 * the server's origin, and never follows redirects. A refused refresh marks the login lapsed.
 */
export async function mcpLoginAccessToken(
  server: string,
  url: string,
  options: McpLoginRefreshOptions & { readonly force: boolean; readonly retried?: boolean },
): Promise<string> {
  const { store, now } = options;
  const login = await store.read(server);
  const state = mcpLoginState(login, url, now());
  if (login === undefined || state.state === "missing")
    throw new Error(
      `MCP server ${server} is not logged in on this host; run ${mcpLoginCommand(server)}`,
    );
  if (state.state === "lapsed") throw new McpLoginLapsedError(server);
  if (
    !options.force &&
    login.accessToken !== undefined &&
    login.accessTokenExpiresAt !== undefined &&
    login.accessTokenExpiresAt > now() + 60_000
  )
    return login.accessToken;
  if (
    !isSafeEndpoint(login.tokenEndpoint) ||
    new URL(login.tokenEndpoint).origin !== new URL(url).origin
  )
    throw new Error(
      `MCP server ${server}: the stored login's token endpoint is not on the server's origin; run ${mcpLoginCommand(server)}`,
    );
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    resource: url,
  });
  if (login.clientSecret !== undefined) form.set("client_secret", login.clientSecret);
  const response = await tokenRequest(options.fetch, server, "token refresh", login.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  // RFC 6749 section 5.2: a refused grant is 400 invalid_grant; some servers answer 401.
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    // Another process may have rotated the refresh token meanwhile; use its result instead.
    const current = await store.read(server);
    // Another refresh of this same login already succeeded: its access token is newer than the
    // refused one. A token from another login (a new URL or client) is never reused here.
    if (
      current !== undefined &&
      current.url === url &&
      sameLoginIdentity(current, login) &&
      current.lapsedAt === undefined &&
      current.accessToken !== undefined &&
      current.accessToken !== login.accessToken &&
      current.accessTokenExpiresAt !== undefined &&
      current.accessTokenExpiresAt > now() + 60_000
    )
      return current.accessToken;
    const rotated = (stored: McpLogin | undefined) =>
      stored !== undefined &&
      stored.lapsedAt === undefined &&
      stored.refreshToken !== login.refreshToken;
    // A rotated or new login goes through the full checks again, including its URL.
    if (rotated(current) && !options.retried)
      return mcpLoginAccessToken(server, url, { ...options, retried: true });
    // Mark lapsed only the refused login itself: a rotation or new login stored since the read
    // above must not be overwritten.
    const marked = await store.writeIf(
      server,
      { ...login, lapsedAt: new Date(now()).toISOString() },
      (stored) => isUnchangedLogin(stored, login) && stored.lapsedAt === undefined,
    );
    if (!marked && !options.retried && rotated(await store.read(server)))
      return mcpLoginAccessToken(server, url, { ...options, retried: true });
    if (marked) options.onLapsed?.(server);
    throw new McpLoginLapsedError(server);
  }
  const body = await tokenResponse(server, "token refresh", response);
  const token = accessToken(server, body);
  // Store the result only over the login whose refresh token was spent: a new login (another
  // URL, client, tokens, or generation) stored meanwhile must not be overwritten by this stale response.
  const stored = await store.writeIf(
    server,
    { ...withTokens(login, body, now()), accessToken: token },
    (current) => isUnchangedLogin(current, login),
  );
  if (stored) return token;
  // Discard the result; the current stored login goes through the full checks again. Its access
  // token is not the one the server refused, so a still-valid one is used without a refresh.
  if (!options.retried)
    return mcpLoginAccessToken(server, url, { ...options, force: false, retried: true });
  throw new Error(
    `MCP server ${server}: its login changed during a token refresh; retry, or run ${mcpLoginCommand(server)}`,
  );
}

function withTokens(login: McpLogin, body: Record<string, unknown>, at: number): McpLogin {
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 300;
  const refreshExpiresIn =
    typeof body["refresh_token_expires_in"] === "number"
      ? body["refresh_token_expires_in"]
      : undefined;
  const rotated =
    typeof body["refresh_token"] === "string" && body["refresh_token"]
      ? body["refresh_token"]
      : undefined;
  const { lapsedAt: _lapsed, ...rest } = login;
  return {
    ...rest,
    ...(rotated === undefined ? {} : { refreshToken: rotated }),
    accessTokenExpiresAt: at + expiresIn * 1000,
    ...(refreshExpiresIn === undefined
      ? {}
      : { refreshTokenExpiresAt: at + refreshExpiresIn * 1000 }),
  };
}

export interface McpLoginFlowOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Opens the authorization URL; defaults to the system browser. */
  readonly openBrowser?: (url: string) => void | Promise<void>;
  readonly write?: (text: string) => void;
  /** How long to wait for the browser to come back. */
  readonly timeoutMs?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PATH = "/callback";

/**
 * Runs the MCP authorization flow for one server: discovers its authorization server, registers
 * a client when needed, opens the browser with a PKCE challenge, receives the code on a loopback
 * redirect, and exchanges it. Returns the login; the caller stores or exports it.
 */
export async function runMcpLoginFlow(
  server: string,
  url: string,
  options: McpLoginFlowOptions = {},
): Promise<McpLogin> {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const metadata = await discoverMcpOAuthMetadata(server, url, http);
  if (metadata.authorizationEndpoint === undefined)
    throw new Error(
      `MCP server ${server}: its authorization server publishes no authorization endpoint`,
    );
  const callback = await startCallbackServer();
  try {
    const redirectUri = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
    const client = await registerClient(server, metadata.registrationEndpoint, redirectUri, http);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const authorize = new URL(metadata.authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("resource", url);
    if (metadata.scopes !== undefined)
      authorize.searchParams.set("scope", metadata.scopes.join(" "));
    write(
      `Log in to MCP server ${server} in your browser. If it does not open, visit:\n  ${authorize.href}\n`,
    );
    const code = callback.code(state, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    await (options.openBrowser ?? openSystemBrowser)(authorize.href);
    const authorizationCode = await code;
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: url,
    });
    if (client.clientSecret !== undefined) form.set("client_secret", client.clientSecret);
    const response = await tokenRequest(http, server, "token", metadata.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
    });
    const body = await tokenResponse(server, "token", response);
    const token = accessToken(server, body);
    if (typeof body["refresh_token"] !== "string" || !body["refresh_token"])
      throw new Error(
        `MCP server ${server}: its authorization server issued no refresh token, so SuperTag cannot keep the login`,
      );
    const at = now();
    return {
      ...withTokens(
        {
          url,
          tokenEndpoint: metadata.tokenEndpoint,
          clientId: client.clientId,
          ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
          refreshToken: body["refresh_token"],
          loggedInAt: new Date(at).toISOString(),
        },
        body,
        at,
      ),
      accessToken: token,
    };
  } finally {
    await callback.close();
  }
}

/**
 * The refresh token form `--export` prints, for `auth: { oauth: { refreshToken: { env: VAR } } }`
 * on another host. It names the client the token belongs to; it never names a token endpoint,
 * which the other host pins itself.
 */
export function exportedRefreshToken(login: McpLogin): string {
  return JSON.stringify({
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    ...(login.clientSecret === undefined ? {} : { client_secret: login.clientSecret }),
  });
}

async function registerClient(
  server: string,
  endpoint: string | undefined,
  redirectUri: string,
  http: typeof fetch,
): Promise<{ readonly clientId: string; readonly clientSecret?: string }> {
  if (endpoint === undefined)
    throw new Error(
      `MCP server ${server}: its authorization server offers no dynamic client registration, which supertag mcp login needs`,
    );
  // RFC 7591. Registration carries no secret, but never follow a redirect with it either.
  const response = await tokenRequest(http, server, "client registration", endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "SuperTag",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await tokenResponse(server, "client registration", response);
  const clientId = body["client_id"];
  if (typeof clientId !== "string" || !clientId)
    throw new Error(`MCP server ${server}: client registration returned no client_id`);
  const secret = body["client_secret"];
  return typeof secret === "string" && secret ? { clientId, clientSecret: secret } : { clientId };
}

interface CallbackServer {
  readonly port: number;
  /** Resolves with the code from the first redirect carrying `state`; others are refused. */
  code(state: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

/** A loopback HTTP server on 127.0.0.1 that receives the authorization redirect. */
async function startCallbackServer(): Promise<CallbackServer> {
  let expected: string | undefined;
  let settle: ((params: URLSearchParams) => void) | undefined;
  const server: Server = createServer((request, response) => {
    const target = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || target.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    // Only the redirect for this login, identified by its state, may finish it.
    if (
      expected === undefined ||
      settle === undefined ||
      !sameText(target.searchParams.get("state") ?? "", expected)
    ) {
      response
        .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end("Unknown login.\n");
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      .end("SuperTag received the login. You can close this window.\n");
    const finish = settle;
    settle = undefined;
    finish(target.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    code: (state, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle = undefined;
          reject(new Error("The browser login did not finish in time"));
        }, timeoutMs);
        timer.unref?.();
        expected = state;
        settle = (params) => {
          clearTimeout(timer);
          const error = params.get("error");
          if (error !== null) {
            reject(
              new Error(
                `The authorization server refused the login: ${error.replace(/[^\w.-]/gu, "")}`,
              ),
            );
            return;
          }
          const code = params.get("code");
          if (!code) reject(new Error("The login redirect carried no authorization code"));
          else resolve(code);
        };
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function openSystemBrowser(url: string): Promise<void> {
  const [program, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    // Opening the browser is best effort: the URL is already printed.
    execFile(program, args as string[], { windowsHide: true }, () => resolve());
  });
}
