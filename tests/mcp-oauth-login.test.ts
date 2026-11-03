import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMcpServer } from "../apps/cli/src/host-mcp.ts";
import { checkHostMcpCredentials, createHostMcpHeaders } from "../apps/cli/src/host-mcp-auth.ts";
import { formatMcpList, runMcpCommand } from "../apps/cli/src/mcp-command.ts";
import {
  FileMcpLoginStore,
  lapsedMcpLogins,
  type McpLogin,
  type McpLoginStore,
  mcpLoginAccessToken,
  runMcpLoginFlow,
} from "../apps/cli/src/mcp-oauth.ts";
import type { ServicesFile } from "../apps/cli/src/supertag-yaml.ts";
import { HostServiceWorklet } from "../apps/cli/src/worker.ts";
import { placeByLabels } from "../packages/control-plane/src/label-placement.ts";
import {
  coordinationInboxCommands,
  coordinationInboxHeadline,
  parseWorkerHostLabels,
} from "../packages/core/src/index.ts";
import { StaticWorker } from "../packages/runtime/sdk/src/index.ts";

/**
 * `auth: { oauth: true }`: `supertag mcp login` runs OAuth with PKCE against a fake
 * authorization server on loopback, stores the tokens, and the policy proxy's header hook
 * refreshes them. A refused refresh marks the login lapsed, so the host advertises
 * `mcp-login:NAME` and Tasks that need the server are held with the login command.
 */

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const noFile = { secrets: {}, envFile: {} };

function memoryLogins(initial: Record<string, McpLogin> = {}) {
  const logins = new Map(Object.entries(initial));
  const store: McpLoginStore & { logins: Map<string, McpLogin> } = {
    logins,
    read: async (server) => logins.get(server),
    write: async (server, login) => {
      logins.set(server, login);
    },
    writeIf: async (server, login, expected) => {
      if (!expected(logins.get(server))) return false;
      logins.set(server, login);
      return true;
    },
  };
  return store;
}

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

interface FakeAuthorizationServer {
  readonly origin: string;
  readonly url: string;
  readonly registrations: Record<string, unknown>[];
  readonly authorizations: URLSearchParams[];
  readonly tokenRequests: URLSearchParams[];
  /** Refresh tokens the server still accepts. */
  readonly validRefreshTokens: Set<string>;
}

/** A fake MCP server origin that is also its own authorization server. */
async function fakeAuthorizationServer(
  options: { readonly refreshToken?: boolean } = {},
): Promise<FakeAuthorizationServer> {
  const registrations: Record<string, unknown>[] = [];
  const authorizations: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const validRefreshTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  let issued = 0;
  let origin = "";
  const json = (response: import("node:http").ServerResponse, status: number, value: unknown) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["read", "write"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
    if (url.pathname === "/register" && request.method === "POST") {
      const registration = JSON.parse(await body(request)) as Record<string, unknown>;
      registrations.push(registration);
      return json(response, 201, { client_id: "client-1" });
    }
    if (url.pathname === "/authorize") {
      authorizations.push(url.searchParams);
      const code = `code-${authorizations.length}`;
      const redirectUri = url.searchParams.get("redirect_uri") as string;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") as string,
        redirectUri,
        clientId: url.searchParams.get("client_id") as string,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") as string);
      response.writeHead(302, { location: target.href }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await body(request));
      tokenRequests.push(form);
      const tokens = () => {
        issued += 1;
        const refresh = `refresh-${issued}`;
        validRefreshTokens.add(refresh);
        return {
          access_token: `access-${issued}`,
          token_type: "Bearer",
          expires_in: 600,
          ...(options.refreshToken === false ? {} : { refresh_token: refresh }),
        };
      };
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          code === undefined ||
          createHash("sha256").update(verifier).digest("base64url") !== code.challenge ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.clientId !== form.get("client_id")
        )
          return json(response, 400, { error: "invalid_grant" });
        codes.delete(form.get("code") ?? "");
        return json(response, 200, tokens());
      }
      if (form.get("grant_type") === "refresh_token") {
        const presented = form.get("refresh_token") ?? "";
        if (!validRefreshTokens.delete(presented))
          return json(response, 400, { error: "invalid_grant" });
        return json(response, 200, tokens());
      }
      return json(response, 400, { error: "unsupported_grant_type" });
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    origin,
    url: `${origin}/mcp`,
    registrations,
    authorizations,
    tokenRequests,
    validRefreshTokens,
  };
}

