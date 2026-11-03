import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectExecutionEnvironmentMcpClient,
  describeToolCall,
  FileToolEffectJournal,
  LocalExecutionEnvironmentProvider,
  McpToolAdapter,
  ReliableToolInvokerRegistry,
  type ToolAdapter,
  ToolAdapterRegistry,
  ToolEffectInDoubtError,
  type ToolEffectJournal,
  type ToolEffectRecord,
  type ToolInput,
  type ToolInvoker,
  ToolInvokerRegistry,
  toolCallOutcomeFromText,
} from "../../packages/runtime/sdk/src/index.ts";
import { repositoryAttempt } from "../support/repository-execution.ts";

interface NativeAdaptation {
  readonly adapter: string;
  readonly operations: readonly string[];
}

class NativeAdapter implements ToolAdapter<NativeAdaptation> {
  readonly id = "native";

  supports(input: ToolInput): boolean {
    return input.binding.kind === "native";
  }

  adapt(input: ToolInput): NativeAdaptation {
    if (input.binding.kind !== "native") throw new Error("Expected native binding");
    return {
      adapter: input.binding.adapter,
      operations: input.capability.operations.map((operation) => operation.name),
    };
  }
}

describe("transport-neutral tool adaptation", () => {
  it("runs a stdio MCP client and server inside the execution environment", async () => {
    const attempt = repositoryAttempt("environment-mcp-client");
    const profile = {
      ref: attempt.workerProfile,
      workerType: "supertag",
      harness: { provider: "codex" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
    };
    const plan = {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" as const },
    };
    const environment = await new LocalExecutionEnvironmentProvider().provision({
      task: attempt,
      profile,
      plan,
    });
    await environment.prepare(plan);
    const server = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "environment-test", version: "1" } } });
  if (message.method === "tools/list")
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "read_environment", description: "Read environment state", inputSchema: { type: "object" } },
      { name: "not_admitted", inputSchema: { type: "object" } },
    ] } });
  if (message.method === "tools/call")
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: process.env.TEST_ENVIRONMENT_SECRET + ":" + message.params.arguments.value }] } });
});
`;
    const input: ToolInput = {
      id: "environment-tools",
      kind: "tool",
      required: true,
      capability: {
        id: "environment-tools",
        provider: "test",
        operations: [
          {
            name: "read_environment",
            effect: "read",
            actions: ["environment:read"],
            resourceArgumentPolicies: [
              { match: "scope", prefix: "value:", components: [{ arguments: ["value"] }] },
            ],
          },
        ],
        authorization: {
          provider: "test",
          resources: [{ surfaceAccountId: "environment", scope: "value:sandbox" }],
        },
      },
      binding: {
        kind: "mcp-stdio",
        name: "environment-tools",
        command: process.execPath,
        args: ["-e", server],
        runtimeEnvironment: { TEST_ENVIRONMENT_SECRET: "inside" },
      },
    };
    let connection: Awaited<ReturnType<typeof connectExecutionEnvironmentMcpClient>> | undefined;
    try {
      connection = await connectExecutionEnvironmentMcpClient(environment, input, {
        nodeCommand: process.execPath,
      });
      expect(connection.client).toBe("execution-environment");
      expect(connection.tools.map((tool) => tool.name)).toEqual(["read_environment"]);
      await expect(connection.callTool("read_environment", { value: "sandbox" })).resolves.toEqual({
        content: [{ type: "text", text: "inside:sandbox" }],
      });
      await expect(connection.callTool("not_admitted", {})).rejects.toThrow("not admitted");
    } finally {
      await connection?.close();
      await environment.dispose("completed");
    }
  });

  it("routes one MCP server through an explicitly selected client boundary", () => {
    const input = hostedMcpSearch();

    expect(new McpToolAdapter("harness-runtime").adapt(input)).toMatchObject({
      client: "harness-runtime",
      transport: "mcp-http",
      name: "search",
      url: "https://tools.example/mcp",
      toolNames: ["search_documents"],
    });
    expect(new McpToolAdapter("execution-environment").adapt(input)).toMatchObject({
      client: "execution-environment",
      transport: "mcp-http",
      name: "search",
    });
  });

  it("adapts a native SDK binding without changing its semantic capability", async () => {
    const input = nativeIssueComment();
    const adapted = await new ToolAdapterRegistry([new NativeAdapter()]).adapt([input], {
      harnessId: "custom-agent-sdk",
    });

    expect(adapted).toEqual([{ adapter: "octokit", operations: ["add_issue_comment"] }]);
    expect(
      describeToolCall([input], {
        id: "call-1",
        binding: { kind: "native", name: "github-sdk" },
        operation: "add_issue_comment",
        arguments: { owner: "atemaguer", repo: "supertag", issue_number: 3 },
      }),
    ).toMatchObject({
      capabilityId: "github:account-1",
      provider: "github",
      binding: { kind: "native", name: "github-sdk" },
      operation: "add_issue_comment",
      effect: "write",
      actions: ["issues:comment"],
      resources: [{ surfaceAccountId: "account-1", scope: "repository:123" }],
    });
  });

  it("fails closed when a required binding has no compatible adapter", async () => {
    await expect(
      new ToolAdapterRegistry([new McpToolAdapter("harness-runtime")]).adapt(
        [nativeIssueComment()],
        {
          harnessId: "codex",
        },
      ),
    ).rejects.toThrow("cannot adapt required native tool");
  });

  it("omits an unsupported optional binding", async () => {
    const optional = { ...nativeIssueComment(), required: false };
    await expect(
      new ToolAdapterRegistry([new McpToolAdapter("harness-runtime")]).adapt([optional], {
        harnessId: "codex",
      }),
    ).resolves.toEqual([]);
  });

  it("supports Worker-managed native invocation with the same audited call envelope", async () => {
    const invoker: ToolInvoker = {
      id: "octokit",
      supports: (input) => input.binding.kind === "native" && input.binding.adapter === "octokit",
      invoke: async (_contribution, request) => ({
        content: { commentId: "42", received: request.arguments ?? {} },
      }),
    };
    const outcome = await new ToolInvokerRegistry([invoker]).invoke([nativeIssueComment()], {
      id: "call-2",
      binding: { kind: "native", name: "github-sdk" },
      operation: "add_issue_comment",
      arguments: { issue_number: 3, body: "Done" },
    });

    expect(outcome.call).toMatchObject({
      operation: "add_issue_comment",
      actions: ["issues:comment"],
      effect: "write",
    });
    expect(outcome.result.content).toMatchObject({ commentId: "42" });
  });

  it("records and replays write effects without invoking a provider twice", async () => {
    let invocations = 0;
    const invoker: ToolInvoker = {
      id: "octokit",
      supports: () => true,
      invoke: async () => {
        invocations += 1;
        return { content: { commentId: "42" } };
      },
    };
    const registry = new ReliableToolInvokerRegistry([invoker], new MemoryEffectJournal());
    const request = {
      id: "call-4",
      idempotencyKey: "task-1/comment/final",
      binding: { kind: "native" as const, name: "github-sdk" },
      operation: "add_issue_comment",
      arguments: { issue_number: 3, body: "Done" },
    };

    await expect(registry.invoke([nativeIssueComment()], request)).resolves.toMatchObject({
      replayed: false,
    });
    await expect(registry.invoke([nativeIssueComment()], request)).resolves.toMatchObject({
      replayed: true,
      result: { content: { commentId: "42" } },
    });
    expect(invocations).toBe(1);
  });

  it("fails closed when a prior write has no durable receipt", async () => {
    const journal = new MemoryEffectJournal();
    const registry = new ReliableToolInvokerRegistry(
      [{ id: "unused", supports: () => true, invoke: async () => ({ content: {} }) }],
      journal,
    );
    const request = {
      id: "call-5",
      idempotencyKey: "task-1/comment/ambiguous",
      binding: { kind: "native" as const, name: "github-sdk" },
      operation: "add_issue_comment",
    };
    const first = registry.invoke([nativeIssueComment()], request);
    await expect(first).resolves.toBeDefined();
    const record = journal.records.get("task-1/comment/ambiguous");
    if (record?.state !== "completed") throw new Error("Expected completed effect");
    journal.records.set("task-1/comment/ambiguous", {
      state: "started",
      key: record.key,
      fingerprint: record.fingerprint,
      startedAt: record.startedAt,
    });
    await expect(registry.invoke([nativeIssueComment()], request)).rejects.toBeInstanceOf(
      ToolEffectInDoubtError,
    );
  });

  it("replays a write receipt after the Worker process journal is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-effects-"));
    const path = join(directory, "effects.json");
    let invocations = 0;
    const invoker: ToolInvoker = {
      id: "octokit",
      supports: () => true,
      invoke: async () => {
        invocations += 1;
        return { content: { commentId: "durable-42" } };
      },
    };
    const request = {
      id: "call-6",
      idempotencyKey: "task-1/comment/durable",
      binding: { kind: "native" as const, name: "github-sdk" },
      operation: "add_issue_comment",
    };
    try {
      await new ReliableToolInvokerRegistry([invoker], new FileToolEffectJournal(path)).invoke(
        [nativeIssueComment()],
        request,
      );
      await expect(
        new ReliableToolInvokerRegistry([invoker], new FileToolEffectJournal(path)).invoke(
          [nativeIssueComment()],
          request,
        ),
      ).resolves.toMatchObject({ replayed: true });
      expect(invocations).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves an effect in doubt when receipt persistence fails after provider success", async () => {
    const journal = new MemoryEffectJournal();
    const complete = journal.complete.bind(journal);
    let failReceipt = true;
    journal.complete = async (input) => {
      if (failReceipt) {
        failReceipt = false;
        throw new Error("receipt store unavailable");
      }
      return complete(input);
    };
    const registry = new ReliableToolInvokerRegistry(
      [{ id: "octokit", supports: () => true, invoke: async () => ({ content: { id: "42" } }) }],
      journal,
    );
    const request = {
      id: "call-7",
      idempotencyKey: "task-1/comment/receipt-failure",
      binding: { kind: "native" as const, name: "github-sdk" },
      operation: "add_issue_comment",
    };
    await expect(registry.invoke([nativeIssueComment()], request)).rejects.toThrow(
      "receipt store unavailable",
    );
    await expect(registry.invoke([nativeIssueComment()], request)).rejects.toBeInstanceOf(
      ToolEffectInDoubtError,
    );
  });

  it("rejects an operation that was not resolved", () => {
    expect(() =>
      describeToolCall([nativeIssueComment()], {
        id: "call-3",
        binding: { kind: "native", name: "github-sdk" },
        operation: "delete_repository",
        arguments: { owner: "atemaguer", repo: "supertag" },
      }),
    ).toThrow("unavailable native operation github-sdk/delete_repository");
  });

  it("keeps canonical references while discarding raw tool output", () => {
    expect(
      toolCallOutcomeFromText([
        'Created {"url":"https://github.com/atemaguer/supertag/issues/17"}.',
        "Duplicate https://github.com/atemaguer/supertag/issues/17 and no other durable data",
      ]),
    ).toEqual({ references: ["https://github.com/atemaguer/supertag/issues/17"] });
    expect(toolCallOutcomeFromText(["Created comment 9001"])).toBeUndefined();
  });
});

function nativeIssueComment(): ToolInput {
  return {
    id: "github-native:account-1",
    kind: "tool",
    required: true,
    capability: {
      id: "github:account-1",
      provider: "github",
      operations: [{ name: "add_issue_comment", effect: "write", actions: ["issues:comment"] }],
      authorization: {
        provider: "github",
        resources: [{ surfaceAccountId: "account-1", scope: "repository:123" }],
      },
    },
    binding: {
      kind: "native",
      name: "github-sdk",
      adapter: "octokit",
      configuration: { apiVersion: "2022-11-28" },
      secretRefs: ["worker://github/account-1/token"],
    },
  };
}

function hostedMcpSearch(): ToolInput {
  return {
    id: "search-tools",
    kind: "tool",
    required: true,
    capability: {
      id: "search:documents",
      provider: "search",
      operations: [{ name: "search_documents", effect: "read", actions: ["documents:read"] }],
      authorization: {
        provider: "search",
        resources: [{ surfaceAccountId: "account-1", scope: "collection:docs" }],
      },
    },
    binding: {
      kind: "mcp-http",
      name: "search",
      url: "https://tools.example/mcp",
    },
  };
}

class MemoryEffectJournal implements ToolEffectJournal {
  readonly records = new Map<string, ToolEffectRecord>();

  async begin(input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly startedAt: string;
  }) {
    const existing = this.records.get(input.key);
    if (existing !== undefined) return { acquired: false, record: existing };
    const record: ToolEffectRecord = { state: "started", ...input };
    this.records.set(input.key, record);
    return { acquired: true, record };
  }

  async complete(input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly completedAt: string;
    readonly result: { readonly content: Record<string, unknown>; readonly isError?: boolean };
  }) {
    const started = this.records.get(input.key);
    if (started === undefined) throw new Error("Effect was not started");
    const record: ToolEffectRecord = { state: "completed", ...input, startedAt: started.startedAt };
    this.records.set(input.key, record);
    return record;
  }

  async fail(input: {
    readonly key: string;
    readonly fingerprint: string;
    readonly failedAt: string;
    readonly error: string;
    readonly retryable: boolean;
  }) {
    const started = this.records.get(input.key);
    if (started === undefined) throw new Error("Effect was not started");
    const record: ToolEffectRecord = { state: "failed", ...input, startedAt: started.startedAt };
    this.records.set(input.key, record);
    return record;
  }
}
