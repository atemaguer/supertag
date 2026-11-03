import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.js";
import { startSharedExecutionServer } from "../packages/runtime/environments/shared-execution/src/server.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import {
  collectTaskAttemptEvents,
  LocalHarnessRuntimeProvider,
  type TaskAttemptSpec,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";

it("runs a local Claude Harness against the shared execution service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-claude-shared-"));
  const source = join(directory, "source");
  const sharedRoot = join(directory, "shared");
  await mkdir(source);
  await writeFile(join(source, "input.txt"), "shared evidence");
  const service = await startSharedExecutionServer({
    rootDirectory: sharedRoot,
    statePath: join(directory, "state", "state.json"),
    environmentId: "claude-shared-test",
    adminToken: "test-admin-token",
  });
  const queryAgent = ((params: { readonly options: QueryOptions }) => {
    return (async function* () {
      const { options } = params;
      const server = options.mcpServers["supertag_execution"];
      if (server?.type !== "sdk") throw new Error("Missing shared execution tools");
      const registered = server.instance._registeredTools;
      expect(options.cwd).not.toContain(sharedRoot);
      expect(options.disallowedTools).toEqual(
        expect.arrayContaining(["Read", "Write", "Edit", "Bash"]),
      );
      expect(await registered.read.handler({ file_path: "input.txt" }, {})).toMatchObject({
        content: [{ text: "shared evidence" }],
      });
      await registered.write.handler({ file_path: "created.txt", content: "from host a" }, {});
      expect(await registered.bash.handler({ command: "cat created.txt" }, {})).toMatchObject({
        content: [{ text: "from host a" }],
      });
      await writeTranscript(options, "shared-session");
      yield {
        type: "result",
        subtype: "success",
        result: "shared execution complete",
        session_id: "shared-session",
      };
    })();
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  try {
    const worker = createClaudeCodeWorker({
      workspace: source,
      queryAgent,
      harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: directory }),
      executionEnvironment: new SharedExecutionEnvironmentProvider({
        baseUrl: service.url,
        adminToken: "test-admin-token",
        environmentId: service.environmentId,
      }),
    });
    const events = await collectTaskAttemptEvents(worker.execute(attempt()));
    expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
    expect(terminalOutputText(events)).toBe("shared execution complete");
    expect(await readFile(join(sharedRoot, "workspace", "created.txt"), "utf8")).toBe(
      "from host a",
    );
    expect(await readFile(join(source, "input.txt"), "utf8")).toBe("shared evidence");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

type ToolResult = { readonly content: readonly { readonly text: string }[] };
type QueryOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly disallowedTools: readonly string[];
  readonly mcpServers: Readonly<
    Record<
      string,
      {
        readonly type: string;
        readonly instance: {
          readonly _registeredTools: Record<
            string,
            {
              handler(input: Record<string, unknown>, extra: unknown): Promise<ToolResult>;
            }
          >;
        };
      }
    >
  >;
};

async function writeTranscript(options: QueryOptions, sessionId: string): Promise<void> {
  const key = (await realpath(options.cwd)).replace(/[^a-zA-Z0-9]/gu, "-");
  const path = join(
    options.env["CLAUDE_CONFIG_DIR"] as string,
    "projects",
    key,
    `${sessionId}.jsonl`,
  );
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "user", sessionId, message: "evidence" })}\n`);
}

function attempt(): TaskAttemptSpec {
  const capturedAt = "2026-09-14T00:00:00.000Z";
  return {
    version: 1,
    taskId: "task-shared",
    attemptId: "attempt-shared",
    tag: { id: "tag-engineering", name: "Engineering" },
    input: {
      origin: {
        surface: "cli",
        accountId: "local",
        scope: "terminal",
        sessionKey: "shared-test",
        occurredAt: capturedAt,
      },
      messages: [{ id: "request", role: "requester", text: "Use the shared workspace" }],
    },
    execution: {},
    workerProfile: { id: "local-claude-code", revision: "1" },
    contextPlan: { version: 1, capturedAt, sets: [] },
    authorization: {
      version: 1,
      capturedAt,
      tag: { id: "tag-engineering", name: "Engineering" },
      origin: {
        tagRouteId: "route",
        surfaceAccountId: "local",
        provider: "cli",
        scope: "terminal",
      },
      requester: { id: "user", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:write", "commands:execute", "web:fetch"],
    },
  };
}