/** A browser that follows the authorization redirect back to the loopback callback. */
const browser = async (url: string) => {
  await fetch(url);
};

function servicesFile(mcp: Record<string, HostMcpServer>): ServicesFile {
  return {
    files: [],
    name: "test",
    version: 1,
    services: [
      { type: "host", name: "laptop", mcp } as unknown as ServicesFile["services"][number],
    ],
    secrets: {},
    envFile: {},
    provenance: new Map(),
  };
}

describe("supertag mcp login", () => {
  it("runs the authorization code flow with PKCE, a loopback redirect, and client registration", async () => {
    const fake = await fakeAuthorizationServer();
    const login = await runMcpLoginFlow("notion", fake.url, {
      openBrowser: browser,
      write: () => undefined,
    });
    expect(fake.registrations).toEqual([
      expect.objectContaining({
        redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u)],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    ]);
    const authorization = fake.authorizations[0] as URLSearchParams;
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("response_type")).toBe("code");
    expect(authorization.get("resource")).toBe(fake.url);
    expect(authorization.get("scope")).toBe("read write");
    expect(authorization.get("state")).toMatch(/^[\w-]{20,}$/u);
    expect(fake.tokenRequests[0]?.get("code_verifier")).toMatch(/^[\w-]{43}$/u);
    expect(login).toMatchObject({
      url: fake.url,
      tokenEndpoint: `${fake.origin}/token`,
      clientId: "client-1",
      refreshToken: "refresh-1",
      accessToken: "access-1",
    });
    expect(login.lapsedAt).toBeUndefined();
  });

  it("ignores a redirect with another state and finishes on the login's own redirect", async () => {
    const fake = await fakeAuthorizationServer();
    const login = await runMcpLoginFlow("notion", fake.url, {
      openBrowser: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri") as string);
        redirect.searchParams.set("code", "forged");
        redirect.searchParams.set("state", "not-this-login");
        expect((await fetch(redirect)).status).toBe(400);
        await fetch(url);
      },
      write: () => undefined,
    });
    expect(login.refreshToken).toBe("refresh-1");
  });

  it("stores the login in the credential store, never printing a token", async () => {
    const fake = await fakeAuthorizationServer();
    const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-login-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const logins = new FileMcpLoginStore(join(directory, "credentials.json"));
    const output: string[] = [];
    const prompts: string[] = [];
    const code = await runMcpCommand(["login", "notion"], {
      file: servicesFile({ notion: { url: fake.url, auth: { oauth: true } } }),
      logins,
      openBrowser: browser,
      write: (text) => prompts.push(text),
      stdout: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(output.join("")).toContain("Logged in to MCP server notion");
    expect(`${output.join("")}${prompts.join("")}`).not.toMatch(/refresh-1|access-1/u);
    expect(await logins.read("notion")).toMatchObject({ refreshToken: "refresh-1" });
    const stored = await readFile(join(directory, "credentials.json"), "utf8");
    expect(stored).toContain("mcp-oauth/notion");
  });

  it("--export prints the refresh token once for auth: { oauth: { refreshToken } } and stores nothing", async () => {
    const fake = await fakeAuthorizationServer();
    const logins = memoryLogins();
    const output: string[] = [];
    await runMcpCommand(["login", "notion", "--export"], {
      file: servicesFile({ notion: { url: fake.url, auth: { oauth: true } } }),
      logins,
      openBrowser: browser,
      write: () => undefined,
      stdout: (text) => output.push(text),
    });
    expect(logins.logins.size).toBe(0);
    const [exported, hint] = output.join("").split("\n");
    expect(JSON.parse(exported as string)).toEqual({
      refresh_token: "refresh-1",
      client_id: "client-1",
    });
    expect(hint).toContain("auth: { oauth: { refreshToken: { env: NOTION_MCP_REFRESH_TOKEN } } }");

    // The exported value works as a declarative refresh token on another host.
    const headers = createHostMcpHeaders(
      { notion: { url: fake.url, auth: { oauth: { refreshToken: { env: "NOTION" } } } } },
      { file: noFile, environment: { NOTION: exported as string } },
    );
    expect(await headers({ server: "notion", url: fake.url, task: {} as never })).toEqual({
      Authorization: "Bearer access-2",
    });
    expect(fake.tokenRequests.at(-1)?.get("client_id")).toBe("client-1");
  });

  it("refuses servers without auth: { oauth: true } and unknown servers", async () => {
    const file = servicesFile({ sentry: { url: "https://mcp.sentry.dev/mcp" } });
    await expect(
      runMcpCommand(["login", "sentry"], { file, logins: memoryLogins() }),
    ).rejects.toThrow(/does not use auth: \{ oauth: true \}/u);
    await expect(
      runMcpCommand(["login", "nope"], { file, logins: memoryLogins() }),
    ).rejects.toThrow(/No host service in supertag\.yaml declares MCP server nope/u);
  });

  it("refuses an authorization server without refresh tokens", async () => {
    const fake = await fakeAuthorizationServer({ refreshToken: false });
    await expect(
      runMcpLoginFlow("notion", fake.url, { openBrowser: browser, write: () => undefined }),
    ).rejects.toThrow(/issued no refresh token/u);
  });

  it("refuses a token endpoint on another origin and token redirects", async () => {
    const metadata = (tokenEndpoint: string, redirect = false) =>
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/.well-known/oauth-protected-resource/mcp"))
          return Response.json({ authorization_servers: ["https://mcp.example.test"] });
        if (url.endsWith("/.well-known/oauth-authorization-server"))
          return Response.json({
            authorization_endpoint: "https://mcp.example.test/authorize",
            token_endpoint: tokenEndpoint,
            registration_endpoint: "https://mcp.example.test/register",
          });
        if (redirect && url === "https://mcp.example.test/register")
          return new Response(null, { status: 307, headers: { location: "https://evil.test/" } });
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;
    await expect(
      runMcpLoginFlow("notion", "https://mcp.example.test/mcp", {
        fetch: metadata("https://evil.test/token"),
        openBrowser: () => undefined,
        write: () => undefined,
      }),
    ).rejects.toThrow(/token endpoint on another origin/u);
    await expect(
      runMcpLoginFlow("notion", "https://mcp.example.test/mcp", {
        fetch: metadata("https://mcp.example.test/token", true),
        openBrowser: () => undefined,
        write: () => undefined,
      }),
    ).rejects.toThrow(/client registration request was redirected/u);
  });
});

