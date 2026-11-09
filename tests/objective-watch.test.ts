import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.ts";
import { approvalMessage } from "../apps/cli/src/objective-protos.ts";
import { type ObjectiveWatchClients, watchObjective } from "../apps/cli/src/objective-watch.ts";
import type { ObjectiveOverview } from "../packages/control-plane/src/index.ts";
import type { ApprovalRequest, TaskDelivery, WorkstreamPost } from "../packages/core/src/index.ts";
import {
  ListApprovalsResponseSchema,
  WatchChangeSchema,
  type WatchEvent,
  WatchEventSchema,
  WatchKind,
} from "../packages/operator-api/src/index.ts";
import { aborted } from "./support/fake-operator-rpc.ts";
import { describedOverview, overviewViewOf } from "./support/objective-overview-view.ts";

const OBJECTIVE = "ship-sso-7f3k";
const OWNER = "owner-tag";
const HELPER = "helper-tag";
const TEAM = "launch";
const BRANCH = `supertag/${OBJECTIVE}/build`;
const HEAD = "0123456789abcdef0123456789abcdef01234567";

type Session = ObjectiveOverview["sessions"][number];

const delivery = (changedFiles = 3): TaskDelivery => ({
  workspace: {
    name: "product",
    delivery: "branch",
    branch: BRANCH,
    head: HEAD,
    base: "fedcba9876543210",
    changedFiles,
  },
  patches: [],
  outputs: [],
});

function ownerSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-owner",
    tagId: OWNER,
    owner: true,
    status: "completed",
    taskCount: 1,
    createdAt: "2026-11-07T00:00:00.000Z",
    task: {
      id: "task-start",
      status: "completed",
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:10.000Z",
      workspace: null,
      delivery: null,
      explanations: [],
    },
    ...overrides,
  } as Session;
}

function workSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-build",
    tagId: HELPER,
    owner: false,
    title: "Build the exporter",
    parentSessionId: "session-owner",
    status: "running",
    taskCount: 1,
    createdAt: "2026-11-07T00:00:20.000Z",
    task: {
      id: "task-build",
      status: "running",
      createdAt: "2026-11-07T00:00:20.000Z",
      updatedAt: "2026-11-07T00:00:20.000Z",
      workspace: "product",
      delivery: null,
      attemptStatus: "running",
      explanations: [],
    },
    ...overrides,
  } as Session;
}

function view(overrides: Partial<ObjectiveOverview> = {}): ObjectiveOverview {
  return {
    projectionVersion: 1,
    capturedAt: "2026-11-07T00:01:00.000Z",
    objective: {
      id: OBJECTIVE,
      status: "working",
      outcome: "Ship SSO for the admin console",
      ownerTagId: OWNER,
      teamId: TEAM,
      revision: 1,
      completionSummary: null,
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
      workspaces: ["product"],
    },
    conditions: [],
    attention: [],
    tagNames: { [OWNER]: "planner", [HELPER]: "builder" },
    team: { id: TEAM, name: "launch", memberTagIds: [OWNER, HELPER], maxConcurrency: null },
    executionReadiness: "ready",
    limits: { deadline: null, budget: null },
    pool: { limitMinor: null, currency: null, spentMinor: null, availableMinor: null },
    objectiveSpend: {
      attempts: 0,
      reportedCostByCurrency: null,
      unknownCostAttempts: 0,
      reportedTokens: null,
      unknownTokenAttempts: 0,
    },
    conversation: [],
    sessions: [ownerSession()],
    highFindings: [],
    posts: [],
    writes: [],
    tasks: [],
    pageUsage: { taskIds: [], provider: { observedCostByCurrency: {} } },
    total: 1,
    offset: 0,
    nextOffset: null,
    ...overrides,
  } as unknown as ObjectiveOverview;
}

