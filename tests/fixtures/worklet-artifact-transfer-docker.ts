import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { connect } from "node:net";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { registerArtifactGrpcRoutes } from "../../apps/cli/src/artifact-grpc.js";
import type { ArtifactCatalog } from "../../packages/control-plane/src/artifact-catalog.js";
import type { ResolvedArtifactTransfer } from "../../packages/core/src/index.js";
import { ArtifactCatalogError } from "../../packages/core/src/index.js";
import { FileArtifactStore } from "../../packages/runtime/sdk/src/artifact-store.js";
import {
  signArtifactTransferGrant,
  WorkletArtifactStore,
  WorkletArtifactTransferClient,
  WorkletArtifactTransferServer,
} from "../../packages/runtime/sdk/src/worklet-artifact-transfer.js";
import { GrpcArtifactCatalogClient } from "../../packages/runtime/transport/src/artifact-client.js";

const mode = required("FIXTURE_MODE");
const metadataTransport = required("ARTIFACT_METADATA_TRANSPORT");
const stateDirectory = "/state";
await mkdir(stateDirectory, { recursive: true });

if (mode === "producer") {
  const store = new FileArtifactStore(`${stateDirectory}/artifacts`);
  const prior = await readFile(`${stateDirectory}/producer.json`, "utf8").catch(
    (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  const priorRef = prior === undefined ? undefined : JSON.parse(prior).ref;
  // Restart must serve its persisted copy even after the original seed has disappeared.
  const bytes = priorRef ? await store.get(priorRef) : await readFile("/seed/evidence.bin");
  const ref =
    priorRef ??
    (await store.put({ bytes, name: "evidence.bin", mediaType: "application/octet-stream" }));
  const server = new WorkletArtifactTransferServer({
    workerHostId: "worker-a",
    store,
    verificationKey: createPublicKey(
      Buffer.from(required("TRANSFER_PUBLIC_KEY"), "base64").toString("utf8"),
    ),
  });
  await server.listen({
    host: "0.0.0.0",
    port: 8788,
    advertiseUrl: "http://worker-a:8788",
    allowInsecureHttp: true,
  });
  await writeFile(
    `${stateDirectory}/producer.json`,
    JSON.stringify({ ref, sizeBytes: bytes.byteLength }),
  );
  process.stdout.write("Producer Worklet ready\n");
} else if (mode === "metadata") {
  const privateKey = createPrivateKey(
    Buffer.from(required("TRANSFER_PRIVATE_KEY"), "base64").toString("utf8"),
  );
  const expectedDigest = required("ARTIFACT_DIGEST");
  const expectedSize = Number(required("ARTIFACT_SIZE"));
  let requests = 0;
  const resolveTransfer = async (
    token: string | undefined,
    value: unknown,
  ): Promise<ResolvedArtifactTransfer> => {
    if (token !== "fixture-attempt-credential")
      throw new ArtifactCatalogError(401, "Invalid execution credential");
    const ref = value as { artifactId: string; path: string };
    if (ref.artifactId !== "artifact-1" || ref.path !== "results/evidence.bin")
      throw new ArtifactCatalogError(403, "Artifact is not visible");
    requests += 1;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 300_000).toISOString();
    const claims = {
      version: 1 as const,
      grantId: "docker-transfer-grant",
      artifactId: ref.artifactId,
      path: ref.path,
      digest: expectedDigest,
      sizeBytes: expectedSize,
      sourceWorkerHostId: "worker-a",
      recipientWorkerHostId: "worker-b",
      recipientConnectionGeneration: 1,
      taskId: "consume-artifact",
      attemptId: "consume-attempt",
      issuedAt: issuedAt.toISOString(),
      expiresAt,
    };
    const location = {
      workerHostId: "worker-a",
      transferUrl: `http://worker-a:8788/v1/artifacts/${expectedDigest.slice("sha256:".length)}`,
    };
    const result = {
      artifactId: ref.artifactId,
      path: ref.path,
      digest: expectedDigest,
      sizeBytes: expectedSize,
      locations: [
        { ...location, grant: signArtifactTransferGrant(claims, privateKey) },
        {
          ...location,
          grant: signArtifactTransferGrant(
            { ...claims, sourceWorkerHostId: "another-worker" },
            privateKey,
          ),
        },
        {
          ...location,
          grant: signArtifactTransferGrant(
            {
              ...claims,
              issuedAt: new Date(issuedAt.getTime() - 120_000).toISOString(),
              expiresAt: new Date(issuedAt.getTime() - 60_000).toISOString(),
            },
            privateKey,
          ),
        },
      ],
      volumes: [],
      holders: { workerHostIds: ["producer-host"], volumes: [] },
      expiresAt,
    };
    await writeFile(
      `${stateDirectory}/metadata.json`,
      JSON.stringify({
        requests,
        requestBytes: Buffer.byteLength(JSON.stringify(value)),
        responseBytes: Buffer.byteLength(JSON.stringify(result)),
        transport: metadataTransport,
      }),
    );
    // Let the unary reply finish, then terminate metadata before any valid byte transfer.
    setTimeout(() => process.exit(0), 150);
    return result;
  };
  const server =
    metadataTransport === "grpc"
      ? createSecureServer(
          { key: await readFile("/tls/server.key"), cert: await readFile("/tls/server.crt") },
          connectNodeAdapter({
            routes: (router) =>
              registerArtifactGrpcRoutes(router, { resolveTransfer } as unknown as ArtifactCatalog),
          }),
        )
      : createServer((request, response) => {
          void (async () => {
            if (request.method !== "POST" || request.url !== "/resolve") {
              response.writeHead(404).end();
              return;
            }
            let raw = "";
            for await (const chunk of request) raw += String(chunk);
            const ref = JSON.parse(raw) as { artifactId: string; path: string; digest: string };
            if (
              ref.artifactId !== "artifact-1" ||
              ref.path !== "results/evidence.bin" ||
              ref.digest !== expectedDigest
            ) {
              response.writeHead(400).end();
              return;
            }
            const result = await resolveTransfer(request.headers.authorization?.slice(7), ref);
            const body = JSON.stringify(result);
            response.writeHead(200, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            });
            response.end(body);
          })().catch((error) => {
            process.stderr.write(`${String(error)}\n`);
            if (!response.headersSent) response.writeHead(500);
            response.end();
          });
        });
  await new Promise<void>((resolve) => server.listen(8789, "0.0.0.0", resolve));
  process.stdout.write("Metadata service ready\n");
} else if (mode === "consumer") {
  const digest = required("ARTIFACT_DIGEST");
  const uri = `supertag-artifact:${digest}`;
  const tlsCa = await readFile("/tls/server.crt", "utf8");
  const resolveMetadata = async (ref: { artifactId: string; path: string }, token: string) => {
    if (metadataTransport === "grpc")
      return new GrpcArtifactCatalogClient({
        baseUrl: "https://metadata:8789",
        token,
        tlsCa,
      }).resolveTransfer(ref);
    const response = await fetch("http://metadata:8789/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...ref, digest }),
    });
    if (!response.ok) throw new Error(`Metadata resolution failed (HTTP ${response.status})`);
    return (await response.json()) as ResolvedArtifactTransfer;
  };
  let wrongCredentialRejected = false;
  try {
    await resolveMetadata(
      { artifactId: "artifact-1", path: "results/evidence.bin" },
      "wrong-credential",
    );
  } catch {
    wrongCredentialRejected = true;
  }
  if (!wrongCredentialRejected)
    throw new Error("Metadata accepted an invalid execution credential");
  const grantRejections: number[] = [];
  const store = new WorkletArtifactStore({
    directory: `${stateDirectory}/artifacts`,
    allowInsecureHttp: true,
    async resolve(ref) {
      if (!ref.artifactId || !ref.path) throw new Error("Missing artifact catalog identity");
      const resolved = await resolveMetadata(
        { artifactId: ref.artifactId, path: ref.path },
        "fixture-attempt-credential",
      );
      await writeFile(`${stateDirectory}/resolution.json`, JSON.stringify(resolved));
      let metadataUnavailable = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!(await portAvailable("metadata", 8789))) {
          metadataUnavailable = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!metadataUnavailable)
        throw new Error("Metadata service remained available after issuing the transfer grant");
      for (const location of resolved.locations.slice(1)) {
        const response = await fetch(location.transferUrl, {
          headers: { authorization: `Bearer ${location.grant}` },
        });
        grantRejections.push(response.status);
        await response.body?.cancel();
      }
      if (grantRejections.some((status) => status !== 403))
        throw new Error("Invalid artifact grant accepted");
      return { ...resolved, locations: resolved.locations.slice(0, 1) };
    },
  });
  const bytes = await store.get({
    artifactId: "artifact-1",
    path: "results/evidence.bin",
    uri,
    digest,
  });
  await writeFile(
    `${stateDirectory}/consumer.json`,
    JSON.stringify({
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      sizeBytes: bytes.byteLength,
      metadataUnavailableBeforeTransfer: true,
      wrongCredentialRejected,
      grantRejections,
    }),
  );
  process.stdout.write("Consumer Worklet complete\n");
} else if (mode === "source-probe") {
  const resolved = JSON.parse(
    await readFile(`${stateDirectory}/resolution.json`, "utf8"),
  ) as ResolvedArtifactTransfer;
  const expectedAvailable = required("SOURCE_AVAILABLE") === "true";
  const store = new FileArtifactStore(`${stateDirectory}/probe-${expectedAvailable}`);
  const client = new WorkletArtifactTransferClient({ store, allowInsecureHttp: true });
  const ref = {
    artifactId: resolved.artifactId,
    path: resolved.path,
    digest: resolved.digest,
    uri: `supertag-artifact:${resolved.digest}`,
  };
  let available = false;
  try {
    await client.fetch(ref, resolved.locations.slice(0, 1), resolved.sizeBytes);
    const bytes = await store.get(ref);
    available = `sha256:${createHash("sha256").update(bytes).digest("hex")}` === resolved.digest;
  } catch {
    if (expectedAvailable) throw new Error("Artifact source did not recover after restart");
  }
  if (available !== expectedAvailable) throw new Error("Unexpected artifact source availability");
  await writeFile(
    `${stateDirectory}/probe-${expectedAvailable}.json`,
    JSON.stringify({ available, metadataAvailable: await portAvailable("metadata", 8789) }),
  );
  process.stdout.write("Source probe complete\n");
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function portAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (available: boolean) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
