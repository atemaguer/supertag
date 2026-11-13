import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerHttp2Session } from "node:http2";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { digestContextPackage } from "@supertag/worker-sdk";
import {
  AdapterBootstrapSchema,
  type AppliedExecutionLimits,
  ApprovalState,
  type AttemptCapabilities,
  CommitReviewDecision,
  ContextPinSchema,
  ExecutionLimitEnforcement,
  type ExecutionLimits,
  ExecutionLimitsSchema,
  Harness,
  type HarnessAskQuestionRequest,
  type HarnessAskWorkSessionQuestionRequest,
  type HarnessCompleteRequest,
  type HarnessContinueWorkSessionRequest,
  HarnessMailbox,
  type HarnessPostWorkstreamRequest,
  HarnessQuestions,
  type HarnessReadMailboxRequest,
  type HarnessReadReviewPatchRequest,
  type HarnessReadWorkstreamRequest,
  type HarnessSendTagMessageRequest,
  type HarnessStartWorkSessionRequest,
  type HarnessUsageRequest,
  HarnessWorkSessions,
  HarnessWorkstreams,
  LiveInputReceipt,
  type ResolvedSkill,
  type SessionCheckpoint,
  TagMessageOrigin,
  type TaskPolicySnapshot,
  TaskPolicySnapshotSchema,
  TaskSchema,
  TaskState,
} from "@supertag/worker-sdk/internal/rust-harness";
import { afterEach, expect, it } from "vitest";
import { mountRoots, permissionHook } from "./src/rust-adapter/adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "fixtures/rust-native-claude.mjs");
const entry = join(here, "dist/rust-adapter/entry.js");
const token = "execution-token-private-fixture-123";
const providerSecret = "provider-secret-private-fixture-123";
const childSession = "work/00000000-0000-4000-8000-000000000001";
const reviewCommit = "ab".repeat(20);
const reviewPatch = Buffer.from(`diff ${providerSecret}\n`);
const reviewDelivery = {
  workspaceId: "repo",
  deliveryId: "d".repeat(64),
  baseCommit: "a".repeat(40),
  startCommit: "a".repeat(40),
  headCommit: reviewCommit,
  committed: true,
  changedFiles: 1n,
  patch: { sha256: "b".repeat(64), byteLength: BigInt(reviewPatch.length + 1) },
  bundle: { sha256: "c".repeat(64), byteLength: 123n },
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function invoke({
  prompt = "write denied secret",
  checkpoint,
  actions = ["files:read", "files:write"],
  lostComplete = false,
  cancel = false,
  liveInput,
  mayAskObjectiveQuestion = false,
  lostQuestion = false,
  coordination,
  policySnapshot,
  executionLimits,
  model,
  skill,
  sessionId = "session",
}: {
  prompt?: string;
  checkpoint?: SessionCheckpoint;
  actions?: string[];
  lostComplete?: boolean;
  cancel?: boolean;
  liveInput?: string;
  mayAskObjectiveQuestion?: boolean;
  lostQuestion?: boolean;
  coordination?: Pick<AttemptCapabilities, "mayUseWorkstream" | "mayReadMailbox"> &
    Partial<
      Pick<
        AttemptCapabilities,
        | "maySendTagMessage"
        | "mayStartWorkSession"
        | "mayContinueWorkSession"
        | "mayAskWorkSessionQuestion"
      >
    >;
  policySnapshot?: TaskPolicySnapshot;
  executionLimits?: ExecutionLimits;
  model?: string;
  skill?: { markdown: string; tamper?: boolean };
  sessionId?: string;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-rust-claude-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "checkout");
  const state = join(directory, "state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await mkdir(join(state, "tmp"), { mode: 0o700 });
  const completions: HarnessCompleteRequest[] = [];
  const events: string[] = [];
  const usage: HarnessUsageRequest[] = [];
  const appliedLimits: AppliedExecutionLimits[] = [];
  const settlements: LiveInputReceipt[] = [];
  const questions: HarnessAskQuestionRequest[] = [];
  const posts: HarnessPostWorkstreamRequest[] = [];
  const workstreamReads: HarnessReadWorkstreamRequest[] = [];
  const mailboxReads: HarnessReadMailboxRequest[] = [];
  const reviewPatchReads: HarnessReadReviewPatchRequest[] = [];
  const mailboxSends: HarnessSendTagMessageRequest[] = [];
  const workSessionStarts: HarnessStartWorkSessionRequest[] = [];
  const workSessionContinuations: HarnessContinueWorkSessionRequest[] = [];
  const workSessionQuestions: HarnessAskWorkSessionQuestionRequest[] = [];
  const workSessionIds = new Map<string, string>();
  const resolvedSkills: Array<Omit<ResolvedSkill, "$typeName">> = [];
  if (skill) {
    const localPath = join(state, `skill-${"a".repeat(64)}`);
    await mkdir(localPath, { mode: 0o700 });
    const markdownPath = join(localPath, "SKILL.md");
    await writeFile(markdownPath, skill.markdown, { mode: 0o600 });
    await writeFile(join(localPath, "reference.md"), "Pinned checklist details.", { mode: 0o600 });
    const digest = await digestContextPackage(localPath, { maxFiles: 2, maxBytes: 4096 });
    if (skill.tamper) await writeFile(markdownPath, "Tampered.");
    resolvedSkills.push({
      localPath,
      pin: create(ContextPinSchema, {
        setId: "context",
        itemId: "runbook",
        itemKey: "runbook",
        reference: "release-runbook",
        version: "1",
        digest,
      }),
    });
  }
  let question: HarnessAskQuestionRequest | undefined;
  let taken = false;
  const sessions = new Set<ServerHttp2Session>();
  const task = create(TaskSchema, {
    taskId: "task",
    tagId: "actor",
    sessionId,
    attemptId: "attempt",
    state: TaskState.RUNNING,
    prompt,
    instructions: "Work on the accepted Task.",
    allowedActions: actions,
    ...(policySnapshot ? { policySnapshot } : {}),
    ...(executionLimits ? { executionLimits } : {}),
  });
  let cancelAdapter = () => {};
  const server = createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(Harness, {
          confirmExecutionLimits(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            expect(usage).toHaveLength(0);
            appliedLimits.push(request);
            return {};
          },
          attach(_request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            return {
              task,
              attemptId: "attempt",
              mayAskObjectiveQuestion,
              resolvedSkills,
              ...(coordination
                ? { coordination: { ...coordination, mayAskObjectiveQuestion } }
                : {}),
              ...(checkpoint ? { checkpoint } : {}),
            };
          },
          takeLiveInput() {
            if (liveInput && !taken) {
              taken = true;
              return { input: { inputId: "input", text: liveInput }, validForMs: 20000n };
            }
            return {};
          },
          settleLiveInput(request) {
            settlements.push(request.receipt);
            return {};
          },
          publish(request) {
            events.push(request.text);
            if (cancel && request.text === "fixture waiting") cancelAdapter();
            return request;
          },
          reportUsage(request) {
            expect(completions).toHaveLength(0);
            usage.push(request);
            return {};
          },
          complete(request) {
            completions.push(request);
            if (lostComplete && completions.length === 1)
              throw new ConnectError("reply lost", Code.Unavailable);
            return {};
          },
        });
        router.service(HarnessQuestions, {
          askQuestion(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            questions.push(request);
            if (
              question &&
              (question.operationId !== request.operationId || question.text !== request.text)
            )
              throw new ConnectError("private refusal details", Code.AlreadyExists);
            question = request;
            if (lostQuestion && questions.length === 1)
              throw new ConnectError("reply lost", Code.Unavailable);
            return {
              taskId: "task",
              attemptId: "attempt",
              objectiveId: "objective",
              text: question.text,
              askedAtMs: 1n,
            };
          },
        });
        router.service(HarnessWorkstreams, {
          read(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            workstreamReads.push(request);
            return {
              team: { teamId: "engineering", name: "Engineering", memberTagIds: ["actor", "lead"] },
              page: {
                posts: [
                  {
                    postId: "post-6",
                    teamId: request.cursor === "s7" ? "other-team" : "engineering",
                    authorTagId: "lead",
                    sequence: 6n,
                    body: `Untrusted Workstream text ${providerSecret}`,
                  },
                ],
                nextCursor: "s6",
              },
            };
          },
          post(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            posts.push(request);
            if (posts.length === 1) throw new ConnectError("reply lost", Code.Unavailable);
            if (
              request.body === "Confirmed post" &&
              posts.filter(({ operationId }) => operationId === request.operationId).length > 1
            ) {
              return {
                post: {
                  postId: "post-7",
                  teamId: "engineering",
                  authorTagId: "actor",
                  sequence: 7n,
                  sourceTaskId: "task",
                  body: request.body,
                  toTagIds: request.toTagIds,
                },
              };
            }
            return {
              approval: {
                approvalId:
                  {
                    "Denied post": "denied",
                    "Confirmed post": "approval-confirmed",
                    "Wrong receipt": "wrong",
                  }[request.body] ?? "approval-1",
                taskId: "task",
                attemptId: request.body === "Wrong receipt" ? "other-attempt" : "attempt",
                tagId: "actor",
                action: "workstream:post",
                state:
                  request.body === "Denied post" ? ApprovalState.DENIED : ApprovalState.PENDING,
              },
            };
          },
        });
        router.service(HarnessWorkSessions, {
          continue(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            workSessionContinuations.push(request);
            if (workSessionContinuations.length === 1)
              throw new ConnectError("reply lost", Code.Unavailable);
            return {
              workSessionId: request.workSessionId,
              parentTagId: "actor",
              parentSessionId: sessionId,
              starterTaskId: "task",
              tagId: "other-team-tag",
              latestTaskId: "next-child-task",
              latestTaskState: TaskState.QUEUED,
              createdOrder: 2n,
            };
          },
          ask(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            workSessionQuestions.push(request);
            if (workSessionQuestions.length === 1)
              throw new ConnectError("reply lost", Code.Unavailable);
            return {
              workSessionId: sessionId,
              taskId: "task",
              attemptId: "attempt",
              text: request.text,
              askedAtMs: 1n,
            };
          },
          start(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            workSessionStarts.push(request);
            let session = workSessionIds.get(request.operationId);
            if (!session) {
              session = `work/00000000-0000-4000-8000-${String(workSessionIds.size + 1).padStart(12, "0")}`;
              workSessionIds.set(request.operationId, session);
            }
            if (workSessionStarts.length === 1)
              throw new ConnectError("reply lost", Code.Unavailable);
            return {
              workSessionId: session,
              title: request.title,
              parentTagId: "actor",
              parentSessionId: request.title === "Wrong parent" ? "other-session" : "session",
              starterTaskId: request.title === "Wrong starter" ? "other-task" : "task",
              tagId: request.title === "Wrong target" ? "other-tag" : "actor",
              latestTaskId: request.title === "Wrong child" ? "task" : "child-task",
              latestTaskState: TaskState.QUEUED,
              createdOrder: 1n,
            };
          },
        });
        router.service(HarnessMailbox, {
          sendMessage(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            mailboxSends.push(request);
            if (mailboxSends.length === 1) throw new ConnectError("reply lost", Code.Unavailable);
            const kind = request.review?.kind;
            const review = {
              requestId: "review-request",
              objectiveId: "objective",
              commit: reviewCommit,
              workspaceId: "repo",
              sourceTaskId: "child-task",
              requestedAtMs: 100n,
              requesterTagId: kind?.case === "response" ? "lead" : "actor",
              reviewerTagId: kind?.case === "response" ? "actor" : "lead",
            };
            if (kind?.case === "response") {
              return {
                duplicate: true,
                review: {
                  ...review,
                  verdict: {
                    decision: kind.value.verdict,
                    summary: request.text,
                    taskId: "task",
                    recordedAtMs: 101n,
                  },
                },
              };
            }
            return {
              duplicate: true,
              message: {
                messageId: kind?.case === "commit" ? review.requestId : "direct-receipt",
                sourceTaskId: "task",
                senderTagId: "actor",
                recipientTagId: request.recipientTagId,
                text: request.text,
                origin: TagMessageOrigin.DIRECT,
                ...(kind?.case === "commit" ? { objectiveId: review.objectiveId, review } : {}),
              },
            };
          },
          readReviewPatch(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            reviewPatchReads.push(request);
            if (request.reviewId === "empty-review")
              return {
                reviewId: request.reviewId,
                offset: 0n,
                data: new Uint8Array(),
                delivery: {
                  ...reviewDelivery,
                  startCommit: reviewCommit,
                  committed: false,
                  changedFiles: 0n,
                  patch: {
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    byteLength: 0n,
                  },
                },
              };
            return {
              reviewId: request.reviewId,
              offset: request.offset,
              data: request.offset === 0n ? reviewPatch : Uint8Array.of(255),
              nextOffset: request.offset === 0n ? BigInt(reviewPatch.length) : undefined,
              delivery: reviewDelivery,
            };
          },
          read(request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            mailboxReads.push(request);
            return {
              messages: [
                {
                  messageId: "mail",
                  senderTagId: "lead",
                  recipientTagId: request.cursor === "wrong-audience" ? "other-tag" : "actor",
                  text: `Untrusted Mailbox text ${providerSecret}`,
                },
              ],
              nextCursor: "next-mail",
            };
          },
        });
      },
    }),
  );
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const bootstrap = create(AdapterBootstrapSchema, {
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
  });
  const child = spawn(
    process.execPath,
    [
      entry,
      "--executable",
      native,
      "--timeout-seconds",
      "12",
      ...(model ? ["--model", model] : []),
    ],
    {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: providerSecret,
        SUPERTAG_ADAPTER_STATE_DIRECTORY: state,
        SUPERTAG_WORKSPACE_DIRECTORY: workspace,
        SUPERTAG_CONTROLPLANE_TOKEN: "must-not-reach-native",
        AWS_SECRET_ACCESS_KEY: "must-not-reach-native",
        NODE_OPTIONS: "--no-warnings",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  cancelAdapter = () => {
    child.kill("SIGTERM");
  };
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  child.stdout.on("data", (data) => {
    stdout += String(data);
  });
  child.stdin.end(toBinary(AdapterBootstrapSchema, bootstrap));
  const [code, signal] = await once(child, "exit");
  expect({ code, signal, stderr, stdout }).toEqual({
    code: 0,
    signal: null,
    stderr: "",
    stdout: "",
  });
  return {
    directory,
    workspace,
    state,
    completions,
    events,
    usage,
    appliedLimits,
    settlements,
    questions,
    posts,
    workstreamReads,
    mailboxReads,
    reviewPatchReads,
    mailboxSends,
    workSessionStarts,
    workSessionContinuations,
    workSessionQuestions,
  };
}

const budgetUsd = create(ExecutionLimitsSchema, {
  maxReportedCost: { amountMinor: 50n, currency: "USD" },
});

it("passes the accepted USD budget to the real Claude SDK and retains cost on budget stop", async () => {
  const run = await invoke({ prompt: "budget-overrun", executionLimits: budgetUsd });
  expect(run.appliedLimits).toMatchObject([
    { limits: budgetUsd, reportedCost: ExecutionLimitEnforcement.PROVIDER_BUDGET },
  ]);
  expect(await readFile(join(run.workspace, "native-budget-usd"), "utf8")).toBe("0.5");
  expect(run.usage.at(-1)).toMatchObject({
    amountMinor: 51n,
    currency: "USD",
    estimated: false,
    nativeUsage: { totalTokens: 19n },
  });
  expect(run.completions[0]).toMatchObject({
    succeeded: false,
    result: "Claude reported USD budget exceeded.",
  });
  expect(run.completions[0]?.checkpoint).toBeUndefined();
  const pid = Number(await readFile(join(run.workspace, "native-child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 30000);

it.each([
  ["budget-success", true, 49n],
  ["budget-rounded-overrun", false, 50n],
  ["budget-no-cost", false, undefined],
] as const)(
  "checks raw cost and requires evidence before reporting bounded Claude success: %s",
  async (prompt, succeeded, amount) => {
    const run = await invoke({ prompt, executionLimits: budgetUsd });
    expect(run.completions[0]?.succeeded).toBe(succeeded);
    expect(run.usage.at(-1)?.amountMinor).toBe(amount);
    expect(Boolean(run.completions[0]?.checkpoint)).toBe(succeeded);
  },
  30000,
);

it("sequences cost-only and combined native usage on independent receipt lanes", async () => {
  const run = await invoke({ prompt: "budget-mixed-usage", executionLimits: budgetUsd });
  expect(run.completions[0]?.succeeded, run.completions[0]?.result).toBe(true);
  expect(
    run.usage.map(({ sequence, amountMinor, nativeUsage }) => [
      sequence,
      amountMinor,
      nativeUsage?.totalTokens,
    ]),
  ).toEqual([
    [1n, 20n, undefined],
    [1n, undefined, 19n],
    [2n, 49n, 19n],
  ]);
}, 30000);

it("attributes only this Claude Attempt's cost when restored native totals are cumulative or reset", async () => {
  for (const firstPrompt of ["budget-lifetime-start", "write"]) {
    const first = await invoke({ prompt: firstPrompt });
    const checkpoint = first.completions[0]?.checkpoint;
    expect(checkpoint).toBeDefined();
    const resumed = await invoke({
      prompt: firstPrompt === "budget-lifetime-start" ? "budget-lifetime-resume" : "budget-success",
      checkpoint,
      executionLimits: budgetUsd,
    });
    expect(resumed.completions[0]?.succeeded, resumed.completions[0]?.result).toBe(true);
    expect(resumed.usage.at(-1)?.amountMinor).toBe(49n);
  }
}, 30000);

it.each([
  [{ maxReportedCost: { currency: "USD", amountMinor: 0n } }, "budget is zero"],
  [{ maxReportedCost: { currency: "EUR", amountMinor: 50n } }, "requires an accepted USD budget"],
  [{ maxReportedTokens: 100n }, "does not support the accepted token or native agent limit"],
] as const)(
  "refuses incompatible Claude limits before native execution",
  async (limits, reason) => {
    const run = await invoke({
      prompt: "budget-success",
      executionLimits: create(ExecutionLimitsSchema, limits),
    });
    expect(run.completions[0]?.succeeded).toBe(false);
    expect(run.completions[0]?.result).toContain(reason);
    expect(run.appliedLimits).toEqual([]);
    expect(run.usage).toEqual([]);
    await expect(readFile(join(run.workspace, "native-budget-usd"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
  30000,
);

it("runs the real Node SDK, denies unadmitted tools, mirrors a bounded checkpoint, and retries the same receipt", async () => {
  const run = await invoke({ lostComplete: true });
  expect(run.completions).toHaveLength(2);
  expect(run.completions[0]).toEqual(run.completions[1]);
  const completed = run.completions[0];
  expect(completed?.succeeded).toBe(true);
  expect(completed?.result).toContain("unadmitted tools denied");
  expect(completed?.result).toContain("[REDACTED]");
  expect(await readFile(join(run.workspace, "answer.txt"), "utf8")).toBe("fixture first turn\n");
  const archive = Buffer.from(completed?.checkpoint?.payload ?? []).toString("utf8");
  expect(archive).toContain("fixture first turn");
  expect(archive).not.toContain(providerSecret);
  expect(archive).not.toContain(token);
  expect(run.events.join(" ")).not.toContain(providerSecret);
  expect(run.usage.at(-1)?.nativeUsage).toMatchObject({
    inputTokens: 15n,
    cachedInputTokens: 3n,
    outputTokens: 4n,
  });
}, 30000);

it("resumes an approved transcript in another host directory with the real SDK materializer", async () => {
  const first = await invoke({ prompt: "write" });
  const checkpoint = first.completions[0]?.checkpoint;
  expect(checkpoint).toBeDefined();
  const second = await invoke({ prompt: "write resume", checkpoint });
  expect(
    second.completions[0]?.succeeded,
    await readFile(join(second.workspace, "fixture-error.txt"), "utf8").catch(
      () => second.completions[0]?.result,
    ),
  ).toBe(true);
  expect(await readFile(join(second.workspace, "answer.txt"), "utf8")).toBe(
    "fixture resumed turn\n",
  );
  const text = Buffer.from(second.completions[0]?.checkpoint?.payload ?? []).toString("utf8");
  expect(text).not.toContain(first.workspace);
  expect(text).toContain(second.workspace);
}, 30000);

it("rejects a damaged checkpoint instead of silently resetting the native Session", async () => {
  const first = await invoke({ prompt: "write" });
  const checkpoint = first.completions[0]?.checkpoint;
  if (!checkpoint) throw new Error("checkpoint missing");
  checkpoint.sha256 = "0".repeat(64);
  const next = await invoke({ checkpoint });
  expect(next.completions[0]?.succeeded).toBe(false);
  expect(next.completions[0]?.checkpoint).toBeUndefined();
  expect(next.completions[0]?.result).toContain("Native execution did not start");
  await expect(readFile(join(next.workspace, "answer.txt"))).rejects.toThrow();
}, 30000);

it("refuses unverified command authority and failed session mirroring", async () => {
  const unsupported = await invoke({ actions: ["commands:execute"] });
  expect(unsupported.completions[0]?.result).toContain("commands:execute is unsupported");
  expect(unsupported.completions[0]?.succeeded).toBe(false);
  const mirror = await invoke({ prompt: "mirror-failure" });
  expect(mirror.completions[0]?.succeeded).toBe(false);
  expect(mirror.completions[0]?.checkpoint).toBeUndefined();
}, 30000);

it("confirms detached native descendant cleanup before reporting a cancelled execution", async () => {
  const run = await invoke({ prompt: "wait", cancel: true });
  const pid = Number(await readFile(join(run.workspace, "native-child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(run.completions[0]?.succeeded).toBe(false);
  expect(run.completions[0]?.checkpoint).toBeUndefined();
}, 30000);

it("denies native file access through a workspace symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-claude-policy-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "workspace"));
  const workspace = await realpath(join(directory, "workspace"));
  await symlink(directory, join(workspace, "outside"));
  await symlink(join(directory, "not-created"), join(workspace, "dangling"));
  const hook = permissionHook(["Read", "Write"], workspace, new AbortController().signal);
  for (const [path, decision] of [
    ["new.txt", "allow"],
    ["outside/escape.txt", "deny"],
    ["dangling", "deny"],
  ]) {
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "session",
        cwd: workspace,
        transcript_path: "",
        tool_name: "Write",
        tool_input: { file_path: join(workspace, path ?? "") },
        tool_use_id: "tool",
      },
      "tool",
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: decision } });
  }
});

it("reads staged Workspace copies and writes only read-write ones", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-claude-mounts-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["workspace", "mounts/data", "mounts/out", "mounts/other"])
    await mkdir(join(directory, name), { recursive: true });
  const workspace = join(directory, "workspace");
  const mounts = mountRoots([
    { destination: join(directory, "mounts/data"), readWrite: false },
    { destination: join(directory, "mounts/out"), readWrite: true },
  ]);
  expect(mounts).toEqual({
    read: [join(directory, "mounts/data")],
    write: [join(directory, "mounts/out")],
  });
  const hook = permissionHook(
    ["Read", "Write"],
    workspace,
    new AbortController().signal,
    new Set(),
    [],
    new Map(),
    mounts,
  );
  for (const [tool, path, decision] of [
    ["Read", "mounts/data/rows.csv", "allow"],
    ["Write", "mounts/data/rows.csv", "deny"],
    ["Read", "mounts/out/report.md", "allow"],
    ["Write", "mounts/out/report.md", "allow"],
    ["Read", "mounts/other/secret", "deny"],
    ["Write", "mounts/other/secret", "deny"],
  ] as const) {
    const result = await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "session",
        cwd: workspace,
        transcript_path: "",
        tool_name: tool,
        tool_input: { file_path: join(directory, path) },
        tool_use_id: "tool",
      },
      "tool",
      { signal: new AbortController().signal },
    );
    expect(result, `${tool} ${path}`).toMatchObject({
      hookSpecificOutput: { permissionDecision: decision },
    });
  }
});

it("settles live input only after the real SDK writes it to the native prompt stream", async () => {
  const run = await invoke({ prompt: "live-input", liveInput: "delivered followup" });
  expect(run.completions[0]?.succeeded).toBe(true);
  expect(run.completions[0]?.result).toContain("delivered followup");
  expect(run.settlements).toEqual([LiveInputReceipt.ACCEPTED]);
}, 30000);

it("registers only the admitted Objective question in the real SDK and retries its exact receipt", async () => {
  const run = await invoke({
    prompt: "objective-question",
    mayAskObjectiveQuestion: true,
    lostQuestion: true,
    actions: [],
  });
  expect(
    run.completions[0]?.succeeded,
    await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
      () => run.completions[0]?.result,
    ),
  ).toBe(true);
  expect(run.completions[0]?.result).toContain("Objective question recorded");
  expect(run.questions.map(({ text }) => text)).toEqual([
    "Confirm the target branch. [REDACTED]",
    "Confirm the target branch. [REDACTED]",
    "Confirm the target branch. [REDACTED]",
    "A different question",
  ]);
  expect(new Set(run.questions.map(({ operationId }) => operationId)).size).toBe(1);
  expect(run.questions[0]?.operationId).toBeTruthy();
}, 30000);

it("does not register or admit the Objective question without the attached capability", async () => {
  const run = await invoke({ prompt: "objective-question-denied" });
  expect(run.completions[0]?.result).toContain("Objective question unavailable");
  expect(run.completions[0]?.succeeded).toBe(true);
  expect(run.questions).toEqual([]);
}, 30000);

it("runs scoped Workstream and Mailbox tools in the real SDK and stages only the pending approval", async () => {
  const run = await invoke({
    prompt: "coordination-tools",
    actions: ["workstream:post"],
    coordination: { mayUseWorkstream: true, mayReadMailbox: true },
    lostComplete: true,
  });
  expect(
    run.completions[0]?.succeeded,
    await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
      () => run.completions[0]?.result,
    ),
  ).toBe(true);
  expect(run.workstreamReads).toMatchObject([{ afterSequence: 5n, limit: 2 }, { cursor: "s7" }]);
  expect(run.mailboxReads).toMatchObject([
    { limit: 3, cursor: "previous-mail" },
    { cursor: "wrong-audience" },
  ]);
  expect(run.posts).toHaveLength(7);
  for (const request of run.posts.slice(0, 3)) {
    expect(request.operationId).toBeTruthy();
    expect(request).toEqual(run.posts[0]);
    expect(request.body).toBe("Pending post [REDACTED]");
    expect(request.toTagIds).toEqual(["builder", "lead"]);
  }
  expect(run.completions).toHaveLength(2);
  expect(run.completions[0]).toEqual(run.completions[1]);
  expect(run.completions[0]?.waitingApprovalIds).toEqual(["approval-1"]);
}, 30000);

it("does not allow Workstream tools from a Task action alone", async () => {
  const run = await invoke({
    prompt: "coordination-mailbox-only",
    actions: ["workstream:post"],
    coordination: { mayUseWorkstream: false, mayReadMailbox: true },
  });
  expect(run.completions[0]?.succeeded).toBe(true);
  expect(run.posts).toEqual([]);
  expect(run.workstreamReads).toEqual([]);
  expect(run.mailboxReads).toHaveLength(1);
}, 30000);

it("sends direct Mailbox messages through the real Claude SDK with a stable retry receipt", async () => {
  const run = await invoke({
    prompt: "direct-mailbox",
    coordination: { mayUseWorkstream: false, mayReadMailbox: false, maySendTagMessage: true },
  });
  expect(
    run.completions[0]?.succeeded,
    await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
      () => run.completions[0]?.result,
    ),
  ).toBe(true);
  expect(run.mailboxSends).toHaveLength(2);
  expect(run.mailboxSends[0]).toEqual(run.mailboxSends[1]);
  expect(run.mailboxSends[0]).toMatchObject({
    operationId: expect.any(String),
    recipientTagId: "lead",
    text: "Private note [REDACTED]",
  });
  expect(run.posts).toEqual([]);
}, 30000);

it.each(["request", "verdict"] as const)(
  "confirms a typed commit review %s through the real Claude SDK",
  async (mode) => {
    const run = await invoke({
      prompt: `commit-review-${mode}`,
      coordination: {
        mayRequestCommitReview: mode === "request",
        mayReadMailbox: mode === "verdict",
        maySendTagMessage: mode === "verdict",
      },
    });
    expect(
      run.completions[0]?.succeeded,
      await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
        () => run.completions[0]?.result,
      ),
    ).toBe(true);
    expect(run.mailboxSends).toHaveLength(2);
    expect(run.mailboxSends[0]).toEqual(run.mailboxSends[1]);
    expect(run.mailboxSends[0]).toMatchObject({
      recipientTagId: "lead",
      text: "Inspect [REDACTED]",
      review: {
        kind:
          mode === "request"
            ? { case: "commit", value: reviewCommit }
            : {
                case: "response",
                value: {
                  requestId: "review-request",
                  verdict: CommitReviewDecision.CHANGES_REQUESTED,
                },
              },
      },
    });
    expect(run.reviewPatchReads.map(({ reviewId, offset }) => [reviewId, offset])).toEqual(
      mode === "request"
        ? []
        : [
            ["review-request", 0n],
            ["review-request", BigInt(reviewPatch.length)],
            ["empty-review", 0n],
          ],
    );
  },
  30000,
);

