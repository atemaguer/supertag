import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedExecutionEnvironmentProvider } from "../packages/runtime/environments/shared-execution/src/index.js";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  collectTaskAttemptEvents,
  LocalHarnessRuntimeProvider,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  ToolProviderRegistry,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";

import { SHARED_MCP_FIXTURE_SOURCE, sharedMcpInputs } from "./support/shared-mcp-fixture.ts";

const execute = promisify(execFile);
const hostedUrl = process.env["SUPERTAG_MIXED_HARNESS_SHARED_URL"];
const requestedTransport = process.env["SUPERTAG_MIXED_HARNESS_SHARED_TRANSPORT"] ?? "http";
if (requestedTransport !== "http" && requestedTransport !== "grpc")
  throw new Error("Mixed Harness execution transport must be http or grpc");
const transport = requestedTransport;
const tlsCaPath = process.env["SUPERTAG_MIXED_HARNESS_TLS_CA_PATH"];
const enabled =
  process.env["SUPERTAG_MIXED_HARNESS_SHARED_DOCKER_LIVE"] === "1" || hostedUrl !== undefined;
const suite = enabled ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..");
const environmentId =
  process.env["SUPERTAG_MIXED_HARNESS_ENVIRONMENT_ID"] ?? "docker-mixed-harness";
const adminToken =
  process.env["SUPERTAG_MIXED_HARNESS_ADMIN_TOKEN"] ?? `docker-mixed-${randomUUID()}`;

