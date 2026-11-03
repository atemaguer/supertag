import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ModalClient, type Sandbox } from "modal";

const root = resolve(import.meta.dirname, "../../../..");
const client = new ModalClient();
const adminToken = randomBytes(32).toString("base64url");
const environmentId = "modal-mixed-mcp";
let sandbox: Sandbox | undefined;
let imageId: string | undefined;
try {
  const app = await client.apps.fromName("supertag-conformance", { createIfMissing: true });
  const manifest = JSON.parse(
    await readFile(resolve(root, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  );
  const version = manifest.dependencies["@openai/codex-sdk"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("Expected pinned Codex version");
  const image = await client.images
    .fromRegistry("node:24-bookworm-slim")
    .dockerfileCommands([
      "RUN apt-get update && apt-get install --no-install-recommends --yes ca-certificates git python3 && rm -rf /var/lib/apt/lists/*",
      `RUN npm install --global --no-audit --no-fund @openai/codex@${version}`,
    ])
    .build(app);
  imageId = image.imageId;
  sandbox = await client.sandboxes.create(app, image, {
    command: ["sleep", "infinity"],
    encryptedPorts: [8787],
    timeoutMs: 600_000,
    tags: { purpose: "supertag-mixed-mcp-conformance" },
  });
  const source = `${await readFile(
    resolve(root, "packages/runtime/environments/shared-execution/dist/server.js"),
    "utf8",
  )}\nawait runSharedExecutionServerFromEnvironment();\n`;
  await sandbox.filesystem.writeText(source, "/tmp/shared-execution.mjs");
  await sandbox.exec(["node", "/tmp/shared-execution.mjs"], {
    env: {
      SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
      SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID: environmentId,
      SUPERTAG_SHARED_EXECUTION_ROOT: "/data",
      SUPERTAG_SHARED_EXECUTION_STATE: "/state/state.json",
      SUPERTAG_SHARED_EXECUTION_HOST: "0.0.0.0",
      SUPERTAG_SHARED_EXECUTION_PORT: "8787",
      SUPERTAG_SHARED_EXECUTION_PROCESS_UID: "1000",
      SUPERTAG_SHARED_EXECUTION_PROCESS_GID: "1000",
    },
  });
  const tunnel = (await sandbox.tunnels())[8787];
  if (!tunnel) throw new Error("Missing Modal tunnel");
  const deadline = Date.now() + 30_000;
  while (true) {
    if (
      await fetch(`${tunnel.url}/healthz`)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break;
    if (Date.now() > deadline) throw new Error("Modal shared execution service did not start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const run = await promisify(execFile)(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/mixed-harness-shared-docker-live.test.ts",
      "-t",
      "routes real Claude",
    ],
    {
      cwd: root,
      timeout: 420_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        SUPERTAG_MIXED_HARNESS_SHARED_URL: tunnel.url,
        SUPERTAG_MIXED_HARNESS_ENVIRONMENT_ID: environmentId,
        SUPERTAG_MIXED_HARNESS_ADMIN_TOKEN: adminToken,
      },
    },
  );
  console.log(run.stdout);
  console.log(
    JSON.stringify({
      provider: "modal",
      sandboxId: sandbox.sandboxId,
      verification: "VERIFIED",
      harnesses: ["claude-code", "codex"],
      mcpTransports: ["stdio", "http"],
    }),
  );
} finally {
  if (sandbox) await sandbox.terminate({ wait: true });
  if (imageId) await client.images.delete(imageId).catch(() => undefined);
  client.close();
}
