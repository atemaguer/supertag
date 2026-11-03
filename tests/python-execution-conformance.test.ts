import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { startSharedExecutionGrpcServer } from "../packages/runtime/environments/shared-execution/src/grpc-server.js";
import { startSharedExecutionServer } from "../packages/runtime/environments/shared-execution/src/server.js";

const execute = promisify(execFile);
const python = process.env["SUPERTAG_CONFORMANCE_PYTHON"];
it.skipIf(!python)(
  "accepts an independently generated Python gRPC client over TLS",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-python-tls-"));
    const adminToken = randomUUID();
    let frontend: Awaited<ReturnType<typeof startSharedExecutionGrpcServer>> | undefined;
    let service: Awaited<ReturnType<typeof startSharedExecutionServer>> | undefined;
    try {
      const key = join(directory, "server.key");
      const cert = join(directory, "server.crt");
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ]);
      service = await startSharedExecutionServer({
        adminToken,
        environmentId: "python-conformance",
        rootDirectory: join(directory, "workspace"),
        statePath: join(directory, "state.json"),
      });
      frontend = await startSharedExecutionGrpcServer({
        service,
        tls: { key: await readFile(key), cert: await readFile(cert) },
      });
      const result = await execute(
        python as string,
        [resolve(import.meta.dirname, "fixtures/python-execution/conformance.py")],
        {
          timeout: 30_000,
          env: {
            ...process.env,
            PYTHONPATH: process.env["SUPERTAG_CONFORMANCE_BINDINGS"],
            SUPERTAG_CONFORMANCE_ENDPOINT: new URL(frontend.url).host,
            SUPERTAG_CONFORMANCE_CA: cert,
            SUPERTAG_CONFORMANCE_ADMIN: adminToken,
            SUPERTAG_CONFORMANCE_NODE: process.execPath,
          },
        },
      );
      expect(result.stdout).toContain("Python gRPC conformance passed");
      expect((await stat(join(directory, "workspace/binary.bin"))).mode & 0o777).toBe(0);
      const journal = await readFile(join(directory, "state.json"), "utf8");
      expect(journal).not.toContain(adminToken);
      expect(journal).not.toContain("python-outsider-");
    } finally {
      await frontend?.close();
      await service?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
