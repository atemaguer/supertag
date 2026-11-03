import { createServer, type ServerHttp2Session } from "node:http2";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it } from "vitest";
import { GrpcArtifactCatalogClient } from "./src/artifact-client.js";
import { ArtifactCatalogService } from "./src/artifact-codec.js";
import { ExecutionAuthorityService } from "./src/coordination-codec.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function server(
  implementation: Partial<ServiceImpl<typeof ArtifactCatalogService>>,
  authority: Partial<ServiceImpl<typeof ExecutionAuthorityService>> = {},
) {
  const listener = createServer(
    connectNodeAdapter({
      grpc: true,
      connect: false,
      grpcWeb: false,
      routes: (router) => {
        router.service(ArtifactCatalogService, implementation);
        router.service(ExecutionAuthorityService, authority);
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
  it("renews Attempt authority once and preserves the original operation input", async () => {
    const input = { operationId: "stable", title: "Original", kind: "report", entries: [] };
    const titles: string[] = [];
    let renewals = 0;
    const { baseUrl } = await server(
      {
        capture(request, context) {
          titles.push(request.title);
          if (context.requestHeader.get("authorization") !== "Bearer new-token")
            throw new ConnectError("expired", Code.Unauthenticated);
          return {
            artifact: {
              ...request,
              id: "artifact",
              taskId: "task",
              attemptId: "attempt",
              tagId: "tag",
              sessionId: "session",
              inputs: [],
              createdAt: "2026-09-17T00:00:00Z",
            },
          };
        },
      },
      {
        rebind(_, context) {
          expect(context.requestHeader.get("authorization")).toBe("Bearer old-token");
          renewals++;
          input.title = "Changed by caller";
          return { token: "new-token" };
        },
      },
    );
    const client = new GrpcArtifactCatalogClient({
      baseUrl,
      token: "old-token",
    });
    await expect(client.request("capture", input)).resolves.toMatchObject({
      artifact: { title: "Original", operationId: "stable" },
    });
    expect(titles).toEqual(["Original", "Original"]);
    expect(renewals).toBe(1);
  });
  it("keeps a shared authority renewal alive when one catalog caller cancels", async () => {
    let renewals = 0;
    let expiredCalls = 0;
    let renewalStarted!: () => void;
    let secondExpired!: () => void;
    let releaseRenewal!: () => void;
    const started = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    const bothExpired = new Promise<void>((resolve) => {
      secondExpired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const { baseUrl } = await server(
      {
        find(_, context) {
          if (context.requestHeader.get("authorization") !== "Bearer new-token") {
            expiredCalls++;
            if (expiredCalls === 2) secondExpired();
            throw new ConnectError("expired", Code.Unauthenticated);
          }
          return { artifacts: [] };
        },
      },
      {
        async rebind() {
          renewals++;
          renewalStarted();
          await released;
          return { token: "new-token" };
        },
      },
    );
    const client = new GrpcArtifactCatalogClient({ baseUrl, token: "old-token" });
    const cancelled = new AbortController();
    const first = client.request("find", {}, cancelled.signal);
    await started;
    const second = client.request("find", {});
    await bothExpired;
    cancelled.abort(new Error("first catalog caller cancelled"));
    releaseRenewal();
    await expect(first).rejects.toThrow("first catalog caller cancelled");
    await expect(second).resolves.toEqual({ artifacts: [] });
    expect(renewals).toBe(1);
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