it("starts a Work Session through the real Claude SDK with a scoped replay receipt", async () => {
  const run = await invoke({
    prompt: "start-work-session",
    coordination: { mayUseWorkstream: false, mayReadMailbox: false, mayStartWorkSession: true },
  });
  expect(
    run.completions[0]?.succeeded,
    await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
      () => run.completions[0]?.result,
    ),
  ).toBe(true);
  expect(run.completions[0]?.result).toBe("fixture started two Work Sessions");
  expect(run.workSessionStarts).toHaveLength(7);
  const [first, retry, second] = run.workSessionStarts;
  expect(first).toMatchObject({
    operationId: expect.stringMatching(/^claude-work-session:[0-9a-f-]{36}$/),
    title: "Investigate release",
    instruction: "Inspect the pinned checkout [REDACTED]",
    workspaceId: "release",
    targetTagId: "actor",
  });
  expect(retry).toEqual(first);
  expect(second?.operationId).not.toBe(first?.operationId);
}, 30000);

it("omits Start Work Session without the Attempt capability", async () => {
  const run = await invoke({ prompt: "work-session-disabled" });
  expect(run.completions[0]?.succeeded).toBe(true);
  expect(run.workSessionStarts).toEqual([]);
}, 30000);

it("records a child question and relays an answer through scoped Claude SDK tools", async () => {
  const child = await invoke({
    prompt: "ask-work-session",
    sessionId: childSession,
    coordination: {
      mayUseWorkstream: false,
      mayReadMailbox: false,
      mayAskWorkSessionQuestion: true,
    },
  });
  const parent = await invoke({
    prompt: "continue-work-session",
    coordination: { mayUseWorkstream: false, mayReadMailbox: false, mayContinueWorkSession: true },
  });
  for (const run of [child, parent]) {
    expect(
      run.completions[0]?.succeeded,
      await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
        () => run.completions[0]?.result,
      ),
    ).toBe(true);
    expect(run.questions).toEqual([]);
  }
  expect(child.workSessionQuestions).toHaveLength(2);
  expect(child.workSessionQuestions[0]).toEqual(child.workSessionQuestions[1]);
  expect(child.workSessionQuestions[0]?.text).toBe("Which branch? [REDACTED]");
  expect(parent.workSessionContinuations).toHaveLength(2);
  expect(parent.workSessionContinuations[0]).toEqual(parent.workSessionContinuations[1]);
  expect(parent.workSessionContinuations[0]).toMatchObject({
    workSessionId: childSession,
    message: "Use staging [REDACTED]",
  });
}, 30000);

