import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import {
  DrizzleStore,
  FileCredentialStore,
  FileGatewayCredentialVault,
} from "../packages/store/src/index.ts";
import {
  verifyGitHubAppAccount,
  verifyGitHubTokenAccount,
} from "../packages/surfaces/github/src/index.ts";
import { verifySlackAccount } from "../packages/surfaces/slack/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

describe("surface setup", () => {
  it("verifies a Slack Socket Mode account without exposing credentials in metadata", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          team: "Acme",
          team_id: "T123",
          user: "supertag",
          user_id: "U123",
          bot_id: "B123",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, url: "wss://example.invalid" }));

    const account = await verifySlackAccount(
      { transport: "socket", botToken: "xoxb-secret", appToken: "xapp-secret" },
      request,
    );

    expect(account).toMatchObject({
      provider: "slack",
      externalAccountId: "T123",
      displayName: "Acme",
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket", botId: "B123", botUserId: "U123" },
    });
    expect(JSON.stringify(account.configuration)).not.toContain("secret");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("verifies a GitHub token without exposing it in account metadata", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 123,
        login: "octocat",
        type: "User",
      }),
    );

    const account = await verifyGitHubTokenAccount({ token: "github_pat_secret" }, request);

    expect(account).toMatchObject({
      provider: "github",
      externalAccountId: "user-123",
      displayName: "octocat",
      authMethod: "github-token",
      configuration: { accountId: "123", accountLogin: "octocat", accountType: "User" },
      secrets: { token: "github_pat_secret" },
    });
    expect(JSON.stringify(account.configuration)).not.toContain("github_pat_secret");
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer github_pat_secret");
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("retains an optional repository webhook secret with GitHub token credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 123,
        login: "octocat",
        type: "User",
      }),
    );

    const account = await verifyGitHubTokenAccount(
      { token: "github_pat_secret", webhookSecret: "repository-webhook-secret" },
      request,
    );

    expect(account.secrets).toEqual({
      token: "github_pat_secret",
      webhookSecret: "repository-webhook-secret",
    });
    expect(JSON.stringify(account.configuration)).not.toContain("repository-webhook-secret");
  });

  it("verifies an advanced GitHub App installation with a signed app JWT", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 456,
        account: { id: 123, login: "acme", type: "User" },
        repository_selection: "selected",
        permissions: { contents: "read", issues: "write" },
      }),
    );

    const account = await verifyGitHubAppAccount(
      {
        appId: "42",
        installationId: "456",
        privateKey,
        webhookSecret: "webhook-secret",
      },
      request,
      () => new Date("2026-07-31T00:00:00.000Z"),
    );

    expect(account).toMatchObject({
      provider: "github",
      externalAccountId: "installation-456",
      displayName: "acme",
      authMethod: "github-app",
    });
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });

  it("stores credentials in a user-only file behind a logical identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-secrets-"));
    const path = join(directory, "credentials", "secrets.json");
    const store = new FileGatewayCredentialVault(path);

    try {
      await store.store("surface/slack/T123", { botToken: "xoxb-secret" });
      await expect(store.resolve("surface/slack/T123")).resolves.toEqual({
        botToken: "xoxb-secret",
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await store.delete("surface/slack/T123");
      await expect(store.resolve("surface/slack/T123")).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the configured state directory for the credential path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-invocation-directory-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, ".supertag"));

    try {
      const store = new FileGatewayCredentialVault();
      await store.store("surface/slack/T123", { botToken: "xoxb-secret" });

      const path = join(directory, ".supertag", "credentials.json");
      await expect(readFile(path, "utf8")).resolves.toContain("surface/slack/T123");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps Gateway and operator credentials in separate sections of one file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-credential-sections-"));
    const path = join(directory, "credentials.json");
    const gateway = new FileCredentialStore("gateway", path);
    const operator = new FileCredentialStore("operator", path);

    try {
      await Promise.all([
        gateway.store("surface/slack/T123", { botToken: "xoxb-secret" }),
        operator.store("control-plane/local-admin", { token: "admin-secret" }),
      ]);

      await expect(gateway.resolve("surface/slack/T123")).resolves.toEqual({
        botToken: "xoxb-secret",
      });
      await expect(operator.resolve("control-plane/local-admin")).resolves.toEqual({
        token: "admin-secret",
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        version: 2,
        gateway: { "surface/slack/T123": { botToken: "xoxb-secret" } },
        operator: { "control-plane/local-admin": { token: "admin-secret" } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists only surface metadata and a provider-neutral credential identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-surface-account-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const credentialVault = new FileGatewayCredentialVault(join(directory, "secrets.json"));
    const controlPlane = new ControlPlane({ store, credentialVault });

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "slack",
        externalAccountId: "T123",
        displayName: "Acme",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-secret" },
      });

      expect(account).toMatchObject({
        provider: "slack",
        externalAccountId: "T123",
        credentialId: "surface/slack/T123",
      });
      expect(JSON.stringify(account)).not.toContain("xoxb-secret");
      await expect(credentialVault.resolve("surface/slack/T123")).resolves.toEqual({
        botToken: "xoxb-secret",
      });
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const postgresqlUrl = process.env["SUPERTAG_POSTGRES_URL"];
describe.runIf(postgresqlUrl !== undefined)("PostgreSQL surface setup", () => {
  it("persists the same surface-account contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-postgres-secrets-"));
    const store = new DrizzleStore({ url: postgresqlUrl });
    const credentialVault = new FileGatewayCredentialVault(join(directory, "secrets.json"));
    const controlPlane = new ControlPlane({ store, credentialVault });

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "slack",
        externalAccountId: "T_POSTGRES_TEST",
        displayName: "PostgreSQL Test",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-postgres-secret" },
      });
      expect(account).toMatchObject({
        provider: "slack",
        externalAccountId: "T_POSTGRES_TEST",
        credentialId: "surface/slack/T_POSTGRES_TEST",
      });
      expect(JSON.stringify(account)).not.toContain("xoxb-postgres-secret");
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
