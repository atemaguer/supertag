import { describe, expect, it, vi } from "vitest";
import { CoordinationClient } from "./src/coordination.js";

describe("CoordinationClient", () => {
  it("sends authenticated commands without exposing the token in its URL or body", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CoordinationClient({
      baseUrl: "https://control-plane.example/control/",
      token: "operator-secret",
      fetch,
    });

    await expect(client.command("read_objective", { objectiveId: "objective-a" })).resolves.toEqual(
      { accepted: true },
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://control-plane.example/api/v1/coordination/read_objective");
    expect(String(url)).not.toContain("operator-secret");
    expect(init?.body).not.toContain("operator-secret");
    expect(init?.headers).toMatchObject({ authorization: "Bearer operator-secret" });
  });

  it("returns the API Server error and rejects paths outside the coordination surface", async () => {
    const client = new CoordinationClient({
      baseUrl: "http://127.0.0.1:3434",
      token: "operator-secret",
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ message: "stale revision" }), { status: 409 }),
      ),
    });

    await expect(client.command("update_team", { expectedRevision: 1 })).rejects.toThrow(
      "stale revision",
    );
    await expect(client.request("/api/v1/tasks")).rejects.toThrow("coordination API");
  });

  it("reads a filtered inbox through the versioned coordination endpoint", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            projectionVersion: 3,
            asOf: "2026-09-11T00:00:00.000Z",
            items: [],
            truncatedKinds: [],
          }),
          { status: 200 },
        ),
    );
    const client = new CoordinationClient({
      baseUrl: "https://control-plane.example",
      token: "operator-secret",
      fetch,
    });

    await client.inbox({
      objectiveId: "objective-a",
      kind: "task_review",
      limit: 20,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://control-plane.example/api/v1/coordination/inbox?objectiveId=objective-a&kind=task_review&limit=20",
    );
  });
});