it.each(["ask-first", "post-first"])(
  "keeps approval and question waits separate (%s)",
  async (order) => {
    const run = await invoke({
      prompt: `mixed-tools-${order}`,
      actions: ["workstream:post"],
      coordination: { mayUseWorkstream: true, mayReadMailbox: false, mayStartWorkSession: true },
      mayAskObjectiveQuestion: true,
    });
    expect(
      run.completions[0]?.succeeded,
      await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
        () => run.completions[0]?.result,
      ),
    ).toBe(true);
    expect(run.questions).toHaveLength(order === "ask-first" ? 1 : 0);
    expect(run.posts).toHaveLength(order === "ask-first" ? 0 : 2);
    expect(run.workSessionStarts).toEqual([]);
    expect(run.completions[0]?.waitingApprovalIds).toEqual(
      order === "ask-first" ? [] : ["approval-1"],
    );
  },
  30000,
);

it("fails before native launch when a required Context Item has no resolver", async () => {
  const policySnapshot = create(TaskPolicySnapshotSchema, {
    version: 1,
    contextSets: [
      {
        setId: "context",
        items: [
          {
            itemId: "runbook",
            itemKey: "runbook",
            type: "fixture/runbook",
            version: 1,
            required: true,
            configJson: "{}",
          },
        ],
      },
    ],
  });
  const run = await invoke({ prompt: "required-context-fixture", policySnapshot });
  expect(run.completions).toHaveLength(1);
  expect(run.completions[0]?.result).toContain("required Context Item");
  expect(run.completions[0]?.succeeded).toBe(false);
  expect(run.completions[0]?.checkpoint).toBeUndefined();
  await expect(readFile(join(run.workspace, "native-started"))).rejects.toThrow();
}, 30000);

