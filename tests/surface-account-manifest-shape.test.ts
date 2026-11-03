import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  declaredConfiguration,
  parseSurfaceAccountManifest,
  resolveSurfaceSecrets,
  sameCredential,
  verifySurfaceAccount,
} from "../apps/cli/src/surface-account-manifest.ts";

const manifest = (spec: Record<string, unknown>, name = "account") => ({
  apiVersion: "supertag/v1",
  kind: "SurfaceAccount",
  metadata: { name },
  spec,
});

describe("SurfaceAccount manifest shape", () => {
  it("fills provider defaults and normalizes API URLs, so equal inputs compare equal", () => {
    expect(
      parseSurfaceAccountManifest(
        manifest({
          provider: "slack",
          secrets: { botToken: { env: "A" }, appToken: { env: "B" } },
        }),
      ).configuration,
    ).toEqual({ transport: "socket" });
    expect(
      parseSurfaceAccountManifest(
        manifest({
          provider: "github",
          configuration: { apiBaseUrl: "https://api.github.com/" },
          secrets: { token: { env: "A" } },
        }),
      ).configuration,
    ).toEqual({ auth: "token" });
    expect(
      parseSurfaceAccountManifest(
        manifest({
          provider: "github",
          configuration: { apiBaseUrl: "https://github.example.com/api/v3/" },
          secrets: { token: { env: "A" } },
        }),
      ).configuration,
    ).toEqual({ apiBaseUrl: "https://github.example.com/api/v3", auth: "token" });
  });

  it("requires the secrets each provider and option needs, and nothing else", () => {
    const parse = (spec: Record<string, unknown>) => () =>
      parseSurfaceAccountManifest(manifest(spec));
    expect(
      parse({
        provider: "slack",
        configuration: { transport: "http" },
        secrets: { botToken: { env: "A" } },
      }),
    ).toThrow("SurfaceAccount spec.secrets is missing signingSecret");
    expect(
      parse({
        provider: "slack",
        secrets: { botToken: { env: "A" }, appToken: { env: "B" }, signingSecret: { env: "C" } },
      }),
    ).toThrow("spec.secrets.signingSecret is not used by this slack account");
    expect(
      parse({
        provider: "github",
        configuration: { auth: "app" },
        secrets: { token: { env: "A" } },
      }),
    ).toThrow("spec.configuration.appId is required for github");
    expect(
      parse({
        provider: "github",
        configuration: { appId: "1" },
        secrets: { token: { env: "A" } },
      }),
    ).toThrow("appId applies only to auth: app GitHub accounts");
    expect(parse({ provider: "lark", secrets: { appSecret: { env: "A" } } })).toThrow(
      "spec.configuration.appId is required for lark",
    );
    expect(parse({ provider: "teams", configuration: { appId: "a" }, secrets: {} })).toThrow(
      "spec.configuration.tenantId is required for teams",
    );
    expect(parse({ provider: "discord", secrets: {} })).toThrow(
      "spec.provider must be slack, github, lark, linear, teams",
    );
    expect(parse({ provider: "linear", token: "x", secrets: {} })).toThrow("unknown fields: token");
    expect(() =>
      parseSurfaceAccountManifest(manifest({ provider: "linear", secrets: {} }, "slack:T123")),
    ).toThrow("metadata.name must be 1-63 letters");
  });

  it("recovers each provider's declared options from what verification stored", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const cases: {
      spec: Record<string, unknown>;
      secrets: Record<string, string>;
      response: unknown;
    }[] = [
      {
        spec: {
          provider: "slack",
          configuration: { transport: "http" },
          secrets: { botToken: { env: "A" }, signingSecret: { env: "B" } },
        },
        secrets: { botToken: "xoxb", signingSecret: "s" },
        response: { ok: true, team: "Acme", team_id: "T1", user_id: "U1" },
      },
      {
        spec: {
          provider: "github",
          configuration: { apiBaseUrl: "https://github.example.com/api/v3" },
          secrets: { token: { env: "A" }, webhookSecret: { env: "B" } },
        },
        secrets: { token: "t", webhookSecret: "w" },
        response: { id: 7, login: "octo", type: "User" },
      },
      {
        spec: {
          provider: "github",
          configuration: { auth: "app", appId: "12", installationId: "34" },
          secrets: { privateKey: { file: "key.pem" }, webhookSecret: { env: "B" } },
        },
        secrets: { privateKey, webhookSecret: "w" },
        response: { id: 34, account: { login: "acme", id: 5, type: "Organization" } },
      },
      {
        spec: {
          provider: "linear",
          secrets: { apiKey: { env: "A" }, webhookSecret: { env: "B" } },
        },
        secrets: { apiKey: "k", webhookSecret: "w" },
        response: {
          data: {
            workspace: { id: "w1", name: "Acme", urlKey: "acme" },
            viewer: { id: "v", name: "Bot", email: "bot@example.com" },
          },
        },
      },
      {
        spec: {
          provider: "teams",
          displayName: "Acme Tenant",
          configuration: { appId: "app", tenantId: "tenant" },
          secrets: { appSecret: { env: "A" } },
        },
        secrets: { appSecret: "s" },
        response: { access_token: "x", token_type: "Bearer", expires_in: 3600 },
      },
    ];
    for (const { spec, secrets, response } of cases) {
      const parsed = parseSurfaceAccountManifest(manifest(spec));
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
      const verified = await verifySurfaceAccount(parsed, secrets, request);
      expect(verified.secrets).toEqual(secrets);
      if (parsed.displayName !== undefined) expect(verified.displayName).toBe(parsed.displayName);
      expect(declaredConfiguration(verified)).toEqual(parsed.configuration);
    }
    // Lark verification uses its SDK client; its stored options recover the same way.
    const lark = parseSurfaceAccountManifest(
      manifest({
        provider: "lark",
        configuration: { appId: "cli_1", domain: "feishu" },
        secrets: { appSecret: { env: "A" } },
      }),
    );
    expect(
      declaredConfiguration({
        provider: "lark",
        authMethod: "lark-long-connection",
        externalAccountId: "cli_1",
        configuration: { appId: "cli_1", botOpenId: "ou_1", domain: "feishu" },
      }),
    ).toEqual(lark.configuration);
  });

  it("resolves env, file, and secretRef references and names the reference on failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-surface-secrets-"));
    try {
      await writeFile(join(directory, "app.txt"), "  xapp-value\n");
      const parsed = parseSurfaceAccountManifest(
        manifest({
          provider: "slack",
          secrets: { botToken: { secretRef: "bot" }, appToken: { file: "app.txt" } },
        }),
      );
      expect(
        await resolveSurfaceSecrets(parsed, {
          baseDirectory: directory,
          resolveSecret: async (name) => `${name}-value`,
        }),
      ).toEqual({ appToken: "xapp-value", botToken: "bot-value" });
      await expect(
        resolveSurfaceSecrets(parsed, {
          baseDirectory: directory,
          resolveSecret: async () => " ",
        }),
      ).rejects.toThrow("spec.secrets.botToken: the referenced secret is empty");
      await expect(
        resolveSurfaceSecrets(parsed, {
          baseDirectory: join(directory, "missing"),
          resolveSecret: async () => "x",
        }),
      ).rejects.toThrow("spec.secrets.appToken: cannot read file app.txt (ENOENT)");
      const fromEnvironment = parseSurfaceAccountManifest(
        manifest({
          provider: "slack",
          secrets: { botToken: { env: "BOT" }, appToken: { env: "APP" } },
        }),
      );
      expect(
        await resolveSurfaceSecrets(fromEnvironment, {
          baseDirectory: directory,
          environment: { BOT: "xoxb", APP: "xapp" },
        }),
      ).toEqual({ appToken: "xapp", botToken: "xoxb" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("compares credentials by every key and value", () => {
    expect(sameCredential({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(sameCredential({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameCredential({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(sameCredential(undefined, { a: "1" })).toBe(false);
  });
});
