import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Sandbox } from "e2b";
import { waitForSharedExecution } from "../../../../tests/support/shared-execution-cloud.js";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const conformanceScript = join(repositoryRoot, "scripts/codex-native-conformance.ts");
const apiKey = await e2bApiKey();
const codexVersion = await pinnedCodexVersion();
const adminToken = randomBytes(32).toString("base64url");
const environmentId = "e2b-codex-split-live";
const outputDirectory = join(
  repositoryRoot,
  ".supertag",
  "native-conformance",
  `e2b-${Date.now()}`,
);
await mkdir(outputDirectory, { recursive: true });
const serverSource =
  (await readFile(resolve(import.meta.dirname, "../shared-execution/dist/server.js"), "utf8")) +
  "\nawait runSharedExecutionServerFromEnvironment();\n";
const sandbox = await Sandbox.create({
  apiKey,
  secure: false,
  allowInternetAccess: true,
  timeoutMs: 10 * 60_000,
  metadata: { purpose: "supertag-codex-split-live" },
});
let serviceOutput = "";

try {
  await sandbox.commands.run(
    `npm install --global --no-audit --no-fund ${shellQuote(`@openai/codex@${codexVersion}`)}`,
    { user: "root", timeoutMs: 180_000 },
  );
  const installed = await sandbox.commands.run("command -v codex && codex --version", {
    timeoutMs: 30_000,
  });
  if (!installed.stdout.split("\n").includes(`codex-cli ${codexVersion}`))
    throw new Error(`E2B did not install the pinned Codex CLI ${codexVersion}`);

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
      SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID: environmentId,
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
  const service = await waitForSharedExecution(baseUrl);
  await execute(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions=development",
      conformanceScript,
      "--live",
      "--split",
      "--backend",
      "shared",
      "--base-url",
      baseUrl,
      "--environment-id",
      environmentId,
      "--output",
      outputDirectory,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240_000,
    },
  );
  const report = JSON.parse(
    await readFile(join(outputDirectory, "report.json"), "utf8"),
  ) as ConformanceReport;
  const phase = report.reports[0];
  if (report.backend !== "shared" || report.split !== true)
    throw new Error("E2B conformance did not report split shared execution");
  if (phase?.verification !== "VERIFIED")
    throw new Error("E2B Codex split execution did not verify its workspace result");
  const manifestEvent = phase.manifest;
  const manifest = manifestEvent?.manifest;
  if (
    manifestEvent?.type !== "runtime-inputs.resolved" ||
    !manifest ||
    manifest.harnessRuntime?.placement !== "local" ||
    manifest.executionEnvironment.placement !== "remote" ||
    manifest.harnessRuntime.id === manifest.executionEnvironment.id
  )
    throw new Error("E2B Codex split execution did not preserve its runtime boundary");
  const provenance = manifest.harness.provenance;
  if (
    provenance?.["protocol"] !== "codex-exec-server" ||
    provenance["protocolVersion"] !== 1 ||
    provenance["execServerVersion"] !== codexVersion ||
    provenance["executionEnvironmentId"] !== manifest.executionEnvironment.id ||
    provenance["transport"] !== "stdio-websocket-bridge" ||
    typeof provenance["execServerSessionId"] !== "string" ||
    !provenance["execServerSessionId"]
  )
    throw new Error("E2B Codex split execution provenance is incomplete");

  console.log(
    JSON.stringify({
      provider: "e2b",
      sandboxId: sandbox.sandboxId,
      environmentId: service.environmentId,
      incarnationId: service.incarnationId,
      codexVersion,
      verification: phase.verification,
      split: true,
      protocol: provenance["protocol"],
      transport: provenance["transport"],
      sessionObserved: true,
      report: outputDirectory,
    }),
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\nRemote service output:\n${serviceOutput}`,
  );
} finally {
  await sandbox.kill();
}

interface ConformanceReport {
  readonly backend: string;
  readonly split: boolean;
  readonly reports: readonly {
    readonly verification: string;
    readonly manifest?: {
      readonly type: string;
      readonly manifest: {
        readonly harness: { readonly provenance?: Record<string, unknown> };
        readonly harnessRuntime?: { readonly id: string; readonly placement: string };
        readonly executionEnvironment: {
          readonly id: string;
          readonly provider: string;
          readonly placement: string;
        };
      };
    };
  }[];
}

async function pinnedCodexVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.["@openai/codex-sdk"];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("Codex Harness must pin an exact SDK version for split conformance");
  return version;
}

async function e2bApiKey(): Promise<string> {
  if (process.env["E2B_API_KEY"]) return process.env["E2B_API_KEY"];
  const config = JSON.parse(await readFile(join(homedir(), ".e2b", "config.json"), "utf8")) as {
    teamApiKey?: string;
  };
  if (!config.teamApiKey) throw new Error("E2B_API_KEY or ~/.e2b/config.json teamApiKey required");
  return config.teamApiKey;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
