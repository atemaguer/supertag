import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { runDeploymentCommand, verifyDeploymentGrpc } from "../apps/cli/src/deploy.js";
import {
  CoordinationService,
  RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";
import { sharedTokenAuthentication } from "./support/worklet-authentication.js";

const { Code, ConnectError } = createRequire(
  new URL("../packages/runtime/transport/package.json", import.meta.url),
)("@connectrpc/connect");

it("verifies TLS RPC routing and fails closed for an accepting or broken coordination service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-deploy-grpc-"));
  let mode: "deny" | "accept" | "unavailable" = "deny";
  const received: string[] = [];
  const remote = new RemoteWorkletServer({
    server: createServer(),
    authenticateWorklet: sharedTokenAuthentication("unused-host-token"),
  });
  let close: (() => Promise<void>) | undefined;
  try {
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    const cert = await readFile(certPath, "utf8");
    const server = await startWorkletGrpcServer({
      remote,
      tls: { key: await readFile(keyPath), cert },
      registerRoutes(router) {
        router.service(CoordinationService, {
          listTools(_, context) {
            received.push(context.requestHeader.get("authorization") ?? "");
            if (mode === "accept") return { tools: [] };
            throw new ConnectError(
              "probe",
              mode === "deny" ? Code.Unauthenticated : Code.Unavailable,
            );
          },
          callTool() {
            throw new ConnectError("probe", Code.Unimplemented);
          },
        });
      },
    });
    close = server.close;
    const edge = createSecureServer(
      { key: await readFile(keyPath), cert },
      (_request, response) => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("edge authentication required");
      },
    );
    await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
    try {
      const address = edge.address();
      if (!address || typeof address === "string") throw new Error("No edge address");
      await expect(verifyDeploymentGrpc(`https://127.0.0.1:${address.port}`, cert)).rejects.toThrow(
        "gRPC verification failed",
      );
    } finally {
      await new Promise<void>((resolve) => edge.close(() => resolve()));
    }
    await expect(verifyDeploymentGrpc(server.url, cert)).resolves.toContain(
      "invalid execution credential rejection passed",
    );
    expect(received).toEqual(["Bearer supertag-deployment-verification-invalid-credential"]);
    await expect(verifyDeploymentGrpc(server.url)).rejects.toThrow("gRPC verification failed");
    mode = "accept";
    await expect(verifyDeploymentGrpc(server.url, cert)).rejects.toThrow("accepted an invalid");
    mode = "unavailable";
    await expect(verifyDeploymentGrpc(server.url, cert)).rejects.toThrow(
      "gRPC verification failed",
    );
  } finally {
    await close?.();
    await remote.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it.each([
  "http://127.0.0.1:1234",
  "https://user:secret@example.com",
  "https://example.com/path",
  "https://example.com?token=secret",
  "not-a-url",
])("rejects unsafe verification address %s", async (url) => {
  await expect(verifyDeploymentGrpc(url)).rejects.toThrow(/gRPC deployment URL/);
});

afterEach(() => vi.unstubAllEnvs());
it("selects the generated Fly gRPC profile through the CLI and refuses platforms it no longer defines", async () => {
  vi.stubEnv("SUPERTAG_DATABASE_URL", "postgresql://test:password@db.example.com/supertag");
  vi.stubEnv("SUPERTAG_ADMIN_TOKEN", "private-admin-test");
  vi.stubEnv("SUPERTAG_COORDINATION_URL", "https://control.example.com");
  const result = await runDeploymentCommand(["check", "--platform", "fly", "--transport", "grpc"]);
  expect(result).toContain("deploy/fly/fly.grpc.toml");
  expect(result).not.toContain("private-admin-test");
  await expect(
    runDeploymentCommand(["check", "--platform", "render", "--transport", "grpc"]),
  ).rejects.toThrow("Deployment platform must be one of");
});
