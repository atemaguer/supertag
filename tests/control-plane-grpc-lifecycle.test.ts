import { createServer } from "node:http2";
import { createConnection } from "node:net";
import { expect, it, vi } from "vitest";
import {
  ControlPlaneApiServer,
  type ControlPlaneApiServerDependencies,
} from "../apps/cli/src/control-plane-api.ts";

function api() {
  return new ControlPlaneApiServer({
    workletApi: { start: vi.fn(), stop: vi.fn() },
    controlPlane: { objectives: {} },
  } as unknown as ControlPlaneApiServerDependencies);
}
async function reachable(url: string): Promise<void> {
  const endpoint = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("Connection timed out"));
    });
  });
}
it("deduplicates listener startup and opens a fresh listener after stop", async () => {
  const server = api();
  server.start();
  try {
    const [firstUrl, secondUrl] = await Promise.all([
      server.startWorkletGrpc({}),
      server.startWorkletGrpc({}),
    ]);
    expect(firstUrl).toBe(secondUrl);
    await reachable(firstUrl);
    await server.stop();
    await expect(reachable(firstUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    server.start();
    await reachable(await server.startWorkletGrpc({}));
  } finally {
    await server.stop();
  }
});
it("allows a corrected listener configuration after a failed bind", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("Expected a port");
  const server = api();
  server.start();
  try {
    await expect(server.startWorkletGrpc({ port: address.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await reachable(await server.startWorkletGrpc({ port: 0 }));
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
