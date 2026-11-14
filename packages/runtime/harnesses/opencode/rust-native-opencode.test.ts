import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  AdapterBootstrapSchema,
  Harness,
  type HarnessCompleteRequest,
  HarnessQuestions,
  TaskSchema,
  TaskState,
} from "@supertag/worker-sdk/internal/rust-harness";
import { expect, it } from "vitest";
import { nativeRequest, runAdapter } from "./src/rust-adapter/adapter.js";

const native = process.env["SUPERTAG_TEST_OPENCODE_BINARY"];
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const taskId = "native-probe-task";
const attemptId = "native-probe-attempt";
const finalText = "The native OpenCode turn finished.";
const childPrompt = "Inspect the native child tool boundary.";
const childResult = "The native child reported back.";

it.runIf(Boolean(native))(
  "the verified native release ignores executable Workspace configuration",
  async () => {
    if (!native) throw new Error("OpenCode fixture executable is required");
    const directory = await mkdtemp(join(tmpdir(), "supertag-opencode-project-"));
    const scratch = join(directory, "scratch");
    const workspace = join(directory, "checkout");
    const plugins = join(workspace, ".opencode", "plugins");
    const marker = join(directory, "plugin-loaded");
    try {
      await mkdir(scratch, { mode: 0o700 });
      await mkdir(plugins, { recursive: true });
      await writeFile(join(workspace, "opencode.json"), "invalid configuration\n");
      await writeFile(
        join(plugins, "test-marker.mjs"),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport const Marker = async () => ({});\n`,
      );
      const request = await nativeRequest(
        create(TaskSchema, { taskId }),
        "fixture/fixture",
        {
          executable: native,
          model: "fixture/fixture",
          timeoutMs: 20_000,
          environment: {
            SUPERTAG_ADAPTER_STATE_DIRECTORY: scratch,
            SUPERTAG_WORKSPACE_DIRECTORY: workspace,
          },
        },
        [],
        [],
        AbortSignal.timeout(20_000),
      );
      const { environment } = request.forTools([]);
      await promisify(execFile)(native, ["--pure", "mcp", "list"], {
        cwd: workspace,
        env: { ...environment, OPENCODE_DISABLE_MODELS_FETCH: "true" },
        timeout: 20_000,
      });
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);

it.runIf(Boolean(native))(
  "streams a native OpenCode turn through an authenticated manager tool and confirms completion",
  async () => {
    if (!native) throw new Error("OpenCode fixture executable is required");
    const directory = await mkdtemp(join(tmpdir(), "supertag-native-opencode-"));
    const scratch = join(directory, "scratch");
    const workspace = join(directory, "workspace");
    const sessionHandles = new Set<ServerHttp2Session>();
    let question: string | undefined;
    let completed: HarnessCompleteRequest | undefined;
    const output: string[] = [];
    let managerCalls = 0;
    let offeredTools: string[] = [];
    let childTools: string[] | undefined;
    const harness = createHttp2Server(
      connectNodeAdapter({
        routes(router) {
          router.service(Harness, {
            attach: async () => ({
              task: {
                taskId,
                attemptId,
                tagId: "owner",
                sessionId: "session",
                state: TaskState.RUNNING,
                prompt: "Ask the operator, then finish.",
              },
              attemptId,
              coordination: { mayAskObjectiveQuestion: true },
            }),
            publish: async ({ text }) => {
              output.push(text);
              return { text };
            },
            complete: async (request) => {
              completed = request;
              return {};
            },
          });
          router.service(HarnessQuestions, {
            askQuestion: async ({ text }) => {
              question = text;
              return { taskId, attemptId, objectiveId: "objective", text };
            },
          });
        },
      }),
    );
    harness.on("session", (session) => {
      sessionHandles.add(session);
      session.once("close", () => sessionHandles.delete(session));
    });
    const provider = createHttpServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
          tools?: { function: { name: string } }[];
          messages: { role: string; content: unknown }[];
        };
        if (req.url !== "/v1/chat/completions" || body.model !== "fixture") {
          res.writeHead(404).end();
          return;
        }
        const names = body.tools?.map((tool) => tool.function.name) ?? [];
        const child = JSON.stringify(
          body.messages.findLast(({ role }) => role === "user")?.content,
        )?.includes(childPrompt);
        if (child) childTools = names;
        const manager = !child && names.includes("supertag_ask");
        if (manager) {
          offeredTools = names;
          managerCalls++;
        }
        const received = (text: string) =>
          body.messages.some(
            ({ role, content }) => role === "tool" && JSON.stringify(content).includes(text),
          );
        const callChild = manager && managerCalls === 1;
        const callQuestion = manager && managerCalls === 2;
        if (callQuestion && !received(childResult))
          throw new Error("OpenCode omitted the child result");
        if (manager && managerCalls === 3 && !received("question recorded"))
          throw new Error("OpenCode omitted the question receipt");
        const header = {
          id: "synthetic-reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
        };
        const send = (delta: object, finish: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({
              ...header,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
          );
        const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
        res.writeHead(200, { "content-type": "text/event-stream" });
        send({ role: "assistant" });
        await delay();
        if (callChild || callQuestion) {
          send({
            tool_calls: [
              {
                index: 0,
                id: callChild ? "probe-child" : "probe-question",
                type: "function",
                function: {
                  name: callChild ? "task" : "supertag_ask",
                  arguments: JSON.stringify(
                    callChild
                      ? {
                          description: "Verify child tool scope",
                          prompt: childPrompt,
                          subagent_type: "general",
                        }
                      : { text: "Which synthetic choice?" },
                  ),
                },
              },
            ],
          });
        } else
          send({ content: child ? childResult : manager ? finalText : "Synthetic task title" });
        await delay();
        send({}, callChild || callQuestion ? "tool_calls" : "stop");
        res.write(
          `data: ${JSON.stringify({ ...header, choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } catch {
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      }
    });
    try {
      await Promise.all([mkdir(scratch, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 })]);
      harness.listen(0, "127.0.0.1");
      provider.listen(0, "127.0.0.1");
      await Promise.all([once(harness, "listening"), once(provider, "listening")]);
      const baseURL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
      const inject = join(directory, "provider.cjs");
      const executable = join(directory, "opencode");
      // The test-only shim selects a loopback provider, then execs the actual CLI.
      await writeFile(
        inject,
        `const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);\nconfig.provider = ${JSON.stringify(
          {
            fixture: {
              name: "Local fixture",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL, apiKey: "fixture-only-key" },
              models: {
                fixture: {
                  name: "Fixture",
                  tool_call: true,
                  limit: { context: 128_000, output: 4096 },
                },
              },
            },
          },
        )};\nprocess.stdout.write(JSON.stringify(config));\n`,
      );
      await writeFile(
        executable,
        `#!/bin/sh\nif [ "$1" = run ]; then\n  OPENCODE_CONFIG_CONTENT=$(${shellQuote(process.execPath)} ${shellQuote(inject)}) || exit 1\n  export OPENCODE_CONFIG_CONTENT\nfi\nexport OPENCODE_DISABLE_MODELS_FETCH=true\nexec ${shellQuote(native)} "$@"\n`,
        { mode: 0o700 },
      );
      await runAdapter(
        create(AdapterBootstrapSchema, {
          endpoint: `http://127.0.0.1:${(harness.address() as AddressInfo).port}`,
          token: "fixture-private-execution-token",
        }),
        new AbortController().signal,
        {
          executable,
          model: "fixture/fixture",
          timeoutMs: 25_000,
          environment: {
            SUPERTAG_ADAPTER_STATE_DIRECTORY: scratch,
            SUPERTAG_WORKSPACE_DIRECTORY: workspace,
          },
        },
      );
      expect(offeredTools).toContain("supertag_ask");
      expect(managerCalls).toBe(3);
      expect(childTools).toBeDefined();
      expect(childTools).not.toContain("supertag_ask");
      expect(childTools).not.toContain("task");
      expect(question).toBe("Which synthetic choice?");
      expect(output).toEqual([finalText]);
      expect(completed).toMatchObject({
        succeeded: true,
        result: finalText,
        waitingApprovalIds: [],
      });
    } finally {
      for (const session of sessionHandles) session.destroy();
      provider.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => harness.close(() => resolve())),
        new Promise<void>((resolve) => provider.close(() => resolve())),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

it.runIf(Boolean(native))(
  "confines native OpenCode file tools to the worktree and its Workspace Volume copies",
  async () => {
    if (!native) throw new Error("OpenCode fixture executable is required");
    const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-opencode-copies-")));
    const scratch = join(directory, "scratch");
    const workspace = join(directory, "workspace");
    const readOnly = join(directory, "mounts", "ro");
    const readWrite = join(directory, "mounts", "rw");
    const outside = join(directory, "outside");
    const sessionHandles = new Set<ServerHttp2Session>();
    const results: string[] = [];
    let completed: HarnessCompleteRequest | undefined;
    const steps = [
      { name: "read", arguments: { filePath: join(readOnly, "data.txt") } },
      { name: "write", arguments: { filePath: join(readWrite, "out.txt"), content: "written\n" } },
      { name: "write", arguments: { filePath: join(readOnly, "denied.txt"), content: "no\n" } },
      { name: "read", arguments: { filePath: join(outside, "secret.txt") } },
    ];
    const harness = createHttp2Server(
      connectNodeAdapter({
        routes(router) {
          router.service(Harness, {
            attach: async () => ({
              task: {
                taskId,
                attemptId,
                tagId: "owner",
                sessionId: "session",
                state: TaskState.RUNNING,
                prompt: "Use the copies, then finish.",
                allowedActions: ["files:read", "files:write"],
                workspace: {
                  workspaceId: "project",
                  mounts: [
                    { volumeId: "ro", destination: readOnly, maxBytes: 1024n, readWrite: false },
                    { volumeId: "rw", destination: readWrite, maxBytes: 1024n, readWrite: true },
                  ],
                },
              },
              attemptId,
            }),
            publish: async ({ text }) => ({ text }),
            complete: async (request) => {
              completed = request;
              return {};
            },
          });
        },
      }),
    );
    harness.on("session", (session) => {
      sessionHandles.add(session);
      session.once("close", () => sessionHandles.delete(session));
    });
    const provider = createHttpServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          tools?: { function: { name: string } }[];
          messages: { role: string; content: unknown }[];
        };
        const header = {
          id: "synthetic-reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
        };
        const send = (delta: object, finish: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ ...header, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        res.writeHead(200, { "content-type": "text/event-stream" });
        send({ role: "assistant" });
        const titled = !body.tools?.some(({ function: { name } }) => name === "read");
        const tools = body.messages.filter(({ role }) => role === "tool");
        const step = titled ? undefined : steps[tools.length];
        if (!titled && tools.length > results.length)
          results.push(
            ...tools.slice(results.length).map(({ content }) => JSON.stringify(content)),
          );
        if (step) {
          send({
            tool_calls: [
              {
                index: 0,
                id: `probe-${tools.length}`,
                type: "function",
                function: { name: step.name, arguments: JSON.stringify(step.arguments) },
              },
            ],
          });
          send({}, "tool_calls");
        } else {
          send({ content: titled ? "Synthetic task title" : "copies probed" });
          send({}, "stop");
        }
        res.end("data: [DONE]\n\n");
      } catch {
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      }
    });
    try {
      await mkdir(scratch, { mode: 0o700 });
      await mkdir(workspace, { mode: 0o700 });
      await promisify(execFile)("git", ["init", "-q", workspace]);
      await mkdir(readOnly, { recursive: true });
      await mkdir(readWrite, { recursive: true });
      await mkdir(outside);
      await writeFile(join(readOnly, "data.txt"), "read-only copy data\n");
      await writeFile(join(outside, "secret.txt"), "outside secret\n");
      harness.listen(0, "127.0.0.1");
      provider.listen(0, "127.0.0.1");
      await Promise.all([once(harness, "listening"), once(provider, "listening")]);
      const baseURL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
      const inject = join(directory, "provider.cjs");
      const executable = join(directory, "opencode");
      await writeFile(
        inject,
        `const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);\nconfig.provider = ${JSON.stringify(
          {
            fixture: {
              name: "Local fixture",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL, apiKey: "fixture-only-key" },
              models: {
                fixture: {
                  name: "Fixture",
                  tool_call: true,
                  limit: { context: 128_000, output: 4096 },
                },
              },
            },
          },
        )};\nprocess.stdout.write(JSON.stringify(config));\n`,
      );
      await writeFile(
        executable,
        `#!/bin/sh\nif [ "$1" = run ]; then\n  OPENCODE_CONFIG_CONTENT=$(${shellQuote(process.execPath)} ${shellQuote(inject)}) || exit 1\n  export OPENCODE_CONFIG_CONTENT\nfi\nexport OPENCODE_DISABLE_MODELS_FETCH=true\nexec ${shellQuote(native)} "$@"\n`,
        { mode: 0o700 },
      );
      await runAdapter(
        create(AdapterBootstrapSchema, {
          endpoint: `http://127.0.0.1:${(harness.address() as AddressInfo).port}`,
          token: "fixture-private-execution-token",
        }),
        new AbortController().signal,
        {
          executable,
          model: "fixture/fixture",
          timeoutMs: 25_000,
          environment: {
            SUPERTAG_ADAPTER_STATE_DIRECTORY: scratch,
            SUPERTAG_WORKSPACE_DIRECTORY: workspace,
          },
        },
      );
      expect(completed).toMatchObject({ succeeded: true });
      expect(results).toHaveLength(steps.length);
      expect(results[0]).toContain("read-only copy data");
      expect(results[1]).toContain("Wrote file successfully");
      expect(await readFile(join(readWrite, "out.txt"), "utf8")).toBe("written\n");
      // A permission rule, not the filesystem, refuses the read-only copy and other directories.
      expect(results[2]).toContain("prevents you from using this specific tool call");
      await expect(stat(join(readOnly, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(results[3]).toContain("prevents you from using this specific tool call");
      expect(results[3]).not.toContain("outside secret");
    } finally {
      for (const session of sessionHandles) session.destroy();
      provider.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => harness.close(() => resolve())),
        new Promise<void>((resolve) => provider.close(() => resolve())),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);
