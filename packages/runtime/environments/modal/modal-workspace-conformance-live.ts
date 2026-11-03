import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModalClient } from "modal";
import {
  runWorkspaceEnvironmentConformance,
  type WorkspaceEnvironmentConformanceFactory,
} from "../../sdk/src/conformance.ts";
import type { ExecutionEnvironment } from "../../sdk/src/index.ts";
import { bundleTaskObjects, bundleTrustedCommit } from "../../sdk/src/workspace-bundles.ts";
import { workspaceDefinition } from "../../sdk/src/workspace-environment.ts";
import {
  ModalWorkspaceEnvironment,
  nativeModalSandboxFactory,
  nativeModalWorkspaceClient,
} from "./src/index.ts";
import { LiveWorkspaceLedger } from "./src/live-workspace-ledger.ts";
import { installLiveWorkspaceSignalCleanup } from "./src/live-workspace-signals.ts";

if (process.env["SUPERTAG_LIVE_MODAL"] !== "1" || process.env["CI"])
  throw new Error("Live Modal conformance requires SUPERTAG_LIVE_MODAL=1 outside CI");

const git = promisify(execFile);
const appName = process.env["SUPERTAG_LIVE_MODAL_APP"] ?? "supertag-conformance";
const runId = randomUUID();
console.log(`Modal conformance: run ${runId} in dedicated app ${appName}`);
const ledger = new LiveWorkspaceLedger({
  workspace: nativeModalWorkspaceClient,
  sandboxes: nativeModalSandboxFactory,
  runId,
  async *listSandboxes() {
    const client = new ModalClient();
    try {
      const app = await client.apps.fromName(appName, { createIfMissing: false });
      for await (const sandbox of client.sandboxes.list({
        appId: app.appId,
        tags: { "supertag.liveRunId": runId },
      })) {
        yield {
          sandboxId: sandbox.sandboxId,
          exec: (command, options) => sandbox.exec(command, options),
          terminate: async (options) => {
            const cleanupClient = new ModalClient();
            try {
              const active = await cleanupClient.sandboxes.fromId(sandbox.sandboxId);
              return await active.terminate(options);
            } finally {
              cleanupClient.close();
            }
          },
        };
      }
    } finally {
      client.close();
    }
  },
  log: (message) => console.log(`Modal conformance: ${message}`),
});
installLiveWorkspaceSignalCleanup(process, ledger, (message) => console.error(message));
const scratch = await mkdtemp(join(tmpdir(), "supertag-live-modal-workspace-"));
/** Where the suite's small file:// Volume is copied in each live Modal sandbox. */
const LIVE_MOUNT = "/mnt/supertag-conformance-volume";
/** Runs a short check inside a started Task's sandbox and returns its exit code and output. */
async function inSandbox(
  environment: ExecutionEnvironment,
  script: string,
  path: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  const process = await environment.spawn({
    command: "sh",
    args: ["-c", script, "sh", path],
    timeoutMs: 30_000,
  });
  return process.wait();
}
const factory: WorkspaceEnvironmentConformanceFactory = async (repository) => {
  const stagingDirectory = join(scratch, "staging");
  await mkdir(stagingDirectory, { recursive: true });
  const environment = new ModalWorkspaceEnvironment({
    appName,
    stagingDirectory,
    image: "python:3.13-slim",
    createAppIfMissing: false,
    cpu: 0.125,
    // Real Modal sandboxes need more than 128 MiB to run Node.js for the MCP bridge and server;
    // the Docker reproduction keeps 128 MiB, where runc accounts less memory.
    memoryMiB: 512,
    sandboxTimeoutMs: 180_000,
    setupTimeoutMs: 180_000,
    snapshotTtlMs: 3_600_000,
    workspaceClient: ledger.workspaceClient,
    sandboxFactory: ledger.sandboxFactory,
  });
  return {
    environment,
    // The Worker Host lists and copies a small file:// Volume into each sandbox, read-only.
    copyMount: {
      path: LIVE_MOUNT,
      read: async (started, relative) => {
        const result = await inSandbox(started, 'cat -- "$1"', `${LIVE_MOUNT}/${relative}`);
        return result.exitCode === 0 ? result.stdout : undefined;
      },
      writable: async (started, relative) =>
        (
          await inSandbox(
            started,
            'test -n "$(find "$1" -maxdepth 0 -perm /222)"',
            `${LIVE_MOUNT}/${relative}`,
          )
        ).exitCode === 0,
      exists: async (started, relative) =>
        (await inSandbox(started, 'test -e "$1" || test -L "$1"', `${LIVE_MOUNT}/${relative}`))
          .exitCode === 0,
    },
    define: async ({ taskId, trustedCommit, setup }) =>
      workspaceDefinition({
        workspace: repository.workspace,
        // Live Modal receives only git objects, never a host path or credential.
        source: "https://example.invalid/supertag-conformance.git",
        trustedCommit,
        content: await bundleTrustedCommit({
          repository: repository.path,
          trustedCommit,
          directory: stagingDirectory,
        }),
        ...(setup === undefined ? {} : { setup }),
        harness: { commands: ["sh"] },
        taskId,
      }),
    objects: ({ trustedCommit, head }) =>
      bundleTaskObjects({
        repository: repository.path,
        trustedCommit,
        head,
        directory: stagingDirectory,
      }),
    deliver: async (branch, result) => {
      if (result.objects === undefined) return;
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("MODAL_TOKEN_") &&
            ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].includes(key),
        ),
      );
      await git(
        "git",
        [
          "-C",
          repository.path,
          "-c",
          "core.hooksPath=/dev/null",
          "fetch",
          "--no-tags",
          result.objects.bundle,
          `+refs/heads/${branch}:refs/heads/${branch}`,
        ],
        { env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
      );
    },
  };
};
let failed = false;
try {
  const report = await runWorkspaceEnvironmentConformance(factory);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) failed = true;
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  try {
    await ledger.cleanup();
  } catch (error) {
    failed = true;
    console.error(error);
  }
  await ledger.settled();
  const { sandboxes, images } = ledger.remaining;
  if (sandboxes.length || images.length) failed = true;
  console.log(`Modal conformance: remaining ${JSON.stringify(ledger.remaining)}`);
  await rm(scratch, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
