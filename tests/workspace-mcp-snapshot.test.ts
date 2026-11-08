import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workSessionBranch } from "../packages/control-plane/src/work-sessions.js";
import type { TagMcpGrant, TaskNamedWorkspacePlan } from "../packages/core/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  HttpMcpToolProvider,
  type ResolutionContext,
  startMcpPolicyProxy,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

const SERVER = fileURLToPath(new URL("./support/fake-stdio-mcp-server.mjs", import.meta.url));

/**
 * A Workspace stdio server is read from, and runs in, a Worker-owned snapshot of the Task's base
 * commit. The harness can write the Task worktree, so nothing there may change what runs.
 */
describe("Workspace MCP servers from the Task's base commit", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  let checkout: string;
  let root: string;
  let log: string;
  let marker: string;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    checkout = await createRepository();
    root = await mkdtemp(join(tmpdir(), "supertag-mcp-snapshot-"));
    const scratch = await mkdtemp(join(tmpdir(), "supertag-mcp-log-"));
    log = join(scratch, "calls.jsonl");
    marker = join(scratch, "tampered");
    await writeFile(log, "");
    for (const path of [checkout, root, scratch])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
    await writeFile(join(checkout, "server.mjs"), await readFile(SERVER, "utf8"));
    await writeMcpJson(checkout, ["server.mjs"]);
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "Add a repository MCP server");
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const writeMcpJson = (directory: string, args: string[]) =>
    writeFile(
      join(directory, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: process.execPath,
            args,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
            env: { FAKE_MCP_LOG: "${SUPERTAG_MCP_LOG}" },
          },
        },
      }),
    );
  const plan = (overrides: Partial<TaskNamedWorkspacePlan> = {}): TaskNamedWorkspacePlan => ({
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: workSessionBranch("task-1"),
    delivery: "branch",
    mcp: ["local"],
    ...overrides,
  });
  const resolver = () =>
    new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: root,
      mcpVariables: { SUPERTAG_MCP_LOG: log },
    });
  const starts = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { started?: number; cwd?: string })
      .filter((entry) => entry.started !== undefined);
  /** Writes into the Task worktree, as a harness with files:write can. */
  const tamper = async (worktree: string) => {
    await writeFile(
      join(worktree, "server.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "script");\n`,
    );
    await writeFile(
      join(worktree, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "/bin/sh", args: ["-c", `echo config > ${JSON.stringify(marker)}`] },
        },
      }),
    );
  };
  /** Lists tools at Attempt start, then calls one through the policy proxy's lazy launch. */
  const useServer = async (workspaces: WorkspaceEnvironmentResolver, attemptId: string) => {
    const provider = new HttpMcpToolProvider({
      servers: {},
      workspaceServers: (id) => workspaces.mcpServersForAttempt(id),
    });
    const [input] = await new ToolProviderRegistry([provider]).resolve(
      context(attemptId, [{ action: "local/read_env" }]),
    );
    const proxy = await startMcpPolicyProxy(input as ToolInput);
    cleanups.push(() => proxy.close());
    const client = new Client({ name: "harness", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    cleanups.push(() => client.close());
    const result = (await client.callTool({ name: "read_env", arguments: {} })) as {
      content: { text: string }[];
    };
    return JSON.parse(result.content[0]?.text ?? "{}") as { cwd: string };
  };

  it("runs the base-commit script and .mcp.json after the Task worktree changes both", async () => {
    const first = resolver();
    const input = await first.resolve({
      task: task(plan(), "attempt-1"),
      profile: { harness: { provider: "codex" } },
    } as ResolutionContext);
    const worktree = fileURLToPath(input?.source.uri ?? "");
    const snapshot = first.mcpSnapshotPath("app", "task-1");
    // The snapshot lives outside the Task worktree the harness may write.
    expect(relative(worktree, snapshot).startsWith("..")).toBe(true);
    expect(first.mcpServersForAttempt("attempt-1")).toEqual([
      expect.objectContaining({ name: "local", cwd: snapshot, args: ["server.mjs"] }),
    ]);
    const digest = first.mcpServersDigestForAttempt("attempt-1");
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    await tamper(worktree);
    const seen = await useServer(first, "attempt-1");
    expect(await realpath(seen.cwd)).toBe(await realpath(snapshot));
    await expect(stat(marker)).rejects.toThrow();
    // Both launches, for the tool list and for the call, ran the committed server.
    expect((await starts()).length).toBe(2);

    // A failed Attempt commits the tampered files to the Task branch and keeps the worktree.
    // The retry still reads and runs the base commit, and its digest matches the pin.
    await first.finalize(task(plan(), "attempt-1"), "failed");
    expect(git(checkout, "show", `${plan().branch}:.mcp.json`)).toContain("/bin/sh");
    const retry = resolver();
    await retry.resolve({
      task: task(plan({ mcpPin: digest as string }), "attempt-2"),
      profile: { harness: { provider: "codex" } },
    } as ResolutionContext);
    expect(retry.mcpServersDigestForAttempt("attempt-2")).toBe(digest);
    const again = await useServer(retry, "attempt-2");
    expect(await realpath(again.cwd)).toBe(await realpath(snapshot));
    await expect(stat(marker)).rejects.toThrow();
    expect(await readFile(join(snapshot, "server.mjs"), "utf8")).toBe(
      await readFile(SERVER, "utf8"),
    );
  });

  it("refuses a retry whose .mcp.json changed since the first Attempt, before any launch", async () => {
    const first = resolver();
    await first.resolve({
      task: task(plan(), "attempt-1"),
      profile: { harness: { provider: "codex" } },
    } as ResolutionContext);
    const digest = first.mcpServersDigestForAttempt("attempt-1") as string;
    // An Attempt without commits deletes the branch, so the retry starts from the moved base.
    await first.finalize(task(plan(), "attempt-1"), "failed");
    // Finalizing removes the snapshot and its registration in the host checkout.
    const snapshot = first.mcpSnapshotPath("app", "task-1");
    await expect(stat(snapshot)).rejects.toThrow();
    expect(git(checkout, "worktree", "list", "--porcelain")).not.toMatch(/\/mcp\//u);
    await writeMcpJson(checkout, ["server.mjs", "--changed"]);
    git(checkout, "commit", "--quiet", "-am", "Change the MCP server");

    const retry = resolver();
    await expect(
      retry.resolve({
        task: task(plan({ mcpPin: digest }), "attempt-2"),
        profile: { harness: { provider: "codex" } },
      } as ResolutionContext),
    ).rejects.toThrow(/MCP servers changed since this Task's first Task Attempt/u);
    expect(retry.mcpServersForAttempt("attempt-2")).toEqual([]);
    expect(await starts()).toEqual([]);
  });

  it("reports the digest before tool resolution starts any server", async () => {
    const workspaces = new WorkspaceResolverRegistry([resolver()]);
    const worker = createCodexWorker({
      workspace: root,
      workspaceResolvers: workspaces,
      toolProviders: new ToolProviderRegistry([
        new HttpMcpToolProvider({
          servers: {},
          workspaceServers: (id) => workspaces.mcpServersForAttempt(id),
        }),
      ]),
      runner: async function* () {
        yield { type: "output.message", text: "Done." };
      } as never,
    });
    const order: string[] = [];
    for await (const event of worker.execute(
      attemptSpec([{ action: "local/read_env" }], ["files:write"]),
    )) {
      if (event.type === "workspace.mcp.resolved") {
        expect(event.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        order.push(`digest:${(await starts()).length}`);
      }
      if (event.type === "runtime-inputs.resolved") order.push(`inputs:${(await starts()).length}`);
      if (event.type === "execution.failed") throw new Error(event.error.message);
    }
    // No server had started when the digest was reported; listing tools started one later.
    expect(order).toEqual(["digest:0", "inputs:1"]);
  });
});

function context(attemptId: string, grants: readonly TagMcpGrant[]): ResolutionContext {
  return {
    task: {
      taskId: "task-1",
      attemptId,
      authorization: { version: 4, runtimeActions: [], resources: [], mcp: grants },
    },
    profile: {},
  } as unknown as ResolutionContext;
}

function task(workspacePlan: TaskNamedWorkspacePlan, attemptId: string): TaskAttemptSpec {
  return {
    taskId: "task-1",
    attemptId,
    workspacePlan,
    authorization: { runtimeActions: ["files:write"] },
  } as unknown as TaskAttemptSpec;
}

function attemptSpec(grants: readonly TagMcpGrant[], runtimeActions: string[]): TaskAttemptSpec {
  const capturedAt = "2026-10-03T00:00:00.000Z";
  return {
    version: 2,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "cli",
        accountId: "account-1",
        scope: "objective:objective-1",
        sessionKey: "objective-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "Use the repository tool" }],
    },
    execution: {},
    workerProfile: { id: "local-codex", revision: "1" },
    contextPlan: { version: 7, capturedAt, sets: [] },
    workspacePlan: {
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: workSessionBranch("task-1"),
      delivery: "branch",
      mcp: ["local"],
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag-1", name: "Engineering" },
      origin: {
        tagRouteId: "surface-1",
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:C1",
      },
      requester: { id: "U1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions,
      mcp: grants,
    },
  } as unknown as TaskAttemptSpec;
}
