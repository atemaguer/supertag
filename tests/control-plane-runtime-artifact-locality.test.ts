import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { loadServicesFile } from "../apps/cli/src/supertag-yaml.js";
import { ArtifactCatalog } from "../packages/control-plane/src/index.js";
import { ArtifactCatalogError } from "../packages/core/src/index.js";
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
      const response = await fetch(`${connectionUrl}/api/v1/artifacts/missing/download`, {
        method: "POST",
        headers: {
          authorization: "Bearer locality-test-admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "file.txt" }),
      });
      expect(response.status).toBe(404);
      await response.body?.cancel();
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve.mock.calls[0]?.[3]?.publicUrl).toBe(local ? runtime.url : undefined);
    } finally {
      await runtime?.close();
      binding?.mockRestore();
      resolve.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
