import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMcpServer } from "../apps/cli/src/host-mcp.ts";
import {
  checkHostMcpCredentials,
  createHostMcpEnvironment,
  createHostMcpHeaders,
  helperEnvironment,
  runMcpHeadersHelper,
  workspaceMcpVariables,
} from "../apps/cli/src/host-mcp-auth.ts";
import {
  HttpMcpToolProvider,
  minimalProcessEnvironment,
  type ResolutionContext,
  startMcpPolicyProxy,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
} from "../packages/runtime/sdk/src/index.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const URL_ = "https://mcp.example.test/mcp";
const TASK = { attemptId: "attempt-1" } as TaskAttemptSpec;
const noFile = { secrets: {}, envFile: {} };

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-auth-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function rsaKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

function verifyJwt(jwt: string, publicKey: string): Record<string, unknown> {
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "RS256" });
  const verified = createVerify("SHA256")
    .update(`${header}.${payload}`)
    .verify(createPublicKey(publicKey), Buffer.from(signature, "base64url"));
  expect(verified).toBe(true);
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Fake OAuth discovery plus a token endpoint, for clientCredentials and oauth refresh. The
 * authorization server is on the MCP server's origin unless the test moves it.
 */
function fakeAuthorizationServer(
  token: (form: URLSearchParams, init: RequestInit) => Response,
  { issuer = "https://mcp.example.test/oauth", tokenEndpoint = `${issuer}/token` } = {},
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const issuerUrl = new URL(issuer);
  const http = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp")
      return json({ resource: URL_, authorization_servers: [issuer] });
    if (url === `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`)
      return json({ token_endpoint: tokenEndpoint });
    if (url === tokenEndpoint) return token(new URLSearchParams(String(init.body)), init);
    return new Response("not found", { status: 404 });
  });
  return { http: http as unknown as typeof fetch, requests };
}

