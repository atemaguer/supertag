import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleArtifactRequest } from "../apps/cli/src/artifact-http.js";
import type { ArtifactCatalog } from "../packages/control-plane/src/index.js";
import type { WorkerHost } from "../packages/core/src/index.js";

describe("distributed artifact HTTP boundary", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function fixture() {
    const registerWorkerArtifactCopies = vi.fn(async () => ({
      accepted: 1,
      inventoryRevision: 7,
    }));
    const resolveTransfer = vi.fn(async () => ({
      artifactId: "artifact-1",
      path: "result.txt",
      sources: [],
    }));
    const recordUpload = vi.fn(async () => {});
    const catalog = {
      registerWorkerArtifactCopies,
      resolveTransfer,
      recordUpload,
    } as unknown as ArtifactCatalog;
    const authenticateWorkerHost = vi.fn(async (workerHostId: string, token: string | undefined) =>
      workerHostId === "host-a" && token === "host-secret"
        ? ({ id: "host-a", connectionGeneration: 9 } as WorkerHost)
        : undefined,
    );
    const server = createServer((request, response) => {
      void handleArtifactRequest(
        request,
        response,
        new URL(request.url ?? "/", "http://localhost"),
        catalog,
        { publicKey: "public-key", authenticateWorkerHost },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
    return {
      url: `http://127.0.0.1:${address.port}`,
      registerWorkerArtifactCopies,
      resolveTransfer,
      recordUpload,
      authenticateWorkerHost,
    };
  }

  it("publishes only the verification key and disables caching for mutable metadata", async () => {
    const f = await fixture();
    const key = await fetch(`${f.url}/internal/v1/artifacts/transfer-key`);
    expect(key.status).toBe(200);
    expect(key.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await key.json()).toEqual({ algorithm: "Ed25519", publicKey: "public-key" });

    const method = await fetch(`${f.url}/internal/v1/artifacts/transfer-key`, { method: "POST" });
    expect(method.status).toBe(405);
  });

  it("derives Worker Host identity and generation from the authenticated connection", async () => {
    const f = await fixture();
    const response = await fetch(`${f.url}/internal/v1/artifacts/worklet-copies`, {
      method: "PUT",
      headers: {
        authorization: "Bearer host-secret",
        "content-type": "application/json",
        "x-supertag-worker-host-id": "host-a",
      },
      body: JSON.stringify({
        inventoryRevision: 7,
        transferBaseUrl: "https://host-a.example",
        copies: [{ digest: `sha256:${"a".repeat(64)}`, sizeBytes: 12 }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.authenticateWorkerHost).toHaveBeenCalledWith("host-a", "host-secret");
    expect(f.registerWorkerArtifactCopies).toHaveBeenCalledWith({
      workerHostId: "host-a",
      connectionGeneration: 9,
      inventoryRevision: 7,
      transferBaseUrl: "https://host-a.example",
      copies: [{ digest: `sha256:${"a".repeat(64)}`, sizeBytes: 12 }],
      observedAt: expect.any(String),
    });
  });

  it("rejects missing, invalid, and body-injected Worker Host authority", async () => {
    const f = await fixture();
    const endpoint = `${f.url}/internal/v1/artifacts/worklet-copies`;
    const body = {
      inventoryRevision: 1,
      transferBaseUrl: "https://host-a.example",
      copies: [],
    };
    expect(
      (
        await fetch(endpoint, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: "PUT",
          headers: {
            authorization: "Bearer wrong",
            "content-type": "application/json",
            "x-supertag-worker-host-id": "host-a",
          },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    const injected = await fetch(endpoint, {
      method: "PUT",
      headers: {
        authorization: "Bearer host-secret",
        "content-type": "application/json",
        "x-supertag-worker-host-id": "host-a",
      },
      body: JSON.stringify({ ...body, connectionGeneration: 500 }),
    });
    expect(injected.status).toBe(400);
    expect(f.registerWorkerArtifactCopies).not.toHaveBeenCalled();
  });

  it("resolves direct sources and records uploads without proxying artifact bytes", async () => {
    const f = await fixture();
    const resolved = await fetch(`${f.url}/internal/v1/artifacts/catalog/resolve-transfer`, {
      method: "POST",
      headers: { authorization: "Bearer attempt-secret", "content-type": "application/json" },
      body: JSON.stringify({ artifactId: "artifact-1", path: "result.txt" }),
    });
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get("cache-control")).toBe("no-store");
    expect(f.resolveTransfer).toHaveBeenCalledWith("attempt-secret", {
      artifactId: "artifact-1",
      path: "result.txt",
    });

    const digest = `sha256:${"b".repeat(64)}`;
    const uploaded = await fetch(`${f.url}/internal/v1/artifacts/catalog/upload`, {
      method: "POST",
      headers: { authorization: "Bearer attempt-secret", "content-type": "application/json" },
      body: JSON.stringify({ digest, sizeBytes: 31 }),
    });
    expect(uploaded.status).toBe(204);
    expect(uploaded.headers.get("cache-control")).toBe("no-store");
    expect(f.recordUpload).toHaveBeenCalledWith("attempt-secret", digest, 31, undefined, undefined);
    // A copy on the host's artifact Volume names the Volume; anything else is refused.
    const onVolume = await fetch(`${f.url}/internal/v1/artifacts/catalog/upload`, {
      method: "POST",
      headers: { authorization: "Bearer attempt-secret", "content-type": "application/json" },
      body: JSON.stringify({
        digest,
        sizeBytes: 31,
        volume: "team-artifacts",
        volumeSource: "s3://team-artifacts/hosts",
      }),
    });
    expect(onVolume.status).toBe(204);
    expect(f.recordUpload).toHaveBeenLastCalledWith(
      "attempt-secret",
      digest,
      31,
      "team-artifacts",
      "s3://team-artifacts/hosts",
    );
    for (const body of [
      { digest, sizeBytes: 31, volume: 7 },
      {
        digest,
        sizeBytes: 31,
        volume: "team-artifacts",
        key: `attempts/victim/sha256/${"b".repeat(64)}`,
      },
    ]) {
      const refused = await fetch(`${f.url}/internal/v1/artifacts/catalog/upload`, {
        method: "POST",
        headers: { authorization: "Bearer attempt-secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(refused.status).toBe(400);
    }
    expect(f.recordUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded or ambiguous upload receipts before catalog mutation", async () => {
    const f = await fixture();
    const endpoint = `${f.url}/internal/v1/artifacts/catalog/upload`;
    for (const body of [
      { digest: `sha256:${"c".repeat(64)}`, sizeBytes: 33_554_433 },
      { digest: "sha256:not-a-digest", sizeBytes: 1 },
      { digest: `sha256:${"c".repeat(64)}`, sizeBytes: 1, workerHostId: "host-a" },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer attempt-secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(f.recordUpload).not.toHaveBeenCalled();
  });
});