describe("oauth: true in the policy proxy", () => {
  async function loggedIn() {
    const fake = await fakeAuthorizationServer();
    const login = await runMcpLoginFlow("notion", fake.url, {
      openBrowser: browser,
      write: () => undefined,
    });
    const logins = memoryLogins({ notion: login });
    const servers = { notion: { url: fake.url, auth: { oauth: true as const } } };
    return { fake, logins, servers };
  }

  it("uses the stored access token, refreshes it when it expires, and keeps the rotated refresh token", async () => {
    const { fake, logins, servers } = await loggedIn();
    let now = Date.now();
    const headers = createHostMcpHeaders(servers, { file: noFile, logins }, { now: () => now });
    const call = (refresh?: boolean) =>
      headers({
        server: "notion",
        url: fake.url,
        task: {} as never,
        ...(refresh ? { refresh } : {}),
      });
    expect(await call()).toEqual({ Authorization: "Bearer access-1" });
    expect(fake.tokenRequests).toHaveLength(1);
    now += 11 * 60_000;
    expect(await call()).toEqual({ Authorization: "Bearer access-2" });
    const refresh = fake.tokenRequests.at(-1) as URLSearchParams;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("refresh-1");
    expect(refresh.get("client_id")).toBe("client-1");
    expect(refresh.get("resource")).toBe(fake.url);
    expect(logins.logins.get("notion")?.refreshToken).toBe("refresh-2");
    // A 401 from the server refetches: a forced refresh with the rotated token.
    expect(await call(true)).toEqual({ Authorization: "Bearer access-3" });
    expect(fake.tokenRequests.at(-1)?.get("refresh_token")).toBe("refresh-2");
  });

  it("refreshes once for concurrent calls, so a rotating refresh token is used once", async () => {
    const { fake, logins, servers } = await loggedIn();
    const now = Date.now() + 11 * 60_000;
    const headers = createHostMcpHeaders(servers, { file: noFile, logins }, { now: () => now });
    const results = await Promise.all(
      [1, 2, 3].map(() => headers({ server: "notion", url: fake.url, task: {} as never })),
    );
    expect(new Set(results.map((result) => result["Authorization"]))).toEqual(
      new Set(["Bearer access-2"]),
    );
    expect(
      fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
  });

  it("refreshes once for concurrent 401s, so a rotating refresh token is not spent twice", async () => {
    const { fake, logins, servers } = await loggedIn();
    const lapsed = vi.fn();
    const headers = createHostMcpHeaders(
      servers,
      { file: noFile, logins },
      { onLoginLapsed: lapsed },
    );
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        headers({ server: "notion", url: fake.url, task: {} as never, refresh: true }),
      ),
    );
    expect(new Set(results.map((result) => result["Authorization"]))).toEqual(
      new Set(["Bearer access-2"]),
    );
    expect(
      fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
    expect(lapsed).not.toHaveBeenCalled();
    expect(logins.logins.get("notion")?.lapsedAt).toBeUndefined();
    expect(logins.logins.get("notion")?.refreshToken).toBe("refresh-2");
  });

  it("a forced refresh waits for an in-flight ordinary refresh, then refreshes once more", async () => {
    const { fake, logins, servers } = await loggedIn();
    const lapsed = vi.fn();
    const now = Date.now() + 11 * 60_000;
    const headers = createHostMcpHeaders(
      servers,
      { file: noFile, logins },
      { now: () => now, onLoginLapsed: lapsed },
    );
    const [ordinary, forced, joined] = await Promise.all([
      headers({ server: "notion", url: fake.url, task: {} as never }),
      headers({ server: "notion", url: fake.url, task: {} as never, refresh: true }),
      headers({ server: "notion", url: fake.url, task: {} as never, refresh: true }),
    ]);
    expect(ordinary).toEqual({ Authorization: "Bearer access-2" });
    expect(forced).toEqual({ Authorization: "Bearer access-3" });
    expect(joined).toEqual({ Authorization: "Bearer access-3" });
    expect(
      fake.tokenRequests
        .filter((form) => form.get("grant_type") === "refresh_token")
        .map((form) => form.get("refresh_token")),
    ).toEqual(["refresh-1", "refresh-2"]);
    expect(lapsed).not.toHaveBeenCalled();
  });

  it("does not mark the login lapsed when another process already rotated it", async () => {
    const { fake, logins, servers } = await loggedIn();
    const lapsed = vi.fn();
    // Two hooks stand in for two processes sharing this host's credential store.
    const first = createHostMcpHeaders(
      servers,
      { file: noFile, logins },
      { onLoginLapsed: lapsed },
    );
    const second = createHostMcpHeaders(
      servers,
      { file: noFile, logins },
      { onLoginLapsed: lapsed },
    );
    const stale = { ...(logins.logins.get("notion") as McpLogin) };
    expect(
      await first({ server: "notion", url: fake.url, task: {} as never, refresh: true }),
    ).toEqual({ Authorization: "Bearer access-2" });
    // The second process read the login before the first rotated it.
    const read = logins.read;
    let reads = 0;
    logins.read = async (server) => (reads++ === 0 ? stale : read(server));
    expect(
      await second({ server: "notion", url: fake.url, task: {} as never, refresh: true }),
    ).toEqual({ Authorization: "Bearer access-2" });
    expect(lapsed).not.toHaveBeenCalled();
    expect(logins.logins.get("notion")?.lapsedAt).toBeUndefined();
  });

  function storedLogin(origin: string, refreshToken: string, extra: Partial<McpLogin> = {}) {
    return {
      url: `${origin}/mcp`,
      tokenEndpoint: `${origin}/token`,
      clientId: "client-1",
      refreshToken,
      accessToken: `stale-${refreshToken}`,
      accessTokenExpiresAt: 0,
      loggedInAt: new Date(0).toISOString(),
      ...extra,
    } satisfies McpLogin;
  }

  it("never returns another server's token after a refused refresh", async () => {
    const logins = memoryLogins({ notion: storedLogin("https://old.example", "refresh-old") });
    const lapsed = vi.fn();
    // While the old login's refresh is in flight, another process logs notion in at new.example.
    const http = vi.fn(async () => {
      logins.logins.set(
        "notion",
        storedLogin("https://new.example", "refresh-new", {
          accessToken: "new-example-token",
          accessTokenExpiresAt: Date.now() + 3_600_000,
        }),
      );
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof fetch;
    const result = mcpLoginAccessToken("notion", "https://old.example/mcp", {
      store: logins,
      fetch: http,
      now: Date.now,
      force: true,
      onLapsed: lapsed,
    });
    await expect(result).rejects.toThrow("MCP server notion is not logged in on this host");
    await expect(result).rejects.not.toThrow(/new-example-token/u);
    expect(http).toHaveBeenCalledTimes(1);
    // The new login is left as it was, not marked lapsed.
    expect(logins.logins.get("notion")).toMatchObject({
      url: "https://new.example/mcp",
      accessToken: "new-example-token",
    });
    expect(logins.logins.get("notion")?.lapsedAt).toBeUndefined();
    expect(lapsed).not.toHaveBeenCalled();
  });

  it("does not overwrite a new login stored while a successful refresh was in flight", async () => {
    const logins = memoryLogins({ notion: storedLogin("https://old.example", "refresh-old") });
    // While the old login's refresh is in flight, another process logs notion in at new.example.
    const http = vi.fn(async () => {
      logins.logins.set(
        "notion",
        storedLogin("https://new.example", "refresh-new", {
          accessToken: "new-example-token",
          accessTokenExpiresAt: Date.now() + 3_600_000,
        }),
      );
      return new Response(
        JSON.stringify({ access_token: "old-access", expires_in: 600, refresh_token: "old-2" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = mcpLoginAccessToken("notion", "https://old.example/mcp", {
      store: logins,
      fetch: http,
      now: Date.now,
      force: true,
    });
    // The stale result is discarded; the current login is checked again and is for another URL.
    await expect(result).rejects.toThrow("MCP server notion is not logged in on this host");
    expect(http).toHaveBeenCalledTimes(1);
    expect(logins.logins.get("notion")).toMatchObject({
      url: "https://new.example/mcp",
      refreshToken: "refresh-new",
      accessToken: "new-example-token",
    });
  });

  it("does not overwrite a new login with the same client and refresh token stored during a refresh", async () => {
    const logins = memoryLogins({
      notion: storedLogin("https://old.example", "refresh-1"),
    });
    // A fresh `mcp login` gets the same client ID and refresh token back while the refresh runs.
    const fresh = storedLogin("https://old.example", "refresh-1", {
      accessToken: "fresh-login-token",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      loggedInAt: new Date(1_000).toISOString(),
    });
    const http = vi.fn(async () => {
      logins.logins.set("notion", fresh);
      return new Response(
        JSON.stringify({
          access_token: "stale-refresh-token",
          expires_in: 600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await expect(
      mcpLoginAccessToken("notion", "https://old.example/mcp", {
        store: logins,
        fetch: http,
        now: Date.now,
        force: true,
      }),
    ).resolves.toBe("fresh-login-token");
    expect(http).toHaveBeenCalledTimes(1);
    expect(logins.logins.get("notion")).toEqual(fresh);
  });

  it("does not mark lapsed a new login with the same client and refresh token stored during a refused refresh", async () => {
    const logins = memoryLogins({
      notion: storedLogin("https://old.example", "refresh-1"),
    });
    // The new login's access token is already expired, so it is not reused and the lapse path runs.
    const fresh = storedLogin("https://old.example", "refresh-1", {
      accessToken: "fresh-login-token",
      accessTokenExpiresAt: 0,
      loggedInAt: new Date(1_000).toISOString(),
    });
    const http = vi.fn(async () => {
      logins.logins.set("notion", fresh);
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      });
    }) as unknown as typeof fetch;
    const lapsed = vi.fn();
    await expect(
      mcpLoginAccessToken("notion", "https://old.example/mcp", {
        store: logins,
        fetch: http,
        now: Date.now,
        force: true,
        onLapsed: lapsed,
      }),
    ).rejects.toThrow("its login lapsed");
    expect(lapsed).not.toHaveBeenCalled();
    expect(logins.logins.get("notion")).toEqual(fresh);
  });

  it("uses the current login when another login of the same URL replaced it during a refresh", async () => {
    const logins = memoryLogins({ notion: storedLogin("https://old.example", "refresh-old") });
    const http = vi.fn(async () => {
      logins.logins.set(
        "notion",
        storedLogin("https://old.example", "refresh-new", {
          clientId: "client-2",
          accessToken: "client-2-token",
          accessTokenExpiresAt: Date.now() + 3_600_000,
        }),
      );
      return new Response(
        JSON.stringify({ access_token: "old-access", expires_in: 600, refresh_token: "old-2" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await expect(
      mcpLoginAccessToken("notion", "https://old.example/mcp", {
        store: logins,
        fetch: http,
        now: Date.now,
        force: true,
      }),
    ).resolves.toBe("client-2-token");
    expect(http).toHaveBeenCalledTimes(1);
    expect(logins.logins.get("notion")).toMatchObject({
      clientId: "client-2",
      refreshToken: "refresh-new",
    });
  });

  it("does not overwrite a rotation stored between reading the login and marking it lapsed", async () => {
    const logins = memoryLogins({ notion: storedLogin("https://old.example", "refresh-1") });
    const stale = logins.logins.get("notion") as McpLogin;
    const read = logins.read;
    let reads = 0;
    // Both reads before the lapse write see the old login; the rotation lands just after them.
    logins.read = async (server) => (++reads <= 2 ? stale : read(server));
    const http = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as URLSearchParams;
      if (form.get("refresh_token") === "refresh-1") {
        logins.logins.set("notion", storedLogin("https://old.example", "refresh-2"));
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: "access-2", expires_in: 600, refresh_token: "refresh-3" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const lapsed = vi.fn();
    await expect(
      mcpLoginAccessToken("notion", "https://old.example/mcp", {
        store: logins,
        fetch: http,
        now: Date.now,
        force: true,
        onLapsed: lapsed,
      }),
    ).resolves.toBe("access-2");
    expect(lapsed).not.toHaveBeenCalled();
    expect(logins.logins.get("notion")).toMatchObject({ refreshToken: "refresh-3" });
    expect(logins.logins.get("notion")?.lapsedAt).toBeUndefined();
  });

  it("stores a login only when the stored one still matches, under the credential file lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-login-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new FileMcpLoginStore(join(directory, "credentials.json"));
    const first = storedLogin("https://old.example", "refresh-1");
    await store.write("notion", first);
    const lapsedCopy = { ...first, lapsedAt: new Date(0).toISOString() };
    await store.write("notion", storedLogin("https://old.example", "refresh-2"));
    expect(
      await store.writeIf("notion", lapsedCopy, (stored) => stored?.refreshToken === "refresh-1"),
    ).toBe(false);
    expect(await store.read("notion")).toMatchObject({ refreshToken: "refresh-2" });
    expect((await store.read("notion"))?.lapsedAt).toBeUndefined();
    expect(
      await store.writeIf("notion", lapsedCopy, (stored) => stored?.refreshToken === "refresh-2"),
    ).toBe(true);
    expect((await store.read("notion"))?.lapsedAt).toBeDefined();
  });

  it("marks the login lapsed when the refresh is refused and names the login command", async () => {
    const { fake, logins, servers } = await loggedIn();
    fake.validRefreshTokens.clear();
    const lapsed = vi.fn();
    const headers = createHostMcpHeaders(
      servers,
      { file: noFile, logins },
      { now: () => Date.now() + 11 * 60_000, onLoginLapsed: lapsed },
    );
    await expect(headers({ server: "notion", url: fake.url, task: {} as never })).rejects.toThrow(
      "MCP server notion: its login lapsed; run supertag mcp login notion on this host to log in again",
    );
    expect(lapsed).toHaveBeenCalledWith("notion");
    expect(logins.logins.get("notion")?.lapsedAt).toEqual(expect.any(String));
    expect([...(await lapsedMcpLogins(servers, logins))]).toEqual(["notion"]);
    // A lapsed login does not stop the host; Tasks that need the server are held instead.
    await expect(
      checkHostMcpCredentials(servers, { file: noFile, logins }),
    ).resolves.toBeUndefined();
    const requests = fake.tokenRequests.length;
    await expect(headers({ server: "notion", url: fake.url, task: {} as never })).rejects.toThrow(
      /login lapsed/u,
    );
    expect(fake.tokenRequests).toHaveLength(requests);
  });

  it("refuses to refresh at a stored token endpoint off the server's origin", async () => {
    const http = vi.fn() as unknown as typeof fetch;
    const logins = memoryLogins({
      notion: {
        url: "https://mcp.example.test/mcp",
        tokenEndpoint: "https://evil.test/token",
        clientId: "c",
        refreshToken: "r",
        loggedInAt: new Date().toISOString(),
      },
    });
    const headers = createHostMcpHeaders(
      { notion: { url: "https://mcp.example.test/mcp", auth: { oauth: true } } },
      { file: noFile, logins },
      { fetch: http },
    );
    await expect(
      headers({ server: "notion", url: "https://mcp.example.test/mcp", task: {} as never }),
    ).rejects.toThrow(/not on the server's origin/u);
    expect(http).not.toHaveBeenCalled();
  });

  it("fails host startup when the server was never logged in, naming both options", async () => {
    await expect(
      checkHostMcpCredentials(
        { notion: { url: "https://mcp.notion.com/mcp", auth: { oauth: true } } },
        { file: noFile, logins: memoryLogins() },
      ),
    ).rejects.toThrow(
      /Run supertag mcp login notion here, or run supertag mcp login notion --export on a machine with a browser and set auth: \{ oauth: \{ refreshToken: \{ env: VAR \} \} \}/u,
    );
  });
});

describe("supertag mcp list", () => {
  it("shows each server's auth form and state, never a credential", async () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    const login = (extra: Partial<McpLogin> = {}): McpLogin => ({
      url: "https://mcp.notion.com/mcp",
      tokenEndpoint: "https://mcp.notion.com/token",
      clientId: "client-1",
      refreshToken: "refresh-secret-value",
      accessToken: "access-secret-value",
      loggedInAt: "2026-10-01T00:00:00.000Z",
      ...extra,
    });
    const file = servicesFile({
      notion: { url: "https://mcp.notion.com/mcp", auth: { oauth: true } },
      linear: { url: "https://mcp.notion.com/mcp", auth: { oauth: true } },
      wiki: { url: "https://mcp.notion.com/mcp", auth: { oauth: true } },
      docs: { url: "https://mcp.notion.com/mcp", auth: { oauth: true } },
      sentry: {
        url: "https://mcp.sentry.dev/mcp",
        auth: { bearer: { env: "SENTRY_TOKEN_UNSET" } },
      },
      open: { url: "https://open.example.test/mcp" },
    });
    const text = await formatMcpList(
      file,
      memoryLogins({
        notion: login({ refreshTokenExpiresAt: Date.parse("2026-11-01T00:00:00.000Z") }),
        linear: login({ lapsedAt: "2026-10-02T11:00:00.000Z" }),
        docs: login(),
      }),
      now,
    );
    expect(text).toMatch(/^SERVICE\s+SERVER\s+URL\s+AUTH\s+STATE$/mu);
    expect(text).toMatch(/notion .*oauth login\s+logged in, expires 2026-11-01T00:00:00\.000Z/u);
    expect(text).toMatch(/docs .*oauth login\s+logged in$/mu);
    expect(text).toMatch(/linear .*login lapsed; run supertag mcp login linear/u);
    expect(text).toMatch(/wiki .*not logged in; run supertag mcp login wiki/u);
    expect(text).toMatch(/sentry .*bearer\s+missing: .*SENTRY_TOKEN_UNSET/u);
    expect(text).toMatch(/open .*none\s+ready/u);
    expect(text).not.toMatch(/secret-value|client-1/u);
  });
});

describe("held for a lapsed login", () => {
  it("advertises mcp-login:NAME instead of mcp:NAME while the login lapsed", async () => {
    let lapsed = new Set(["notion"]);
    const worklet = new HostServiceWorklet(
      "w",
      "h",
      [new StaticWorker()],
      { labels: [] },
      ["notion", "sentry"],
      async () => lapsed,
    );
    expect((await worklet.describe()).host.labels).toEqual(
      expect.arrayContaining(["mcp-login:notion", "mcp:sentry"]),
    );
    expect((await worklet.describe()).host.labels).not.toContain("mcp:notion");
    lapsed = new Set();
    expect((await worklet.describe()).host.labels).toEqual(
      expect.arrayContaining(["mcp:notion", "mcp:sentry"]),
    );
  });

  it("holds placement with the servers that need a login", () => {
    const hosts = [
      {
        id: "laptop",
        enrollmentStatus: "active" as const,
        labels: ["mcp-login:notion", "mcp:sentry"],
      },
    ];
    expect(placeByLabels(["laptop"], hosts, ["mcp:notion", "mcp:sentry"])).toEqual({
      status: "unmet",
      missingLabels: ["mcp:notion"],
      requirement: "labels:mcp:notion",
      mcpLogins: ["notion"],
    });
    expect(placeByLabels(["laptop"], hosts, ["mcp:linear"])).toEqual({
      status: "unmet",
      missingLabels: ["mcp:linear"],
      requirement: "labels:mcp:linear",
    });
  });

  it("shows the login command in the operator inbox", () => {
    const item = {
      kind: "mcp_login" as const,
      key: "mcp_login:mcp-http:task-1:notion",
      objectiveId: "obj",
      evidence: [
        {
          kind: "task" as const,
          id: "mcp-http:task-1",
          status: "queued",
          attemptCount: 0,
          updatedAt: "",
        },
      ],
    };
    expect(coordinationInboxCommands(item)).toEqual([
      "supertag mcp login notion",
      "supertag describe objective obj",
    ]);
    expect(coordinationInboxHeadline(item as never)).toBe(
      "Task mcp-http:task-1 is held until MCP server notion is logged in",
    );
  });

  it("keeps mcp-login: labels out of hand-written label lists", () => {
    for (const field of ["labels", "Tag runsOn", "Auth Key labels"])
      expect(() => parseWorkerHostLabels(["mcp-login:notion"], field)).toThrow(
        /mcp-login: labels come from host MCP logins/u,
      );
  });
});
