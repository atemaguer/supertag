/** Bounded native CLI proof of the MCP-to-gRPC bridge; policy-owner recovery is tested separately. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerCoordinationGrpcRoutes } from "../apps/cli/src/coordination-grpc.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  collectTaskAttemptEvents,
  InMemorySessionStateStore,
  type TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";
import {
  GrpcCoordinationClient,
  type RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";
import { repositoryAttempt } from "../tests/support/repository-execution.js";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to use existing CLI subscription authentication");
for (const key of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
])
  delete process.env[key];
const output = resolve(".supertag/grpc-coordination-live", `${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const reports = await Promise.all(
  ["codex", "claude-code"].map(async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-grpc-manager-"));
    const token = randomUUID(),
      nonce = randomUUID();
    let calls = 0;
    const controller = {
      async authenticate(credential: string | undefined) {
        if (credential !== token) throw new Error("Invalid fixture credential");
        return { kind: "surface" };
      },
      async coordinationActions() {
        return ["read_objective"];
      },
      async commandAsAttempt(name: string) {
        if (name !== "read_objective") throw new Error("Unknown fixture tool");
        calls++;
        return { objective: { id: "probe", verification: nonce } };
      },
      async rebindExecutionCredential() {
        throw new Error("No renewal in this probe");
      },
    };
    const listener = await startWorkletGrpcServer({
      remote: {} as RemoteWorkletServer,
      registerRoutes: (router) =>
        registerCoordinationGrpcRoutes(
          router,
          controller as unknown as Parameters<typeof registerCoordinationGrpcRoutes>[1],
        ),
    });
    try {
      const base = repositoryAttempt(provider);
      const spec: TaskAttemptSpec = {
        ...base,
        coordination: { controlPlaneUrl: "http://127.0.0.1:1", token, scope: "surface" },
        input: {
          ...base.input,
          messages: [
            {
              id: "probe",
              role: "requester",
              text: "Use read_objective to read the current objective. Reply with its verification value exactly. Do not create files or use other tools.",
            },
          ],
        },
      };
      const options = {
        workspace: directory,
        profileId: "repository",
        profileRevision: "1",
        timeoutMs: 120000,
        sessionStateStore: () => new InMemorySessionStateStore(),
        coordinationFetch: () => new GrpcCoordinationClient({ baseUrl: listener.url, token }).fetch,
      };
      const worker =
        provider === "codex"
          ? createCodexWorker({
              ...options,
              executionMode: "app-server",
              model: "gpt-5.6-luna",
              maxNativeAgents: 0,
            })
          : createClaudeCodeWorker({ ...options, maxTurns: 6 });
      const events = await collectTaskAttemptEvents(worker.execute(spec));
      const completed = events.some((event) => event.type === "execution.completed");
      const verified = completed && calls > 0 && JSON.stringify(events).includes(nonce);
      const report = {
        provider,
        verified,
        completed,
        calls,
        transport: "grpc",
        harnessInterface: "MCP",
        scope: "local CLI bridge; fixture owner",
      };
      await writeFile(
        join(output, `${provider}.json`),
        JSON.stringify({ report, events }, null, 2),
        { mode: 0o600 },
      );
      if (!verified)
        throw new Error(`${provider} bridge did not verify; inspect private report ${output}`);
      return report;
    } finally {
      await listener.close();
      await rm(directory, { recursive: true, force: true });
    }
  }),
);
console.log(JSON.stringify({ verified: true, reports, output }));