it.each(["valid", "tampered", "hooks"] as const)(
  "stages only admitted static Skills before the Claude SDK launches (%s)",
  async (kind) => {
    const policySnapshot = create(TaskPolicySnapshotSchema, {
      version: 1,
      contextSets: [
        {
          setId: "context",
          items: [
            {
              itemId: "runbook",
              itemKey: "runbook",
              type: "supertag/skill",
              version: 1,
              required: true,
              configJson: JSON.stringify({ reference: "release-runbook", version: "1" }),
            },
          ],
        },
      ],
    });
    const run = await invoke({
      prompt: "inspect-skill-package",
      policySnapshot,
      skill: {
        markdown: `---\nname: release-runbook\ndescription: Verify the release.\n${kind === "hooks" ? "hooks: {}\n" : ""}---\nUse the release checklist.\n`,
        tamper: kind === "tampered",
      },
    });
    expect(
      run.completions[0]?.succeeded,
      await readFile(join(run.workspace, "fixture-error.txt"), "utf8").catch(
        () => run.completions[0]?.result,
      ),
    ).toBe(kind === "valid");
    if (kind === "valid") {
      expect(run.completions[0]?.result).toBe("fixture verified Skill package");
    } else {
      await expect(readFile(join(run.workspace, "native-started"))).rejects.toThrow();
    }
  },
  30000,
);

