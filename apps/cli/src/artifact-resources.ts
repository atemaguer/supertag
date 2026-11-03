import type { ServerResponse } from "node:http";
import type { CapturedArtifact, Store, WorkerHost } from "@supertag/core";
import { type ArtifactCopyLocations, artifactCopyLocations } from "./task-storage.js";

/**
 * An Artifact resource. Its `status` says where each copy is (Worker Hosts and Volumes, never the
 * Control Plane) and whether some file is held only on ephemeral Worker Hosts.
 */
export function artifactResource(artifact: CapturedArtifact, status?: ArtifactCopyLocations) {
  const { id, createdAt, ...spec } = artifact;
  return {
    apiVersion: "supertag/v1",
    kind: "Artifact",
    metadata: { id, createdAt },
    spec,
    ...(status === undefined ? {} : { status }),
  };
}

/** Each artifact's copy locations, reading hosts, Volumes, and Attempts once per page. */
async function withLocations(store: Store, artifacts: readonly CapturedArtifact[]) {
  if (artifacts.length === 0) return [];
  const [hosts, volumes, attempts] = await Promise.all([
    store.listWorkerHosts(),
    store.listVolumes(),
    store.listTaskAttempts([...new Set(artifacts.map((artifact) => artifact.taskId))]),
  ]);
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const byId = new Map<string, WorkerHost>(hosts.map((host) => [host.id, host]));
  const names = new Map(volumes.map((volume) => [volume.id, volume.name]));
  const resources = [];
  for (const artifact of artifacts)
    resources.push(
      artifactResource(
        artifact,
        await artifactCopyLocations(store, artifact, byId, names, attemptsById),
      ),
    );
  return resources;
}

/**
 * Called only after the API Server has authenticated an administrator. Serves catalog metadata
 * and where each copy is: the Control Plane holds no artifact bytes to serve.
 */
export async function handleOperatorArtifacts(
  url: URL,
  response: ServerResponse,
  store: Store,
): Promise<boolean> {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/v1/artifacts") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      send(400, { message: "limit must be an integer between 1 and 100" });
      return true;
    }
    const page = await store.listCapturedArtifacts({
      limit,
      ...(url.searchParams.has("task") ? { taskId: url.searchParams.get("task") as string } : {}),
      ...(url.searchParams.has("cursor")
        ? { cursor: url.searchParams.get("cursor") as string }
        : {}),
    });
    send(200, {
      apiVersion: "supertag/v1",
      kind: "ArtifactList",
      metadata: { nextCursor: page.nextCursor },
      items: await withLocations(store, page.artifacts),
    });
    return true;
  }
  const match = /^\/api\/v1\/artifacts\/([^/]+)$/u.exec(url.pathname);
  if (!match?.[1]) return false;
  const artifact = await store.findCapturedArtifact(decodeURIComponent(match[1]));
  if (!artifact) {
    send(404, { message: "Artifact does not exist" });
    return true;
  }
  send(200, (await withLocations(store, [artifact]))[0]);
  return true;
}
