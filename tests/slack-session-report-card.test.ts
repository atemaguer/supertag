import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import {
  workSessionEvent,
  workSessionResultCard,
} from "../packages/control-plane/src/work-sessions.ts";
import {
  type InboundSurfaceEvent,
  workspacePullRequestReference,
} from "../packages/core/src/index.ts";
import {
  defaultTaskResult,
  LocalWorklet,
  TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  WORKSPACE_CLONE_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import type { SurfacePresentation } from "../packages/surfaces/sdk/src/index.ts";
import { postSlackThreadReply } from "../packages/surfaces/slack/src/reply.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Answers every turn; a work Session turn also records a pull request and a branch commit. */
class DeliveringWorker implements Worker {
  constructor(private readonly pullRequestUrl: string) {}
  async describe() {
    const profile = { id: "static", revision: "1" };
    return {
      id: "delivering",
      type: "static",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY, WORKSPACE_CLONE_CAPABILITY],
      profiles: [profile],
      contextTypes: [],
      profileCapabilities: [
        {
          profile,
          capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY, WORKSPACE_CLONE_CAPABILITY],
          contextTypes: [],
        },
      ],
    };
  }
  async *execute(spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> {
    const at = new Date().toISOString();
    const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at };
    yield { type: "execution.started", ...identity, workerId: "delivering" };
    const work = spec.input.messages.some((message) =>
      message.text.includes("This is work Session"),
    );
    const branch =
      spec.workspacePlan.status === "workspace" ? spec.workspacePlan.branch : undefined;
    const text = work ? "Opened the pull request." : "Reported.";
    yield { type: "output.message", ...identity, message: { role: "teammate", text } };
    const base = defaultTaskResult(text);
    yield {
      type: "result",
      ...identity,
      result:
        work && branch !== undefined
          ? {
              ...base,
              changes: [{ reference: `git:${branch}@abcdef1234567`, summary: "2 changed files" }],
              references: [
                workspacePullRequestReference({
                  repository: "acme/app",
                  number: 7,
                  url: this.pullRequestUrl,
                }),
              ],
            }
          : base,
    };
    yield { type: "execution.completed", ...identity };
  }
}

async function runReport(pullRequestUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-slack-card-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const replies: { event: InboundSurfaceEvent; presentation: SurfacePresentation }[] = [];
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: new LocalWorklet("worklet", "host", [new DeliveringWorker(pullRequestUrl)]),
    reply: async (event, presentation) => {
      replies.push({ event, presentation });
      return {};
    },
    dispatch: { pollIntervalMs: 5 },
  });
  await controlPlane.start();
  cleanups.push(() => controlPlane.stop());
  await store.applyWorkspace({
    name: "app",
    source: "https://github.com/acme/app.git",
    delivery: "pull-request",
  });
  const account = await controlPlane.setupSurfaceAccount({
    provider: "slack",
    externalAccountId: "T1",
    displayName: "Acme",
    authMethod: "slack-socket-mode",
    configuration: {},
    secrets: { botToken: "fake", appToken: "fake" },
  });
  const tag = await store.createTag({ name: "lead" });
  await store.bindTagWorkerHost(tag.id, "host");
  await store.addTagRoute({ tagId: tag.id, surfaceAccountId: account.id, scope: "channel:C1" });
  const admission = await controlPlane.ingestSurfaceEvent({
    eventId: "mention",
    logicalEventId: "mention",
    provider: "slack",
    externalAccountId: "T1",
    kind: "mention",
    scope: "channel:C1",
    sessionKey: "slack:T1:C1:1",
    actor: { id: "U1", kind: "user" },
    text: "Ship it",
    occurredAt: new Date().toISOString(),
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: "T1|C1|1",
      target: { channelId: "C1", threadTs: "1" },
    },
    source: {},
    metadata: {},
  });
  const startingId = admission.taskId as string;
  await expect
    .poll(async () => (await store.findTaskById(startingId))?.status, { timeout: 5000 })
    .toBe("completed");
  const startingTask = await store.findTaskById(startingId);
  const starting = await store.findInboundEventById(startingTask?.inboundEventId ?? "");
  if (!startingTask || !starting) throw new Error("missing starting turn");
  // The work Session a start_session call admits: same location, its own Workspace branch.
  await store.admitInboundEvent({
    surfaceAccountId: starting.surfaceAccountId,
    tagRouteId: starting.tagRouteId,
    tagId: starting.tagId,
    authorization: starting.authorization,
    contextPlan: starting.contextPlan,
    execution: starting.execution,
    event: workSessionEvent(
      starting,
      startingTask.id,
      startingTask.sessionId,
      { title: "ship", instruction: "Ship it", workspace: "app" },
      new Date().toISOString(),
    ),
  });
  await expect
    .poll(
      () =>
        replies.find(
          (reply) =>
            reply.event.internal?.kind === "session_report" &&
            reply.presentation.kind === "final-result",
        ),
      { timeout: 8000 },
    )
    .toBeDefined();
  const report = replies.find((reply) => reply.event.internal?.kind === "session_report");
  const internal = report?.event.internal;
  const workTask =
    internal?.kind === "session_report" ? await store.findTaskById(internal.workTaskId) : undefined;
  return { replies, report, workTask };
}

