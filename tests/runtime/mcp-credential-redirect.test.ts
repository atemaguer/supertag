import { afterEach, expect, it, vi } from "vitest";
import { credentialRetryingFetch } from "../../packages/runtime/sdk/src/http-mcp-tools.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Records each hop's URL and headers; answers from a route table without opening sockets. */
function stubFetch(routes: Record<string, () => Response>) {
  const hops: { url: string; method: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: URL, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      hops.push({
        url: target.href,
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      const route = routes[target.href];
      if (route === undefined) throw new Error(`unexpected request to ${target.href}`);
      return route();
    }),
  );
  return hops;
}

const redirect = (location: string, status = 307) =>
  new Response(null, { status, headers: { location } });

it("drops every configured credential header when a redirect leaves the origin", async () => {
  const hops = stubFetch({
    "https://mcp.example.test/mcp": () => redirect("https://mcp.example.test/v2/mcp"),
    "https://mcp.example.test/v2/mcp": () => redirect("https://elsewhere.example.test/mcp"),
    "https://elsewhere.example.test/mcp": () => new Response("ok"),
  });
  const credentials = { Authorization: "Bearer secret", "X-Api-Key": "key-secret" };
  const send = credentialRetryingFetch(credentials, async () => credentials);
  // The MCP transport also copies its requestInit headers into each request.
  const response = await send(new URL("https://mcp.example.test/mcp"), {
    method: "POST",
    body: "{}",
    headers: { ...credentials, "content-type": "application/json", "mcp-protocol-version": "1" },
  });
  expect(await response.text()).toBe("ok");
  expect(hops.map((hop) => hop.url)).toEqual([
    "https://mcp.example.test/mcp",
    "https://mcp.example.test/v2/mcp",
    "https://elsewhere.example.test/mcp",
  ]);
  for (const hop of hops.slice(0, 2)) {
    expect(hop.headers["authorization"]).toBe("Bearer secret");
    expect(hop.headers["x-api-key"]).toBe("key-secret");
  }
  const crossOrigin = hops[2]?.headers ?? {};
  expect(crossOrigin["authorization"]).toBeUndefined();
  expect(crossOrigin["x-api-key"]).toBeUndefined();
  expect(crossOrigin["mcp-protocol-version"]).toBe("1");
  expect(JSON.stringify(hops[2])).not.toContain("secret");
  expect(hops[2]?.method).toBe("POST");
});

it("strips refreshed header names too and bounds redirect chains", async () => {
  let refused = true;
  const hops = stubFetch({
    "https://mcp.example.test/mcp": () => {
      if (refused) {
        refused = false;
        return new Response(null, { status: 401 });
      }
      return redirect("https://elsewhere.example.test/mcp", 303);
    },
    "https://elsewhere.example.test/mcp": () => new Response("ok"),
  });
  const send = credentialRetryingFetch({ Authorization: "Bearer old" }, async () => ({
    "X-Session-Token": "new-secret",
  }));
  await send(new URL("https://mcp.example.test/mcp"), {
    method: "POST",
    body: "{}",
    headers: { Authorization: "Bearer old" },
  });
  const last = hops.at(-1);
  expect(last?.url).toBe("https://elsewhere.example.test/mcp");
  expect(last?.method).toBe("GET");
  expect(JSON.stringify(last)).not.toMatch(/secret|old/u);

  stubFetch({ "https://mcp.example.test/loop": () => redirect("https://mcp.example.test/loop") });
  const looping = credentialRetryingFetch({}, async () => ({}));
  await expect(looping(new URL("https://mcp.example.test/loop"), {})).rejects.toThrow(/too many/u);
});
