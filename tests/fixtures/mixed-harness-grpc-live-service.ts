import { readFile } from "node:fs/promises";
import { startSharedExecutionGrpcServer } from "../../packages/runtime/environments/shared-execution/src/grpc-server.js";
import { startSharedExecutionServer } from "../../packages/runtime/environments/shared-execution/src/server.js";

const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
const environmentId = process.env["SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID"];
if (!adminToken || !environmentId) throw new Error("Missing live execution service configuration");
const service = await startSharedExecutionServer({
  adminToken,
  environmentId,
  rootDirectory: "/data",
  statePath: "/state/state.json",
  processUid: 10001,
  processGid: 10001,
});
const frontend = await startSharedExecutionGrpcServer({
  service,
  host: "0.0.0.0",
  port: 8788,
  tls: {
    key: await readFile("/certificates/server.key"),
    cert: await readFile("/certificates/server.crt"),
  },
});
process.stdout.write("mixed Harness gRPC execution ready\n");
process.once("SIGTERM", async () => {
  await frontend.close();
  await service.close();
});
