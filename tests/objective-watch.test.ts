import { describe, expect, it } from "vitest";
import type { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.ts";
import { watchObjective } from "../apps/cli/src/objective-watch.ts";
import type { ObjectiveOverview } from "../packages/control-plane/src/index.ts";
import type { ApprovalRequest, TaskDelivery, WorkstreamPost } from "../packages/core/src/index.ts";

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
    pool: { limitMinor: null, currency: null, spentMinor: null },
    objectiveSpend: { attempts: 0 },
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

/**
 * A client that answers each overview poll with the next scripted snapshot, keeping the last one
 * afterwards, plus the approval requests and Workstream posts of that step.
 */
function scripted(
  steps: readonly {
    readonly view: ObjectiveOverview;
    readonly approvals?: readonly ApprovalRequest[];
    readonly posts?: readonly WorkstreamPost[];
  }[],
) {
  let step = -1;
  const paths: string[] = [];
  const client = {
    request: async (path: string) => {
      paths.push(path);
      if (path.includes("/overview")) {
        step = Math.min(step + 1, steps.length - 1);
        return steps[step]?.view;
      }
      const current = steps[Math.max(step, 0)];
      if (path.includes("/approvals")) return { requests: current?.approvals ?? [] };
      if (path.includes("/posts")) {
        const after = Number(new URL(path, "http://x").searchParams.get("afterSequence") ?? 0);
        return { items: (current?.posts ?? []).filter((post) => post.sequence > after) };
      }
      throw new Error(`Unexpected request ${path}`);
    },
  } as unknown as Pick<ControlPlaneClient, "request">;
  return { client, paths, polls: () => step + 1 };
}

async function run(
  steps: Parameters<typeof scripted>[0],
  options: { readonly output?: "json" | "text"; readonly settleMs?: number } = {},
) {
  const written: string[] = [];
  const controller = new AbortController();
  const { client, paths } = scripted(steps);
  // Stop once the watch has seen every step, in case the Objective never closes.
  let polls = 0;
  const counting = {
    request: async (path: string) => {
      if (path.includes("/overview") && ++polls > steps.length) controller.abort();
      return client.request(path);
    },
  } as unknown as Pick<ControlPlaneClient, "request">;
  await watchObjective(counting, OBJECTIVE, {
    output: options.output ?? "text",
    signal: controller.signal,
    write: (text) => written.push(text),
    intervalMs: 1,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  });
  return { written, text: written.join(""), lines: written.join("").split("\n"), paths };
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
    const { text, paths } = await run([
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
    // Each poll reads only the posts after the newest one already printed.
    expect(paths.filter((path) => path.includes("/posts")).at(-1)).toContain("afterSequence=1");
    expect(text.split("Workstream post 1")).toHaveLength(2);
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
    await expect(
      watchObjective(
        {
          request: async () => {
            throw new Error("Objective not found");
          },
        } as unknown as Pick<ControlPlaneClient, "request">,
        "missing",
        {
          output: "text",
          signal: controller.signal,
          write: () => undefined,
          intervalMs: 1,
        },
      ),
    ).rejects.toThrow("Objective not found");
    const written: string[] = [];
    const stopping = new AbortController();
    let polls = 0;
    await watchObjective(
      {
        request: async (path: string) => {
          if (path.includes("/overview")) {
            if (++polls === 2) stopping.abort();
            return view();
          }
          return path.includes("/approvals") ? { requests: [] } : { items: [] };
        },
      } as unknown as Pick<ControlPlaneClient, "request">,
      OBJECTIVE,
      {
        output: "text",
        signal: stopping.signal,
        write: (text) => written.push(text),
        intervalMs: 1,
      },
    );
    // An open Objective prints no closing summary when the watch is interrupted.
    expect(written.join("")).not.toContain("is completed");
    expect(polls).toBe(2);
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
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Objective ${OBJECTIVE}: ready for review`);
    expect(lines[1]).toBe("Outcome: Ship SSO for the admin console");
    expect(text).toContain("Runnable: yes");
    expect(text).toContain("Delivered:\n  Build the exporter (builder, Task task-build)");
    expect(text).toContain(`Branch ${BRANCH} in Workspace product, 3 changed files`);
    expect(text).toContain("The owner submitted the Objective for review.");
    expect(text).toContain(`Approve: supertag approve objective ${OBJECTIVE}`);
    expect(text).toContain(`Ask for changes: supertag message objective ${OBJECTIVE} TEXT`);
    expect(text).toContain("Work: 2 Sessions");
  });

  it("shows the owner's question in full, with the command that answers it", () => {
    const question = `Which region first?\n\n${"Detail. ".repeat(30)}`;
    const text = formatObjectiveOverview(
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
    );
    expect(text).toContain('planner asks: "Which region first?');
    expect(text).toContain("Detail. Detail.");
    expect(text).toContain(`supertag message objective ${OBJECTIVE} TEXT`);
  });

  it("says nothing was delivered for a closed Objective and keeps the follow-up commands", () => {
    const text = formatObjectiveOverview(
      view({ objective: { ...view().objective, status: "cancelled", cancelledAt: "2026-11-07Z" } }),
    );
    expect(text).toContain("Delivered:\n  Nothing was delivered.");
    expect(text).toContain("Needs you:\n  Nothing right now.");
    expect(text).toContain("Cancelled: 2026-11-07Z");
    expect(text).toContain(`Full record: supertag describe objective ${OBJECTIVE} --output json`);
  });
});
