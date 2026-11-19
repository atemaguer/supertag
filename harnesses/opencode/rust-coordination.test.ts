import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AttemptMemoryResponseSchema,
  AttemptScheduleResponseSchema,
  HarnessKind,
  HarnessRunSchema,
  harnessClient,
  ListTagSessionsResponseSchema,
  MemoryState,
  ObjectiveSignal,
  ReadTagSessionResponseSchema,
  ReadTagTurnResponseSchema,
  ScheduleState,
  SearchTagSessionsResponseSchema,
  TagSessionAudience,
  TaskEventKind,
  TaskState,
  tagPortfolio,
  WorkSessionCloseReason,
  WorkSessionQuestionSchema,
  WorkSessionSchema,
  webAccessNote,
  withObjectiveReport,
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

it("offers report_objective only to an Objective's owner and applies only a successful report", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const scope = {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: new AbortController().signal,
    active: () => true,
  };
  const plain = await startCoordination(
    bridge,
    create(HarnessRunSchema, { task: { taskId, tagId, sessionId: "objective" }, attemptId }),
    scope,
  );
  expect(plain.tools).toEqual([]);
  expect(await plain.objectiveReport()).toBeUndefined();
  await plain.close();

  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId: "objective" },
      attemptId,
      coordination: { mayAskObjectiveQuestion: true },
    }),
    scope,
  );
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    expect(tool.operations).toEqual(["ask", "report_objective"]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    for (const args of [
      { status: "working", summary: "Still going" },
      { status: "completed", summary: "   " },
      { status: "completed", summary: "Done", objectiveId: "other" },
    ])
      expect(await client.callTool({ name: "report_objective", arguments: args })).toMatchObject({
        isError: true,
      });
    expect(await service.objectiveReport()).toBeUndefined();
    await client.callTool({
      name: "report_objective",
      arguments: { status: "blocked", summary: "Waiting on staging" },
    });
    const recorded = await client.callTool({
      name: "report_objective",
      arguments: { status: "completed", summary: `  Shipped ${grpcToken}. ` },
    });
    expect(recorded.isError).toBeFalsy();
    const report = await service.objectiveReport();
    expect(report).toEqual({ signal: ObjectiveSignal.COMPLETED, summary: "Shipped [REDACTED]." });
    expect(
      await client.callTool({ name: "ask", arguments: { text: "Which branch?" } }),
    ).toMatchObject({ isError: true });

    const succeeded = { succeeded: true, result: "Final reply", waitingApprovalIds: [] };
    expect(withObjectiveReport(succeeded, report)).toEqual({
      ...succeeded,
      result: "Shipped [REDACTED].",
      objectiveSignal: ObjectiveSignal.COMPLETED,
    });
    expect(withObjectiveReport({ ...succeeded, waitingApprovalIds: ["approval"] }, report)).toEqual(
      {
        ...succeeded,
        waitingApprovalIds: ["approval"],
      },
    );
    expect(withObjectiveReport({ succeeded: false, result: "Failed" }, report)).toEqual({
      succeeded: false,
      result: "Failed",
    });
  } finally {
    await client.close();
    await service.close();
  }
});

