import { createServer, type IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { attemptArtifactMetadata } from "../apps/cli/src/worker.js";

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

it("rebinds an Attempt's credential once after a Control Plane restart, then fails closed", async () => {
  const requests: { path: string; authorization: string | undefined; body: string }[] = [];
  let accepted = "rebound-token";
  const server = createServer((request, response) => {
    void body(request).then((text) => {
      requests.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: text,
      });
      if (request.url === "/internal/v1/coordination/rebind") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "rebound-token" }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${accepted}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Expired Attempt" }));
        return;
      }
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const controlPlaneUrl = `http://127.0.0.1:${address.port}`;
  try {
    const metadata = attemptArtifactMetadata({ controlPlaneUrl, token: "original-token" });
    const receipt = { digest: `sha256:${"a".repeat(64)}`, sizeBytes: 3 };
    await metadata("/internal/v1/artifacts/catalog/upload", receipt);
    expect(requests).toEqual([
      {
        path: "/internal/v1/artifacts/catalog/upload",
        authorization: "Bearer original-token",
        body: JSON.stringify(receipt),
      },
      {
        path: "/internal/v1/coordination/rebind",
        authorization: "Bearer original-token",
        body: "",
      },
      {
        path: "/internal/v1/artifacts/catalog/upload",
        authorization: "Bearer rebound-token",
        body: JSON.stringify(receipt),
      },
    ]);
    // The rebound credential is kept for later requests.
    requests.length = 0;
    await metadata("/internal/v1/artifacts/catalog/upload", receipt);
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer rebound-token"]);
    // A credential refused again after one rebind is an error, never a loop.
    accepted = "never";
    requests.length = 0;
    await expect(metadata("/internal/v1/artifacts/catalog/upload", receipt)).rejects.toThrow(
      "HTTP 401",
    );
    expect(requests.map((request) => request.path)).toEqual([
      "/internal/v1/artifacts/catalog/upload",
      "/internal/v1/coordination/rebind",
      "/internal/v1/artifacts/catalog/upload",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("refuses a non-loopback HTTP Control Plane before sending the credential", async () => {
  const metadata = attemptArtifactMetadata({
    controlPlaneUrl: "http://control-plane.example",
    token: "attempt-secret",
  });
  await expect(metadata("/internal/v1/artifacts/catalog/upload", {})).rejects.toThrow(
    "Artifact Control Plane requires HTTPS outside loopback",
  );
});