suite("mixed Harness collaboration through one shared execution environment", () => {
  let directory = "";
  let source = "";
  let container = "";
  let image = "";
  let baseUrl = "";
  let tlsCa: string | undefined;

  beforeAll(async () => {
    if (tlsCaPath) tlsCa = await readFile(tlsCaPath, "utf8");
    directory = await mkdtemp(join(tmpdir(), "supertag-mixed-harness-shared-"));
    source = join(directory, "source");
    await Promise.all([
      mkdir(source),
      mkdir(join(directory, "workspace")),
      mkdir(join(directory, "state")),
    ]);
    await writeFile(join(source, "objective.txt"), "Find one shared conclusion.\n");
    if (hostedUrl) {
      baseUrl = hostedUrl;
      return;
    }
    const suffix = randomUUID().slice(0, 8);
    container = `supertag-mixed-harness-${suffix}`;
    image = `supertag-mixed-harness:${suffix}`;
    await execute(
      "docker",
      [
        "build",
        "--build-arg",
        `SUPERTAG_CODEX_VERSION=${await pinnedCodexVersion()}`,
        "-t",
        image,
        "packages/runtime/environments/shared-execution",
      ],
      { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 },
    );
    await execute(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-p",
        "127.0.0.1::8787",
        "-e",
        "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
        "-e",
        `SUPERTAG_SHARED_EXECUTION_ENVIRONMENT_ID=${environmentId}`,
        "-v",
        `${join(directory, "workspace")}:/data`,
        "-v",
        `${join(directory, "state")}:/state`,
        image,
      ],
      { env: { ...process.env, SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: adminToken } },
    );
    const port = await execute("docker", ["port", container, "8787/tcp"]);
    const match = /:(\d+)\s*$/u.exec(port.stdout.trim());
    if (!match) throw new Error(`Could not parse Docker port: ${port.stdout}`);
    baseUrl = `http://127.0.0.1:${match[1]}`;
    await eventually(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
  }, 180_000);

  afterAll(async () => {
    if (container) await execute("docker", ["rm", "-f", container]).catch(() => undefined);
    if (image) await execute("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("lets Claude produce work that a separately authenticated Codex Attempt consumes", async () => {
    const environment = new SharedExecutionEnvironmentProvider({
      baseUrl,
      transport,
      ...(tlsCa === undefined ? {} : { tlsCa }),
      adminToken,
      environmentId,
      guarantees: {
        filesystemIsolation: "sandbox",
        networkPolicy: "none",
        processTreeTermination: true,
        scopedHttp: false,
      },
    });
    const claudeEvents = await collectTaskAttemptEvents(
      createClaudeCodeWorker({
        workspace: source,
        maxTurns: 8,
        timeoutMs: 180_000,
        harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: directory }),
        executionEnvironment: environment,
      }).execute(
        attempt(
          "local-claude-code",
          "claude-producer",
          "Read objective.txt. Write claude-note.txt containing exactly: evidence from claude followed by a newline. Read it back, then reply exactly CLAUDE_HANDOFF_READY.",
        ),
      ),
    );
    assertCompleted(claudeEvents, "CLAUDE_HANDOFF_READY");

    const codexEvents = await collectTaskAttemptEvents(
      createCodexWorker({
        workspace: source,
        executionMode: "app-server",
        model: "gpt-5.6-luna",
        maxNativeAgents: 0,
        sandboxMode: "external",
        timeoutMs: 180_000,
        harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: directory }),
        executionEnvironment: environment,
      }).execute(
        attempt(
          "local-codex",
          "codex-consumer",
          "Read objective.txt and claude-note.txt. Write codex-note.txt containing exactly: evidence from claude accepted by codex followed by a newline. Read it back, then reply exactly CODEX_HANDOFF_VERIFIED. Do not spawn subagents.",
        ),
      ),
    );
    assertCompleted(codexEvents, "CODEX_HANDOFF_VERIFIED");

    const inspectAttempt = attempt("inspector", "handoff-inspector", "Inspect shared handoff");
    const inspector = await environment.provision({
      task: inspectAttempt,
      profile: {
        ref: inspectAttempt.workerProfile,
        workerType: "supertag",
        harness: { provider: "codex" },
        execution: { provider: environment.id, lifetime: { scope: "attempt" } },
      },
      plan: {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "unrestricted" },
      },
    });
    try {
      expect(await inspector.read("workspace/claude-note.txt")).toBe("evidence from claude\n");
      expect(await inspector.read("workspace/codex-note.txt")).toBe(
        "evidence from claude accepted by codex\n",
      );
    } finally {
      await inspector.dispose();
    }
    const claudePlacement = placement(claudeEvents);
    const codexPlacement = placement(codexEvents);
    expect(claudePlacement.executionEnvironment.provenance.transport).toBe(transport);
    expect(codexPlacement.executionEnvironment.provenance.transport).toBe(transport);
    expect(claudePlacement.executionEnvironment.provenance.incarnationId).toBe(
      codexPlacement.executionEnvironment.provenance.incarnationId,
    );
    expect(claudePlacement.executionEnvironment.provenance.accessId).not.toBe(
      codexPlacement.executionEnvironment.provenance.accessId,
    );
    expect(claudePlacement.harness.provenance.protocol).toBe("claude-split-execution-bridge");
    expect(codexPlacement.harness.provenance.protocol).toBe("codex-exec-server");
  }, 360_000);
  it("routes real Claude and Codex MCP calls into the same sandbox with policy enforcement", async () => {
    const fixtureToken = `fixture-${randomUUID()}`;
    const environment = new SharedExecutionEnvironmentProvider({
      baseUrl,
      transport,
      ...(tlsCa === undefined ? {} : { tlsCa }),
      adminToken,
      environmentId,
      guarantees: {
        filesystemIsolation: "sandbox",
        networkPolicy: "none",
        processTreeTermination: true,
        scopedHttp: false,
      },
    });
    const inspectAttempt = attempt("inspector", "mcp-inspector", "Inspect shared tools");
    const inspectPlan = {
      files: [{ path: "mcp-fixture.cjs", content: SHARED_MCP_FIXTURE_SOURCE }],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "unrestricted" as const },
    };
    const inspector = await environment.provision({
      task: inspectAttempt,
      profile: {
        ref: inspectAttempt.workerProfile,
        workerType: "supertag",
        harness: { provider: "codex" },
        execution: { provider: environment.id, lifetime: { scope: "attempt" } },
      },
      plan: inspectPlan,
    });
    await inspector.prepare(inspectPlan);
    const sharedWorkspace = inspector.resolvePath("workspace");
    await inspector
      .spawn({ command: "mkdir", args: ["-p", sharedWorkspace] })
      .then((process) => process.wait());
    await inspector.spawn({
      command: "node",
      args: [inspector.resolvePath("mcp-fixture.cjs")],
      environment: {
        MCP_TRANSPORT: "http",
        MCP_WORKSPACE: sharedWorkspace,
        MCP_FIXTURE_TOKEN: fixtureToken,
      },
      streamOutput: true,
    });
    try {
      const toolProviders = new ToolProviderRegistry([
        {
          provider: "shared-fixture",
          resolve: async () => ({
            provider: "shared-fixture",
            inputs: sharedMcpInputs(sharedWorkspace, fixtureToken),
          }),
        },
      ]);
      const common = {
        workspace: source,
        timeoutMs: 180_000,
        toolProviders,
        selectMcpClient: () => "execution-environment" as const,
        harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: directory }),
        executionEnvironment: environment,
      };
      const claudeEvents = await collectTaskAttemptEvents(
        createClaudeCodeWorker({ ...common, maxTurns: 10 }).execute(
          attempt(
            "local-claude-code",
            "claude-mcp",
            "Test the supplied MCP tools. Call shared_stdio exchange with collection docs, action publish, text exactly CLAUDE_MCP_EVIDENCE. Then call shared_http exchange with collection private and action read; this is an intentional negative test and must be denied. Finally call shared_http exchange with collection docs and action read, verify CLAUDE_MCP_EVIDENCE, and reply CLAUDE_MCP_VERIFIED. Use the MCP tools, not shell or file tools. Do not spawn subagents.",
          ),
        ),
      );
      assertCompleted(claudeEvents, "CLAUDE_MCP_VERIFIED");
      const codexEvents = await collectTaskAttemptEvents(
        createCodexWorker({
          ...common,
          executionMode: "app-server",
          model: "gpt-5.6-luna",
          maxNativeAgents: 0,
          sandboxMode: "external",
        }).execute(
          attempt(
            "local-codex",
            "codex-mcp",
            "Test the supplied MCP tools. Call shared_http exchange with collection docs and action read; verify CLAUDE_MCP_EVIDENCE. Call shared_stdio exchange with collection private and action read; this intentional negative test must be denied. Then call shared_http exchange with collection docs, action publish, text exactly CODEX_ACCEPTED_CLAUDE_MCP_EVIDENCE. Finally call shared_stdio exchange with collection docs and action read to verify that value, and reply CODEX_MCP_VERIFIED. Use MCP tools, not shell or file tools. Do not spawn subagents.",
          ),
        ),
      );
      assertCompleted(codexEvents, "CODEX_MCP_VERIFIED");
      expect(await inspector.read("workspace/mcp-note.txt")).toBe(
        "CODEX_ACCEPTED_CLAUDE_MCP_EVIDENCE",
      );
      const calls = (await inspector.read("workspace/mcp-calls.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(5);
      expect(calls.every((call) => call.collection === "docs" && call.name === "exchange")).toBe(
        true,
      );
      expect(new Set(calls.map((call) => call.transport))).toEqual(new Set(["stdio", "http"]));
      expect((await inspector.read("workspace/mcp-closed.txt")).trim().split("\n")).toHaveLength(2);
      for (const events of [claudeEvents, codexEvents]) {
        expect(placement(events).harness.provenance.mcpClients).toEqual([
          { client: "execution-environment", server: "shared_stdio", transport: "mcp-stdio" },
          { client: "execution-environment", server: "shared_http", transport: "mcp-http" },
        ]);
        expect(JSON.stringify(events)).not.toContain(fixtureToken);
      }
      expect(placement(claudeEvents).executionEnvironment.provenance.incarnationId).toBe(
        placement(codexEvents).executionEnvironment.provenance.incarnationId,
      );
    } finally {
      await inspector.dispose();
    }
  }, 360_000);
});

