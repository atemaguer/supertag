import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createServer, type ServerHttp2Session } from "node:http2";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, expect, it } from "vitest";
import { permissionHook } from "./src/rust-adapter/adapter.js";
import {
  type TaskPolicySnapshot,
  TaskPolicySnapshotSchema,
} from "./src/rust-adapter/gen/supertag/runtime/v2/policy_pb.js";
import {
  AdapterBootstrapSchema,
  ApprovalState,
  type AttemptCapabilities,
  Harness,
  type HarnessAskQuestionRequest,
  type HarnessCompleteRequest,
  HarnessMailbox,
  type HarnessPostWorkstreamRequest,
  HarnessQuestions,
  type HarnessReadMailboxRequest,
  type HarnessReadWorkstreamRequest,
  type HarnessUsageRequest,
  HarnessWorkstreams,
  LiveInputReceipt,
  type SessionCheckpoint,
  TaskSchema,
  TaskState,
} from "./src/rust-adapter/gen/supertag/runtime/v2/runtime_pb.js";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "fixtures/rust-native-claude.mjs");
const entry = join(here, "dist/rust-adapter/entry.js");
const token = "execution-token-private-fixture-123";
const providerSecret = "provider-secret-private-fixture-123";
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
  model,
}: {
  prompt?: string;
  checkpoint?: SessionCheckpoint;
  actions?: string[];
  lostComplete?: boolean;
  cancel?: boolean;
  liveInput?: string;
  mayAskObjectiveQuestion?: boolean;
  lostQuestion?: boolean;
  coordination?: Pick<AttemptCapabilities, "mayUseWorkstream" | "mayReadMailbox">;
  policySnapshot?: TaskPolicySnapshot;
  model?: string;
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
  const settlements: LiveInputReceipt[] = [];
  const questions: HarnessAskQuestionRequest[] = [];
  const posts: HarnessPostWorkstreamRequest[] = [];
  const workstreamReads: HarnessReadWorkstreamRequest[] = [];
  const mailboxReads: HarnessReadMailboxRequest[] = [];
  let question: HarnessAskQuestionRequest | undefined;
  let taken = false;
  const sessions = new Set<ServerHttp2Session>();
  const task = create(TaskSchema, {
    taskId: "task",
    tagId: "actor",
    sessionId: "session",
    attemptId: "attempt",
    state: TaskState.RUNNING,
    prompt,
    instructions: "Work on the accepted Task.",
    allowedActions: actions,
    ...(policySnapshot ? { policySnapshot } : {}),
  });
  let cancelAdapter = () => {};
  const server = createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(Harness, {
          attach(_request, context) {
            expect(context.requestHeader.get("authorization")).toBe(`Bearer ${token}`);
            return {
              task,
              attemptId: "attempt",
              mayAskObjectiveQuestion,
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
        router.service(HarnessMailbox, {
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
    settlements,
    questions,
    posts,
    workstreamReads,
    mailboxReads,
  };
}

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

it.each(["ask-first", "post-first"])(
  "keeps approval and question waits separate (%s)",
  async (order) => {
    const run = await invoke({
      prompt: `mixed-tools-${order}`,
      actions: ["workstream:post"],
      coordination: { mayUseWorkstream: true, mayReadMailbox: false },
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
