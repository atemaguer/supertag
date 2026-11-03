import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SharedExecutionEnvironmentProvider } from "supertag-ai/environments/shared-execution";
import { createClaudeCodeWorker } from "supertag-ai/harnesses/claude-code";
import { createCodexWorker } from "supertag-ai/harnesses/codex";
import { connectWorklet } from "supertag-ai/transport";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  ToolProviderRegistry,
} from "supertag-ai/worker";

import { exampleMcpInputs } from "./mcp-tools.mjs";

if (process.argv.includes("--help")) {
  console.log(
    "node worker.mjs claude|codex (SUPERTAG_EXAMPLE_STATE or SUPERTAG_EXAMPLE_WORKER_CONFIG)",
  );
} else {
  const name = process.argv[2];
  if (!["claude", "codex"].includes(name)) throw new Error("Choose claude or codex");
  const stateDirectory = resolve(
    process.env.SUPERTAG_EXAMPLE_STATE ?? join(homedir(), ".supertag/examples/shared-organization"),
  );
  const config = JSON.parse(
    await readFile(
      process.env.SUPERTAG_EXAMPLE_WORKER_CONFIG ?? join(stateDirectory, `${name}.json`),
      "utf8",
    ),
  );
  // Use the private example configuration, not a caller's production Control Plane settings.
  for (const key of Object.keys(process.env))
    if (key.startsWith("SUPERTAG_") && !key.startsWith("SUPERTAG_EXAMPLE_"))
      delete process.env[key];
  // Keep native CLI login state; prevent environment API keys from changing the billing path.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete process.env[key];
  const localState = resolve(
    process.env.SUPERTAG_EXAMPLE_WORKER_STATE ?? join(stateDirectory, name),
  );
  await mkdir(localState, { recursive: true, mode: 0o700 });
  const timeoutMs = Number(process.env.SUPERTAG_EXAMPLE_ATTEMPT_MS ?? 300000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("SUPERTAG_EXAMPLE_ATTEMPT_MS must be a positive integer");
  const environment = new SharedExecutionEnvironmentProvider({
    baseUrl: config.executionUrl,
    adminToken: config.executionToken,
    environmentId: "shared-organization",
    // Access covers the native deadline plus startup/cleanup; expiry still forbids new work.
    accessTtlMs: timeoutMs + 60_000,
    guarantees: {
      filesystemIsolation: "sandbox",
      networkPolicy: "none",
      processTreeTermination: true,
      scopedHttp: false,
    },
  });
  const options = {
    workspace: join(dirname(fileURLToPath(import.meta.url)), "seed"),
    workerId: `${name}-worker`,
    profileId: `shared-${name}`,
    profileRevision: "1",
    maxConcurrency: 1,
    timeoutMs,
    harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: localState }),
    executionEnvironment: environment,
    redactValues: [
      config.credential,
      config.executionToken,
      ...(config.mcpToken ? [config.mcpToken] : []),
    ],
    ...(config.mcpToken
      ? {
          toolProviders: new ToolProviderRegistry([
            {
              provider: "example-notes",
              resolve: async ({ task: attempt }) => ({
                provider: "example-notes",
                inputs: exampleMcpInputs({
                  actor: name === "claude" ? "claude-code" : "codex",
                  taskId: attempt.taskId,
                  attemptId: attempt.attemptId,
                  token: config.mcpToken,
                }),
              }),
            },
          ]),
          selectMcpClient: (input) =>
            input.id.startsWith("example-")
              ? "execution-environment"
              : name === "codex" && input.audience === "manager"
                ? input.binding.kind === "mcp-stdio"
                  ? "execution-environment"
                  : "worker-host"
                : "harness-runtime",
        }
      : {}),
  };
  const worker =
    name === "claude"
      ? createClaudeCodeWorker({
          ...options,
          model: process.env.SUPERTAG_EXAMPLE_CLAUDE_MODEL ?? "sonnet",
          maxTurns: 24,
        })
      : createCodexWorker({
          ...options,
          model: process.env.SUPERTAG_EXAMPLE_CODEX_MODEL ?? "gpt-5.6-luna",
          executionMode: "app-server",
          maxNativeAgents: 0,
          sandboxMode: "external",
        });
  const worklet = new LocalWorklet(`${name}-worklet`, config.hostId, [worker]);
  const durableWorklet = new DurableLocalWorklet(
    worklet,
    new FileAttemptJournal(join(localState, "journal")),
  );
  const connection = await connectWorklet({
    url: config.workletUrl,
    credential: config.credential,
    worklet,
    durableWorklet,
    onError: (error) => {
      const message = String(error)
        .replaceAll(config.credential, "[redacted]")
        .replaceAll(config.executionToken, "[redacted]");
      process.stderr.write(`${message}\n`);
    },
  });
  process.stdout.write(`${name} Worker connected\n`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await durableWorklet.shutdown("Example Worker stopped");
      await connection.stop();
      process.exit(0);
    });
}