describe("declarative MCP auth headers", () => {
  it("reads bearer and headers references from env, env_file, files, and secrets", async () => {
    const directory = await scratch();
    await writeFile(join(directory, "key"), "file-key\n");
    const servers: Record<string, HostMcpServer> = {
      sentry: { url: URL_, auth: { bearer: { env: "SENTRY_TOKEN" } } },
      internal: {
        url: URL_,
        auth: {
          headers: {
            "X-Api-Key": { file: join(directory, "key") },
            "X-Team": { secretRef: "team" },
            "X-Env-File": { env: "FROM_ENV_FILE" },
          },
        },
      },
      open: { url: URL_ },
    };
    const sources = {
      file: {
        secrets: { team: { environment: "TEAM_SECRET" } },
        envFile: { FROM_ENV_FILE: "env-file-value" },
      },
      environment: { SENTRY_TOKEN: "sentry-token", TEAM_SECRET: "team-secret" },
    };
    await checkHostMcpCredentials(servers, sources);
    const headers = createHostMcpHeaders(servers, sources);
    expect(await headers({ server: "sentry", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer sentry-token",
    });
    expect(await headers({ server: "internal", url: URL_, task: TASK })).toEqual({
      "X-Api-Key": "file-key",
      "X-Team": "team-secret",
      "X-Env-File": "env-file-value",
    });
    expect(await headers({ server: "open", url: URL_, task: TASK })).toEqual({});
    expect(await headers({ server: "unknown", url: URL_, task: TASK })).toEqual({});
  });

  it("fails before the host takes Tasks when a credential is missing, without values", async () => {
    const directory = await scratch();
    await writeFile(join(directory, "bad.pem"), "not-a-key-but-secret-looking");
    const servers: Record<string, HostMcpServer> = {
      sentry: { url: URL_, auth: { bearer: { env: "SENTRY_TOKEN" } } },
      notes: { url: URL_, auth: { headers: { "X-Key": { file: join(directory, "missing") } } } },
      github: {
        url: URL_,
        auth: {
          githubApp: {
            appId: 1,
            installationId: 2,
            privateKey: { file: join(directory, "bad.pem") },
          },
        },
      },
      vendor: { url: URL_, auth: { helper: [join(directory, "no-such-helper")] } },
      notion: { url: URL_, auth: { oauth: { refreshToken: { env: "NOTION_REFRESH" } } } },
      local: { url: URL_, auth: { oauth: true } },
      acme: {
        url: URL_,
        auth: { clientCredentials: { clientId: "acme", clientSecret: { env: "ACME_SECRET" } } },
      },
    };
    const failure = checkHostMcpCredentials(servers, {
      file: noFile,
      environment: { SENTRY_TOKEN: "" },
      logins: {
        read: async () => undefined,
        write: async () => undefined,
        writeIf: async () => false,
      },
    });
    await expect(failure).rejects.toThrow(/this host takes no Tasks/u);
    const message = await failure.catch((error: Error) => error.message);
    for (const expected of [
      "MCP server sentry auth.bearer reads SENTRY_TOKEN, which is not set",
      "MCP server notes auth.headers.X-Key reads",
      "MCP server github auth.githubApp.privateKey is not an RSA or EC private key",
      "MCP server vendor auth.helper runs",
      "MCP server notion auth.oauth.refreshToken reads NOTION_REFRESH",
      "MCP server local uses auth: { oauth: true } but is not logged in on this host. Run supertag mcp login local",
      "MCP server acme auth.clientCredentials.clientSecret reads ACME_SECRET",
    ])
      expect(message).toContain(expected);
    expect(message).not.toContain("not-a-key-but-secret-looking");
  });

  it("mints a GitHub App installation token per Task Attempt and on refetch", async () => {
    const { privateKey, publicKey } = rsaKey();
    const directory = await scratch();
    await writeFile(join(directory, "app.pem"), privateKey);
    const jwts: string[] = [];
    let issued = 0;
    const http = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      expect(String(input)).toBe("https://github.fake/app/installations/7890123/access_tokens");
      expect(init.method).toBe("POST");
      const authorization = new Headers(init.headers).get("authorization") ?? "";
      jwts.push(authorization.replace(/^Bearer /u, ""));
      issued += 1;
      return json({ token: `ghs_installation_${issued}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
    }) as unknown as typeof fetch;
    const servers: Record<string, HostMcpServer> = {
      github: {
        url: URL_,
        preset: "github",
        auth: {
          githubApp: {
            appId: 123456,
            installationId: 7890123,
            privateKey: { file: join(directory, "app.pem") },
          },
        },
      },
    };
    await checkHostMcpCredentials(servers, { file: noFile });
    const now = 1_800_000_000_000;
    const headers = createHostMcpHeaders(
      servers,
      { file: noFile },
      { fetch: http, githubApiUrl: "https://github.fake/", now: () => now },
    );
    expect(await headers({ server: "github", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer ghs_installation_1",
    });
    expect(
      await headers({
        server: "github",
        url: URL_,
        task: { attemptId: "attempt-2" } as TaskAttemptSpec,
      }),
    ).toEqual({ Authorization: "Bearer ghs_installation_2" });
    expect(await headers({ server: "github", url: URL_, task: TASK, refresh: true })).toEqual({
      Authorization: "Bearer ghs_installation_3",
    });
    const claims = verifyJwt(jwts[0] as string, publicKey);
    expect(claims).toEqual({ iss: "123456", iat: now / 1000 - 60, exp: now / 1000 + 480 });
  });

  it("gets a client-credentials token with a client secret, for the server as resource", async () => {
    const { http, requests } = fakeAuthorizationServer((form, init) => {
      expect(form.get("grant_type")).toBe("client_credentials");
      expect(form.get("resource")).toBe(URL_);
      expect(form.get("scope")).toBe("mcp:tools");
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("acme-client:s3cret").toString("base64")}`,
      );
      return json({ access_token: "cc-token", token_type: "Bearer", expires_in: 600 });
    });
    const servers: Record<string, HostMcpServer> = {
      acme: {
        url: URL_,
        auth: {
          clientCredentials: {
            clientId: { env: "ACME_ID" },
            clientSecret: { env: "ACME_SECRET" },
            scope: "mcp:tools",
          },
        },
      },
    };
    const sources = {
      file: noFile,
      environment: { ACME_ID: "acme-client", ACME_SECRET: "s3cret" },
    };
    const headers = createHostMcpHeaders(servers, sources, { fetch: http });
    expect(await headers({ server: "acme", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer cc-token",
    });
    // Discovery is cached; the token is fetched again for the next Attempt.
    await headers({ server: "acme", url: URL_, task: TASK, refresh: true });
    expect(requests.filter((request) => request.url.includes("well-known"))).toHaveLength(2);
    expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
  });

  it("gets a client-credentials token with a signed JWT client assertion", async () => {
    const { privateKey, publicKey } = rsaKey();
    const directory = await scratch();
    await writeFile(join(directory, "acme.pem"), privateKey);
    const { http } = fakeAuthorizationServer((form) => {
      expect(form.get("client_id")).toBe("acme");
      expect(form.get("client_assertion_type")).toBe(
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      const claims = verifyJwt(form.get("client_assertion") as string, publicKey);
      expect(claims).toMatchObject({
        iss: "acme",
        sub: "acme",
        aud: "https://mcp.example.test/oauth/token",
      });
      expect(typeof claims["jti"]).toBe("string");
      return json({ access_token: "assertion-token", token_type: "bearer" });
    });
    const headers = createHostMcpHeaders(
      {
        acme: {
          url: URL_,
          auth: {
            clientCredentials: {
              clientId: "acme",
              assertionKey: { file: join(directory, "acme.pem") },
            },
          },
        },
      },
      { file: noFile },
      { fetch: http },
    );
    expect(await headers({ server: "acme", url: URL_, task: TASK })).toEqual({
      Authorization: "Bearer assertion-token",
    });
  });

  it("reports a failed token request by status only", async () => {
    const { http } = fakeAuthorizationServer(() => json({ error: "bad", echoed: "s3cret" }, 400));
    const headers = createHostMcpHeaders(
      {
        acme: {
          url: URL_,
          auth: { clientCredentials: { clientId: "acme", clientSecret: { env: "S" } } },
        },
      },
      { file: noFile, environment: { S: "s3cret" } },
      { fetch: http },
    );
    const failure = await Promise.resolve(headers({ server: "acme", url: URL_, task: TASK })).catch(
      (error: Error) => error.message,
    );
    expect(failure).toBe("MCP server acme: token request failed with HTTP 400");
  });

  it("refreshes an OAuth access token, caches it, and keeps a rotated refresh token", async () => {
    let issued = 0;
    const seen: string[] = [];
    const { http } = fakeAuthorizationServer((form) => {
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("resource")).toBe(URL_);
      seen.push(`${form.get("refresh_token")}|${form.get("client_id")}`);
      issued += 1;
      return json({
        access_token: `access-${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `rotated-${issued}`,
      });
    });
    const headers = createHostMcpHeaders(
      { notion: { url: URL_, auth: { oauth: { refreshToken: { env: "NOTION_REFRESH" } } } } },
      {
        file: noFile,
        environment: {
          NOTION_REFRESH: JSON.stringify({ refresh_token: "initial", client_id: "client-1" }),
        },
      },
      { fetch: http },
    );
    const request = { server: "notion", url: URL_, task: TASK };
    expect(await headers(request)).toEqual({ Authorization: "Bearer access-1" });
    expect(await headers(request)).toEqual({ Authorization: "Bearer access-1" });
    expect(await headers({ ...request, refresh: true })).toEqual({
      Authorization: "Bearer access-2",
    });
    expect(seen).toEqual(["initial|client-1", "rotated-1|client-1"]);
  });

  it("refreshes an OAuth refresh token once for concurrent 401s", async () => {
    let issued = 0;
    const valid = new Set(["initial"]);
    const seen: string[] = [];
    const { http } = fakeAuthorizationServer((form) => {
      const presented = form.get("refresh_token") as string;
      seen.push(presented);
      // A rotating server accepts each refresh token once.
      if (!valid.delete(presented)) return json({ error: "invalid_grant" }, 400);
      issued += 1;
      valid.add(`rotated-${issued}`);
      return json({
        access_token: `access-${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `rotated-${issued}`,
      });
    });
    const headers = createHostMcpHeaders(
      { notion: { url: URL_, auth: { oauth: { refreshToken: { env: "NOTION_REFRESH" } } } } },
      { file: noFile, environment: { NOTION_REFRESH: "initial" } },
      { fetch: http },
    );
    const request = { server: "notion", url: URL_, task: TASK, refresh: true };
    const results = await Promise.all([headers(request), headers(request), headers(request)]);
    expect(results).toEqual(Array(3).fill({ Authorization: "Bearer access-1" }));
    expect(seen).toEqual(["initial"]);
  });

  it("runs host helpers with the host environment and repository helpers without credentials", async () => {
    const directory = await scratch();
    const helper = join(directory, "helper.mjs");
    await writeFile(
      helper,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  "X-Token": process.env.VENDOR_TOKEN ?? "none",
  "X-Visible": process.env.VISIBLE ?? "none",
  "X-Arg": process.argv[2] ?? "none",
}));
`,
    );
    await chmod(helper, 0o755);
    const environment = {
      PATH: process.env["PATH"],
      VENDOR_TOKEN: "vendor-secret",
      VISIBLE: "yes",
    };
    const servers: Record<string, HostMcpServer> = {
      vendor: { url: URL_, auth: { helper: [helper, "vendor"] } },
    };
    await checkHostMcpCredentials(servers, { file: noFile, environment });
    const headers = createHostMcpHeaders(servers, { file: noFile, environment });
    expect(await headers({ server: "vendor", url: URL_, task: TASK })).toEqual({
      "X-Token": "vendor-secret",
      "X-Visible": "yes",
      "X-Arg": "vendor",
    });
    expect(
      await runMcpHeadersHelper("repo", [helper, "repo"], { trusted: false, environment }),
    ).toEqual({ "X-Token": "none", "X-Visible": "yes", "X-Arg": "repo" });
    const scrubbed = helperEnvironment(
      {
        GITHUB_TOKEN: "a",
        AWS_SECRET_ACCESS_KEY: "b",
        DB_PASSWORD: "c",
        OPENAI_API_KEY: "d",
        SUPERTAG_AUTH_KEY: "e",
        HOME: "/home/me",
      },
      false,
    );
    expect(scrubbed).toEqual({ HOME: "/home/me" });
  });

  it("runs repository helpers without connection-string or userinfo URL variables", () => {
    const environment = {
      DATABASE_URL: "postgres://app:hunter2@db.internal/app",
      MONGO_URL: "mongodb://db.internal/app",
      MONGODB_URI: "mongodb+srv://u:p@cluster.example/app",
      REDIS_URL: "redis://:pw@cache.internal:6379",
      AMQP_URL: "amqp://guest:guest@mq.internal",
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
      UPSTREAM: "https://user:pass@proxy.internal:8080",
      HTTPS_PROXY: "http://proxy-user@proxy.internal:3128",
      PUBLIC_DOCS_URL: "https://docs.example.com/path?q=@x",
      NO_PROXY: "localhost",
      HOME: "/home/me",
    };
    expect(helperEnvironment(environment, false)).toEqual({
      PUBLIC_DOCS_URL: "https://docs.example.com/path?q=@x",
      NO_PROXY: "localhost",
      HOME: "/home/me",
    });
    expect(helperEnvironment(environment, true)).toEqual(environment);
  });

  it("rejects helper output that is not a JSON object of strings, without echoing it", async () => {
    const directory = await scratch();
    const helper = join(directory, "bad.sh");
    await writeFile(helper, "#!/bin/sh\necho 'leaked-secret-value'\n");
    await chmod(helper, 0o755);
    const failure = await runMcpHeadersHelper("vendor", [helper], { trusted: true }).catch(
      (error: Error) => error.message,
    );
    expect(failure).toContain("must print a JSON object");
    expect(failure).not.toContain("leaked-secret-value");
  });
});

describe("auth through the per-Task policy proxy", () => {
  it("never shows credentials to the harness: proxy URL, tool list, and process environment", async () => {
    const upstream = await startAuthenticatedMcpServer(() => "Bearer host-only-token");
    const headers = createHostMcpHeaders(
      { fake: { url: upstream.url, auth: { bearer: { env: "FAKE_MCP_TOKEN" } } } },
      { file: noFile, environment: { FAKE_MCP_TOKEN: "host-only-token" } },
    );
    const input = await resolveOne(upstream.url, headers);
    const { client, proxyUrl } = await connectThroughProxy(input);
    expect(proxyUrl).not.toContain("host-only-token");
    const listed = JSON.stringify(await client.listTools());
    expect(listed).not.toContain("host-only-token");
    const result = (await client.callTool({ name: "whoami", arguments: {} })) as {
      content: { text: string }[];
    };
    expect(result.content[0]?.text).toBe("ok");
    expect(upstream.authorizations.every((value) => value === "Bearer host-only-token")).toBe(true);
    // The harness and its shell start from an allowlisted environment.
    const harnessEnvironment = minimalProcessEnvironment({
      PATH: "/usr/bin",
      FAKE_MCP_TOKEN: "host-only-token",
      SENTRY_TOKEN: "x",
    });
    expect(Object.values(harnessEnvironment)).not.toContain("host-only-token");
    expect(harnessEnvironment).not.toHaveProperty("SENTRY_TOKEN");
  });

  it("refetches credentials and retries once after a 401", async () => {
    let accepted = "Bearer token-1";
    const upstream = await startAuthenticatedMcpServer(() => accepted);
    let generation = 0;
    const hook = vi.fn(async () => {
      generation += 1;
      return { Authorization: `Bearer token-${generation}` };
    });
    const input = await resolveOne(upstream.url, hook);
    expect(hook).toHaveBeenCalledTimes(1);
    const { client } = await connectThroughProxy(input);
    accepted = "Bearer token-2";
    const before = upstream.authorizations.length;
    const result = (await client.callTool({ name: "whoami", arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[1]?.[0]).toMatchObject({ server: "fake", refresh: true });
    expect(upstream.calls).toHaveBeenCalledTimes(1);
    const after = upstream.authorizations.slice(before);
    expect(after).toContain("Bearer token-1");
    expect(after.at(-1)).toBe("Bearer token-2");
  });

  it("retries exactly once when the refetched credentials are refused too (403)", async () => {
    let accepted = "Bearer token-1";
    const upstream = await startAuthenticatedMcpServer(() => accepted, 403);
    let generation = 0;
    const hook = vi.fn(async () => {
      generation += 1;
      return { Authorization: `Bearer token-${generation}` };
    });
    const input = await resolveOne(upstream.url, hook);
    const { client } = await connectThroughProxy(input);
    accepted = "Bearer never";
    const before = upstream.rejected;
    const result = (await client
      .callTool({ name: "whoami", arguments: {} })
      .catch((error: Error) => ({ isError: true, error }))) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(upstream.rejected - before).toBe(2);
    expect(upstream.calls).not.toHaveBeenCalled();
  });

  it("retries tool listing once when the server refuses the first credentials", async () => {
    const upstream = await startAuthenticatedMcpServer(() => "Bearer token-2");
    let generation = 0;
    const hook = vi.fn(async () => {
      generation += 1;
      return { Authorization: `Bearer token-${generation}` };
    });
    const input = await resolveOne(upstream.url, hook);
    expect(input.capability.operations.map((operation) => operation.name)).toEqual(["whoami"]);
    expect(hook).toHaveBeenCalledTimes(2);
  });
});

async function resolveOne(
  url: string,
  headers: ConstructorParameters<typeof HttpMcpToolProvider>[0]["headers"],
): Promise<ToolInput> {
  const provider = new HttpMcpToolProvider({
    servers: { fake: { url } },
    ...(headers === undefined ? {} : { headers }),
  });
  const [input] = await new ToolProviderRegistry([provider]).resolve({
    task: {
      attemptId: "attempt-1",
      authorization: { mcp: [{ action: "fake/whoami" }] },
    },
  } as unknown as ResolutionContext);
  return input as ToolInput;
}

async function connectThroughProxy(input: ToolInput) {
  const proxy = await startMcpPolicyProxy(input);
  cleanups.push(() => proxy.close());
  const client = new Client({ name: "harness", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(proxy.url), {
      requestInit: { headers: proxy.headers },
    }),
  );
  cleanups.push(() => client.close());
  return { client, proxyUrl: proxy.url };
}

/** A fake MCP server that answers only requests carrying the currently accepted credential. */
async function startAuthenticatedMcpServer(accepted: () => string, refusal = 401) {
  const calls = vi.fn();
  const authorizations: string[] = [];
  const state = { rejected: 0 };
  const app = createMcpExpressApp();
  app.post("/mcp", async (request, response) => {
    const authorization = String(request.headers.authorization ?? "");
    authorizations.push(authorization);
    if (authorization !== accepted()) {
      state.rejected += 1;
      response.status(refusal).json({ error: "unauthorized" });
      return;
    }
    const protocol = new McpProtocolServer(
      { name: "fake-upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "whoami", inputSchema: { type: "object", additionalProperties: true } }],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls(params.name);
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await protocol.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      void transport.close();
      void protocol.close();
    });
  });
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    authorizations,
    get rejected() {
      return state.rejected;
    },
  };
}

describe("stdio server environment", () => {
  const servers: Record<string, HostMcpServer> = {
    db: {
      command: [process.execPath, "server.mjs"],
      env: { DATABASE_URL: { env: "ACME_DB_URL" }, API_KEY: { secretRef: "db-key" } },
    },
  };
  const file = { secrets: { "db-key": { environment: "DB_KEY" } }, envFile: {} };

  it("resolves env references for the server process only", async () => {
    const environment = { ACME_DB_URL: "postgres://app:pw@db/app", DB_KEY: "key-value" };
    const hook = createHostMcpEnvironment(servers, { file, environment } as never);
    expect(await hook({ server: "db", task: TASK })).toEqual({
      DATABASE_URL: "postgres://app:pw@db/app",
      API_KEY: "key-value",
    });
    expect(await hook({ server: "other", task: TASK })).toEqual({});
    // HTTP servers get no environment, and stdio servers get no headers.
    expect(
      await createHostMcpHeaders(servers, { file, environment } as never)({
        server: "db",
        url: "",
        task: TASK,
      }),
    ).toEqual({});
  });

  it("fails before the host takes Tasks when a reference or the command is missing", async () => {
    const failure = checkHostMcpCredentials(
      { ...servers, gone: { command: [join(tmpdir(), "supertag-no-such-mcp")] } },
      { file, environment: { DB_KEY: "key-value" } } as never,
    );
    await expect(failure).rejects.toThrow(/MCP server db env\.DATABASE_URL reads ACME_DB_URL/u);
    await expect(failure).rejects.toThrow(/MCP server gone command runs .*not executable/u);
    await expect(failure).rejects.not.toThrow(/key-value/u);
  });

  it("lets trusted host servers reference any variable, unlike a Workspace .mcp.json", async () => {
    const host: Record<string, HostMcpServer> = {
      github: {
        command: [process.execPath, "server.mjs"],
        env: { TOKEN: { env: "GITHUB_TOKEN" }, KEY: { env: "SUPERTAG_AUTH_KEY" } },
      },
    };
    const environment = { GITHUB_TOKEN: "github-value", SUPERTAG_AUTH_KEY: "stak_value" };
    expect(
      await createHostMcpEnvironment(host, { file: noFile, environment } as never)({
        server: "github",
        task: TASK,
      }),
    ).toEqual({ TOKEN: "github-value", KEY: "stak_value" });
  });

  it("offers a Workspace .mcp.json only SUPERTAG_MCP_ variables, from env and env_file", () => {
    expect(
      workspaceMcpVariables({
        file: { secrets: {}, envFile: { SUPERTAG_MCP_SENTRY: "file", SUPERTAG_MCP_DB: "file" } },
        environment: {
          SUPERTAG_MCP_SENTRY: "environment",
          GITHUB_TOKEN: "github-value",
          SUPERTAG_AUTH_KEY: "stak_value",
          SUPERTAG_MCP_EMPTY: "",
        },
      }),
    ).toEqual({ SUPERTAG_MCP_SENTRY: "environment", SUPERTAG_MCP_DB: "file" });
  });
});
