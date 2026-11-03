import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Sandbox } from "e2b";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live for ephemeral E2B and CLI testing");
const root = resolve(import.meta.dirname, "../../../..");
const output =
  process.env["SUPERTAG_SESSION_CLOUD_OUTPUT"] ?? `/tmp/supertag-session-e2b-${Date.now()}`;
await mkdir(output, { recursive: true, mode: 0o700 });
const config = process.env["E2B_API_KEY"]
  ? undefined
  : JSON.parse(await readFile(join(homedir(), ".e2b/config.json"), "utf8"));
const apiKey = process.env["E2B_API_KEY"] ?? config?.teamApiKey;
if (typeof apiKey !== "string" || !apiKey) throw new Error("E2B credential unavailable");
const token = randomUUID();
const environmentId = `session-live-${randomUUID()}`;
const sandbox = await Sandbox.create({
  apiKey,
  secure: false,
  allowInternetAccess: true,
  timeoutMs: 900_000,
  metadata: { purpose: "supertag-session-persistence-live" },
});
try {
  const manifest = JSON.parse(
    await readFile(resolve(root, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  );
  const version = manifest.dependencies["@openai/codex-sdk"];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Codex SDK version must be pinned");
  await sandbox.commands.run(`npm install --global --no-audit --no-fund @openai/codex@${version}`, {
    user: "root",
    timeoutMs: 180_000,
  });
  const source = `${await readFile(resolve(root, "packages/runtime/environments/shared-execution/dist/server.js"), "utf8")}\nawait runSharedExecutionServerFromEnvironment();\n`;
  await sandbox.files.write("/tmp/server.mjs", source);
  await sandbox.commands.run("node /tmp/server.mjs", {
    background: true,
    user: "root",
    envs: {
      SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: token,
      SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID: environmentId,
      SUPERTAG_SHARED_EXECUTION_ROOT: "/home/user/session-proof/data",
      SUPERTAG_SHARED_EXECUTION_STATE: "/home/user/session-proof/state.json",
      SUPERTAG_SHARED_EXECUTION_HOST: "0.0.0.0",
      SUPERTAG_SHARED_EXECUTION_PORT: "8787",
      SUPERTAG_SHARED_EXECUTION_PROCESS_UID: "1000",
      SUPERTAG_SHARED_EXECUTION_PROCESS_GID: "1000",
    },
  });
  const baseUrl = `https://${sandbox.getHost(8787)}`;
  const deadline = Date.now() + 60_000;
  while (
    !(await fetch(`${baseUrl}/healthz`)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline) throw new Error("E2B service readiness timed out");
    await new Promise((done) => setTimeout(done, 500));
  }
  const reports: unknown[] = [];
  for (const provider of ["codex", "claude-code"]) {
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
          resolve(output, provider),
          "--database",
          process.env["SUPERTAG_SESSION_CLOUD_DATABASE"] ?? "sqlite",
        ],
        {
          cwd: root,
          timeout: 420_000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            SUPERTAG_SESSION_LIVE_EXECUTION_URL: baseUrl,
            SUPERTAG_SESSION_LIVE_EXECUTION_TOKEN: token,
            SUPERTAG_SESSION_LIVE_EXECUTION_ID: environmentId,
          },
        },
      );
      reports.push(JSON.parse(result.stdout));
      console.log(result.stdout.trim());
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      const message = (failure.stderr ?? failure.message ?? "failed")
        .replaceAll(token, "[redacted]")
        .replaceAll(apiKey, "[redacted]");
      await writeFile(resolve(output, `${provider}-failure.log`), message, { mode: 0o600 });
      throw new Error(`E2B ${provider} Session probe failed; see ${output}`);
    }
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      { provider: "e2b", sandboxId: sandbox.sandboxId, verification: "VERIFIED", reports },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ verification: "VERIFIED", output }));
} finally {
  await sandbox.kill();
}
