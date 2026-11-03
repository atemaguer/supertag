import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForControlPlaneHealth } from "../apps/cli/src/up.ts";

afterEach(() => vi.unstubAllGlobals());

describe("supertag up Control Plane health", () => {
  it("retries transient fetch failures and unhealthy responses before accepting health", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("fetch timed out"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(waitForControlPlaneHealth("http://127.0.0.1:3434")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/healthz"))).toBe(true);
  });
});
