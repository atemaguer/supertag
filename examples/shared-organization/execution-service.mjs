import { spawn } from "node:child_process";
import { chmod, chown, mkdir } from "node:fs/promises";
import { startSharedExecutionServer } from "supertag-ai/environments/shared-execution";

const adminToken = process.env.SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN;
if (!adminToken) throw new Error("Missing execution service credential");
let mcp;
if (process.env.SUPERTAG_EXAMPLE_MCP_TOKEN) {
  await mkdir("/state/example-mcp", { recursive: true });
  await chown("/state/example-mcp", 0, 0);
  await chmod("/state/example-mcp", 0o700);
  mcp = spawn("node", ["/app/mcp-fixture.cjs"], {
    env: {
      PATH: process.env.PATH,
      MCP_TRANSPORT: "http",
      MCP_FIXTURE_TOKEN: process.env.SUPERTAG_EXAMPLE_MCP_TOKEN,
    },
    stdio: "ignore",
  });
}
const server = await startSharedExecutionServer({
  adminToken,
  environmentId: "shared-organization",
  rootDirectory: "/data",
  statePath: "/state/state.json",
  host: "0.0.0.0",
  port: 8787,
  processUid: 10001,
  processGid: 10001,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    mcp?.kill();
    process.exit(0);
  });
