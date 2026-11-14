import { create } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  HarnessRunSchema,
  harnessClient,
  WorkSessionQuestionSchema,
} from "@supertag/worker-sdk/internal/rust-harness";
import { expect, it, vi } from "vitest";
import { startCoordination } from "./src/rust-adapter/coordination.js";

const taskId = "child-task";
const tagId = "builder";
const attemptId = "child-attempt";
const sessionId = "work/1ed2c531-904a-419e-b7af-332f10537ba2";
const grpcToken = "private-grpc-execution-secret";

it("exposes only admitted tools to the authenticated Attempt and redacts both credentials", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const ask = vi
    .spyOn(bridge.workSessions, "ask")
    .mockImplementation(async ({ text }) =>
      create(WorkSessionQuestionSchema, { taskId, attemptId, workSessionId: sessionId, text }),
    );
  const run = create(HarnessRunSchema, {
    task: { taskId, tagId, sessionId },
    attemptId,
    coordination: { mayAskWorkSessionQuestion: true },
  });
  const abort = new AbortController();
  let active = true;
  const service = await startCoordination(bridge, run, {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: abort.signal,
    active: () => active,
  });
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    expect(service.tools).toHaveLength(1);
    expect(tool).toMatchObject({ name: "supertag", operations: ["ask"], audience: "manager" });
    expect(new URL(tool.url).hostname).toBe("127.0.0.1");
    expect(tool.headers.Authorization).not.toContain(grpcToken);
    expect((await fetch(tool.url)).status).toBe(403);
    expect(
      (await fetch(tool.url, { headers: { ...tool.headers, Origin: "https://foreign.invalid" } }))
        .status,
    ).toBe(403);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["ask"]);
    const denied = await client.callTool({ name: "start_session", arguments: {} });
    expect(denied).toMatchObject({ isError: true });
    expect(ask).not.toHaveBeenCalled();
    const result = await client.callTool({
      name: "ask",
      arguments: { text: `Which provider? ${grpcToken} ${tool.headers.Authorization}` },
    });
    expect(result.content).toEqual([{ type: "text", text: "Work Session question recorded." }]);
    expect(ask).toHaveBeenCalledExactlyOnceWith(
      {
        operationId: "opencode-work-session-question",
        text: "Which provider? [REDACTED] [REDACTED]",
      },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    expect(await service.waitingApprovalIds()).toEqual([]);
    active = false;
    expect((await fetch(tool.url, { headers: tool.headers })).status).toBe(410);
    abort.abort();
  } finally {
    await client.close();
    await service.close();
  }
});

it("exposes scoped artifact reads and attachment only with their accepted capabilities", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const read = vi.spyOn(bridge.artifacts, "read").mockImplementation(async (input) => ({
    $typeName: "supertag.runtime.v2.HarnessArtifactPage" as const,
    acquisition: {
      $typeName: "supertag.runtime.v2.ArtifactAcquisition" as const,
      acquisitionId: "acq",
      operationId: input.operationId ?? "",
      taskId,
      attemptId,
      artifactId: input.artifactId ?? "",
      files: [],
      delivery: 1,
      state: 2,
      createdAtMs: 1n,
      updatedAtMs: 1n,
    },
    path: input.path ?? "",
    text: `selected evidence ${grpcToken}`,
    offset: 0n,
    nextOffset: 17n,
    truncated: false,
  }));
  const attach = vi.spyOn(bridge.artifacts, "attach");
  const abort = new AbortController();
  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId },
      attemptId,
      mayAcquireArtifacts: true,
      mayMaterializeArtifacts: false,
    }),
    {
      taskId,
      tagId,
      attemptId,
      secrets: [grpcToken],
      signal: abort.signal,
      active: () => !abort.signal.aborted,
    },
  );
  const client = new Client({ name: "artifact-reader", version: "1" });
  try {
    const tool = service.tools[0];
    if (!tool) throw new Error("missing private artifact tools");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "find_artifacts",
      "inspect_artifact",
      "read_artifact",
    ]);
    const result = await client.callTool({
      name: "read_artifact",
      arguments: { artifactId: "prior", path: "evidence.txt", operationId: "read-one" },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("selected evidence [REDACTED]");
    expect(read).toHaveBeenCalledExactlyOnceWith(
      { artifactId: "prior", path: "evidence.txt", operationId: "read-one", offset: 0n, limit: 0 },
      expect.objectContaining({ timeoutMs: 120000 }),
    );
    expect(
      (
        await client.callTool({
          name: "attach_artifact",
          arguments: { artifactId: "prior", paths: ["evidence.txt"] },
        })
      ).isError,
    ).toBe(true);
    expect(attach).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await service.close();
  }
});
