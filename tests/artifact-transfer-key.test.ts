import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  artifactTransferVerificationKey,
  CONTROL_PLANE_ARTIFACT_TRANSFER_KEY_ID,
  loadArtifactTransferSigningIdentity,
} from "../apps/cli/src/artifact-transfer-key.js";
import type { GatewayCredentialVault } from "../packages/core/src/index.js";
import { FileGatewayCredentialVault } from "../packages/store/src/index.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("persists one Ed25519 transfer identity across concurrent bootstrap and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-transfer-key-"));
  directories.push(directory);
  const path = join(directory, "credentials.json");

  const identities = await Promise.all(
    Array.from({ length: 12 }, () =>
      loadArtifactTransferSigningIdentity(new FileGatewayCredentialVault(path)),
    ),
  );
  const publicKey = identities[0]?.publicKeyBase64;
  expect(publicKey).toBeTruthy();
  expect(identities.every((identity) => identity.publicKeyBase64 === publicKey)).toBe(true);

  const restarted = await loadArtifactTransferSigningIdentity(new FileGatewayCredentialVault(path));
  expect(restarted.publicKeyBase64).toBe(publicKey);
  expect((await stat(path)).mode & 0o077).toBe(0);

  const message = Buffer.from("artifact grant");
  const signature = sign(null, message, restarted.privateKey);
  expect(verify(null, message, artifactTransferVerificationKey(publicKey ?? ""), signature)).toBe(
    true,
  );
});

it("requires atomic creation when the transfer key is not preprovisioned", async () => {
  const store = vi.fn(async () => {});
  const vault: GatewayCredentialVault = {
    store,
    resolve: async () => undefined,
    delete: async () => {},
  };

  await expect(loadArtifactTransferSigningIdentity(vault)).rejects.toThrow(/storeIfAbsent/);
  expect(store).not.toHaveBeenCalled();
});

it("rejects malformed and non-Ed25519 persisted transfer keys", async () => {
  const base: GatewayCredentialVault = {
    store: async () => {},
    resolve: async () => ({ privateKey: "bad=" }),
    delete: async () => {},
  };
  await expect(loadArtifactTransferSigningIdentity(base)).rejects.toThrow(
    "Invalid persisted artifact transfer signing key",
  );

  const nonEd25519 = generateKeyPairSync("x25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  await expect(
    loadArtifactTransferSigningIdentity({
      ...base,
      resolve: async (credentialId) =>
        credentialId === CONTROL_PLANE_ARTIFACT_TRANSFER_KEY_ID
          ? { privateKey: nonEd25519 }
          : undefined,
    }),
  ).rejects.toThrow("Artifact transfer signing key must be Ed25519");
});

it("rejects malformed and non-Ed25519 distributed verification keys", () => {
  expect(() => artifactTransferVerificationKey("bad=")).toThrow(
    "Invalid artifact transfer verification key",
  );
  const nonEd25519 = generateKeyPairSync("x25519")
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64url");
  expect(() => artifactTransferVerificationKey(nonEd25519)).toThrow(
    "Artifact transfer verification key must be Ed25519",
  );
});
