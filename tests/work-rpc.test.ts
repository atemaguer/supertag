import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Code } from "@connectrpc/connect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mailboxService } from "../apps/cli/src/mailbox-rpc.ts";
import { mailboxClient, teamClient, workClient } from "../apps/cli/src/operator-client.ts";
import { createOperatorRpcHandler } from "../apps/cli/src/operator-rpc.ts";
import type { OperatorAuthentication } from "../apps/cli/src/operator-rpc-context.ts";
import { teamService } from "../apps/cli/src/team-rpc.ts";
import { workService } from "../apps/cli/src/work-rpc.ts";
import {
  MailboxService,
  TaskStatus,
  TeamService,
  WorkService,
} from "../packages/operator-api/src/index.ts";

const AT = "2026-11-08T00:00:00.000Z";

const session = (id: string, sessionKey: string, extra: Record<string, unknown> = {}) => ({
  id,
  tagId: "tag-builder",
  sessionKey,
  origin: {},
  state: "open",
  audience: "private",
  lastInteractionAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const task = (id: string, sessionId: string, createdAt: string, extra = {}) => ({
  id,
  tagId: "tag-builder",
  sessionId,
  status: "pending",
  execution: {},
  trigger: {},
  workspacePlan: { version: 1, status: "none" },
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

const SESSIONS = [
  session("alice-plan", "cli:alice:plan"),
  session("alice-work", "work:alice-plan:1", { parentSessionId: "alice-plan" }),
  session("bob-plan", "cli:bob:plan"),
  session("thread", "slack:T1:C1:1.2", { audience: "shared" }),
];

const TASKS = [
  task("alice-task", "alice-plan", "2026-11-08T00:00:05.000Z"),
  task("work-task", "alice-work", "2026-11-08T00:00:04.000Z", {
    status: "completed",
    workspacePlan: {
      version: 1,
      status: "workspace",
      workspace: "app",
      branch: "supertag/session/alice-work",
      delivery: "branch",
    },
    result: {
      changes: [
        { reference: "git:supertag/session/alice-work@abcdef1", summary: "3 changed files" },
      ],
    },
  }),
  task("bob-task", "bob-plan", "2026-11-08T00:00:03.000Z"),
  task("thread-1", "thread", "2026-11-08T00:00:02.000Z"),
  task("thread-2", "thread", "2026-11-08T00:00:01.000Z"),
];

const EVENTS = Array.from({ length: 5 }, (_, index) => ({
  id: `event-${index + 1}`,
  taskId: "thread-1",
  sequence: index + 1,
  type: "task.updated",
  payload: { index },
  createdAt: AT,
}));

const ARTIFACTS = ["alice-plan", "bob-plan"].map((sessionId) => ({
  id: `${sessionId}-artifact`,
  taskId: `${sessionId.split("-")[0]}-task`,
  attemptId: "attempt",
  tagId: "tag-builder",
  sessionId,
  operationId: "operation",
  title: "Report",
  kind: "output",
  entries: [],
  inputs: [],
  createdAt: AT,
}));

/** Tasks and native archives one test adds to the fixed ones and removes when it ends. */
const extraTasks: ReturnType<typeof task>[] = [];
const sessionStates: {
  id: string;
  sessionId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  nativeId: string;
  ref: { id: string };
  status: string;
  writeVersion: number;
  createdAt: string;
  updatedAt: string;
}[] = [];

const store = {
  findSessionById: async (id: string) => SESSIONS.find((candidate) => candidate.id === id),
  listSessions: async () => SESSIONS,
  findTaskById: async (id: string) => TASKS.find((candidate) => candidate.id === id),
  listTasks: async (filter: {
    sessionId?: string;
    objectiveId?: string;
    before?: { createdAt: string; id: string };
    limit?: number;
  }) =>
    [...TASKS, ...extraTasks]
      .filter(
        (candidate) =>
          (!filter.sessionId || candidate.sessionId === filter.sessionId) &&
          (!filter.objectiveId ||
            (candidate as { objectiveId?: string }).objectiveId === filter.objectiveId) &&
          (!filter.before ||
            candidate.createdAt < filter.before.createdAt ||
            (candidate.createdAt === filter.before.createdAt && candidate.id > filter.before.id)),
      )
      .toSorted(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, filter.limit ?? 100),
  listTaskEvents: async (id: string) => (id === "thread-1" ? EVENTS : []),
  listTaskAttempts: async (id: string | readonly string[]) =>
    id === "work-task"
      ? [
          {
            id: "work-attempt",
            taskId: "work-task",
            attemptNumber: 1,
            status: "completed",
            workerProfile: { id: "default", revision: "1" },
            workerSnapshot: { workerHostId: "laptop" },
            startedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
        ]
      : [],
  listSessionTaskIds: async (sessionId: string) =>
    TASKS.filter((candidate) => candidate.sessionId === sessionId)
      .toReversed()
      .map((candidate) => candidate.id),
  sessionTaskSummaries: async () => new Map(),
  findTagById: async (id: string) =>
    ({
      "tag-builder": { id, name: "builder", status: "active" },
      "tag-reviewer": { id, name: "reviewer", status: "active" },
    })[id],
  findTagByName: async (name: string) =>
    ({
      builder: { id: "tag-builder", name, status: "active" },
      reviewer: { id: "tag-reviewer", name, status: "active" },
    })[name],
  listCapturedArtifacts: async () => ({ artifacts: ARTIFACTS }),
  findCapturedArtifact: async (id: string) => ARTIFACTS.find((candidate) => candidate.id === id),
  listWorkerHosts: async () => [{ id: "laptop", ephemeral: false, enrollmentStatus: "active" }],
  listVolumes: async () => [],
  hasArtifactUpload: async () => false,
  listArtifactStorageLocations: async () => [],
  listArtifactVolumeLocations: async () => [],
  listSessionStates: async (input: {
    sessionId: string;
    before?: { createdAt: string; id: string };
    limit?: number;
  }) =>
    sessionStates
      .filter(
        (state) =>
          state.sessionId === input.sessionId &&
          (!input.before ||
            state.createdAt < input.before.createdAt ||
            (state.createdAt === input.before.createdAt && state.id < input.before.id)),
      )
      .toSorted(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, input.limit ?? 100),
  getTeam: async () => undefined,
  listTeams: async () => [],
  listTeamsOfTag: async () => [],
  listTagMessagingGrants: async () => [],
};

describe("WorkService, TeamService and MailboxService", () => {
  let url = "";
  let server: Server | undefined;
  const audited: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const created: Record<string, unknown>[] = [];
  const grants = new Set<string>();

  beforeAll(async () => {
    const principals: Record<string, OperatorAuthentication> = {
      "Bearer alice": {
        kind: "operator-token",
        principal: { operatorId: "alice", scopes: { actions: ["*"] } },
      },
      "Bearer admin": {
        kind: "break-glass",
        principal: { operatorId: "control-plane-break-glass", scopes: { actions: ["*"] } },
      },
    };
    const control = {
      accepting: async () => true,
      cancelTask: async (id: string) => {
        cancelled.push(id);
        return {
          accepted: true,
          task: { ...(TASKS.find((candidate) => candidate.id === id) ?? {}), status: "running" },
        };
      },
      createTeam: async (input: Record<string, unknown>) => {
        created.push(input);
        return { ...input, maxConcurrency: null, revision: 1, createdAt: AT, updatedAt: AT };
      },
      grantMailbox: async (grant: { senderTagId: string; recipientTagId: string }) => {
        const key = `${grant.senderTagId}>${grant.recipientTagId}`;
        const changed = !grants.has(key);
        grants.add(key);
        return { grant, changed };
      },
    };
    const handler = createOperatorRpcHandler(
      {
        auditTrail: { record: async (entry) => void audited.push({ ...entry }) },
        authenticate: async (authorization) =>
          authorization === undefined ? undefined : principals[authorization],
        accepting: () => true,
      },
      (router) => {
        router.service(
          WorkService,
          workService({ store: store as never, writes: {} as never, control: control as never }),
        );
        router.service(
          TeamService,
          teamService({ store: store as never, control: control as never }),
        );
        router.service(
          MailboxService,
          mailboxService({ store: store as never, control: control as never }),
        );
      },
    );
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  beforeEach(() => {
    audited.length = 0;
    cancelled.length = 0;
    created.length = 0;
    grants.clear();
    extraTasks.length = 0;
    sessionStates.length = 0;
  });

  const work = (token = "alice") => workClient({ url, token });

  it("hides another operator's CLI conversation, its work Sessions, Tasks and artifacts", async () => {
    const sessions = await work().listSessions({});
    expect(sessions.sessions.map((candidate) => candidate.id)).toEqual([
      "alice-plan",
      "alice-work",
      "thread",
    ]);
    const tasks = await work().listTasks({});
    expect(tasks.tasks.map((candidate) => candidate.id)).toEqual([
      "alice-task",
      "work-task",
      "thread-1",
      "thread-2",
    ]);
    for (const call of [
      () => work().getSession({ id: "bob-plan" }),
      () => work().getTask({ id: "bob-task" }),
      () => work().listTaskEvents({ taskId: "bob-task" }),
      () => work().cancelTask({ id: "bob-task" }),
      () => work().getArtifact({ id: "bob-plan-artifact" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: Code.NotFound });
    expect(cancelled).toEqual([]);
    expect((await work().listArtifacts({})).artifacts.map((artifact) => artifact.id)).toEqual([
      "alice-plan-artifact",
    ]);
    // The admin token holds the `admin` conversations, so Alice's are hidden from it too.
    expect(
      (await work("admin").listSessions({})).sessions.map((candidate) => candidate.id),
    ).toEqual(["thread"]);
  });

  it("pages Tasks and events with stateless tokens", async () => {
    const first = await work().listTasks({ pageSize: 2 });
    expect(first.tasks.map((candidate) => candidate.id)).toEqual(["alice-task", "work-task"]);
    expect(first.tasks[0]).toMatchObject({ tag: "builder", status: TaskStatus.PENDING });
    const second = await work().listTasks({ pageSize: 2, pageToken: first.nextPageToken });
    expect(second.tasks.map((candidate) => candidate.id)).toEqual(["thread-1", "thread-2"]);
    expect(second.nextPageToken).toBe("");
    await expect(work().listTasks({ pageToken: "not a token" })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    const events = await work().listTaskEvents({ taskId: "thread-1", pageSize: 2 });
    expect(events.events.map((event) => event.sequence)).toEqual([1n, 2n]);
    const rest = await work().listTaskEvents({
      taskId: "thread-1",
      pageSize: 10,
      pageToken: events.nextPageToken,
    });
    expect(rest.events.map((event) => event.sequence)).toEqual([3n, 4n, 5n]);
    expect(
      (await work().listTaskEvents({ taskId: "thread-1", afterSequence: 4n })).events,
    ).toHaveLength(1);
  });

  it("pages every matching Task however old, past Tasks the caller cannot see", async () => {
    const at = (base: string, offset: number) =>
      new Date(Date.parse(base) + offset * 1_000).toISOString();
    for (let index = 0; index < 1_500; index += 1)
      extraTasks.push(
        task(
          `old-${String(index).padStart(4, "0")}`,
          "thread",
          at("2026-11-01T00:00:00.000Z", -index),
          {
            ...(index >= 1_000 ? { objectiveId: "objective-o" } : {}),
          },
        ),
      );
    const objective = await work().listTasks({ objectiveId: "objective-o", pageSize: 500 });
    expect(objective.tasks).toHaveLength(500);
    expect(objective.tasks.every((candidate) => candidate.objectiveId === "objective-o")).toBe(
      true,
    );
    expect(objective.nextPageToken).toBe("");
    const seen: string[] = [];
    let token = "";
    do {
      const page = await work().listTasks({ pageSize: 500, pageToken: token });
      seen.push(...page.tasks.map((candidate) => candidate.id));
      token = page.nextPageToken;
    } while (token !== "");
    expect(seen).toHaveLength(1_504);
    expect(new Set(seen).size).toBe(1_504);
    expect(seen).not.toContain("bob-task");
    extraTasks.length = 0;
    for (let index = 0; index < 6_000; index += 1)
      extraTasks.push(task(`bob-${index}`, "bob-plan", at("2026-11-09T00:00:00.000Z", index)));
    const hidden = await work().listTasks({ pageSize: 10 });
    expect(hidden.tasks).toEqual([]);
    expect(hidden.nextPageToken).not.toBe("");
    const mine = await work().listTasks({ pageSize: 10, pageToken: hidden.nextPageToken });
    expect(mine.tasks.map((candidate) => candidate.id)).toEqual([
      "alice-task",
      "work-task",
      "thread-1",
      "thread-2",
    ]);
    expect(mine.nextPageToken).toBe("");
  });

  it("pages every native archive of a Session", async () => {
    for (let index = 0; index < 150; index += 1)
      sessionStates.push({
        id: `state-${String(index).padStart(3, "0")}`,
        sessionId: "alice-plan",
        taskId: "alice-task",
        attemptId: "attempt",
        harnessId: "codex",
        nativeId: `thread-${index}`,
        ref: { id: `state-${index}` },
        status: "stored",
        writeVersion: 1,
        createdAt: new Date(Date.parse(AT) + index * 1_000).toISOString(),
        updatedAt: AT,
      });
    for (const pageSize of [50, 100]) {
      const seen: string[] = [];
      let token = "";
      let pages = 0;
      do {
        const page = await work().listSessionStates({
          sessionId: "alice-plan",
          pageSize,
          pageToken: token,
        });
        seen.push(...page.states.map((state) => state.id));
        token = page.nextPageToken;
        pages += 1;
      } while (token !== "");
      expect(pages).toBe(Math.ceil(150 / pageSize));
      expect(seen).toEqual(sessionStates.map((state) => state.id).toReversed());
    }
  });

  it("reads a work Session's delivered branch and where its checkout is", async () => {
    const read = await work().getSession({ id: "alice-work" });
    expect(read).toMatchObject({
      parentSessionId: "alice-plan",
      latestTaskId: "work-task",
      delivery: {
        taskId: "work-task",
        delivery: {
          workspace: { name: "app", branch: "supertag/session/alice-work", head: "abcdef1" },
        },
        checkout: { workerHostId: "laptop", ephemeral: false },
      },
    });
    const listed = await work().listSessions({ parentSessionId: "alice-plan" });
    expect(listed.sessions.map((candidate) => [candidate.id, candidate.delivery])).toEqual([
      ["alice-work", undefined],
    ]);
  });

  it("cancels a Task through the control seam and audits it by Task", async () => {
    expect(await work().cancelTask({ id: "alice-task" })).toMatchObject({
      taskId: "alice-task",
      accepted: true,
      status: TaskStatus.RUNNING,
    });
    expect(cancelled).toEqual(["alice-task"]);
    await expect.poll(() => audited.length).toBe(1);
    expect(audited[0]).toMatchObject({
      actor: "alice",
      action: "task.cancel",
      target: "Task/alice-task",
      outcome: "succeeded",
      path: "/supertag.operator.v1.WorkService/CancelTask",
    });
  });

  it("serves each service as plain Connect JSON", async () => {
    const call = async (path: string, body: unknown) => {
      const response = await fetch(`${url}/supertag.operator.v1.${path}`, {
        method: "POST",
        headers: { authorization: "Bearer alice", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect(await call("WorkService/GetTask", { id: "alice-task" })).toMatchObject({
      status: 200,
      body: { id: "alice-task", tag: "builder", status: "TASK_STATUS_PENDING" },
    });
    expect(
      await call("TeamService/CreateTeam", { name: "crew", members: ["builder", "reviewer"] }),
    ).toMatchObject({
      status: 200,
      body: {
        id: "crew",
        members: [
          { tagId: "tag-builder", tag: "builder" },
          { tagId: "tag-reviewer", tag: "reviewer" },
        ],
        revision: "1",
      },
    });
    expect(created).toEqual([
      { id: "crew", name: "crew", memberTagIds: ["tag-builder", "tag-reviewer"] },
    ]);
    expect(
      await call("MailboxService/GrantMailbox", { sender: "builder", recipient: "reviewer" }),
    ).toMatchObject({
      status: 200,
      body: {
        grant: { senderTagId: "tag-builder", recipientTagId: "tag-reviewer" },
        changed: true,
      },
    });
  });

  it("refuses unknown Tags and empty Team members before any write", async () => {
    const teams = teamClient({ url, token: "alice" });
    await expect(teams.createTeam({ name: "crew", members: ["nobody"] })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await expect(teams.createTeam({ name: "crew", members: [] })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await expect(
      mailboxClient({ url, token: "alice" }).grantMailbox({ sender: "builder", recipient: "" }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(created).toEqual([]);
    expect(grants.size).toBe(0);
  });
});
