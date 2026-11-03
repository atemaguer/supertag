import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "../apps/cli/src/gateway.ts";
import type { SurfaceController } from "../apps/cli/src/gateway-surfaces.ts";

describe("Gateway draining", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("refuses new ingress and waits for both an active request and surface shutdown", async () => {
    const requestStarted = deferred<void>();
    const releaseRequest = deferred<void>();
    const releaseSurfaces = deferred<void>();
    const surfaceController = {
      start: vi.fn(async () => {}),
      stop: vi.fn(() => releaseSurfaces.promise),
    } as unknown as SurfaceController;
    const server = createServer();
    const handleRequest = vi.fn(async (_request, response) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      response.writeHead(200).end("complete");
    });
    const gateway = new Gateway({
      server,
      host: "127.0.0.1",
      port: 0,
      surfaceController,
      handleRequest,
    });
    cleanups.push(() => gateway.stop());

    const url = await gateway.start();
    expect(surfaceController.start).toHaveBeenCalledOnce();
    expect(server.listenerCount("request")).toBe(1);

    const response = fetch(url);
    await requestStarted.promise;

    gateway.beginDrain();
    expect(server.listenerCount("request")).toBe(1);
    expect(surfaceController.stop).toHaveBeenCalledOnce();

    const refused = await fetch(`${url}/webhooks/slack/test-account`, { method: "POST" });
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toEqual({ error: "control_plane_draining" });
    expect(handleRequest).toHaveBeenCalledOnce();

    let drained = false;
    const drain = gateway.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseRequest.resolve();
    await expect(response.then((result) => result.text())).resolves.toBe("complete");
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseSurfaces.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(surfaceController.stop).toHaveBeenCalledOnce();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value as T),
  };
}
