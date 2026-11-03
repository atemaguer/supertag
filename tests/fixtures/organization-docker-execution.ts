import { startSharedExecutionServer } from "../../packages/runtime/environments/shared-execution/src/server.js";

const adminToken = process.env["SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN"];
if (!adminToken) throw new Error("Missing execution credential");
await startSharedExecutionServer({
  adminToken,
  environmentId: "organization-shared",
  rootDirectory: "/data",
  statePath: "/state/state.json",
  host: "0.0.0.0",
  port: 8787,
  processUid: 10001,
  processGid: 10001,
});
process.stdout.write("Organization execution ready\n");
