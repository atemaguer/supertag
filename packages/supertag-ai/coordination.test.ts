import { describe, expect, it, vi } from "vitest";
import { CoordinationClient } from "./src/coordination.js";

function page(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("CoordinationClient", () => {
  it("reads a filtered inbox through the versioned coordination endpoint", async () => {
    const fetch = page({
      projectionVersion: 8,
      asOf: "2026-09-11T00:00:00.000Z",
      items: [],
      truncatedKinds: [],
    });
    const client = new CoordinationClient({
      baseUrl: "https://control-plane.example",
      token: "operator-secret",
      fetch,
    });

    await expect(
      client.inbox({ objectiveId: "objective-a", kind: "question", limit: 20 }),
    ).resolves.toMatchObject({ items: [] });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://control-plane.example/api/v1/coordination/inbox?objectiveId=objective-a&kind=question&limit=20",
    );
  });

  it("authenticates with a header, never in the URL or the body", async () => {
    const fetch = page({ projectionVersion: 8, asOf: "", items: [], truncatedKinds: [] });
    const client = new CoordinationClient({
      baseUrl: "https://control-plane.example/control/",
      token: "operator-secret",
      fetch,
    });

    await client.inbox();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://control-plane.example/api/v1/coordination/inbox");
    expect(String(url)).not.toContain("operator-secret");
    expect(init?.body ?? "").not.toContain("operator-secret");
    expect(init?.headers).toMatchObject({ authorization: "Bearer operator-secret" });
  });

  it("returns the API Server error and rejects paths outside the coordination surface", async () => {
    const client = new CoordinationClient({
      baseUrl: "http://127.0.0.1:3434",
      token: "operator-secret",
      fetch: page({ message: "stale revision" }, 409),
    });

    await expect(client.inbox()).rejects.toThrow("stale revision");
    await expect(client.request("/api/v1/tasks")).rejects.toThrow("coordination API");
  });

  it("requires a token and an HTTP base URL", () => {
    expect(
      () => new CoordinationClient({ baseUrl: "https://control-plane.example", token: " " }),
    ).toThrow("token is required");
    expect(
      () => new CoordinationClient({ baseUrl: "ftp://control-plane.example", token: "t" }),
    ).toThrow("HTTP or HTTPS");
  });
});
