import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialVaultFromEnvironment } from "../apps/cli/src/credential-vault.ts";
import {
  FileGatewayCredentialVault,
  VaultGatewayCredentialVault,
} from "../packages/store/src/index.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Control Plane credential provider selection", () => {
  it("preserves the local default and requires an explicit supported provider", () => {
    expect(createCredentialVaultFromEnvironment({})).toBeInstanceOf(FileGatewayCredentialVault);
    expect(() =>
      createCredentialVaultFromEnvironment({ SUPERTAG_CREDENTIAL_VAULT: "typo" }),
    ).toThrow("must be file or vault");
  });

  it.each(["VAULT_ADDR", "VAULT_TOKEN"])("fails closed when %s is missing", (missing) => {
    expect(() =>
      createCredentialVaultFromEnvironment({
        SUPERTAG_CREDENTIAL_VAULT: "vault",
        VAULT_ADDR: "https://vault.example.com",
        VAULT_TOKEN: "secret-token",
        [missing]: "",
      }),
    ).toThrow(`${missing} is required`);
  });

  it("uses the configured Vault mount, namespace and token for credential requests", async () => {
    const request = vi.fn(async () => Response.json({ data: { data: { key: "durable-key" } } }));
    vi.stubGlobal("fetch", request);
    const vault = createCredentialVaultFromEnvironment({
      SUPERTAG_CREDENTIAL_VAULT: "vault",
      VAULT_ADDR: "https://vault.example.com",
      VAULT_TOKEN: "secret-token",
      SUPERTAG_VAULT_MOUNT: "organization",
      SUPERTAG_VAULT_PATH_PREFIX: "production",
      VAULT_NAMESPACE: "team",
    });
    expect(vault).toBeInstanceOf(VaultGatewayCredentialVault);
    await expect(vault.resolve("control-plane/coordination-signing-key")).resolves.toEqual({
      key: "durable-key",
    });
    expect(request).toHaveBeenCalledWith(
      "https://vault.example.com/v1/organization/data/production/control-plane/coordination-signing-key",
      expect.objectContaining({ method: "GET" }),
    );
    const headers = new Headers(
      (request.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    );
    expect(headers.get("X-Vault-Token")).toBe("secret-token");
    expect(headers.get("X-Vault-Namespace")).toBe("team");
  });
});
