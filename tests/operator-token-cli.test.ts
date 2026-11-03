import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ password: vi.fn(), confirm: vi.fn() }));
// The CLI resolves the prompt library from its own package, so the mock names that copy.
vi.mock("../apps/cli/node_modules/@inquirer/prompts", () => prompts);

import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.ts";
import { resolveControlPlaneTarget } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { runOperatorTokenCommand } from "../apps/cli/src/operator-tokens.ts";
import { migrateSqlite } from "./support/database.ts";

const CONTROL_PLANE = "https://control.example.com";
const SECRET = `stop_${"b".repeat(64)}`;
const ADMIN = "operator-token-cli-admin";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  prompts.password.mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function captureOutput(): () => string {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => write.mock.calls.map(([value]) => String(value)).join("");
}

describe("Operator Token commands", () => {
  it("routes the action-first commands", () => {
    expect(normalizeActionFirstCommand(["create", "operator-token", "laptop-2"])).toEqual([
      "operator-token",
      "create",
      "laptop-2",
    ]);
    expect(normalizeActionFirstCommand(["revoke", "operator-token", "laptop-2"])).toEqual([
      "operator-token",
      "revoke",
      "laptop-2",
    ]);
    expect(normalizeActionFirstCommand(["list", "operator-token"])).toEqual([
      "get",
      "operator-token",
    ]);
  });

  it("lists the commands in help", async () => {
    const output = captureOutput();
    expect(await main(["--help"])).toBe(0);
    expect(output()).toContain("supertag create operator-token NAME");
    expect(output()).toContain("supertag revoke operator-token NAME");
    expect(output()).toContain("auth-key|operator-token|task|session");
    expect(await main(["help", "create", "operator-token"])).toBe(0);
    expect(output()).toContain("Only the admin token creates, lists, and revokes Operator Tokens");
  });

  it("creates a token, prints the secret once, and never takes a flag for it", async () => {
    const requests: { path: string; init?: RequestInit }[] = [];
    const client = {
      async request<T>(path: string, init?: RequestInit): Promise<T> {
        requests.push({ path, ...(init ? { init } : {}) });
        return {
          apiVersion: "supertag/v1",
          kind: "OperatorToken",
          metadata: { id: "t", name: path.endsWith("/revoke") ? "laptop-2" : "laptop-2" },
          spec: {},
          status: {
            phase: path.endsWith("/revoke") ? "revoked" : "active",
            operatorId: "token:laptop-2",
            expiresAt: "2026-12-30T00:00:00.000Z",
          },
          secret: SECRET,
        } as T;
      },
    };
    const output = await runOperatorTokenCommand(client, "create", ["laptop-2"], CONTROL_PLANE);
    expect(output.split(SECRET)).toHaveLength(2);
    expect(output).toContain("recorded as token:laptop-2");
    expect(output).toContain(`supertag connect control-plane ${CONTROL_PLANE}`);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      apiVersion: "supertag/v1",
      kind: "OperatorToken",
      metadata: { name: "laptop-2" },
      spec: {},
    });
    await expect(
      runOperatorTokenCommand(client, "create", ["laptop-2", "--expires", "1d"], CONTROL_PLANE),
    ).rejects.toThrow("Unknown option '--expires'");
    await expect(runOperatorTokenCommand(client, "create", [], CONTROL_PLANE)).rejects.toThrow(
      "Usage: supertag create operator-token NAME",
    );
    await expect(
      runOperatorTokenCommand(client, "revoke", ["laptop-2"], CONTROL_PLANE),
    ).resolves.toContain("Revoked Operator Token laptop-2");
    expect(requests.at(-1)?.path).toBe("/api/v1/operator-tokens/laptop-2/revoke");
  });
});

describe("a teammate connecting with an Operator Token", () => {
  async function controlPlane() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-operator-token-cli-"));
    const databasePath = join(directory, "server.db");
    await migrateSqlite(databasePath);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: ADMIN,
      coordinationOperatorCredentials: [],
      stateDirectory: join(directory, "server"),
      reply: async () => {},
    });
    cleanups.push(async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    });
    const created = await fetch(`${runtime.url}/api/v1/operator-tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "OperatorToken", metadata: { name: "laptop-2" } }),
    });
    const { secret } = (await created.json()) as { secret: string };
    return { url: runtime.url, secret, client: join(directory, "client") };
  }

  it("saves the token from SUPERTAG_OPERATOR_TOKEN and uses it for later commands", async () => {
    const { url, secret, client } = await controlPlane();
    vi.stubEnv("SUPERTAG_STATE_DIR", client);
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", "");
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", undefined);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", secret);
    const output = captureOutput();
    expect(await main(["connect", "control-plane", url])).toBe(0);
    expect(output()).toContain("This is now your active Control Plane");
    expect(prompts.password).not.toHaveBeenCalled();
    // The secret lands in the operator credential store, never in the connection registry.
    expect(await readFile(join(client, "control-planes.json"), "utf8")).not.toContain(secret);

    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "");
    expect((await resolveControlPlaneTarget())?.token).toBe(secret);
    expect(await main(["create", "tag", "reviewer"])).toBe(0);
    // Managing Operator Tokens still needs the admin token.
    await expect(main(["create", "operator-token", "laptop-3"])).rejects.toThrow(
      "Only the admin token manages Operator Tokens",
    );
  });

  it("reads the token from a masked prompt when no environment variable is set", async () => {
    const { url, secret, client } = await controlPlane();
    vi.stubEnv("SUPERTAG_STATE_DIR", client);
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", "");
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "");
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", undefined);
    prompts.password.mockResolvedValue(`  ${secret}\n`);
    captureOutput();
    expect(await main(["connect", "control-plane", url, "--name", "shared"])).toBe(0);
    expect(prompts.password).toHaveBeenCalledWith(expect.objectContaining({ mask: "*" }));
    expect((await resolveControlPlaneTarget())?.token).toBe(secret);
    await expect(main(["connect", "control-plane", url, "--token", secret])).rejects.toThrow(
      "Unknown option '--token'",
    );
  });

  it("refuses a revoked token when connecting", async () => {
    const { url, secret, client } = await controlPlane();
    await fetch(`${url}/api/v1/operator-tokens/laptop-2/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    vi.stubEnv("SUPERTAG_STATE_DIR", client);
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", "");
    vi.stubEnv("SUPERTAG_CONTROL_PLANE", undefined);
    vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", secret);
    captureOutput();
    await expect(main(["connect", "control-plane", url])).rejects.toThrow("was revoked");
  });
});