it("offers an ongoing Objective's owner no completion and refuses one without ending the turn", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId: "objective" },
      attemptId,
      coordination: { mayAskObjectiveQuestion: true, objectiveOngoing: true },
    }),
    {
      taskId,
      tagId,
      attemptId,
      secrets: [grpcToken],
      signal: new AbortController().signal,
      active: () => true,
    },
  );
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    const listed = (await client.listTools()).tools.find(({ name }) => name === "report_objective");
    expect(listed?.description).toContain("never completes");
    expect(
      (listed?.inputSchema.properties?.status as { enum?: string[] } | undefined)?.enum,
    ).toEqual(["ready_for_review", "blocked"]);
    const refused = await client.callTool({
      name: "report_objective",
      arguments: { status: "completed", summary: "Done" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("never completes");
    expect(await service.objectiveReport()).toBeUndefined();
    const ready = await client.callTool({
      name: "report_objective",
      arguments: { status: "ready_for_review", summary: "Assessment ready" },
    });
    expect(ready.isError).toBeFalsy();
    expect(await service.objectiveReport()).toEqual({
      signal: ObjectiveSignal.READY_FOR_REVIEW,
      summary: "Assessment ready",
    });
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

it("reads the Tag's Sessions and Objectives, refuses an unasked Objective, and carries the portfolio", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const listSessions = vi.spyOn(bridge.tagSessions, "listSessions").mockImplementation(async () =>
    create(ListTagSessionsResponseSchema, {
      sessions: [
        {
          sessionId: "conversation/earlier",
          audience: TagSessionAudience.PRIVATE,
          firstRequest: `Draft notes ${grpcToken}`,
          lastInteractionAtMs: 1_796_083_200_000n,
        },
      ],
    }),
  );
  const search = vi.spyOn(bridge.tagSessions, "searchSessions").mockImplementation(async () =>
    create(SearchTagSessionsResponseSchema, {
      matches: [
        { sessionId: "conversation/earlier", taskId: "earlier", resultExcerpt: "v2 notes" },
      ],
    }),
  );
  const readTurn = vi.spyOn(bridge.tagSessions, "readTurn").mockImplementation(async () =>
    create(ReadTagTurnResponseSchema, {
      sessionId: "conversation/earlier",
      state: TaskState.SUCCEEDED,
      events: [
        { sequence: 3n, kind: TaskEventKind.ACTIVITY, text: `Ran the release check ${grpcToken}` },
      ],
      nextAfter: 3n,
    }),
  );
  const readSession = vi.spyOn(bridge.tagSessions, "readSession").mockImplementation(async () =>
    create(ReadTagSessionResponseSchema, {
      entries: [{ taskId: "earlier", state: 3, request: "Draft", result: "Drafted" }],
      nextBefore: 4n,
    }),
  );
  const run = create(HarnessRunSchema, {
    task: { taskId, tagId, sessionId: "conversation/now" },
    attemptId,
    coordination: {
      mayReadTagSessions: true,
      tagPortfolio: "Tag portfolio: this Tag owns no open Objectives you can see.",
    },
  });
  expect(tagPortfolio(run)).toBe(
    "SuperTag context:\nTag portfolio: this Tag owns no open Objectives you can see.",
  );
  expect(tagPortfolio(create(HarnessRunSchema, { coordination: {} }))).toBe("");
  // A Task without web:fetch hears so; the line grants nothing.
  expect(webAccessNote(["files:read", "web:fetch"])).toBe("");
  expect(webAccessNote(["files:read"])).toMatch(
    /^This Tag has no web access: .* grant web:fetch\.$/u,
  );
  const abort = new AbortController();
  const service = await startCoordination(bridge, run, {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: abort.signal,
    active: () => !abort.signal.aborted,
  });
  const client = new Client({ name: "session-reader", version: "1" });
  try {
    const tool = service.tools[0];
    if (!tool) throw new Error("missing private Session tools");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "list_sessions",
      "search_sessions",
      "read_session",
      "read_turn",
      "list_objectives",
      "read_objective",
    ]);
    // An out-of-range limit is a tool error the agent can retry, not a failed turn.
    const tooMany = await client.callTool({ name: "list_sessions", arguments: { limit: 50 } });
    expect(tooMany).toMatchObject({ isError: true });
    expect(JSON.stringify(tooMany)).toContain("limit");
    expect(listSessions).not.toHaveBeenCalled();
    const listed = JSON.stringify(
      await client.callTool({ name: "list_sessions", arguments: { limit: 5 } }),
    );
    expect(listed).toContain("conversation/earlier");
    expect(listed).toContain("Draft notes [REDACTED]");
    expect(listed).toContain("untrusted");
    expect(listSessions).toHaveBeenCalledWith(
      { limit: 5, offset: 0 },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    expect(
      JSON.stringify(
        await client.callTool({ name: "search_sessions", arguments: { query: "notes" } }),
      ),
    ).toContain("v2 notes");
    expect(search).toHaveBeenCalledWith(
      { query: "notes", limit: 0 },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    const page = JSON.stringify(
      await client.callTool({
        name: "read_session",
        arguments: { sessionId: "conversation/earlier", before: 9 },
      }),
    );
    expect(page).toContain("Drafted");
    expect(page).toContain('\\"nextBefore\\":4');
    expect(readSession).toHaveBeenCalledWith(
      { sessionId: "conversation/earlier", limit: 0, before: 9n },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    const turn = JSON.stringify(
      await client.callTool({
        name: "read_turn",
        arguments: { taskId: "earlier", after: 2 },
      }),
    );
    expect(turn).toContain("Ran the release check [REDACTED]");
    expect(turn).toContain('\\"kind\\":\\"activity\\"');
    expect(turn).toContain('\\"nextAfter\\":3');
    expect(readTurn).toHaveBeenCalledWith(
      { taskId: "earlier", limit: 0, after: 2n },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    expect(
      (
        await client.callTool({
          name: "search_sessions",
          arguments: { query: "x".repeat(201) },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await service.close();
  }
});

it("lets a Work Session's own Task reread only its own Session", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const readSession = vi.spyOn(bridge.tagSessions, "readSession").mockImplementation(async () =>
    create(ReadTagSessionResponseSchema, {
      entries: [{ taskId: "earlier", state: 3, request: "Compare", result: "Compared" }],
    }),
  );
  const run = create(HarnessRunSchema, {
    task: { taskId, tagId, sessionId: "work/compare" },
    attemptId,
    coordination: { mayReadOwnSession: true },
  });
  expect(tagPortfolio(run)).toBe("");
  const abort = new AbortController();
  const service = await startCoordination(bridge, run, {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: abort.signal,
    active: () => !abort.signal.aborted,
  });
  const client = new Client({ name: "work-reader", version: "1" });
  try {
    const tool = service.tools[0];
    if (!tool) throw new Error("missing own Session tools");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    const tools = (await client.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual(["read_session", "read_turn"]);
    expect(tools[0]?.description).toContain("You may read only this Session.");
    expect(
      JSON.stringify(
        await client.callTool({ name: "read_session", arguments: { sessionId: "work/compare" } }),
      ),
    ).toContain("Compared");
    expect(readSession).toHaveBeenCalledWith(
      { sessionId: "work/compare", limit: 0 },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  } finally {
    await client.close();
    await service.close();
  }
});

it("schedules a follow-up in the turn's Session, redacts the note, and reports refusals", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const scope = {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: new AbortController().signal,
    active: () => true,
  };
  const plain = await startCoordination(
    bridge,
    create(HarnessRunSchema, { task: { taskId, tagId, sessionId: "ops" }, attemptId }),
    scope,
  );
  expect(plain.tools).toEqual([]);
  await plain.close();

  const due = 1_900_000_000_000n;
  const createSchedule = vi
    .spyOn(bridge.schedules, "create")
    .mockImplementationOnce(async ({ note }) =>
      create(AttemptScheduleResponseSchema, {
        schedule: {
          scheduleId: "sch_new",
          note,
          atMs: due,
          nextDueAtMs: due,
          state: ScheduleState.STAGED,
        },
        pending: [
          {
            scheduleId: "sch_weekly",
            note: "Summarize open work",
            nextDueAtMs: due + 3_600_000n,
            every: { cron: "0 9 * * MON", timeZone: "Europe/Berlin" },
            state: ScheduleState.ACTIVE,
          },
        ],
        timeZone: "UTC",
      }),
    )
    .mockImplementationOnce(async () => {
      throw new ConnectError(
        "every must be at least one hour between occurrences",
        Code.InvalidArgument,
      );
    });
  const cancel = vi.spyOn(bridge.schedules, "cancel").mockImplementation(async ({ scheduleId }) =>
    create(AttemptScheduleResponseSchema, {
      schedule: { scheduleId, note: "x", state: ScheduleState.CANCELLED },
      timeZone: "UTC",
    }),
  );
  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId: "ops" },
      attemptId,
      coordination: { maySchedule: true, timeZone: "Europe/Berlin" },
    }),
    scope,
  );
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    expect(tool.operations).toEqual(["schedule", "cancel_schedule"]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    const listed = (await client.listTools()).tools.find(({ name }) => name === "schedule");
    expect(listed?.description).toContain("read in Europe/Berlin unless you pass timeZone");
    // Exactly one of at and every; no other fields.
    for (const args of [
      { note: "Check PR 412" },
      { note: "Check PR 412", at: "2h", every: "@daily" },
      { note: "   ", at: "2h" },
      { note: "Check PR 412", at: "2h", tag: "other" },
    ])
      expect(await client.callTool({ name: "schedule", arguments: args })).toMatchObject({
        isError: true,
      });
    expect(createSchedule).not.toHaveBeenCalled();

    const scheduled = await client.callTool({
      name: "schedule",
      arguments: { note: `  Check PR 412 with ${grpcToken} `, at: "2h" },
    });
    expect(scheduled.isError).toBeFalsy();
    expect(createSchedule).toHaveBeenNthCalledWith(
      1,
      {
        operationId: "opencode-schedule-1",
        note: "Check PR 412 with [REDACTED]",
        at: "2h",
        every: "",
      },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    const text = (scheduled.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("Scheduled sch_new next Sun, 17 Mar 2030, 17:46 UTC, once");
    expect(text).toContain("It takes effect when this turn succeeds.");
    expect(text).toContain("- sch_weekly next Sun, 17 Mar 2030, 19:46 CET, every 0 9 * * MON");

    const refused = await client.callTool({
      name: "schedule",
      arguments: { note: "Ping", every: "*/5 * * * *", timeZone: "Europe/Berlin" },
    });
    expect(refused).toMatchObject({ isError: true });
    expect((refused.content as { text: string }[])[0]?.text).toBe(
      "Refused: every must be at least one hour between occurrences",
    );
    expect(createSchedule).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operationId: "opencode-schedule-2",
        every: "*/5 * * * *",
        timeZone: "Europe/Berlin",
      }),
      expect.anything(),
    );

    const cancelled = await client.callTool({
      name: "cancel_schedule",
      arguments: { scheduleId: "sch_new" },
    });
    expect((cancelled.content as { text: string }[])[0]?.text).toContain("Cancelled sch_new.");
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      { scheduleId: "sch_new" },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  } finally {
    await client.close();
    await service.close();
  }
});

it("shows the open Work Sessions, passes the limit's refusal to the model, and closes one", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const refusal =
    'This Tag has 8 of 8 Work Sessions open, its limit, so no new one started.\n- work/1 "Draft" (reported, this conversation)';
  const start = vi
    .spyOn(bridge.workSessions, "start")
    .mockImplementationOnce(async () => {
      throw new ConnectError(refusal, Code.FailedPrecondition);
    })
    .mockImplementationOnce(async () => {
      throw new ConnectError("unknown Work Session harness", Code.InvalidArgument);
    })
    .mockImplementationOnce(async () => {
      throw new ConnectError("execution ownership does not match", Code.PermissionDenied);
    });
  const close = vi
    .spyOn(bridge.workSessions, "close")
    .mockImplementation(async ({ workSessionId }) =>
      create(WorkSessionSchema, {
        workSessionId,
        parentTagId: tagId,
        closedAtMs: 1n,
        closeReason: WorkSessionCloseReason.TAG,
      }),
    );
  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId: "conversation/1", harnessKind: HarnessKind.OPENCODE },
      attemptId,
      coordination: { mayStartWorkSession: true, openWorkSessions: 8, maxWorkSessions: 8 },
    }),
    {
      taskId,
      tagId,
      attemptId,
      secrets: [grpcToken],
      signal: new AbortController().signal,
      active: () => true,
    },
  );
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    expect(tool.operations).toEqual(["start_session", "close_session"]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    const listed = (await client.listTools()).tools.find(({ name }) => name === "start_session");
    expect(listed?.description).toContain("This Tag has 8 of 8 Work Sessions open");
    // A conversation's turn can't delegate, so it isn't offered tag, nor ever a Workspace; it
    // hears which harness it keeps.
    expect(Object.keys(listed?.inputSchema.properties ?? {}).sort()).toEqual([
      "harness",
      "instruction",
      "title",
    ]);
    expect(listed?.description).toContain("Omit harness to keep opencode");
    expect(listed?.description).not.toContain("tag");
    const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.content as { text: string }[])[0]?.text;
    const refused = await client.callTool({
      name: "start_session",
      arguments: { title: "More", instruction: "Do more" },
    });
    expect(refused).toMatchObject({ isError: true });
    expect(text(refused)).toBe(refusal);
    // Every refusal the model can act on comes back with its reason; an ownership failure
    // stays opaque.
    const invalid = await client.callTool({
      name: "start_session",
      arguments: { title: "More", instruction: "Do more" },
    });
    expect(text(invalid)).toBe("unknown Work Session harness");
    const opaque = await client.callTool({
      name: "start_session",
      arguments: { title: "More", instruction: "Do more" },
    });
    expect(text(opaque)).toBe("The Work Session start could not be confirmed.");
    expect(
      await client.callTool({
        name: "start_session",
        arguments: { title: "More", instruction: "Do more", tag: "builder" },
      }),
    ).toMatchObject({ isError: true });
    expect(start).toHaveBeenCalledTimes(3);
    const sessionId = "work/1ed2c531-904a-419e-b7af-332f10537ba2";
    const closed = await client.callTool({ name: "close_session", arguments: { sessionId } });
    expect(closed.isError).toBeFalsy();
    expect(close).toHaveBeenCalledExactlyOnceWith(
      { workSessionId: sessionId },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    expect(
      await client.callTool({ name: "close_session", arguments: { sessionId: "not-a-session" } }),
    ).toMatchObject({ isError: true });
  } finally {
    await client.close();
    await service.close();
  }
});

