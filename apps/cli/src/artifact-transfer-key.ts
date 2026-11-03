import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { CredentialValue, GatewayCredentialVault } from "@supertag/core";

export const CONTROL_PLANE_ARTIFACT_TRANSFER_KEY_ID = "control-plane/artifact-transfer-signing-key";

export interface ArtifactTransferSigningIdentity {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** Stable SPKI DER encoding suitable for distribution to Worklets. */
  readonly publicKeyBase64: string;
}

/** Loads one durable Ed25519 identity; concurrent bootstrap preserves the first key. */
export async function loadArtifactTransferSigningIdentity(
  vault: GatewayCredentialVault,
): Promise<ArtifactTransferSigningIdentity> {
  let value = await vault.resolve(CONTROL_PLANE_ARTIFACT_TRANSFER_KEY_ID);
  if (value === undefined) {
    if (!vault.storeIfAbsent)
      throw new Error(
        `Control Plane credential vault must support atomic storeIfAbsent or preprovision ${CONTROL_PLANE_ARTIFACT_TRANSFER_KEY_ID}`,
      );
    const generated = generateKeyPairSync("ed25519");
    value = await vault.storeIfAbsent(CONTROL_PLANE_ARTIFACT_TRANSFER_KEY_ID, {
      privateKey: generated.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
    });
  }
  return decodeIdentity(value);
}

function decodeIdentity(value: CredentialValue): ArtifactTransferSigningIdentity {
  const encoded = value["privateKey"];
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid persisted artifact transfer signing key");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded)
    throw new Error("Invalid persisted artifact transfer signing key");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  } catch (error) {
    throw new Error("Invalid persisted artifact transfer signing key", { cause: error });
  }
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("Artifact transfer signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

export function artifactTransferVerificationKey(encoded: string): KeyObject {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid artifact transfer verification key");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded)
    throw new Error("Invalid artifact transfer verification key");
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Artifact transfer verification key must be Ed25519");
  return key;
}
