import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.ts";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.ts";
import { watchObjective } from "../apps/cli/src/objective-watch.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.ts";
import { emptyTagContextPlan, type Tag } from "../packages/core/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";

const OBJECTIVE = "ship-sso-7f3k";
const BRANCH = `supertag/${OBJECTIVE}/build`;
// Admission names each Workspace Task's branch after its Objective and Task.
const START_BRANCH = `supertag/${OBJECTIVE}/start`;
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";

/**
 * A scripted Objective lifecycle against a real store and Objective controller. Each overview
 * read advances the script one step, so every watch poll observes exactly one step's changes.
 */
async function lifecycle(
  options: { readonly lateDelivery?: boolean; readonly harness?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-objective-watch-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  // Admission reserves a Workspace Task's branch against its stored Workspace.
  await store.applyWorkspace({ name: "app", delivery: "branch" });
  const lead = await store.createTag({ name: "lead" });
  const builder = await store.createTag({ name: "builder" });
  await store.createObjective({
    id: OBJECTIVE,
    ownerTagId: lead.id,
    outcome: "Ship SSO for the admin console. Done when sign-in works with Okta.",
  });
  const team = await store.createTeam({
    id: `${OBJECTIVE}:leadership`,
    objectiveId: OBJECTIVE,
    name: "Leadership",
    leadTagId: lead.id,
    memberTagIds: [builder.id],
    maxConcurrency: 2,
  });
  const controller = new ObjectiveController(store, undefined);
  const admit = (
    taskId: string,
    assigned: Tag,
    instruction: string,
    workspace = false,
    start = false,
  ) => {
    const at = new Date().toISOString();
    return store.admitTaskAssignment({
      taskId,
      ...(start ? { startObjectiveExecution: true as const } : {}),
      objectiveId: OBJECTIVE,
      teamId: team.id,
      requestedByTagId: lead.id,
      assignedTagId: assigned.id,
      instruction,
      acceptanceCriteria: ["Reviewed"],
      requiresApproval: false,
      dependencies: [],
      maxCostMinor: 0,
      execution: {},
      workspacePlan: workspace
        ? { version: 1, status: "workspace", workspace: "app", branch: BRANCH, delivery: "branch" }
        : { version: 1, status: "none" },
      contextPlan: emptyTagContextPlan(at),
      authorizationSnapshot: {
        version: 4,
        capturedAt: at,
        tag: { id: assigned.id, name: assigned.name },
        origin: { kind: "internal", objectiveId: OBJECTIVE, requestedByTagId: lead.id },
        requester: { id: lead.id, kind: "bot" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
    });
  };
  const run = async (taskId: string) => {
    await store.claimTaskAssignment({ taskId, leaseOwner: "test", leaseSeconds: 60 });
    return store.createTaskAttempt({
      taskId,
      attemptNumber: 1,
      workerProfile: { id: "fixture", revision: "1" },
      workerSnapshot: options.harness
        ? {
            placement: { workerHostId: "laptop", workerId: "worker" },
            execution: { harness: options.harness },
          }
        : {},
      startedAt: new Date().toISOString(),
    });
  };
  const submit = async (taskId: string, attemptId: string, delivered: boolean) => {
    const branch = `supertag/${OBJECTIVE}/${taskId}`;
    const taskResult = {
      summary: "Done",
      decisions: [],
      changes: delivered
        ? [
            {
              summary: `Workspace app: branch ${branch} at ${HEAD.slice(0, 12)} with 4 changed files since ${BASE.slice(0, 12)}`,
              reference: `git:${branch}@${HEAD}`,
            },
          ]
        : [],
      unresolved: [],
      findings: [],
      references: [],
      artifacts: [],
    };
    if (delivered)
      await store.appendTaskEvent({
        taskId,
        attemptId,
        type: "progress.updated",
        payload: {
          progress: {
            summary: `Committed workspace app changes to ${branch}`,
            items: [
              { id: "workspace-branch", text: `Branch: ${branch}`, status: "completed" },
              { id: "workspace-base", text: `Base: ${BASE}`, status: "completed" },
            ],
          },
        },
      });
    await store.appendTaskEvent({
      taskId,
      attemptId,
      type: "result",
      payload: { type: "result", result: taskResult },
    });
    await store.settleTaskAssignment({
      taskId,
      leaseOwner: "test",
      attemptCount: 1,
      terminalAttempt: { id: attemptId, status: "completed" },
      result: { text: "Done", taskResult },
    });
  };
  const attempts = new Map<string, string>();
  const status = async (next: "ready_for_review" | "completed", completionSummary?: string) => {
    const objective = await store.getObjective(OBJECTIVE);
    await store.updateObjectiveStatus(
      OBJECTIVE,
      {
        status: next,
        expectedRevision: objective.revision,
        ...(completionSummary === undefined ? {} : { completionSummary }),
      },
      undefined,
      undefined,
      next === "completed" ? { operatorId: "operator" } : undefined,
    );
  };
  const late: Array<() => Promise<unknown>> = [
    async () => {
      await admit("start", lead, "Coordinate the Objective", true, true);
      attempts.set("start", (await run("start")).id);
    },
    async () => admit("build", builder, "Add Okta sign-in to the admin console"),
    async () => attempts.set("build", (await run("build")).id),
    async () => submit("build", attempts.get("build") as string, false),
    async () => store.reviewTaskAssignment("build", lead.id, true, "Sign-in works with Okta."),
    // The owner completes the Objective while its own Task Attempt still commits the branch.
    async () => {
      const objective = await store.getObjective(OBJECTIVE);
      await store.updateObjectiveStatus(
        OBJECTIVE,
        {
          status: "completed",
          expectedRevision: objective.revision,
          completionSummary: "Okta sign-in shipped on the build branch.",
        },
        lead.id,
      );
    },
    async () => {},
    async () => submit("start", attempts.get("start") as string, true),
  ];
  const steps: Array<() => Promise<unknown>> = options.lateDelivery
    ? late
    : [
        async () => {
          await admit("start", lead, "Coordinate the Objective", false, true);
          attempts.set("start", (await run("start")).id);
        },
        async () => admit("build", builder, "Add Okta sign-in to the admin console", true),
        async () => attempts.set("build", (await run("build")).id),
        async () =>
          store.createApprovalRequest({
            objectiveId: OBJECTIVE,
            taskId: "build",
            requestingTagId: builder.id,
            kind: "surface-action",
            actions: [{ target: "runtime", action: "commands:execute" }],
            summary: "Push the sign-in branch",
            ruleSources: ["release"],
            approvers: [],
          }),
        async () => {
          const [request] = await store.listApprovalRequests({ objectiveId: OBJECTIVE });
          await store.decideApprovalRequest({
            id: request?.id as string,
            decision: "approve",
            decidedBy: "operator",
            decidedByKind: "operator",
          });
        },
        async () => submit("build", attempts.get("build") as string, true),
        async () => store.reviewTaskAssignment("build", lead.id, true, "Sign-in works with Okta."),
        async () => submit("start", attempts.get("start") as string, false),
        async () => status("ready_for_review", "Okta sign-in shipped on the build branch."),
        async () => status("completed", "Okta sign-in shipped on the build branch."),
      ];
  let step = 0;
  const advance = async () => {
    const next = steps[step];
    step += 1;
    if (next) await next();
  };
  const client: Pick<ControlPlaneClient, "request"> = {
    async request<T>(pathname: string): Promise<T> {
      const url = new URL(pathname, "http://control-plane.test");
      if (url.pathname.endsWith("/overview")) {
        await advance();
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        return (await controller.readObjectiveOverview({
          objectiveId: OBJECTIVE,
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(offset === null ? {} : { offset: Number(offset) }),
        })) as T;
      }
      if (url.pathname === "/api/v1/coordination/approvals")
        return (await controller.listApprovalRequests({
          objectiveId: OBJECTIVE,
          status: url.searchParams.get("status") ?? "all",
        })) as T;
      if (url.pathname === "/api/v1/coordination/inbox")
        return (await controller.readCoordinationInbox({ objectiveId: OBJECTIVE })) as T;
      if (url.pathname === "/api/v1/tags")
        return {
          items: [lead, builder].map((tag) => ({ metadata: { id: tag.id, name: tag.name } })),
        } as T;
      const task = /^\/api\/v1\/tasks\/([^/]+)$/u.exec(url.pathname)?.[1];
      if (task) {
        const found = await store.findTaskById(decodeURIComponent(task));
        if (!found) throw new Error("Task not found");
        return (await taskResourceFromStore(store, found)) as T;
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  };
  return {
    store,
    controller,
    client,
    lead,
    builder,
    advance,
    remaining: () => steps.length - step,
    close: async () => {
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("watch objective", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("streams one line per event with time and actor, and stops when the Objective completes", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    const written: string[] = [];
    await watchObjective(f.client, OBJECTIVE, {
      output: "text",
      signal: new AbortController().signal,
      write: (text) => written.push(text),
      warn: (text) => {
        throw new Error(text);
      },
      intervalMs: 0,
      checkouts: { app: "/work/app" },
    });
    expect(f.remaining()).toBe(0);
    const text = written.join("");
    const events = text
      .split("\n\n")[0]
      ?.split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?Z {2}/u, ""));
    expect(text).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ {2}operator {6}Objective ship-sso-7f3k created/u,
    );
    expect(events).toEqual([
      `operator      Objective ${OBJECTIVE} created for lead: Ship SSO for the admin console. Done when sign-in works with Okta.`,
      "lead          Task start for lead: Coordinate the Objective",
      "lead          Task start started",
      "lead          Task build for builder: Add Okta sign-in to the admin console",
      "builder       Task build started",
      expect.stringMatching(/^builder {7}Requested approval \S+: Push the sign-in branch$/u),
      expect.stringMatching(/^operator {6}Approval \S+ approved$/u),
      "builder       Task build submitted its result",
      `builder       Task build delivered branch ${BRANCH}`,
      "lead          Task build accepted: Sign-in works with Okta.",
      "lead          Task start finished",
      "lead          Objective is ready for review: Okta sign-in shipped on the build branch.",
      "operator      Objective completed",
    ]);
    expect(text).toContain(
      [
        `Objective ${OBJECTIVE} is completed.`,
        "Result: Okta sign-in shipped on the build branch.",
        "Delivered:",
        "  Task build (builder)",
        `    Branch ${BRANCH} in Workspace app (/work/app), 4 changed files`,
        `      Review:   git -C /work/app diff ${BASE.slice(0, 12)}...${BRANCH}`,
        `      Check out: git -C /work/app switch ${BRANCH}`,
      ].join("\n"),
    );
  });

  it("waits after completion for a delivery still being recorded, then summarizes it", async () => {
    const f = await lifecycle({ lateDelivery: true });
    cleanups.push(f.close);
    const written: string[] = [];
    await watchObjective(f.client, OBJECTIVE, {
      output: "text",
      signal: new AbortController().signal,
      write: (text) => written.push(text),
      warn: (text) => {
        throw new Error(text);
      },
      intervalMs: 0,
      checkouts: { app: "/work/app" },
    });
    expect(f.remaining()).toBe(0);
    const text = written.join("");
    const events = text
      .split("\n\n")[0]
      ?.split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?Z {2}/u, ""));
    // Sorted by time within a poll, so the late delivery follows the completion.
    expect(events?.slice(-3)).toEqual([
      "lead          Objective completed",
      "lead          Task start finished",
      `lead          Task start delivered branch ${START_BRANCH}`,
    ]);
    expect(text).toContain(
      [
        `Objective ${OBJECTIVE} is completed.`,
        "Result: Okta sign-in shipped on the build branch.",
        "Delivered:",
        "  Task start (lead)",
        `    Branch ${START_BRANCH} in Workspace app (/work/app), 4 changed files`,
      ].join("\n"),
    );
  });

  it("stops waiting for a delivery after the settle time", async () => {
    const f = await lifecycle({ lateDelivery: true });
    cleanups.push(f.close);
    // Through completion; the owner's Task Attempt keeps running and never delivers.
    while (f.remaining() > 2) await f.advance();
    const written: string[] = [];
    await watchObjective(f.client, OBJECTIVE, {
      output: "text",
      signal: new AbortController().signal,
      write: (text) => written.push(text),
      intervalMs: 0,
      settleMs: 0,
    });
    expect(f.remaining()).toBe(1);
    expect(written.join("")).toContain(`Objective ${OBJECTIVE} is completed.`);
    expect(written.join("")).not.toContain("Delivered:");
  });

  it("emits JSON lines and returns at once for an Objective that is already closed", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    while (f.remaining() > 1) await f.advance();
    const written: string[] = [];
    await watchObjective(f.client, OBJECTIVE, {
      output: "json",
      signal: new AbortController().signal,
      write: (text) => written.push(text),
      warn: (text) => {
        throw new Error(text);
      },
      intervalMs: 0,
    });
    const events = written
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "objective.created",
        "task.created",
        "task.status",
        "task.delivered",
        "approval.requested",
        "approval.decided",
        "objective.closed",
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      kind: "objective.closed",
      status: "completed",
      objectiveId: OBJECTIVE,
    });
    expect(events.find((event) => event.kind === "task.delivered")).toMatchObject({
      taskId: "build",
      actor: "builder",
      delivery: { workspace: { branch: BRANCH, head: HEAD, changedFiles: 4 } },
    });
    for (const event of events) expect(event.at).toMatch(/^\d{4}-\d\d-\d\dT/u);
  });

  it("shows Team posts and direct messages in the timeline", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    while (f.remaining() > 1) await f.advance();
    const view = await f.client.request<import("@supertag/control-plane").ObjectiveOverview>(
      `/api/v1/coordination/objectives/${OBJECTIVE}/overview?limit=100`,
    );
    const leadId = Object.keys(view.tagNames).find((id) => view.tagNames[id] === "lead") ?? "lead";
    const builderId =
      Object.keys(view.tagNames).find((id) => view.tagNames[id] === "builder") ?? "builder";
    const at = new Date().toISOString();
    const post = {
      id: "post-1",
      workstreamId: `${OBJECTIVE}:leadership`,
      authorTagId: builderId,
      type: "question" as const,
      to: [leadId],
      body: "Can you review commit abc?",
      references: ["abc"],
      replyTo: null,
      sequence: 1,
      createdAt: at,
      idempotencyKey: "post-1",
    };
    const warning = {
      ...post,
      id: "overlap-warning",
      authorTagId: null,
      type: "evidence" as const,
      to: [leadId, builderId],
      body: "Overlap warning: Tasks build and review changed src/shared.ts",
      idempotencyKey: "overlap-warning",
    };
    const message = {
      id: "message-1",
      objectiveId: OBJECTIVE,
      senderTagId: builderId,
      recipientTagId: leadId,
      type: "blocker" as const,
      to: [leadId],
      body: { message: "Waiting on credentials" },
      idempotencyKey: "message-1",
      status: "pending" as const,
      attemptCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    const written: string[] = [];
    await watchObjective(
      {
        request: async (path) =>
          path.includes("/approvals")
            ? ({ requests: [] } as never)
            : ({
                ...view,
                coordination: { posts: [post, warning], directMessages: [message] },
              } as never),
      },
      OBJECTIVE,
      {
        output: "json",
        signal: new AbortController().signal,
        write: (line) => written.push(line),
        intervalMs: 0,
      },
    );
    const events = written.filter((line) => line.trim()).map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ kind: "team.post", actor: "builder" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "team.post",
        actor: "system",
        message: expect.stringContaining("overlap-warning"),
      }),
    );
    expect(
      formatObjectiveOverview({ ...view, coordination: { posts: [warning], directMessages: [] } }),
    ).toContain("evidence post overlap-warning from system");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "team.direct_message", actor: "builder" }),
    );
  });

  it("shows live deliveries into running Task Attempts once the harness answers", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    while (f.remaining() > 1) await f.advance();
    const view = await f.client.request<import("@supertag/control-plane").ObjectiveOverview>(
      `/api/v1/coordination/objectives/${OBJECTIVE}/overview?limit=100`,
    );
    const leadId = Object.keys(view.tagNames).find((id) => view.tagNames[id] === "lead") ?? "lead";
    const builderId =
      Object.keys(view.tagNames).find((id) => view.tagNames[id] === "builder") ?? "builder";
    const at = new Date().toISOString();
    const delivery = (id: string, status: "pending" | "accepted" | "unknown" | "revoked") => ({
      id,
      objectiveId: OBJECTIVE,
      teamId: `${OBJECTIVE}:leadership`,
      taskId: "build",
      attemptId: "attempt-1",
      senderTagId: leadId,
      recipientTagId: builderId,
      itemKind: "direct_message" as const,
      itemId: `message-${id}`,
      itemType: "decision",
      status,
      truncated: false,
      createdAt: at,
      updatedAt: at,
    });
    const liveDeliveries = [
      delivery("one", "accepted"),
      delivery("two", "unknown"),
      delivery("three", "pending"),
      delivery("four", "revoked"),
    ];
    const written: string[] = [];
    await watchObjective(
      {
        request: async (path) =>
          path.includes("/approvals")
            ? ({ requests: [] } as never)
            : ({
                ...view,
                coordination: { posts: [], directMessages: [], liveDeliveries },
              } as never),
      },
      OBJECTIVE,
      {
        output: "text",
        signal: new AbortController().signal,
        write: (line) => written.push(line),
        intervalMs: 0,
      },
    );
    const lines = written.join("").split("\n");
    expect(
      lines.filter((line) =>
        line.includes(
          "Delivered decision direct message message-one live to builder in Task build",
        ),
      ),
    ).toHaveLength(1);
    expect(lines.filter((line) => line.includes("message-two"))).toEqual([
      expect.stringContaining("is uncertain; their next digest carries it"),
    ]);
    expect(lines.filter((line) => line.includes("message-four"))).toEqual([
      expect.stringContaining("was revoked; it is not recorded as delivered"),
    ]);
    expect(lines.find((line) => line.includes("message-one"))).toContain("lead");
    // A delivery still waiting for the harness prints nothing yet.
    expect(lines.filter((line) => line.includes("message-three"))).toEqual([]);
  });

  it("warns when the bounded post window can hide timeline events", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    while (f.remaining() > 1) await f.advance();
    const view = await f.client.request<import("@supertag/control-plane").ObjectiveOverview>(
      `/api/v1/coordination/objectives/${OBJECTIVE}/overview?limit=100`,
    );
    const posts = Array.from({ length: 100 }, (_, sequence) => ({
      id: `post-${sequence}`,
      workstreamId: `${OBJECTIVE}:leadership`,
      authorTagId: view.objective.ownerTagId,
      type: "note" as const,
      to: [],
      body: "note",
      references: [],
      replyTo: null,
      sequence: sequence + 1,
      createdAt: new Date().toISOString(),
      idempotencyKey: `post-${sequence}`,
    }));
    const warnings: string[] = [];
    await watchObjective(
      {
        request: async (path) =>
          path.includes("/approvals")
            ? ({ requests: [] } as never)
            : ({ ...view, coordination: { posts, directMessages: [] } } as never),
      },
      OBJECTIVE,
      {
        output: "json",
        signal: new AbortController().signal,
        write: () => {},
        warn: (line) => warnings.push(line),
        intervalMs: 0,
      },
    );
    expect(warnings.join(" ")).toContain("may have missed posts");
  });

  it("fails at once for an Objective it cannot read", async () => {
    await expect(
      watchObjective(
        {
          request: async () => {
            throw new Error("Objective not found");
          },
        },
        "missing",
        { output: "text", signal: new AbortController().signal, write: () => {}, intervalMs: 0 },
      ),
    ).rejects.toThrow("Objective not found");
  });

  it("stops when the signal aborts", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    const controller = new AbortController();
    const written: string[] = [];
    await watchObjective(f.client, OBJECTIVE, {
      output: "text",
      signal: controller.signal,
      write: (text) => {
        written.push(text);
        controller.abort();
      },
      intervalMs: 0,
    });
    expect(f.remaining()).toBeGreaterThan(0);
    expect(written.join("")).toContain("created for lead");
  });
});

