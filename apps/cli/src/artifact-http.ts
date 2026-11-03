import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactCatalog } from "@supertag/control-plane";
import { ArtifactCatalogError, TagMessagingError, type WorkerHost } from "@supertag/core";
import { MAX_ARTIFACT_BYTES } from "@supertag/worker-sdk";

/**
 * The artifact catalog's internal HTTP routes. They carry metadata only: the Control Plane never
 * receives, relays, or serves artifact bytes. Bytes stay on the Worker Hosts that hold them and
 * move between hosts directly, under short-lived grants this catalog signs.
 */
export async function handleArtifactRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  catalog: ArtifactCatalog,
  directTransfers?: {
    readonly publicKey: string;
    readonly authenticateWorkerHost: (
      workerHostId: string,
      token: string | undefined,
    ) => Promise<WorkerHost | undefined>;
  },
): Promise<void> {
  try {
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : undefined;
    if (url.pathname === "/internal/v1/artifacts/transfer-key") {
      if (request.method !== "GET") throw new TagMessagingError(405, "Method not allowed");
      if (!directTransfers)
        throw new TagMessagingError(503, "Direct artifact transfer is not configured");
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      });
      response.end(JSON.stringify({ algorithm: "Ed25519", publicKey: directTransfers.publicKey }));
      return;
    }
    if (url.pathname === "/internal/v1/artifacts/worklet-copies") {
      if (request.method !== "PUT") throw new TagMessagingError(405, "Method not allowed");
      if (!directTransfers)
        throw new TagMessagingError(503, "Direct artifact transfer is not configured");
      const workerHostId = singleHeader(request.headers["x-supertag-worker-host-id"]);
      if (!workerHostId) throw new TagMessagingError(401, "Worker Host identity is required");
      const host = await directTransfers.authenticateWorkerHost(workerHostId, token);
      if (!host) throw new TagMessagingError(401, "Worker Host authentication failed");
      const input = await artifactJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TagMessagingError(400, "Artifact inventory must be an object");
      const value = input as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (key) => !["inventoryRevision", "transferBaseUrl", "copies"].includes(key),
        )
      )
        throw new TagMessagingError(400, "Unknown artifact inventory field");
      const result = await catalog.registerWorkerArtifactCopies({
        workerHostId: host.id,
        connectionGeneration: host.connectionGeneration,
        inventoryRevision: value["inventoryRevision"] as number,
        transferBaseUrl: value["transferBaseUrl"] as string,
        copies: value["copies"] as { digest: string; sizeBytes: number }[],
        observedAt: new Date().toISOString(),
      });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
      return;
    }
    if (url.pathname === "/internal/v1/artifacts/volume") {
      if (request.method !== "GET") throw new TagMessagingError(405, "Method not allowed");
      if (!directTransfers)
        throw new TagMessagingError(503, "Direct artifact transfer is not configured");
      const workerHostId = singleHeader(request.headers["x-supertag-worker-host-id"]);
      if (!workerHostId) throw new TagMessagingError(401, "Worker Host identity is required");
      const host = await directTransfers.authenticateWorkerHost(workerHostId, token);
      if (!host) throw new TagMessagingError(401, "Worker Host authentication failed");
      const volume = await catalog.workerHostArtifactVolume(host, url.searchParams.get("name"));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(volume));
      return;
    }
    if (url.pathname === "/internal/v1/artifacts/catalog/resolve-transfer") {
      if (request.method !== "POST") throw new TagMessagingError(405, "Method not allowed");
      const result = await catalog.resolveTransfer(token, await artifactJson(request));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
      return;
    }
    if (url.pathname === "/internal/v1/artifacts/catalog/upload") {
      if (request.method !== "POST") throw new TagMessagingError(405, "Method not allowed");
      const input = await artifactJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TagMessagingError(400, "Artifact upload receipt must be an object");
      const value = input as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (key) => !["digest", "sizeBytes", "volume", "volumeSource"].includes(key),
        )
      )
        throw new TagMessagingError(400, "Unknown artifact upload receipt field");
      if (
        typeof value["digest"] !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(value["digest"]) ||
        typeof value["sizeBytes"] !== "number" ||
        !Number.isSafeInteger(value["sizeBytes"]) ||
        value["sizeBytes"] < 0 ||
        value["sizeBytes"] > MAX_ARTIFACT_BYTES ||
        (value["volume"] !== undefined && typeof value["volume"] !== "string")
      )
        throw new TagMessagingError(400, "Invalid artifact upload receipt");
      await catalog.recordUpload(
        token,
        value["digest"],
        value["sizeBytes"],
        value["volume"] as string | undefined,
        value["volumeSource"] as string | undefined,
      );
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const command = /^\/internal\/v1\/artifacts\/catalog\/([a-z]+)$/u.exec(url.pathname)?.[1];
    if (command) {
      if (request.method !== "POST") throw new TagMessagingError(405, "Method not allowed");
      await catalog.execution(token);
      const input = await artifactJson(request);
      const result = await catalog.command(command, input, token);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
      return;
    }
    throw new TagMessagingError(404, "Artifact not found");
  } catch (error) {
    const status =
      error instanceof TagMessagingError || error instanceof ArtifactCatalogError
        ? error.statusCode
        : 500;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(
      JSON.stringify({
        error: status === 500 ? "Artifact catalog unavailable" : (error as Error).message,
      }),
    );
  }
}

async function artifactJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 256 * 1024) throw new TagMessagingError(413, "Artifact metadata exceeds limit");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TagMessagingError(400, "Invalid artifact JSON");
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
