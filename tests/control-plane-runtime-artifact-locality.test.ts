import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { workClient } from "../apps/cli/src/operator-client.js";
import { loadServicesFile } from "../apps/cli/src/supertag-yaml.js";
import { ArtifactCatalog } from "../packages/control-plane/src/index.js";
import { ArtifactCatalogError } from "../packages/core/src/index.js";
import { DrizzleStore } from "../packages/store/src/index.js";
import { migrateSqlite } from "./support/database.js";

it.each([
  ["127.0.0.1", false, true],
  ["127.0.0.2", false, true],
  ["::ffff:127.0.0.1", false, true],
  ["0.0.0.0", false, false],
  ["0.0.0.0", true, false],
  ["::", false, false],
  ["::", true, false],
] as const)(
  "checks the listener before local downloads (%s, YAML URL %s)",
  async (host, yaml, local) => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-locality-"));
    const databasePath = join(directory, "state.db");
    const resolve = vi
      .spyOn(ArtifactCatalog.prototype, "resolveOperatorDownload")
      .mockRejectedValue(new ArtifactCatalogError(404, "No artifact"));
    const cataloged = vi
      .spyOn(DrizzleStore.prototype, "findCapturedArtifact")
      .mockResolvedValue({ id: "missing", sessionId: "unknown-session", entries: [] } as never);
    vi.stubEnv("SUPERTAG_COORDINATION_URL", undefined);
    // macOS does not bind every numeric loopback form. Keep the configured host
    // for the policy check, but route these test sockets through 127.0.0.1.
    const listen = Server.prototype.listen;
    const binding =
      host === "127.0.0.2" || host === "::ffff:127.0.0.1"
        ? vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args) {
            if (args[1] === host) args[1] = "127.0.0.1";
            return Reflect.apply(listen, this, args);
          })
        : undefined;
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
    try {
      await migrateSqlite(databasePath);
      const path = join(directory, "supertag.yaml");
      await writeFile(
        path,
        `services:\n  control-plane: { type: control-plane, ports: ["${host.includes(":") ? `[${host}]` : host}:3434"] }\n`,
      );
      const service = (await loadServicesFile({ files: [path], environment: {} })).services[0];
      if (service?.type !== "control-plane") throw new Error("Missing Control Plane service");
      runtime = await startControlPlaneRuntime({
        host,
        port: 0,
        databaseUrl: `file:${databasePath}`,
        stateDirectory: directory,
        adminToken: "locality-test-admin",
        ...(yaml ? { coordinationUrl: service.url } : {}),
      });
      const connectionUrl = runtime.url.replace(/^http:\/\/.*:/u, "http://127.0.0.1:");
      await expect(
        workClient({ url: connectionUrl, token: "locality-test-admin" }).resolveArtifactDownload({
          artifactId: "missing",
          path: "file.txt",
        }),
      ).rejects.toMatchObject({ code: Code.NotFound });
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve.mock.calls[0]?.[3]?.publicUrl).toBe(local ? runtime.url : undefined);
      // The peer is the listener socket's, never a header.
      expect(resolve.mock.calls[0]?.[3]?.operatorAddress).toMatch(/127\.0\.0\.1$/u);
    } finally {
      await runtime?.close();
      binding?.mockRestore();
      resolve.mockRestore();
      cataloged.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
