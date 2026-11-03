import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ModalClient, type Sandbox } from "modal";
import {
  runSharedExecutionCloudScenario,
  runSharedExecutionWorker,
  waitForSharedExecution,
} from "../../../../tests/support/shared-execution-cloud.js";

const adminToken = randomBytes(32).toString("base64url");
const suffix = randomUUID().slice(0, 8);
const volumeName = `supertag-shared-live-${suffix}`;
const client = new ModalClient();
const app = await client.apps.fromName("supertag-shared-execution-live", {
  createIfMissing: true,
});
const volume = await client.volumes.fromName(volumeName, { createIfMissing: true });
const image = client.images.fromRegistry("node:24-alpine");
const serverSource =
  (await readFile(resolve(import.meta.dirname, "../shared-execution/dist/server.js"), "utf8")) +
  "\nawait runSharedExecutionServerFromEnvironment();\n";
let active: Sandbox | undefined;

try {
  const first = await startSandbox(randomUUID());
  active = first.sandbox;
  const initial = await waitForSharedExecution(first.baseUrl);
  const scenario = await runSharedExecutionCloudScenario(first.baseUrl, adminToken);
  const staleAccess = await issueAccess(first.baseUrl);
  const sync = await first.sandbox.exec(["sync", "/shared"]);
  if ((await sync.wait()) !== 0) throw new Error("Modal Volume sync failed");
  await first.sandbox.terminate({ wait: true });
  active = undefined;

  const replacement = await startSandbox(randomUUID());
  active = replacement.sandbox;
  const replaced = await waitForSharedExecution(replacement.baseUrl);
  if (initial.incarnationId === replaced.incarnationId)
    throw new Error("Replacement Modal sandbox reused the old incarnation ID");
  const fenced = await fetch(`${replacement.baseUrl}/v1/operations/stale-access-probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${staleAccess}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "file.read", path: "pooled.txt", maximumBytes: 1024 }),
  });
  if (fenced.status !== 409)
    throw new Error(`Replacement Modal sandbox did not fence old access: ${fenced.status}`);
  const reader = await runSharedExecutionWorker(
    replacement.baseUrl,
    adminToken,
    "reader",
    "modal-reader-after-replacement",
  );
  if (reader.findLast((event) => event.type === "output.message")?.message?.text !== "worker-a")
    throw new Error("Replacement Modal sandbox did not restore the shared Volume workspace");
  console.log(
    JSON.stringify({
      provider: "modal",
      environmentId: initial.environmentId,
      firstSandboxId: first.sandbox.sandboxId,
      replacementSandboxId: replacement.sandbox.sandboxId,
      incarnationReplaced: true,
      oldAccessFenced: true,
      volumeRestored: true,
      scenario,
    }),
  );
} finally {
  if (active) await active.terminate({ wait: true }).catch(() => undefined);
  await client.volumes.delete(volumeName, { allowMissing: true }).catch(() => undefined);
  client.close();
}

async function startSandbox(incarnationId: string) {
  const sandbox = await client.sandboxes.create(app, image, {
    command: ["sleep", "infinity"],
    encryptedPorts: [8787],
    timeoutMs: 10 * 60_000,
    volumes: { "/shared": volume },
    tags: { purpose: "supertag-shared-execution-live" },
  });
  try {
    await sandbox.filesystem.writeText(serverSource, "/tmp/supertag-shared-execution.mjs");
    await sandbox.exec(["node", "/tmp/supertag-shared-execution.mjs"], {
      env: {
        SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken,
        SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID: "modal-shared-live",
        SUPERTAG_SHARED_EXECUTION_INCARNATION_ID: incarnationId,
        SUPERTAG_SHARED_EXECUTION_ROOT: "/shared/data",
        SUPERTAG_SHARED_EXECUTION_STATE: "/shared/state/state.json",
        SUPERTAG_SHARED_EXECUTION_HOST: "0.0.0.0",
        SUPERTAG_SHARED_EXECUTION_PORT: "8787",
        SUPERTAG_SHARED_EXECUTION_PROCESS_UID: "1000",
        SUPERTAG_SHARED_EXECUTION_PROCESS_GID: "1000",
      },
    });
    const tunnels = await sandbox.tunnels();
    const tunnel = tunnels[8787];
    if (!tunnel) throw new Error("Modal did not provide the shared execution tunnel");
    return { sandbox, baseUrl: tunnel.url };
  } catch (error) {
    await sandbox.terminate({ wait: true }).catch(() => undefined);
    throw error;
  }
}

async function issueAccess(baseUrl: string): Promise<string> {
  const accessId = randomUUID();
  const accessToken = `stx_${randomBytes(32).toString("base64url")}`;
  const response = await fetch(`${baseUrl}/v1/accesses/${accessId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      taskId: "modal-replacement-probe",
      attemptId: "before-replacement",
      tagId: "tag-live",
      accessToken,
      ttlMs: 60_000,
    }),
  });
  if (!response.ok) throw new Error(`Could not issue Modal replacement probe: ${response.status}`);
  return accessToken;
}
