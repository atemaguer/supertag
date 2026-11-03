import { resolve } from "node:path";
import type { GatewayCredentialVault } from "@supertag/core";
import { FileGatewayCredentialVault, VaultGatewayCredentialVault } from "@supertag/store";

/** Configure durable credentials independently of the Control Plane's filesystem. */
export function createCredentialVaultFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GatewayCredentialVault {
  const provider = environment["SUPERTAG_CREDENTIAL_VAULT"]?.trim() || "file";
  if (provider === "file")
    return new FileGatewayCredentialVault(
      environment["SUPERTAG_STATE_DIR"]
        ? resolve(environment["SUPERTAG_STATE_DIR"], "credentials.json")
        : undefined,
    );
  if (provider !== "vault") throw new Error("SUPERTAG_CREDENTIAL_VAULT must be file or vault");
  const required = (key: string): string => {
    const value = environment[key]?.trim();
    if (!value) throw new Error(`${key} is required when SUPERTAG_CREDENTIAL_VAULT=vault`);
    return value;
  };
  const mount = environment["SUPERTAG_VAULT_MOUNT"]?.trim();
  const pathPrefix = environment["SUPERTAG_VAULT_PATH_PREFIX"]?.trim();
  const vaultNamespace = environment["VAULT_NAMESPACE"]?.trim();
  return new VaultGatewayCredentialVault({
    address: required("VAULT_ADDR"),
    token: required("VAULT_TOKEN"),
    ...(mount ? { mount } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(vaultNamespace ? { vaultNamespace } : {}),
  });
}