it("keeps notes with remember and forget only with the capability, redacted", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const scope = {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: new AbortController().signal,
    active: () => true,
  };
  const plain = await startCoordination(
    bridge,
    create(HarnessRunSchema, { task: { taskId, tagId, sessionId: "ops" }, attemptId }),
    scope,
  );
  expect(plain.tools).toEqual([]);
  await plain.close();

  const remember = vi
    .spyOn(bridge.memory, "remember")
    .mockImplementationOnce(async ({ text }) =>
      create(AttemptMemoryResponseSchema, {
        memory: { memoryId: "mem_new", text, state: MemoryState.STAGED },
        notes: [
          { memoryId: "mem_new", text, state: MemoryState.STAGED },
          { memoryId: "mem_old", text: "Release checklist: docs/release.md" },
        ],
      }),
    )
    .mockImplementationOnce(async () => {
      throw new ConnectError("your notes are full", Code.FailedPrecondition);
    });
  const forget = vi
    .spyOn(bridge.memory, "forget")
    .mockImplementation(async () => create(AttemptMemoryResponseSchema, {}));
  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId: "ops" },
      attemptId,
      coordination: { mayRemember: true },
    }),
    scope,
  );
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    expect(tool.operations).toEqual(["remember", "forget"]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    for (const args of [{ text: " " }, { text: "x".repeat(501) }, { text: "x", tag: "other" }])
      expect(await client.callTool({ name: "remember", arguments: args })).toMatchObject({
        isError: true,
      });
    expect(remember).not.toHaveBeenCalled();
    const saved = await client.callTool({
      name: "remember",
      arguments: { text: ` Atem prefers squash merges ${grpcToken} `, replaces: "mem_older" },
    });
    expect(saved.isError).toBeFalsy();
    expect(remember).toHaveBeenNthCalledWith(
      1,
      {
        operationId: "opencode-memory-1",
        text: "Atem prefers squash merges [REDACTED]",
        replaces: "mem_older",
      },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
    const text = (saved.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("Saved mem_new. It takes effect when this turn succeeds.");
    expect(text).toContain("- mem_old: Release checklist: docs/release.md");
    const full = await client.callTool({ name: "remember", arguments: { text: "More" } });
    expect((full.content as { text: string }[])[0]?.text).toBe("Refused: your notes are full");
    const forgot = await client.callTool({ name: "forget", arguments: { memoryId: "mem_old" } });
    expect((forgot.content as { text: string }[])[0]?.text).toContain("Forgot mem_old.");
    expect(forget).toHaveBeenCalledExactlyOnceWith(
      { operationId: "opencode-memory-3", memoryId: "mem_old" },
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  } finally {
    await client.close();
    await service.close();
  }
});

it("offers stay_quiet only to a turn no person waits on, and finishes it quietly", async () => {
  const bridge = harnessClient("http://127.0.0.1:1", grpcToken);
  const scope = {
    taskId,
    tagId,
    attemptId,
    secrets: [grpcToken],
    signal: new AbortController().signal,
    active: () => true,
  };
  const plain = await startCoordination(
    bridge,
    create(HarnessRunSchema, { task: { taskId, tagId, sessionId: "ops" }, attemptId }),
    scope,
  );
  expect(plain.tools).toEqual([]);
  expect(await plain.quietNote()).toBeUndefined();
  await plain.close();

  const service = await startCoordination(
    bridge,
    create(HarnessRunSchema, {
      task: { taskId, tagId, sessionId: "ops" },
      attemptId,
      coordination: { mayStayQuiet: true },
    }),
    scope,
  );
  const client = new Client({ name: "opencode-fixture", version: "1" });
  try {
    const [tool] = service.tools;
    if (!tool) throw new Error("expected private MCP binding");
    expect(tool.operations).toEqual(["stay_quiet"]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(tool.url), {
        requestInit: { headers: tool.headers },
      }),
    );
    for (const args of [{ note: " " }, { note: "x".repeat(501) }, { note: "x", post: true }])
      expect(await client.callTool({ name: "stay_quiet", arguments: args })).toMatchObject({
        isError: true,
      });
    expect(await service.quietNote()).toBeUndefined();
    const quiet = await client.callTool({
      name: "stay_quiet",
      arguments: { note: ` CI is green ${grpcToken} ` },
    });
    expect(quiet.isError).toBeFalsy();
    expect((quiet.content as { text: string }[])[0]?.text).toContain(
      "nothing from this turn is posted",
    );
    const note = await service.quietNote();
    expect(note).toBe("CI is green [REDACTED]");

    // The note is the result, whatever text came first. A report or a failure posts.
    const succeeded = { succeeded: true, result: "I'll check CI.", waitingApprovalIds: [] };
    expect(withObjectiveReport(succeeded, undefined, note)).toEqual({
      ...succeeded,
      result: "CI is green [REDACTED]",
      quiet: true,
    });
    expect(withObjectiveReport({ ...succeeded, result: " " }, undefined, note)).toEqual({
      ...succeeded,
      result: "CI is green [REDACTED]",
      quiet: true,
    });
    const report = { signal: ObjectiveSignal.BLOCKED, summary: "Blocked on staging" };
    expect(withObjectiveReport(succeeded, report, note)).toEqual({
      ...succeeded,
      result: "Blocked on staging",
      objectiveSignal: ObjectiveSignal.BLOCKED,
    });
    expect(withObjectiveReport({ succeeded: false, result: "Failed" }, undefined, note)).toEqual({
      succeeded: false,
      result: "Failed",
    });
  } finally {
    await client.close();
    await service.close();
  }
});
