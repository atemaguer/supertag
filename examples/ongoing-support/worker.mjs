import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCodeWorker } from "supertag-ai/harnesses/claude-code";
import { createCodexWorker } from "supertag-ai/harnesses/codex";
import { connectWorklet } from "supertag-ai/transport";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  ToolProviderRegistry,
  WorkletArtifactStore,
} from "supertag-ai/worker";
import { coordinationClient, supportWorker } from "./application.mjs";

const name = process.argv[2];
if (!["manager", "analyst"].includes(name)) throw new Error("Choose manager or analyst");
const config = JSON.parse(await readFile(process.env.SUPPORT_WORKER_CONFIG, "utf8"));
const directory = resolve(process.env.SUPPORT_WORKER_STATE);
await mkdir(directory, { recursive: true, mode: 0o700 });
// Artifact bytes stay on this machine. Both example Workers run here and share one directory, so
// the manager reads the analyst's exact copy; the Control Plane records only digests and sizes.
const artifactStore = (spec) => {
  const { catalog } = coordinationClient(spec);
  return new WorkletArtifactStore({
    directory: join(directory, "..", "artifacts"),
    publish: ({ ref, sizeBytes }) => catalog("upload", { digest: ref.digest, sizeBytes }),
    resolve: (ref) => catalog("resolve-transfer", { artifactId: ref.artifactId, path: ref.path }),
  });
};
for (const key of Object.keys(process.env))
  if (key.startsWith("SUPERTAG_")) delete process.env[key];
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
const options = {
  workerId: `support-${name}`,
  profileId: `support-${name}`,
  profileRevision: "1",
  maxConcurrency: 1,
  workspace: join(dirname(fileURLToPath(import.meta.url)), "workspace"),
  timeoutMs: 180000,
  redactValues: [config.credential, config.policyToken],
  artifactStore,
  ...(name === "manager"
    ? {
        toolProviders: new ToolProviderRegistry([
          {
            provider: "support-policy",
            resolve: async () => ({
              provider: "support-policy",
              inputs: [
                {
                  id: "support-policy",
                  kind: "tool",
                  required: true,
                  audience: "manager",
                  capability: {
                    id: "support-policy",
                    provider: "support-policy",
                    operations: [
                      {
                        name: "policy_status",
                        effect: "read",
                        actions: ["policies:read"],
                        resourceArgumentPolicies: [
                          {
                            match: "scope",
                            prefix: "collection:",
                            components: [{ arguments: ["collection"] }],
                          },
                        ],
                      },
                      {
                        name: "operation_status",
                        effect: "read",
                        actions: ["policies:read"],
                        resourceArgumentPolicies: [
                          {
                            match: "scope",
                            prefix: "collection:",
                            components: [{ arguments: ["collection"] }],
                          },
                        ],
                      },
                      {
                        name: "apply_policy",
                        effect: "write",
                        actions: ["policies:write"],
                        resourceArgumentPolicies: [
                          {
                            match: "scope",
                            prefix: "collection:",
                            components: [{ arguments: ["collection"] }],
                          },
                        ],
                      },
                    ],
                    authorization: {
                      provider: "support-policy",
                      resources: [{ surfaceAccountId: "example", scope: "collection:support" }],
                    },
                  },
                  binding: {
                    kind: "mcp-stdio",
                    name: "support_policy",
                    command: process.execPath,
                    args: [fileURLToPath(new URL("./policy-mcp.mjs", import.meta.url))],
                    runtimeEnvironment: {
                      SUPPORT_POLICY_URL: config.policyUrl,
                      SUPPORT_POLICY_TOKEN: config.policyToken,
                    },
                  },
                },
              ],
            }),
          },
        ]),
      }
    : {}),
};
const worker =
  process.env.SUPPORT_MODE === "reference"
    ? supportWorker({ name, config, artifactStore })
    : name === "manager"
      ? createClaudeCodeWorker({
          ...options,
          model: process.env.SUPPORT_CLAUDE_MODEL ?? "sonnet",
          maxTurns: 32,
        })
      : createCodexWorker({
          ...options,
          model: process.env.SUPPORT_CODEX_MODEL ?? "gpt-5.6-luna",
          executionMode: "app-server",
          maxNativeAgents: 0,
        });
const worklet = new LocalWorklet(`support-${name}`, config.hostId, [worker]);
const durableWorklet = new DurableLocalWorklet(
  worklet,
  new FileAttemptJournal(join(directory, "journal")),
);
const connection = await connectWorklet({
  url: config.workletUrl,
  credential: config.credential,
  worklet,
  durableWorklet,
  onError: (error) =>
    console.error(
      String(error)
        .replaceAll(config.credential, "[redacted]")
        .replaceAll(config.policyToken, "[redacted]"),
    ),
});
console.log(`${name} connected`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await durableWorklet.shutdown("Example stopped");
    await connection.stop();
    process.exit(0);
  });
