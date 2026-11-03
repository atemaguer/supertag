import { createServer, type ServerHttp2Session } from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError, createClient, type ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it } from "vitest";
import { GrpcSessionStateStore } from "./src/session-client.js";
import { encodeSessionRef, SessionService, sessionArchiveDigest } from "./src/session-codec.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const state = {
  ref: { id: "state", uri: "supertag:session:state", format: "codex.native.v1", provenance: {} },
  harnessId: "codex",
  data: { nativeConversationId: "conversation" },
};
const archive = Buffer.from(JSON.stringify(state.data));
const header = {
  ref: encodeSessionRef(state.ref),
  harnessId: state.harnessId,
  archiveSize: archive.length,
  archiveSha256: sessionArchiveDigest(archive),
};
async function server(implementation: Partial<ServiceImpl<typeof SessionService>>) {
  const listener = createServer(
    connectNodeAdapter({
      grpc: true,
      connect: false,
      grpcWeb: false,
      routes: (router) => {
        router.service(SessionService, implementation);
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
  return { baseUrl, client: new GrpcSessionStateStore({ baseUrl, token: "attempt-token" }) };
}

describe("Session gRPC client boundary", () => {
  it.each([
    "reference",
    "digest",
    "truncated",
    "header-only",
    "empty",
    "missing-trailing",
    "duplicate-header",
    "empty-chunk",
  ] as const)(
    "rejects a malformed %s response instead of returning resumable state",
    async (mode) => {
      const { client } = await server({
        async *load() {
          if (mode === "empty") return;
          if (mode === "missing-trailing") {
            yield { frame: { case: "notFound", value: true } };
            yield { frame: { case: "chunk", value: archive } };
            return;
          }
          yield {
            frame: {
              case: "header",
              value: {
                ...header,
                ...(mode === "reference"
                  ? { ref: encodeSessionRef({ ...state.ref, id: "foreign" }) }
                  : {}),
                ...(mode === "digest" ? { archiveSha256: "0".repeat(64) } : {}),
              },
            },
          };
          if (mode === "header-only") return;
          if (mode === "duplicate-header") yield { frame: { case: "header", value: header } };
          yield {
            frame: {
              case: "chunk",
              value:
                mode === "empty-chunk"
                  ? Buffer.alloc(0)
                  : mode === "truncated"
                    ? archive.subarray(0, archive.length - 1)
                    : archive,
            },
          };
        },
      });
      await expect(client.load(state.ref)).rejects.toThrow();
    },
  );

  it("accepts complete verified state and a single explicit missing result", async () => {
    let missing = false;
    const { client } = await server({
      async *load(_, context) {
        expect(context.requestHeader.get("authorization")).toBe("Bearer attempt-token");
        expect(context.timeoutMs()).toBeLessThanOrEqual(30_000);
        if (missing) {
          yield { frame: { case: "notFound", value: true } };
          return;
        }
        yield { frame: { case: "header", value: header } };
        yield { frame: { case: "chunk", value: archive } };
      },
    });
    await expect(client.load(state.ref)).resolves.toEqual(state);
    missing = true;
    await expect(client.load(state.ref)).resolves.toBeUndefined();
  });

  it("does not automatically retry a write after its bytes were consumed but acknowledgement was lost", async () => {
    let calls = 0;
    let receivedBytes = 0;
    const { client } = await server({
      async save(requests) {
        calls++;
        for await (const request of requests)
          if (request.frame.case === "chunk") receivedBytes += request.frame.value.length;
        throw new ConnectError("Acknowledgement unavailable", Code.Unavailable);
      },
    });
    await expect(client.save(state)).rejects.toMatchObject({ code: Code.Unavailable });
    expect(receivedBytes).toBe(archive.length);
    expect(calls).toBe(1);
  });

  it("rejects a mismatched write acknowledgement without retrying", async () => {
    let calls = 0;
    const { client } = await server({
      async save(requests) {
        calls++;
        for await (const request of requests) void request;
        return { writeVersion: 99n };
      },
    });
    await expect(client.save(state)).rejects.toThrow("acknowledgement mismatch");
    expect(calls).toBe(1);
  });

  it("propagates a deadline to a stalled stream and releases its handler", async () => {
    let active = 0;
    const { baseUrl } = await server({
      async *load(_, context) {
        active++;
        try {
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new ConnectError("Observation ended", Code.Canceled);
        } finally {
          active--;
        }
      },
    });
    const raw = createClient(SessionService, createGrpcTransport({ baseUrl }));
    await expect(
      (async () => {
        for await (const response of raw.load(
          { ref: encodeSessionRef(state.ref) },
          { timeoutMs: 50 },
        ))
          void response;
      })(),
    ).rejects.toMatchObject({ code: Code.DeadlineExceeded });
    for (let count = 0; active !== 0 && count < 20; count++) await delay(5);
    expect(active).toBe(0);
  });
});