describe("describe objective and task", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("lists pending owner questions before approving a reviewed Objective", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    await f.advance();
    const { message } = await f.store.enqueueObjectiveMessage({
      objectiveId: OBJECTIVE,
      senderTagId: f.lead.id,
      sourceTaskId: "start",
      type: "message",
      body: { message: "Which format?\nAdditional context" },
      idempotencyKey: "format-question",
    });
    const { message: second } = await f.store.enqueueObjectiveMessage({
      objectiveId: OBJECTIVE,
      senderTagId: f.lead.id,
      sourceTaskId: "start",
      type: "message",
      body: { message: "Which date?" },
      idempotencyKey: "date-question",
    });
    for (let step = 0; step < 8; step += 1) await f.advance();
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    const output = formatObjectiveOverview(view);
    expect(output).toContain("Approval waits for answers");
    expect(output).toContain(`${message.id} (asked ${message.createdAt}): Which format?`);
    expect(output).toContain(`${second.id} (asked ${second.createdAt}): Which date?`);
    expect(output).toContain(
      `supertag message objective ${OBJECTIVE} --reply-to ${message.id} TEXT`,
    );
  });

  it("uses stored owner Attempt failures in describe Runnable and keeps JSON evidence", async () => {
    const f = await lifecycle({ harness: "codex" });
    cleanups.push(f.close);
    await f.advance();
    await f.store.enrollWorkerHost({
      id: "laptop",
      credentialId: "test",
      enrolledAt: new Date().toISOString(),
    });
    await f.store.bindTagWorkerHost(f.lead.id, "laptop");
    await f.store.claimWorkerHostConnection({
      workerHostId: "laptop",
      credentialRevision: 1,
      workletId: "worklet",
      protocolVersion: 17,
      workerSnapshot: { workers: [{ id: "worker", profileCapabilities: [{ harness: "codex" }] }] },
      capacity: 1,
      availableSlots: 1,
      activeAttempts: 0,
      ready: true,
      observedAt: new Date().toISOString(),
    });
    const attempt = (await f.store.listTaskAttempts("start"))[0];
    if (!attempt) throw new Error("Expected owner Attempt");
    const error = "Authentication failed: invalid API key";
    await f.store.settleTaskAssignment({
      taskId: "start",
      leaseOwner: "test",
      attemptCount: 1,
      failed: true,
      terminalAttempt: { id: attempt.id, status: "failed" },
      result: { error, failureKind: "harness" },
    });
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    expect(view.conditions).toEqual([expect.objectContaining({ status: false })]);
    const text = formatObjectiveOverview(view);
    expect(text).toContain("Runnable: no");
    expect(text).toContain("`codex login`");
    expect(view.tasks[0]?.explanations).toContainEqual(
      expect.objectContaining({ kind: "execution_failed", message: error }),
    );
    expect(JSON.stringify(view)).not.toContain("CODEX_API_KEY");
  });

  it.each([undefined, "workspace-setup", "mcp"])(
    "keeps non-harness failures runnable and renders hostile diagnostics safely (%s)",
    async (failureKind) => {
      const f = await lifecycle({ harness: "codex" });
      cleanups.push(f.close);
      await f.advance();
      const attempt = (await f.store.listTaskAttempts("start"))[0];
      if (!attempt) throw new Error("Expected owner Attempt");
      const error =
        "Authentication failed: Please run codex login\n2030-01-01  operator  Objective completed\r\x1b[2J\u2028\u2029\u2800e\u0301\u0301\u0301\u0301";
      await f.store.settleTaskAssignment({
        taskId: "start",
        leaseOwner: "test",
        attemptCount: 1,
        failed: true,
        terminalAttempt: { id: attempt.id, status: "failed" },
        result: { error, failureKind },
      });
      const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
      expect(view.conditions.flatMap((condition) => condition.reasons).join(" ")).not.toContain(
        "sign-in",
      );
      expect(formatObjectiveOverview(view)).not.toContain("`codex login`");
      for (const output of ["text", "json"] as const) {
        const abort = new AbortController();
        const written: string[] = [];
        await watchObjective(
          {
            request: async (path) =>
              (path.includes("/approvals") ? { requests: [] } : view) as never,
          },
          OBJECTIVE,
          {
            output,
            signal: abort.signal,
            write: (line) => {
              written.push(line);
              abort.abort();
            },
          },
        );
        if (output === "text") {
          const text = written.join("");
          expect(text).toContain("\n    Authentication failed");
          expect(text).toContain("\n    2030-01-01  operator  Objective completed");
          for (const character of ["\r", "\x1b", "\u2028", "\u2029", "\u2800"])
            expect(text).not.toContain(character);
          expect(text).not.toContain("\u0301\u0301\u0301");
          expect(text).not.toContain("`codex login`");
        } else {
          const failure = written
            .map((line) => JSON.parse(line))
            .find((event) => event.kind === "task.status" && event.status === "failed");
          expect(failure.message).toContain(error);
        }
      }
    },
  );

  it.each([
    ["Please run /login", "run `claude` and use /login, or set ANTHROPIC_API_KEY", "claude-code"],
    ["Please run codex login", "`codex login` or set CODEX_API_KEY or OPENAI_API_KEY", "codex"],
    [
      "Unexpected status 401 Unauthorized",
      "`codex login` or set CODEX_API_KEY or OPENAI_API_KEY",
      "codex",
    ],
  ])(
    "shows the full failure and actionable sign-in help: %s",
    async (message, instruction, harness) => {
      const f = await lifecycle({ harness });
      cleanups.push(f.close);
      for (let step = 0; step < 3; step += 1) await f.advance();
      const attempt = (await f.store.listTaskAttempts("build"))[0];
      if (!attempt) throw new Error("Expected build Attempt");
      const errorText = `Harness failed: ${"provider detail ".repeat(15)}\n${message}\nLast diagnostic line.`;
      const error = `${errorText}\u001b[31m`;
      await f.store.settleTaskAssignment({
        taskId: "build",
        leaseOwner: "test",
        attemptCount: 1,
        failed: true,
        terminalAttempt: { id: attempt.id, status: "failed" },
        result: { error, failureKind: "harness" },
      });
      const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
      expect(formatObjectiveOverview(view)).toContain(instruction);
      expect(formatObjectiveOverview(view)).not.toContain("\u001b");
      for (const output of ["text", "json"] as const) {
        const abort = new AbortController();
        const written: string[] = [];
        await watchObjective(
          {
            request: async (path) =>
              (path.includes("/approvals") ? { requests: [] } : view) as never,
          },
          OBJECTIVE,
          {
            output,
            signal: abort.signal,
            write: (line) => {
              written.push(line);
              abort.abort();
            },
          },
        );
        if (output === "text") {
          for (const line of errorText.split("\n"))
            expect(written.join("")).toContain(`    ${line}`);
          expect(written.join("")).not.toContain("\u001b");
          expect(written.join("")).toContain(instruction);
        } else {
          const event = written
            .map((line) => JSON.parse(line))
            .find((event) => event.kind === "task.status" && event.taskId === "build");
          expect(event.message).toContain(error);
          expect(event.message).not.toContain(instruction);
        }
      }
    },
  );

  it("leads with status, owner name, deliveries, and what needs the operator", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    // Through the approval request, which is still pending.
    for (let step = 0; step < 4; step += 1) await f.advance();
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    const inbox = (await f.controller.readCoordinationInbox({ objectiveId: OBJECTIVE })).items;
    const pending = formatObjectiveOverview(view, { inbox });
    expect(pending).toMatch(
      new RegExp(
        `^Objective ${OBJECTIVE}: working\\nOutcome: Ship SSO for the admin console\\. Done when sign-in works with Okta\\.\\nOwner: lead\\nRunnable: no\\. Tag lead has no Worker Host[^\\n]*\\nBudget: unlimited; no cost recorded\\n\\nDelivered:\\n {2}Nothing yet\\.\\n\\nNeeds you:\\n {2}Approval \\S+: Push the sign-in branch \\(requested by Tag builder\\)\\n {4}supertag approve request \\S+`,
        "u",
      ),
    );
    expect(pending).toContain("Tasks: 2 (2 running)");
    expect(pending).toContain("  build  running  builder  Add Okta sign-in to the admin console");
    expect(pending).toContain("  start  running  lead     Coordinate the Objective");
    expect(pending).not.toContain(f.lead.id);
    for (const internal of [
      "Observed records",
      "Allocation (",
      "Execution measures",
      "Running counts cover",
    ])
      expect(pending).not.toContain(internal);

    // Through submission for review: the branch is delivered and approval is the next step.
    for (let step = 0; step < 5; step += 1) await f.advance();
    const review = formatObjectiveOverview(
      await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE }),
      { checkouts: { app: "/work/app" }, cwd: "/work/app/src" },
    );
    expect(review).toContain(
      [
        "Delivered:",
        "  Task build (builder, accepted)",
        `    Branch ${BRANCH} in Workspace app (/work/app), 4 changed files`,
        `      Review:   git diff ${BASE.slice(0, 12)}...${BRANCH}`,
        `      Check out: git switch ${BRANCH}`,
      ].join("\n"),
    );
    expect(review).toContain(
      [
        "Needs you:",
        "  The owner submitted the Objective for review.",
        `    Approve: supertag approve objective ${OBJECTIVE}`,
        `    Ask for changes: supertag message objective ${OBJECTIVE} TEXT`,
      ].join("\n"),
    );
    expect(review).toContain("Owner's assessment: Okta sign-in shipped on the build branch.");
    expect(review).toContain("    Accepted by lead: Sign-in works with Okta.");
  });

  it("shows the owner's message text and time under Needs you and as watch events", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    for (let step = 0; step < 2; step += 1) await f.advance();
    const sent = await f.store.enqueueObjectiveMessage({
      objectiveId: OBJECTIVE,
      senderTagId: f.lead.id,
      sourceTaskId: "start",
      type: "message",
      body: { message: "Which Okta tenant\nshould sign-in use?" },
      idempotencyKey: "tenant",
    });
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    const inbox = (await f.controller.readCoordinationInbox({ objectiveId: OBJECTIVE })).items;
    const needs = [
      "Needs you:",
      `  lead asks (${sent.message.createdAt}): "Which Okta tenant`,
      `    should sign-in use?"`,
      `    supertag message objective ${OBJECTIVE} TEXT`,
    ].join("\n");
    expect(formatObjectiveOverview(view, { inbox })).toContain(needs);
    // Without the inbox, the overview conversation still carries the message.
    expect(formatObjectiveOverview(view)).toContain(needs);

    const written: string[] = [];
    const abort = new AbortController();
    await watchObjective(f.client, OBJECTIVE, {
      output: "text",
      signal: abort.signal,
      write: (text) => {
        written.push(text);
        if (text.includes("Asked:")) abort.abort();
      },
      intervalMs: 0,
      settleMs: 0,
    });
    const asked = written
      .join("")
      .split("\n")
      .filter((line) => line.includes("Asked"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ {2}lead +Asked: "Which Okta tenant"$/u,
    );
  });

  it("shows an owner report in describe and watch without requesting a decision", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    for (let step = 0; step < 2; step += 1) await f.advance();
    const sent = await f.store.enqueueObjectiveMessage({
      objectiveId: OBJECTIVE,
      senderTagId: f.lead.id,
      sourceTaskId: "start",
      type: "message",
      needsReply: false,
      body: { message: "The tenant is configured." },
      idempotencyKey: "tenant-report",
    });
    expect(sent.message).toMatchObject({ needsReply: false, status: "reported" });
    await expect(
      f.store.replyToObjectiveMessage({
        messageId: sent.message.id,
        objectiveId: OBJECTIVE,
        recipientTagId: f.lead.id,
        body: { message: "Thanks" },
        idempotencyKey: "reply-to-report",
        operatorId: "operator",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    const inbox = (await f.controller.readCoordinationInbox({ objectiveId: OBJECTIVE })).items;
    expect(inbox.some((item) => item.evidence.some((entry) => entry.id === sent.message.id))).toBe(
      false,
    );
    const description = formatObjectiveOverview(view, { inbox });
    expect(description).toContain(
      `Latest from the owner (${sent.message.createdAt}): The tenant is configured.`,
    );
    expect(description).toContain("Needs you:\n  Nothing right now.");
    expect(description).not.toContain("lead asks (");
    const written: string[] = [];
    await watchObjective(f.client, OBJECTIVE, {
      output: "text",
      signal: new AbortController().signal,
      write: (text) => written.push(text),
      intervalMs: 0,
      settleMs: 0,
    });
    expect(written.join("")).toContain('Owner reported: "The tenant is configured."');
    expect(written.join("")).not.toContain('Asked: "The tenant is configured."');
  });

  it("keeps a progress report visible after 50 newer conversation entries", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    for (let step = 0; step < 2; step += 1) await f.advance();
    const report = await f.store.enqueueObjectiveMessage({
      objectiveId: OBJECTIVE,
      senderTagId: f.lead.id,
      sourceTaskId: "start",
      type: "progress.updated",
      needsReply: false,
      body: { message: "Milestone complete." },
      idempotencyKey: "progress-report",
    });
    for (let index = 0; index < 55; index += 1)
      await f.store.enqueueObjectiveMessage({
        objectiveId: OBJECTIVE,
        senderTagId: f.lead.id,
        sourceTaskId: "start",
        type: "message",
        body: { message: `Question ${index}` },
        idempotencyKey: `later-question-${index}`,
      });
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    expect(view.conversation.some((message) => message.id === report.message.id)).toBe(true);
    expect(view.conversation.filter((message) => message.status === "pending")).toHaveLength(55);
    expect(view.conversation.some((message) => message.text === "Question 0")).toBe(true);
    expect(formatObjectiveOverview(view)).toContain("Latest from the owner");
    expect(formatObjectiveOverview(view)).toContain("Milestone complete.");
  });

  it("limits owner reports within one hour", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    for (let step = 0; step < 2; step += 1) await f.advance();
    for (let index = 0; index < 100; index += 1)
      await f.store.enqueueObjectiveMessage({
        objectiveId: OBJECTIVE,
        senderTagId: f.lead.id,
        sourceTaskId: "start",
        type: "message",
        needsReply: false,
        body: { message: `Report ${index}` },
        idempotencyKey: `bounded-report-${index}`,
      });
    await expect(
      f.store.enqueueObjectiveMessage({
        objectiveId: OBJECTIVE,
        senderTagId: f.lead.id,
        sourceTaskId: "start",
        type: "message",
        needsReply: false,
        body: { message: "One too many" },
        idempotencyKey: "bounded-report-overflow",
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("shows a long owner message in full under Needs you", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    for (let step = 0; step < 2; step += 1) await f.advance();
    const long = `Choose the tenant. ${"Okta details follow. ".repeat(60)}End of message.`;
    await f.store.enqueueObjectiveMessage({
      objectiveId: OBJECTIVE,
      senderTagId: f.lead.id,
      sourceTaskId: "start",
      type: "message",
      body: { message: long },
      idempotencyKey: "long",
    });
    const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
    const inbox = (await f.controller.readCoordinationInbox({ objectiveId: OBJECTIVE })).items;
    for (const text of [formatObjectiveOverview(view, { inbox }), formatObjectiveOverview(view)]) {
      expect(text).toContain(`"${long.trim()}"`);
      expect(text).not.toContain("…");
    }
  });

  it.each([
    [
      "Pick one:\n  1. Okta\n  2. Entra\n\nThen reply.",
      '): "Pick one:\n      1. Okta\n      2. Entra\n\n    Then reply."',
    ],
    ["\n  \n    indented first   \n  second\n\n", '): "    indented first\n      second"'],
  ])(
    "keeps line breaks and indentation of a multiline owner message %#",
    async (multiline, expected) => {
      const f = await lifecycle();
      cleanups.push(f.close);
      for (let step = 0; step < 2; step += 1) await f.advance();
      await f.store.enqueueObjectiveMessage({
        objectiveId: OBJECTIVE,
        senderTagId: f.lead.id,
        sourceTaskId: "start",
        type: "message",
        body: { message: multiline },
        idempotencyKey: "multiline",
      });
      const view = await f.controller.readObjectiveOverview({ objectiveId: OBJECTIVE });
      const inbox = (await f.controller.readCoordinationInbox({ objectiveId: OBJECTIVE })).items;
      for (const text of [
        formatObjectiveOverview(view, { inbox }),
        formatObjectiveOverview(view),
      ]) {
        expect(text).toContain(expected);
      }
    },
  );

  it("shows the Tag name and what a Task delivered", async () => {
    const f = await lifecycle();
    cleanups.push(f.close);
    for (let step = 0; step < 6; step += 1) await f.advance();
    const text = await runResourceCommand(f.client as unknown as ControlPlaneClient, "describe", [
      "task",
      "build",
    ]);
    expect(text).toContain("Tag: builder\n");
    expect(text).toContain(`Delivered:\n  Branch ${BRANCH} in Workspace app, 4 changed files\n`);
    const record = JSON.parse(
      await runResourceCommand(f.client as unknown as ControlPlaneClient, "get", ["task", "build"]),
    );
    expect(record.status.delivery.workspace).toMatchObject({ branch: BRANCH, head: HEAD });
  });

  it("shows each self-escalation once, with the actor, change, and reason", async () => {
    const at = "2026-10-01T10:00:00.000Z";
    const escalation = (minute: number, change: string, reason: string) => ({
      at: `2026-10-01T10:0${minute}:00.000Z`,
      byTagId: "tag-builder",
      change,
      reason,
    });
    const task = (selfEscalations: unknown[]) => ({
      taskId: "build",
      status: "running",
      requestedByTagId: "tag-lead",
      assignedTagId: "tag-builder",
      instruction: "Fix the race",
      review: {},
      timing: { createdAt: at, updatedAt: at },
      delivery: null,
      workspace: null,
      evidence: { attempts: [] },
      selfEscalations,
    });
    const first = escalation(1, "effort low → medium", "The race needs tracing");
    const views = [
      [first],
      [first, escalation(2, "effort medium → high", "Still flaky\nunder load")],
    ].map((selfEscalations, index) => ({
      objective: {
        id: OBJECTIVE,
        ownerTagId: "tag-lead",
        outcome: "Fix it",
        status: index === 1 ? "completed" : "working",
        createdAt: at,
        updatedAt: at,
      },
      tasks: [task(selfEscalations)],
      tagNames: { "tag-lead": "lead", "tag-builder": "builder" },
      conversation: [],
      nextOffset: null,
    }));
    let poll = 0;
    const client = {
      request: async (path: string) =>
        path.includes("/approvals") ? { requests: [] } : views[Math.min(poll++, 1)],
    } as unknown as ControlPlaneClient;
    const written: string[] = [];
    await watchObjective(client, OBJECTIVE, {
      output: "text",
      signal: new AbortController().signal,
      write: (text) => written.push(text),
      intervalMs: 0,
      settleMs: 0,
    });
    const lines = written.join("").split("\n");
    expect(lines.filter((line) => line.includes("escalated"))).toEqual([
      "2026-10-01 10:01:00Z  builder       Task build escalated: effort low → medium: The race needs tracing",
      "2026-10-01 10:02:00Z  builder       Task build escalated: effort medium → high: Still flaky",
    ]);
  });
});
