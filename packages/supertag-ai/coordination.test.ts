import { describe, expect, it, vi } from "vitest";
import { CoordinationClient, InboxItemKind } from "./src/coordination.js";

function reply(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("CoordinationClient", () => {
  it("lists a filtered inbox through InboxService.ListInboxItems", async () => {
    const fetch = reply({ asOf: "2026-09-11T00:00:00Z", items: [], truncatedKinds: [] });
    const client = new CoordinationClient({
      baseUrl: "https://control-plane.example",
      token: "operator-secret",
      fetch,
    });

    await expect(
      client.inbox({ objectiveId: "objective-a", kind: InboxItemKind.QUESTION, pageSize: 20 }),
    ).resolves.toMatchObject({ items: [] });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://control-plane.example/supertag.operator.v1.InboxService/ListInboxItems",
    );
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
      objectiveId: "objective-a",
      kind: "INBOX_ITEM_KIND_QUESTION",
      pageSize: 20,
    });
  });

  it("authenticates with a header, never in the URL or the body", async () => {
    const fetch = reply({ items: [] });
    const client = new CoordinationClient({
      baseUrl: "https://control-plane.example/control/",
      token: "operator-secret",
      fetch,
    });

    await client.inbox();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("operator-secret");
    expect(new TextDecoder().decode(init?.body as Uint8Array)).not.toContain("operator-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operator-secret");
  });

  it("returns the Control Plane's error message", async () => {
    const client = new CoordinationClient({
      baseUrl: "http://127.0.0.1:3434",
      token: "operator-secret",
      fetch: reply({ code: "permission_denied", message: "missing read_coordination_inbox" }, 403),
    });

    await expect(client.inbox()).rejects.toThrow("missing read_coordination_inbox");
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
