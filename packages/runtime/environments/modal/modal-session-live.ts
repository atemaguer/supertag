import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ModalClient, type Sandbox } from "modal";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live for ephemeral Modal and CLI testing");
const root = resolve(import.meta.dirname, "../../../..");
const output =
  process.env["SUPERTAG_SESSION_CLOUD_OUTPUT"] ?? `/tmp/supertag-session-modal-${Date.now()}`;
await mkdir(output, { recursive: true, mode: 0o700 });
const client = new ModalClient();
const token = randomUUID();
const environmentId = `session-live-${randomUUID()}`;
let sandbox: Sandbox | undefined;
let imageId: string | undefined;
try {
  const app = await client.apps.fromName("supertag-conformance", { createIfMissing: false });
  const manifest = JSON.parse(
    await readFile(resolve(root, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  );
  const version = manifest.dependencies["@openai/codex-sdk"];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Codex SDK version must be pinned");
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
    timeoutMs: 900_000,
    tags: { purpose: "supertag-session-persistence-live" },
  });
  const source = `${await readFile(resolve(root, "packages/runtime/environments/shared-execution/dist/server.js"), "utf8")}\nawait runSharedExecutionServerFromEnvironment();\n`;
  await sandbox.filesystem.writeText(source, "/tmp/server.mjs");
  await sandbox.exec(["node", "/tmp/server.mjs"], {
    env: {
      SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: token,
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
  if (!tunnel) throw new Error("Modal tunnel unavailable");
  const deadline = Date.now() + 60_000;
  while (
    !(await fetch(`${tunnel.url}/healthz`)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline) throw new Error("Modal service readiness timed out");
    await new Promise((done) => setTimeout(done, 500));
  }
  const reports: unknown[] = [];
  for (const provider of ["codex", "claude-code"]) {
    const directory = resolve(output, provider);
    try {
      const result = await promisify(execFile)(
        "pnpm",
        [
          "exec",
          "tsx",
          "--conditions=development",
          "scripts/session-persistence-live.ts",
          "--live",
          "--provider",
          provider,
          "--output",
          directory,
          "--database",
          process.env["SUPERTAG_SESSION_CLOUD_DATABASE"] ?? "sqlite",
        ],
        {
          cwd: root,
          timeout: 420_000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            SUPERTAG_SESSION_LIVE_EXECUTION_URL: tunnel.url,
            SUPERTAG_SESSION_LIVE_EXECUTION_TOKEN: token,
            SUPERTAG_SESSION_LIVE_EXECUTION_ID: environmentId,
          },
        },
      );
      reports.push(JSON.parse(result.stdout));
      console.log(result.stdout.trim());
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      const message = (failure.stderr ?? failure.message ?? "failed").replaceAll(
        token,
        "[redacted]",
      );
      await writeFile(resolve(output, `${provider}-failure.log`), message, { mode: 0o600 });
      throw new Error(`Modal ${provider} Session probe failed; see ${output}`);
    }
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      { provider: "modal", sandboxId: sandbox.sandboxId, verification: "VERIFIED", reports },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ verification: "VERIFIED", output }));
} finally {
  if (sandbox) await sandbox.terminate({ wait: true });
  if (imageId) await client.images.delete(imageId).catch(() => undefined);
  client.close();
}
