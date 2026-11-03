import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Sandbox } from "e2b";
import {
  runSharedExecutionCloudScenario,
  runSharedExecutionWorker,
  waitForSharedExecution,
} from "../../../../tests/support/shared-execution-cloud.js";

const apiKey = await e2bApiKey();
const adminToken = randomBytes(32).toString("base64url");
const serverSource =
  (await readFile(resolve(import.meta.dirname, "../shared-execution/dist/server.js"), "utf8")) +
  "\nawait runSharedExecutionServerFromEnvironment();\n";
const sandbox = await Sandbox.create({
  apiKey,
  secure: false,
  timeoutMs: 10 * 60_000,
  metadata: { purpose: "supertag-shared-execution-live" },
});
let serviceOutput = "";

try {
  await sandbox.files.write("/tmp/supertag-shared-execution.mjs", serverSource);
  await sandbox.commands.run(
    "mkdir -p /home/user/shared-execution/data /home/user/shared-execution/state",
    { user: "root" },
  );
  await sandbox.commands.run("node /tmp/supertag-shared-execution.mjs", {
    background: true,
    user: "root",
    envs: {
      SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
      SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID: "e2b-shared-live",
      SUPERTAG_SHARED_EXECUTION_INCARNATION_ID: sandbox.sandboxId,
      SUPERTAG_SHARED_EXECUTION_ROOT: "/home/user/shared-execution/data",
      SUPERTAG_SHARED_EXECUTION_STATE: "/home/user/shared-execution/state/state.json",
      SUPERTAG_SHARED_EXECUTION_HOST: "0.0.0.0",
      SUPERTAG_SHARED_EXECUTION_PORT: "8787",
      SUPERTAG_SHARED_EXECUTION_PROCESS_UID: "1000",
      SUPERTAG_SHARED_EXECUTION_PROCESS_GID: "1000",
    },
    onStdout: (text) => {
      serviceOutput = `${serviceOutput}${text}`.slice(-4000);
    },
    onStderr: (text) => {
      serviceOutput = `${serviceOutput}${text}`.slice(-4000);
    },
  });
  const baseUrl = `https://${sandbox.getHost(8787)}`;
  const initial = await waitForSharedExecution(baseUrl);
  const scenario = await runSharedExecutionCloudScenario(baseUrl, adminToken);

  const reconnected = await Sandbox.connect(sandbox.sandboxId, { apiKey });
  const afterReconnect = await waitForSharedExecution(`https://${reconnected.getHost(8787)}`);
  const reader = await runSharedExecutionWorker(
    baseUrl,
    adminToken,
    "reader",
    "cloud-reader-after-reconnect",
  );
  if (reader.findLast((event) => event.type === "output.message")?.message?.text !== "worker-a")
    throw new Error("Reconnected E2B sandbox did not preserve the shared workspace");
  console.log(
    JSON.stringify({
      provider: "e2b",
      sandboxId: sandbox.sandboxId,
      environmentId: initial.environmentId,
      incarnationStable: initial.incarnationId === afterReconnect.incarnationId,
      scenario,
    }),
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\nRemote service output:\n${serviceOutput}`,
  );
} finally {
  await sandbox.kill();
}

async function e2bApiKey(): Promise<string> {
  if (process.env["E2B_API_KEY"]) return process.env["E2B_API_KEY"];
  const config = JSON.parse(await readFile(join(homedir(), ".e2b", "config.json"), "utf8")) as {
    teamApiKey?: string;
  };
  if (!config.teamApiKey) throw new Error("E2B_API_KEY or ~/.e2b/config.json teamApiKey required");
  return config.teamApiKey;
}