it("carries a completed work Session's PR URL and branch to the Slack sender", async () => {
  const prUrl = "https://github.com/acme/app/pull/7";
  const { replies, report, workTask } = await runReport(prUrl);
  expect(workTask?.status).toBe("completed");
  const branch = workTask?.workspacePlan.status === "workspace" && workTask.workspacePlan.branch;
  expect(report?.presentation).toEqual({
    kind: "final-result",
    markdown: "Reported.",
    resultCard: { pullRequestUrl: prUrl, branch },
  });
  // Every other reply stays text-only.
  for (const reply of replies.filter((entry) => entry !== report))
    expect(reply.presentation).not.toHaveProperty("resultCard");

  // The Slack sender adds the card beside the unchanged text fallback in the same thread.
  let body: Record<string, unknown> = {};
  await postSlackThreadReply(report?.event as InboundSurfaceEvent, report?.presentation as never, {
    botToken: "xoxb-token",
    ...(report?.presentation.resultCard === undefined
      ? {}
      : { resultCard: report.presentation.resultCard }),
    request: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, ts: "2" }));
    },
  });
  const { attachments, ...text } = body;
  expect(text).toEqual({
    channel: "C1",
    thread_ts: "1",
    text: "Reported.",
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  });
  expect(JSON.stringify(attachments)).toContain(JSON.stringify(prUrl));
}, 20000);

it("drops a pull request URL that is not a GitHub pull request URL", async () => {
  const { report } = await runReport("https://example.com/acme/app/pull/7");
  expect(report?.presentation.markdown).toBe("Reported.");
  expect(report?.presentation.resultCard).not.toHaveProperty("pullRequestUrl");
  expect(JSON.stringify(report?.presentation)).not.toContain("example.com");
}, 20000);

it("keeps only GitHub pull request URLs and only completed work Tasks", () => {
  const task = (status: string) =>
    ({
      status,
      workspacePlan: {
        status: "workspace",
        workspace: "app",
        branch: "supertag/session/1",
        delivery: "pull-request",
      },
    }) as never;
  const events = (url: string) => [
    {
      type: "result",
      payload: {
        result: {
          changes: [{ reference: "git:supertag/session/1@abcdef1234567" }],
          references: [
            { ...workspacePullRequestReference({ repository: "acme/app", number: 7, url }) },
          ],
        },
      },
    },
  ];
  const card = (url: string, status = "completed") =>
    workSessionResultCard(task(status), events(url) as never);
  expect(card("https://github.com/acme/app/pull/7")).toEqual({
    pullRequestUrl: "https://github.com/acme/app/pull/7",
    branch: "supertag/session/1",
  });
  for (const url of [
    "http://github.com/acme/app/pull/7",
    "https://gitlab.com/acme/app/pull/7",
    "https://github.com/acme/app/issues/7",
    "https://github.com/acme/app/pull/7/files",
    "https://github.com/acme/app/pull/8",
    "https://github.com.evil.example/acme/app/pull/7",
  ])
    expect(card(url)).toEqual({ branch: "supertag/session/1" });
  expect(card("https://github.com/acme/app/pull/7", "failed")).toBeUndefined();
});
