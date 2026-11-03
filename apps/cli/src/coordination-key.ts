import { randomBytes } from "node:crypto";
import type { CredentialValue, GatewayCredentialVault } from "@supertag/core";

export const CONTROL_PLANE_COORDINATION_KEY_ID = "control-plane/coordination-signing-key";

/** Control Plane signing identity is durable; concurrent bootstrap must preserve one key. */
export async function loadControlPlaneCoordinationKey(
  vault: GatewayCredentialVault,
): Promise<Uint8Array> {
  const existing = await vault.resolve(CONTROL_PLANE_COORDINATION_KEY_ID);
  if (existing !== undefined) return decodeKey(existing);

  if (!vault.storeIfAbsent)
    throw new Error(
      `Control Plane credential vault must support atomic storeIfAbsent or preprovision ${CONTROL_PLANE_COORDINATION_KEY_ID} with a 32-byte base64url key`,
    );
  const value = await vault.storeIfAbsent(CONTROL_PLANE_COORDINATION_KEY_ID, {
    key: randomBytes(32).toString("base64url"),
  });
  return decodeKey(value);
}
function decodeKey(value: CredentialValue): Uint8Array {
  const encoded = value["key"];
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
    throw new Error("Invalid persisted Control Plane coordination signing key");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded)
    throw new Error("Invalid persisted Control Plane coordination signing key");
  return key;
}
