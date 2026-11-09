import { createServer, type ServerHttp2Session } from "node:http2";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it } from "vitest";
import { GrpcArtifactCatalogClient } from "./src/artifact-client.js";
import { ArtifactCatalogService } from "./src/artifact-codec.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function server(implementation: Partial<ServiceImpl<typeof ArtifactCatalogService>>) {
  const listener = createServer(
    connectNodeAdapter({
      grpc: true,
      connect: false,
      grpcWeb: false,
      routes: (router) => {
        router.service(ArtifactCatalogService, implementation);
      },
    }),
  );
  const sessions = new Set<ServerHttp2Session>();
  listener.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, client: new GrpcArtifactCatalogClient({ baseUrl, token: "attempt-token" }) };
}

describe("artifact gRPC client", () => {
  it("refuses an expired Attempt credential without replaying the operation", async () => {
    let calls = 0;
    const { client } = await server({
      capture() {
        calls++;
        throw new ConnectError("expired", Code.Unauthenticated);
      },
    });
    await expect(
      client.request("capture", {
        operationId: "stable",
        title: "Report",
        kind: "report",
        entries: [],
      }),
    ).rejects.toMatchObject({ name: "ArtifactRequestError", status: 401 });
    expect(calls).toBe(1);
  });
  it("does not retry an uncertain capture or silently use HTTP", async () => {
    let calls = 0;
    const { client } = await server({
      capture() {
        calls++;
        throw new ConnectError("lost reply", Code.Unavailable);
      },
    });
    await expect(
      client.request("capture", {
        operationId: "stable",
        title: "Report",
        kind: "report",
        entries: [],
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("preserves absent and explicit zero limits and rejects unknown fields before dispatch", async () => {
    const limits: (number | undefined)[] = [];
    const { client } = await server({
      find(request, context) {
        expect(context.requestHeader.get("authorization")).toBe("Bearer attempt-token");
        expect(context.timeoutMs()).toBeLessThanOrEqual(30_000);
        limits.push(request.limit);
        return { artifacts: [] };
      },
    });
    await client.request("find", {});
    await client.request("find", { limit: 0 });
    await expect(client.request("find", { sql: "unavailable" })).rejects.toThrow();
    expect(limits).toEqual([undefined, 0]);
  });
  it("maps definitive catalog conflicts without replay", async () => {
    let calls = 0;
    const { client } = await server({
      capture() {
        calls++;
        throw new ConnectError("conflict", Code.FailedPrecondition);
      },
    });
    await expect(
      client.request("capture", {
        operationId: "stable",
        title: "Report",
        kind: "report",
        entries: [],
      }),
    ).rejects.toMatchObject({ name: "ArtifactRequestError", status: 409 });
    expect(calls).toBe(1);
  });
  it("rejects missing artifact identity", async () => {
    const { client } = await server({
      inspect() {
        return {};
      },
    });
    await expect(client.request("inspect", { artifactId: "artifact" })).rejects.toThrow();
  });
});