/** A change stream: a heartbeat, then a change to the Objective each time `next` is called. */
function changes() {
  const waiting: (() => void)[] = [];
  let position = 0;
  const event = (value: WatchEvent["event"]) =>
    create(WatchEventSchema, { resumeToken: `v1.test.${position}`, event: value });
  const events: ObjectiveWatchClients["events"] = {
    watch: (_request, options) =>
      (async function* () {
        const signal = options?.signal ?? new AbortController().signal;
        yield event({ case: "heartbeat", value: {} });
        while (!signal.aborted) {
          await Promise.race([
            new Promise<void>((resolve) => waiting.push(resolve)),
            aborted(signal),
          ]);
          if (signal.aborted) return;
          position += 1;
          yield event({
            case: "change",
            value: create(WatchChangeSchema, {
              kind: WatchKind.OBJECTIVE,
              id: OBJECTIVE,
              objectiveId: OBJECTIVE,
              reason: "changed",
            }),
          });
        }
      })(),
  };
  return {
    events,
    next: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/**
 * Clients that answer each overview read with the next scripted snapshot, keeping the last one
 * afterwards, plus the approval requests and Workstream posts of that step. Each read but the
 * last sends one change notice, so the watch reads every step once.
 */
function scripted(
  steps: readonly {
    readonly view: ObjectiveOverview;
    readonly approvals?: readonly ApprovalRequest[];
    readonly posts?: readonly WorkstreamPost[];
  }[],
  afterLast: () => void,
) {
  let step = -1;
  const stream = changes();
  const clients: ObjectiveWatchClients = {
    events: stream.events,
    objectives: {
      describeObjective: async () => {
        step = Math.min(step + 1, steps.length - 1);
        if (step < steps.length - 1) setTimeout(stream.next, 1);
        else setTimeout(afterLast, 20);
        const current = steps[step];
        if (current === undefined) throw new Error("No step");
        return describedOverview(current.view);
      },
    },
    inbox: {
      listApprovals: async () =>
        create(ListApprovalsResponseSchema, {
          approvals: (steps[Math.max(step, 0)]?.approvals ?? []).map(approvalMessage),
        }),
    },
    posts: async (_teamId, afterSequence, limit) =>
      (steps[Math.max(step, 0)]?.posts ?? [])
        .filter((post) => post.sequence > afterSequence)
        .slice(0, limit),
  };
  return { clients, reads: () => step + 1 };
}

async function run(
  steps: Parameters<typeof scripted>[0],
  options: { readonly output?: "json" | "text"; readonly settleMs?: number } = {},
) {
  const written: string[] = [];
  const controller = new AbortController();
  // Stop once the watch has read every step, in case the Objective never closes.
  const { clients } = scripted(steps, () => controller.abort());
  await watchObjective(clients, OBJECTIVE, {
    output: options.output ?? "text",
    signal: controller.signal,
    write: (text) => written.push(text),
    intervalMs: 1,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  });
  return { written, text: written.join(""), lines: written.join("").split("\n") };
}

describe("watch objective", () => {
  it("streams one line per event with time and actor, and stops when the Objective closes", async () => {
    const built = workSession({
      status: "completed",
      task: {
        ...(workSession().task as NonNullable<Session["task"]>),
        status: "completed",
        updatedAt: "2026-11-07T00:00:40.000Z",
        attemptStatus: "completed",
        delivery: delivery(),
      },
    });
    const { text } = await run([
      { view: view() },
      { view: view({ sessions: [ownerSession(), workSession()] }) },
      { view: view({ sessions: [ownerSession(), built] }) },
      {
        view: view({
          objective: {
            ...view().objective,
            status: "completed",
            completionSummary: "SSO ships behind a flag.",
            updatedAt: "2026-11-07T00:00:50.000Z",
          },
          sessions: [ownerSession(), built],
        }),
      },
    ]);
    const timeline = text.split("\n");
    expect(timeline[0]).toBe(
      `2026-11-07 00:00:00Z  operator      Objective ${OBJECTIVE} created for planner: Ship SSO for the admin console`,
    );
    expect(timeline).toContain(
      "2026-11-07 00:00:10Z  planner       Objective conversation: Task task-start finished",
    );
    expect(timeline).toContain("2026-11-07 00:00:20Z  builder       Started Build the exporter");
    expect(timeline).toContain(
      `2026-11-07 00:00:40Z  builder       Build the exporter: Task task-build delivered branch ${BRANCH}`,
    );
    // The closing summary names the result and what each Session delivered.
    expect(text).toContain(`Objective ${OBJECTIVE} is completed.`);
    expect(text).toContain("Result: SSO ships behind a flag.");
    expect(text).toContain(`Build the exporter (builder)`);
    expect(text).toContain(`Branch ${BRANCH} in Workspace product, 3 changed files`);
  });

  it("waits after the Objective closes for a delivery still being recorded", async () => {
    const closed = {
      ...view().objective,
      status: "completed" as const,
      updatedAt: new Date().toISOString(),
    };
    const pending = workSession();
    const recorded = workSession({
      task: {
        ...(workSession().task as NonNullable<Session["task"]>),
        status: "completed",
        attemptStatus: "completed",
        updatedAt: "2026-11-07T00:00:45.000Z",
        delivery: delivery(1),
      },
    });
    const { text } = await run([
      { view: view({ objective: closed, sessions: [ownerSession(), pending] }) },
      { view: view({ objective: closed, sessions: [ownerSession(), recorded] }) },
    ]);
    expect(text).toContain("delivered branch");
    expect(text).toContain("1 changed file");
  });

  it("stops waiting for a delivery after the settle time", async () => {
    const closed = {
      ...view().objective,
      status: "cancelled" as const,
      cancellationReason: "Superseded",
      cancelledAt: "2026-11-07T00:02:00.000Z",
      updatedAt: "2026-11-07T00:02:00.000Z",
    };
    const { text } = await run(
      [{ view: view({ objective: closed, sessions: [ownerSession(), workSession()] }) }],
      { settleMs: 0 },
    );
    expect(text).toContain("Objective cancelled: Superseded");
    expect(text).toContain(`Objective ${OBJECTIVE} is cancelled.`);
    expect(text).not.toContain("Delivered:");
  });

  it("emits JSON lines and returns at once for an Objective that is already closed", async () => {
    const { written } = await run(
      [
        {
          view: view({
            objective: {
              ...view().objective,
              status: "completed",
              updatedAt: "2026-11-07T00:00:20.000Z",
            },
            sessions: [ownerSession()],
          }),
        },
      ],
      { output: "json" },
    );
    const events = written.filter((line) => line.trim()).map((line) => JSON.parse(line));
    expect(events.map((event) => event.kind)).toEqual([
      "objective.created",
      "task.status",
      "objective.closed",
    ]);
    expect(events[0]).toMatchObject({ objectiveId: OBJECTIVE, actor: "operator" });
    expect(events[2]).toMatchObject({ status: "completed" });
  });

  it("shows approvals and Team posts in the timeline", async () => {
    const request = {
      id: "request-1",
      objectiveId: OBJECTIVE,
      taskId: "task-build",
      requestingTagId: HELPER,
      kind: "surface-action",
      actions: [],
      ruleSources: [],
      approvers: [],
      summary: "Merge pull request 42",
      status: "pending",
      createdAt: "2026-11-07T00:00:30.000Z",
      updatedAt: "2026-11-07T00:00:30.000Z",
    } as unknown as ApprovalRequest;
    const post = {
      id: "post-1",
      teamId: TEAM,
      authorTagId: HELPER,
      to: [OWNER],
      body: "Export is ready for review.",
      sequence: 1,
      createdAt: "2026-11-07T00:00:35.000Z",
    } as WorkstreamPost;
    const { text } = await run([
      { view: view(), approvals: [request], posts: [post] },
      {
        view: view(),
        approvals: [
          {
            ...request,
            status: "approved",
            decidedAt: "2026-11-07T00:00:38.000Z",
            decidedByKind: "operator",
            decidedBy: "ops",
            updatedAt: "2026-11-07T00:00:38.000Z",
          } as unknown as ApprovalRequest,
        ],
        posts: [post],
      },
    ]);
    expect(text).toContain(
      "2026-11-07 00:00:30Z  builder       Requested approval request-1: Merge pull request 42",
    );
    expect(text).toContain(
      "2026-11-07 00:00:35Z  builder       Workstream post 1 to planner: Export is ready for review.",
    );
    expect(text).toContain("2026-11-07 00:00:38Z  operator      Approval request-1 approved");
    // Each read prints only the posts after the newest one already printed.
    expect(text.split("Workstream post 1")).toHaveLength(2);
  });

  it("replays every Team post, a page at a time, and prints each burst in full", async () => {
    const post = (sequence: number) =>
      ({
        id: `post-${sequence}`,
        teamId: TEAM,
        authorTagId: HELPER,
        to: [],
        body: `Update ${sequence}`,
        sequence,
        createdAt: new Date(Date.parse("2026-11-07T00:01:00.000Z") + sequence * 1000).toISOString(),
      }) as WorkstreamPost;
    const first = Array.from({ length: 120 }, (_, index) => post(index + 1));
    const burst = [...first, ...Array.from({ length: 130 }, (_, index) => post(index + 121))];
    const { text } = await run([
      { view: view(), posts: first },
      { view: view(), posts: burst },
    ]);
    for (const sequence of [1, 50, 120, 121, 250])
      expect(text.split(`Workstream post ${sequence}: `)).toHaveLength(2);
    expect(text.match(/Workstream post \d+: /gu)).toHaveLength(250);
  });

  it("rereads approvals and posts after a failed read instead of waiting for a change", async () => {
    const post = {
      id: "post-1",
      teamId: TEAM,
      authorTagId: HELPER,
      to: [],
      body: "Export is ready.",
      sequence: 1,
      createdAt: "2026-11-07T00:00:35.000Z",
    } as WorkstreamPost;
    const controller = new AbortController();
    const written: string[] = [];
    let postReads = 0;
    let approvalReads = 0;
    const clients: ObjectiveWatchClients = {
      events: changes().events,
      objectives: { describeObjective: async () => describedOverview(view()) },
      inbox: {
        listApprovals: async () => {
          approvalReads += 1;
          if (approvalReads === 1) throw new Error("unavailable");
          return create(ListApprovalsResponseSchema, {});
        },
      },
      posts: async () => {
        postReads += 1;
        if (postReads === 1) throw new Error("unavailable");
        setTimeout(() => controller.abort(), 20);
        return [post];
      },
    };
    await watchObjective(clients, OBJECTIVE, {
      output: "text",
      signal: controller.signal,
      write: (text) => written.push(text),
      intervalMs: 1,
    });
    expect(written.join("")).toContain("Workstream post 1: Export is ready.");
    expect(approvalReads).toBeGreaterThan(1);
  });

  it("explains a failed turn on its own lines and keeps the message in JSON", async () => {
    const failed = ownerSession({
      status: "failed",
      task: {
        ...(ownerSession().task as NonNullable<Session["task"]>),
        status: "failed",
        updatedAt: "2026-11-07T00:00:15.000Z",
        explanations: [
          {
            kind: "execution_failed",
            message: "The harness is not signed in.",
            nextAction: "Inspect it.",
            harness: "codex",
            failureKind: "harness_sign_in",
          },
        ],
      },
    });
    const { text } = await run([{ view: view({ sessions: [failed] }) }]);
    const [headline, detail] = text
      .split("\n")
      .filter((line) => line.includes("Task task-start") || line.trim().startsWith("The harness"));
    expect(headline).toBe(
      "2026-11-07 00:00:15Z  planner       Objective conversation: Task task-start failed",
    );
    expect(detail?.trim()).toContain("The harness is not signed in.");
    const { written } = await run([{ view: view({ sessions: [failed] }) }], { output: "json" });
    const event = written.map((line) => JSON.parse(line)).find((item) => item.status === "failed");
    expect(event).toMatchObject({
      failure: "The harness is not signed in.",
      harness: "codex",
      failureKind: "harness_sign_in",
      message: "Objective conversation: Task task-start failed: The harness is not signed in.",
    });
  });

  it("shows a question the owner's turn is waiting on", async () => {
    const asking = ownerSession({
      status: "waiting",
      task: {
        ...(ownerSession().task as NonNullable<Session["task"]>),
        status: "waiting",
        question: "Which region first?",
        updatedAt: "2026-11-07T00:00:12.000Z",
      },
    });
    const { text } = await run([{ view: view({ sessions: [asking] }) }]);
    expect(text).toContain(
      "Objective conversation: Task task-start is waiting: Which region first?",
    );
  });

  it("fails at once for an Objective it cannot read, and stops when the signal aborts", async () => {
    const controller = new AbortController();
    const refused: ObjectiveWatchClients = {
      events: changes().events,
      objectives: {
        describeObjective: async () => {
          throw new Error("Objective not found");
        },
      },
      inbox: { listApprovals: async () => create(ListApprovalsResponseSchema, {}) },
      posts: async () => [],
    };
    await expect(
      watchObjective(refused, "missing", {
        output: "text",
        signal: controller.signal,
        write: () => undefined,
        intervalMs: 1,
      }),
    ).rejects.toThrow("Objective not found");
    const written: string[] = [];
    const stopping = new AbortController();
    const { clients, reads } = scripted([{ view: view() }, { view: view() }], () =>
      stopping.abort(),
    );
    await watchObjective(clients, OBJECTIVE, {
      output: "text",
      signal: stopping.signal,
      write: (text) => written.push(text),
      intervalMs: 1,
    });
    // An open Objective prints no closing summary when the watch is interrupted.
    expect(written.join("")).not.toContain("is completed");
    expect(reads()).toBe(2);
  });
});

describe("describe objective", () => {
  it("leads with status, owner, deliveries, and what needs the operator", () => {
    const delivered = workSession({
      status: "completed",
      task: {
        ...(workSession().task as NonNullable<Session["task"]>),
        status: "completed",
        delivery: delivery(),
      },
    });
    const text = formatObjectiveOverview(
      overviewViewOf(
        view({
          objective: { ...view().objective, status: "ready_for_review" },
          sessions: [ownerSession(), delivered],
          attention: [
            {
              kind: "objective_review",
              message: "The owner submitted this Objective for review.",
              nextAction: "Approve it.",
            },
          ],
          conditions: [{ type: "Runnable", status: true, reasons: [] }],
        }),
      ),
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Objective ${OBJECTIVE}: ready for review`);
    expect(lines[1]).toBe("Outcome: Ship SSO for the admin console");
    expect(text).toContain("Runnable: yes");
    expect(text).toContain("Delivered:\n  Build the exporter (builder, Task task-build)");
    expect(text).toContain(`Branch ${BRANCH} in Workspace product, 3 changed files`);
    expect(text).toContain("The owner submitted the Objective for review.");
    expect(text).toContain(`Approve: supertag approve objective ${OBJECTIVE}`);
    expect(text).toContain(
      "To ask for changes, open supertag in a terminal, select this Objective, and press m.",
    );
    expect(text).toContain("Work: 2 Sessions");
  });

  it("shows the owner's question in full and directs the operator to the terminal UI", () => {
    const question = `Which region first?\n\n${"Detail. ".repeat(30)}`;
    const text = formatObjectiveOverview(
      overviewViewOf(
        view({
          sessions: [
            ownerSession({
              status: "waiting",
              task: {
                ...(ownerSession().task as NonNullable<Session["task"]>),
                status: "waiting",
                question,
              },
            }),
          ],
        }),
      ),
    );
    expect(text).toContain('planner asks: "Which region first?');
    expect(text).toContain("Detail. Detail.");
    expect(text).toContain("Open supertag in a terminal and answer under Waiting on you.");
  });

  it("says nothing was delivered for a closed Objective and keeps the follow-up commands", () => {
    const text = formatObjectiveOverview(
      overviewViewOf(
        view({
          objective: {
            ...view().objective,
            status: "cancelled",
            cancelledAt: "2026-11-07T00:02:00.000Z",
          },
        }),
      ),
    );
    expect(text).toContain("Delivered:\n  Nothing was delivered.");
    expect(text).toContain("Needs you:\n  Nothing right now.");
    expect(text).toContain("Cancelled: 2026-11-07T00:02:00.000Z");
    expect(text).toContain(`Full record: supertag describe objective ${OBJECTIVE} --output json`);
  });
});
