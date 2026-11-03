import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMcpServer } from "../apps/cli/src/host-mcp.ts";
import { createHostMcpHeaders } from "../apps/cli/src/host-mcp-auth.ts";
import {
  HttpMcpToolProvider,
  type ResolutionContext,
  type TaskAttemptSpec,
  ToolProviderRegistry,
} from "../packages/runtime/sdk/src/index.ts";

/**
 * Token requests carry client secrets and refresh tokens, so they go only to a token endpoint on
 * the MCP server's origin or one configured in supertag.yaml, and never follow a redirect. Tool
 * discovery failures are Task-visible, so they never carry the server's response text.
 */

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const URL_ = "https://mcp.example.test/mcp";
const TASK = { attemptId: "attempt-1" } as TaskAttemptSpec;
const noFile = { secrets: {}, envFile: {} };
const SECRET = "client-s3cret-value";
const REFRESH = "refresh-t0ken-value";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake network: OAuth discovery on the MCP origin advertising `tokenEndpoint`, plus routes. */
function fakeNetwork(
  tokenEndpoint: string,
  routes: Record<string, (init: RequestInit) => Response> = {},
) {
  const requests: Recorded[] = [];
  const http = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp")
      return json({ resource: URL_, authorization_servers: ["https://mcp.example.test"] });
    if (url === "https://mcp.example.test/.well-known/oauth-authorization-server")
      return json({ token_endpoint: tokenEndpoint });
    const route = routes[url];
    if (route !== undefined) return route(init);
    return new Response("not found", { status: 404 });
  });
  const posts = () => requests.filter((request) => request.init.method === "POST");
  return { http: http as unknown as typeof fetch, requests, posts };
}

const token = () => json({ access_token: "access-1", token_type: "Bearer", expires_in: 600 });

function clientCredentials(tokenUrl?: string): Record<string, HostMcpServer> {
  return {
    acme: {
      url: URL_,
      auth: {
        clientCredentials: {
          clientId: "acme",
          clientSecret: { env: "ACME_SECRET" },
          ...(tokenUrl === undefined ? {} : { tokenUrl }),
        },
      },
    },
  };
}

function oauth(tokenUrl?: string): Record<string, HostMcpServer> {
  return {
    notion: {
      url: URL_,
      auth: {
        oauth: {
          refreshToken: { env: "REFRESH" },
          ...(tokenUrl === undefined ? {} : { tokenUrl }),
        },
      },
    },
  };
}

const environment = { ACME_SECRET: SECRET, REFRESH };

async function failure(promise: unknown): Promise<string> {
  return Promise.resolve(promise).then(
    () => "resolved",
    (error: Error) => error.message,
  );
}

function expectNoSecretSent(requests: readonly Recorded[], host: string) {
  for (const request of requests.filter((entry) => new URL(entry.url).host === host)) {
    expect(String(request.init.body ?? "")).not.toContain(REFRESH);
    expect(new Headers(request.init.headers).get("authorization")).toBeNull();
  }
}

