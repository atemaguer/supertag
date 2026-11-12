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
  AdapterBootstrapSchema,
  Harness,
  type HarnessAskQuestionRequest,
  type HarnessCompleteRequest,
  HarnessQuestions,
  type HarnessUsageRequest,
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
}: {
  prompt?: string;
  checkpoint?: SessionCheckpoint;
  actions?: string[];
  lostComplete?: boolean;
  cancel?: boolean;
  liveInput?: string;
  mayAskObjectiveQuestion?: boolean;
  lostQuestion?: boolean;
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
    [entry, "--executable", native, "--timeout-seconds", "12"],
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
  return { directory, workspace, state, completions, events, usage, settlements, questions };
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