function assertCompleted(events: readonly TaskAttemptEvent[], marker: string): void {
  const failed = events.find((event) => event.type === "execution.failed");
  expect(failed, JSON.stringify(failed)).toBeUndefined();
  expect(events.at(-1)?.type, JSON.stringify(events)).toBe("execution.completed");
  expect(terminalOutputText(events)).toContain(marker);
}

function placement(events: readonly TaskAttemptEvent[]) {
  const event = events.find((candidate) => candidate.type === "runtime-inputs.resolved");
  if (event?.type !== "runtime-inputs.resolved") throw new Error("Missing runtime manifest");
  return event.manifest as typeof event.manifest & {
    readonly harness: { readonly provenance: Record<string, unknown> };
    readonly executionEnvironment: {
      readonly provenance: {
        readonly incarnationId: string;
        readonly accessId: string;
        readonly transport: string;
      };
    };
  };
}

function attempt(profileId: string, name: string, text: string): TaskAttemptSpec {
  const capturedAt = new Date().toISOString();
  return {
    version: 1,
    taskId: `task-${name}-${randomUUID()}`,
    attemptId: `attempt-${name}-${randomUUID()}`,
    tag: { id: `tag-${name}`, name },
    input: {
      origin: {
        surface: "cli",
        accountId: "local",
        scope: "terminal",
        sessionKey: name,
        occurredAt: capturedAt,
      },
      messages: [{ id: "request", role: "requester", text }],
    },
    execution: {},
    workerProfile: { id: profileId, revision: "1" },
    contextPlan: { version: 1, capturedAt, sets: [] },
    authorization: {
      version: 1,
      capturedAt,
      tag: { id: `tag-${name}`, name },
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

async function pinnedCodexVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "packages/runtime/harnesses/codex/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.["@openai/codex-sdk"];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("Codex Harness must pin an exact SDK version for split conformance");
  return version;
}

async function eventually(check: () => Promise<true | undefined>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Shared execution service did not become healthy");
}