it("uses the first accepted model and falls back to the host model without one", async () => {
  const policySnapshot = create(TaskPolicySnapshotSchema, {
    version: 1,
    execution: { models: ["accepted-model", "another-model"] },
  });
  const prompt = "model-policy-fixture";
  const accepted = await invoke({ prompt, model: "host-model", policySnapshot });
  expect(accepted.completions[0]?.result).toBe("fixture model accepted-model");
  const fallback = await invoke({ prompt, model: "host-model" });
  expect(fallback.completions[0]?.result).toBe("fixture model host-model");
}, 30000);

it("reports Claude Code background tasks and API retries as progress events", async () => {
  const run = await invoke({ prompt: "task-progress" });
  expect(run.completions[0]?.result).toContain("fixture first turn");
  const progress = run.events
    .filter((text) => text.startsWith('{"type":"progress.updated"'))
    .map((text) => JSON.parse(text));
  expect(progress).toEqual([
    {
      type: "progress.updated",
      progress: {
        summary:
          "Provider request failed (overloaded, HTTP 529); Claude Code is retrying request 1 of 10 after 500 ms.",
      },
    },
    {
      type: "progress.updated",
      progress: {
        summary: "Working through the plan",
        items: [{ id: "lint", text: "Run the linter [REDACTED]", status: "active" }],
      },
    },
    {
      type: "progress.updated",
      progress: {
        summary: "Finishing up",
        items: [{ id: "lint", text: "Run the linter [REDACTED]", status: "completed" }],
      },
    },
  ]);
  expect(run.events.join(" ")).not.toContain(providerSecret);
}, 30000);