describe("token endpoint pinning", () => {
  it("refuses a client-credentials token endpoint the metadata puts on another origin", async () => {
    const network = fakeNetwork("https://evil.example.test/token", {
      "https://evil.example.test/token": token,
    });
    const headers = createHostMcpHeaders(
      clientCredentials(),
      { file: noFile, environment },
      { fetch: network.http },
    );
    const message = await failure(headers({ server: "acme", url: URL_, task: TASK }));
    expect(message).toBe(
      "MCP server acme: its OAuth metadata names a token endpoint on another origin than the server; set the authorization server's token endpoint as tokenUrl under its auth in supertag.yaml to trust it",
    );
    expect(message).not.toContain("evil");
    expect(network.posts()).toEqual([]);
    expectNoSecretSent(network.requests, "evil.example.test");
  });

  it("refuses an oauth refresh-token endpoint on another origin, even one the stored token names", async () => {
    const network = fakeNetwork("https://evil.example.test/token", {
      "https://evil.example.test/token": token,
      "https://other.example.test/token": token,
    });
    const headers = createHostMcpHeaders(
      oauth(),
      {
        file: noFile,
        environment: {
          REFRESH: JSON.stringify({
            refresh_token: REFRESH,
            token_endpoint: "https://other.example.test/token",
          }),
        },
      },
      { fetch: network.http },
    );
    const message = await failure(headers({ server: "notion", url: URL_, task: TASK }));
    expect(message).toMatch(
      /^MCP server notion: its OAuth metadata names a token endpoint on another origin/u,
    );
    expect(message).not.toMatch(/evil\.example|other\.example/u);
    expect(network.posts()).toEqual([]);
  });

  it("uses a same-origin token endpoint from the metadata", async () => {
    const network = fakeNetwork("https://mcp.example.test/oauth/token", {
      "https://mcp.example.test/oauth/token": token,
    });
    const headers = createHostMcpHeaders(
      { ...clientCredentials(), ...oauth() },
      { file: noFile, environment },
      { fetch: network.http },
    );
    expect(await headers({ server: "acme", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer access-1",
    });
    expect(await headers({ server: "notion", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer access-1",
    });
    expect(network.posts().map((request) => request.url)).toEqual([
      "https://mcp.example.test/oauth/token",
      "https://mcp.example.test/oauth/token",
    ]);
  });

  it("uses a tokenUrl from supertag.yaml on another origin without consulting metadata", async () => {
    const network = fakeNetwork("https://evil.example.test/token", {
      "https://idp.example.test/oauth/token": (init) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("resource")).toBe(URL_);
        return token();
      },
    });
    const headers = createHostMcpHeaders(
      {
        ...clientCredentials("https://idp.example.test/oauth/token"),
        ...oauth("https://idp.example.test/oauth/token"),
      },
      { file: noFile, environment },
      { fetch: network.http },
    );
    expect(await headers({ server: "acme", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer access-1",
    });
    expect(await headers({ server: "notion", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer access-1",
    });
    expect(network.requests.map((request) => request.url)).toEqual([
      "https://idp.example.test/oauth/token",
      "https://idp.example.test/oauth/token",
    ]);
  });
});

describe("token requests never follow redirects", () => {
  const redirect = () =>
    new Response(null, { status: 307, headers: { location: "https://evil.example.test/token" } });

  for (const [form, servers, server] of [
    ["clientCredentials", clientCredentials("https://idp.example.test/token"), "acme"],
    ["oauth refreshToken", oauth("https://idp.example.test/token"), "notion"],
  ] as const)
    it(`refuses a redirected ${form} token request`, async () => {
      const network = fakeNetwork("https://mcp.example.test/token", {
        "https://idp.example.test/token": redirect,
        "https://evil.example.test/token": token,
      });
      const headers = createHostMcpHeaders(
        servers,
        { file: noFile, environment },
        { fetch: network.http },
      );
      const message = await failure(headers({ server, url: URL_, task: TASK }));
      expect(message).toMatch(
        new RegExp(
          `^MCP server ${server}: the token (refresh )?request was redirected; SuperTag does not follow redirects for token requests$`,
          "u",
        ),
      );
      expect(network.posts()).toHaveLength(1);
      expect(network.posts()[0]?.init.redirect).toBe("manual");
      expect(network.requests.some((request) => request.url.includes("evil"))).toBe(false);
    });

  it("refuses a redirected GitHub App installation token request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-pin-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await writeFile(join(directory, "app.pem"), privateKey);
    const network = fakeNetwork("https://mcp.example.test/token", {
      "https://github.fake/app/installations/2/access_tokens": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }),
    });
    const headers = createHostMcpHeaders(
      {
        github: {
          url: URL_,
          auth: {
            githubApp: {
              appId: 1,
              installationId: 2,
              privateKey: { file: join(directory, "app.pem") },
            },
          },
        },
      },
      { file: noFile },
      { fetch: network.http, githubApiUrl: "https://github.fake" },
    );
    expect(await failure(headers({ server: "github", url: URL_, task: TASK }))).toBe(
      "MCP server github: the GitHub App installation token request was redirected; SuperTag does not follow redirects for token requests",
    );
    expect(network.posts()[0]?.init.redirect).toBe("manual");
    expect(network.requests).toHaveLength(1);
  });

  it("refuses a redirect from a real token endpoint over the network", async () => {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? "");
      if (request.url === "/token") {
        response.writeHead(307, { location: "/elsewhere" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "leaked", token_type: "Bearer" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => closeServer(server));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    const headers = createHostMcpHeaders(
      clientCredentials(`http://127.0.0.1:${address.port}/token`),
      { file: noFile, environment },
    );
    expect(await failure(headers({ server: "acme", url: URL_, task: TASK }))).toMatch(
      /token request was redirected/u,
    );
    expect(hits).toEqual(["/token"]);
  });
});

describe("tool discovery failures", () => {
  it("report only the server name and HTTP status, never the response or header values", async () => {
    const credential = "Bearer discovery-secret-token";
    const apiKey = "api-key-secret-value";
    const server = createServer((request, response) => {
      request.resume();
      // A server that echoes what it was sent, as some error pages do.
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(
        `internal error for ${String(request.headers.authorization)} ${String(request.headers["x-api-key"])}`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => closeServer(server));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    {
      const provider = new HttpMcpToolProvider({
        servers: { acme: { url } },
        headers: async () => ({ Authorization: credential, "X-Api-Key": apiKey }),
        listTimeoutMs: 5_000,
      });
      const message = await failure(
        new ToolProviderRegistry([provider]).resolve({
          task: { attemptId: "attempt-1", authorization: { mcp: [{ action: "acme/whoami" }] } },
        } as unknown as ResolutionContext),
      );
      expect(message).toBe("Could not list the tools of MCP server acme: HTTP 500");
      for (const secret of [credential, "discovery-secret-token", apiKey, "internal error"])
        expect(message).not.toContain(secret);
    }
  });

  it("report an unreachable server by name only", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address");
    await closeServer(server);
    const provider = new HttpMcpToolProvider({
      servers: { acme: { url: `http://127.0.0.1:${address.port}/mcp` } },
      headers: async () => ({ Authorization: "Bearer unreachable-secret" }),
      listTimeoutMs: 5_000,
    });
    const message = await failure(
      new ToolProviderRegistry([provider]).resolve({
        task: { attemptId: "attempt-1", authorization: { mcp: [{ action: "acme/whoami" }] } },
      } as unknown as ResolutionContext),
    );
    expect(message).toBe("Could not list the tools of MCP server acme");
  });
});

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
