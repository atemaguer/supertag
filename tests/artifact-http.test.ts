import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { handleArtifactRequest } from "../apps/cli/src/artifact-http.js";
import type { ArtifactCatalog } from "../packages/control-plane/src/index.js";

/** A catalog that fails the test if the handler consults it for a byte request. */
function untouchedCatalog(calls: string[]): ArtifactCatalog {
  return new Proxy({} as ArtifactCatalog, {
    get: (_target, property) => () => {
      calls.push(String(property));
      throw new Error(`catalog.${String(property)} must not be called for artifact bytes`);
    },
  });
}

it("serves no artifact bytes: every byte route is gone, whatever the credential", async () => {
  const bytes = Buffer.from("bytes that belong on a Worker Host");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const calls: string[] = [];
  const server = createServer((request, response) => {
    void handleArtifactRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://localhost"),
      untouchedCatalog(calls),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const method of ["PUT", "GET", "POST", "PATCH", "DELETE", "HEAD"])
      for (const authorization of [undefined, "Bearer writer"]) {
        const response = await fetch(`${origin}/internal/v1/artifacts/${digest}`, {
          method,
          headers: {
            "content-type": "application/octet-stream",
            ...(authorization ? { authorization } : {}),
          },
          ...(["PUT", "POST", "PATCH"].includes(method) ? { body: bytes } : {}),
        });
        expect(response.status, `${method} ${authorization ?? "anonymous"}`).toBe(404);
        expect(response.headers.get("content-type")).toBe("application/json");
        const body = Buffer.from(await response.arrayBuffer());
        expect(body.includes(bytes)).toBe(false);
        if (method !== "HEAD")
          expect(JSON.parse(body.toString())).toEqual({ error: "Artifact not found" });
      }
    // The catalog is never asked, so nothing is authenticated or recorded for these requests.
    expect(calls).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("hides internal failures behind a catalog message, without storage wording", async () => {
  const server = createServer((request, response) => {
    void handleArtifactRequest(request, response, new URL(request.url ?? "/", "http://localhost"), {
      execution: async () => {
        throw new Error("private database detail");
      },
    } as unknown as ArtifactCatalog);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/v1/artifacts/catalog/find`,
      { method: "POST", headers: { authorization: "Bearer reader" }, body: "{}" },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Artifact catalog unavailable" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
