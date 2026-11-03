import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { VaultGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const vaultAddress = process.env["SUPERTAG_TEST_VAULT_ADDR"];
const vaultToken = process.env["SUPERTAG_TEST_VAULT_TOKEN"];

describe("Vault credential provider configuration", () => {
  it("requires TLS for non-loopback services", () => {
    expect(
      () => new VaultGatewayCredentialVault({ address: "http://vault.example.com", token: "test" }),
    ).toThrow("Non-loopback Vault addresses must use HTTPS");
  });
});

describe.runIf(vaultAddress !== undefined && vaultToken !== undefined)(
  "HashiCorp Vault credential provider",
  () => {
    it("stores, rotates, resolves, deletes, and redacts Gateway credentials", async () => {
      const vault = new VaultGatewayCredentialVault({
        address: required(vaultAddress),
        token: required(vaultToken),
        mount: "supertag",
        pathPrefix: "validation",
      });
      const credentialId = `surface/slack/test-${crypto.randomUUID()}`;

      await expect(vault.resolve(credentialId)).resolves.toBeUndefined();
      await vault.store(credentialId, { botToken: "vault-v1", signingSecret: "signing-v1" });
      await expect(vault.resolve(credentialId)).resolves.toEqual({
        botToken: "vault-v1",
        signingSecret: "signing-v1",
      });
      await vault.store(credentialId, { botToken: "vault-v2", signingSecret: "signing-v2" });
      await expect(vault.resolve(credentialId)).resolves.toEqual({
        botToken: "vault-v2",
        signingSecret: "signing-v2",
      });
      await vault.delete(credentialId);
      await expect(vault.resolve(credentialId)).resolves.toBeUndefined();
    });

    it("fails closed without returning Vault response bodies", async () => {
      const denied = new VaultGatewayCredentialVault({
        address: required(vaultAddress),
        token: "invalid-validation-token",
        mount: "supertag",
        pathPrefix: "validation",
      });

      await expect(denied.resolve("surface/slack/denied")).rejects.toThrow(
        /^Vault could not resolve Gateway credentials \(HTTP 403\)$/u,
      );
    });

    it("persists API enrollment and rotation through Vault without changing the resource", async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-vault-gateway-"));
      const databasePath = join(directory, "supertag.db");
      await migrateSqlite(databasePath);
      const externalAccountId = `T_${crypto.randomUUID()}`;
      const credentialId = `surface/slack/${externalAccountId}`;
      const vault = new VaultGatewayCredentialVault({
        address: required(vaultAddress),
        token: required(vaultToken),
        mount: "supertag",
        pathPrefix: "validation",
      });
      const runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: `file:${databasePath}`,
        adminToken: "vault-gateway-validation-token",
        credentialVault: vault,
      });

      try {
        const client = new ControlPlaneClient({
          url: runtime.url,
          token: "vault-gateway-validation-token",
        });
        const enrollment = {
          provider: "slack" as const,
          externalAccountId,
          displayName: "Vault Gateway Validation",
          authMethod: "slack-http",
          configuration: { transport: "http" },
          secrets: { botToken: "api-v1", signingSecret: "signing-v1" },
        };
        const account = await client.setupSurface(enrollment);
        expect(JSON.stringify(account)).not.toContain("api-v1");
        expect(JSON.stringify(account)).not.toContain("credentialId");
        await expect(vault.resolve(credentialId)).resolves.toEqual({
          botToken: "api-v1",
          signingSecret: "signing-v1",
        });

        await client.setupSurface({
          ...enrollment,
          secrets: { botToken: "api-v2", signingSecret: "signing-v2" },
        });
        await expect(vault.resolve(credentialId)).resolves.toEqual({
          botToken: "api-v2",
          signingSecret: "signing-v2",
        });
      } finally {
        await runtime.close();
        await vault.delete(credentialId);
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("Vault test configuration is missing");
  return value;
}
