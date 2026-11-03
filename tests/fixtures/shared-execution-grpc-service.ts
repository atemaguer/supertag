import { readFile } from "node:fs/promises";
import { startSharedExecutionGrpcServer } from "../../packages/runtime/environments/shared-execution/src/grpc-server.js";
import { startSharedExecutionServer } from "../../packages/runtime/environments/shared-execution/src/server.js";

const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
if (!adminToken) throw new Error("Missing execution service credential");
const service = await startSharedExecutionServer({
  adminToken,
  environmentId: "docker-grpc-shared",
  rootDirectory: "/data",
  statePath: "/state/state.json",
  host: "0.0.0.0",
  port: 8787,
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
process.stdout.write("shared gRPC execution ready\n");
process.once("SIGTERM", async () => {
  await frontend.close();
  await service.close();
});
