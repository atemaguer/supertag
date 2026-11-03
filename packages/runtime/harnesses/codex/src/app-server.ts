import { setTimeout as delay } from "node:timers/promises";
import {
  connectWorkerMcpClient,
  describeToolCall,
  ExecutionBudgetExceededError,
  ExecutionCleanupError,
  type ExecutionContext,
  type HarnessEvent,
  type HarnessExecution,
  HarnessProviderError,
  type HarnessRuntime,
  LocalHarnessExecutionControl,
  type McpClientConnection,
  type ToolInput,
} from "@supertag/worker-sdk";
import { codexCommandStatus, codexCommandText } from "./command-activity.js";
import type { CodexRunRequest } from "./index.js";
import { codexCostFields, reportedCodexModel } from "./pricing.js";
import {
  type CodexSandboxAllowance,
  codexProtectedGitDirectory,
  codexSandboxAllowance,
  codexSandboxMode,
} from "./sandbox.js";

type Json = Record<string, unknown>;
type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};
type DynamicToolSet = {
  readonly input: ToolInput;
  readonly namespace: string;
  readonly connected: McpClientConnection;
};
const DYNAMIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;
const RESERVED_DYNAMIC_TOOL_NAMESPACES = new Set([
  "functions",
  "multi_tool_use",
  "file_search",
  "web",
  "browser",
  "image_gen",
  "computer",
  "container",
  "terminal",
  "python",
  "python_user_visible",
  "api_tool",
  "tool_search",
  "submodel_delegator",
]);
export interface CodexAppServerOptions {
  readonly request: CodexRunRequest;
  readonly environment: HarnessRuntime;
  readonly executionEnvironment?: {
    readonly environmentId: string;
    readonly url: string;
    readonly cwd: string;
    readonly provenance: Readonly<Record<string, unknown>>;
  };
  readonly context: ExecutionContext;
  /** Marks dependent transports as intentionally closing before this process is stopped. */
  readonly onClosing?: () => void;
  /** Tool Inputs intentionally kept out of Codex's process-wide MCP configuration. */
  readonly dynamicToolInputs?: readonly ToolInput[];
  /** Opens the selected Worker-owned or execution-environment-owned MCP client. */
  readonly connectDynamicTool?: (input: ToolInput) => Promise<McpClientConnection>;
  /** Complete Worker-owned launch arguments, including the app-server subcommand and policy. */
  readonly command: string;
  readonly args: readonly string[];
  readonly processEnvironment: Readonly<Record<string, string>>;
  readonly limits?: { readonly maxAgents: number; readonly maxTokens?: number };
  readonly usageBaselines?: Readonly<Record<string, Usage>>;
  readonly model?: string;
}
export interface CodexAppServerExecution extends HarnessExecution {
  readonly threadIds: readonly string[];
  readonly threadUsage: Readonly<Record<string, Usage>>;
  readonly provenance?: Readonly<Record<string, unknown>>;
}
const zero = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  totalTokens: 0,
});
const keys = ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"] as const;

/** One environment-owned app-server and one root turn; control never creates another turn. */
export async function startCodexAppServer(
  options: CodexAppServerOptions,
): Promise<CodexAppServerExecution> {
  const { request, environment, context } = options;
  let closingNotified = false;
  const notifyClosing = () => {
    if (closingNotified) return;
    closingNotified = true;
    options.onClosing?.();
  };
  if (
    options.limits &&
    (!Number.isSafeInteger(options.limits.maxAgents) ||
      options.limits.maxAgents < 0 ||
      (options.limits.maxTokens !== undefined &&
        (!Number.isSafeInteger(options.limits.maxTokens) || options.limits.maxTokens <= 0)))
  )
    throw new Error("Invalid Codex native execution limits");
  if ((options.limits?.maxAgents ?? 0) > 0)
    throw new Error(
      "Codex native subagents are disabled until child tool inheritance can be isolated",
    );
  for (const baseline of Object.values(options.usageBaselines ?? {}))
    for (const key of keys)
      if (!Number.isSafeInteger(baseline[key]) || baseline[key] < 0)
        throw new Error("Invalid Codex persisted usage baseline");
  context.signal?.throwIfAborted();
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error(`Codex app-server timed out after ${request.timeoutMs}ms`)),
    request.timeoutMs,
  );
  const executionSignal = context.signal
    ? AbortSignal.any([context.signal, deadline.signal])
    : deadline.signal;
  const executionError = (error: unknown) =>
    error instanceof ExecutionCleanupError
      ? error
      : executionSignal.aborted
        ? executionSignal.reason
        : error;
  const dynamicToolSets: DynamicToolSet[] = [];
  const dynamicToolInputs =
    options.dynamicToolInputs ?? context.tools.filter((tool) => tool.audience === "manager");
  const connectDynamicTool = options.connectDynamicTool ?? connectWorkerMcpClient;
  const connectBeforeDeadline = (input: ToolInput): Promise<McpClientConnection> => {
    const opening = connectDynamicTool(input);
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        executionSignal.removeEventListener("abort", abort);
        // A custom surface cannot be forcibly cancelled before it returns its handle.
        // Keep execution uncertain, and close that handle if it eventually arrives.
        reject(
          new ExecutionCleanupError(
            "Codex MCP initialization ended before connection cleanup could be confirmed",
            { cause: executionSignal.reason },
          ),
        );
      };
      executionSignal.addEventListener("abort", abort, { once: true });
      void opening.then(
        (connected) => {
          if (settled) {
            void Promise.resolve()
              .then(() => connected.close())
              .catch(() => {});
            return;
          }
          settled = true;
          executionSignal.removeEventListener("abort", abort);
          resolve(connected);
        },
        (error) => {
          if (settled) return;
          settled = true;
          executionSignal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (executionSignal.aborted) abort();
    });
  };
  try {
    for (const input of dynamicToolInputs) {
      executionSignal.throwIfAborted();
      const namespace = dynamicToolNamespace(input.binding.name);
      if (dynamicToolSets.some((entry) => entry.namespace === namespace))
        throw new Error("Dynamic tool namespaces must be unique");
      dynamicToolSets.push({ input, namespace, connected: await connectBeforeDeadline(input) });
      executionSignal.throwIfAborted();
    }
  } catch (error) {
    clearTimeout(deadlineTimer);
    const primary = executionError(error);
    await closeCodexResources(
      dynamicToolSets.map(
        ({ connected }) =>
          () =>
            connected.close(),
      ),
      [primary],
    );
    throw primary;
  }
  const process = await environment
    .spawn(
      {
        command: options.command,
        args: [...options.args],
        cwd: environment.rootDirectory,
        environment: options.processEnvironment,
        streamInput: true,
        streamOutput: true,
        timeoutMs: request.timeoutMs,
      },
      executionSignal,
    )
    .catch(async (error) => {
      clearTimeout(deadlineTimer);
      const primary = executionError(error);
      await closeCodexResources(
        dynamicToolSets.map(
          ({ connected }) =>
            () =>
              connected.close(),
        ),
        [primary],
      );
      throw primary;
    });
  if (!process.output || !process.write || !process.endInput) {
    clearTimeout(deadlineTimer);
    notifyClosing();
    const primary = new Error(
      "Codex app-server requires environment-owned streaming input and output",
    );
    await closeCodexResources(
      [
        async () => {
          process.kill();
          await process.wait().catch((error) => {
            if (error instanceof ExecutionCleanupError) throw error;
          });
        },
        ...dynamicToolSets.map(
          ({ connected }) =>
            () =>
              connected.close(),
        ),
      ],
      [primary],
    );
    throw primary;
  }
  const queue = new EventQueue();
  const pending = new Map<
    string,
    { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const questions = new Map<string, { rpcId: string | number; ids: Set<string> }>();
  const dynamicCallIds = new Set<string>();
  const threads = new Map<
    string,
    {
      parentId?: string;
      baseline?: Usage | undefined;
      usage?: Usage;
      status: "running" | "completed" | "failed" | "interrupted";
      usageComplete: boolean;
      conservativeBaseline: boolean;
      turnId?: string;
    }
  >();
  let pendingSubscriptions = 0;
  let pendingSteers = 0;
  let failed = false;
  const unattributed = new Map<string, Json[]>();
  let unattributedCount = 0;
  let unattributedBytes = 0;
  let attributionTimer: ReturnType<typeof setTimeout> | undefined;
  const clearUnattributed = () => {
    clearTimeout(attributionTimer);
    attributionTimer = undefined;
    unattributed.clear();
    unattributedCount = 0;
    unattributedBytes = 0;
  };
  let nextId = 0,
    rootId: string | undefined,
    activeTurn: string | undefined;
  let awaitingRoot = false,
    turnRequested = false,
    ran = false,
    finished = false,
    interrupted = false;
  let capacityRetries = 0;
  let retryFenced = false;
  let retryTurn: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let writing = Promise.resolve();
  let finalText = "";
  let budgetReminderSent = false;
  let terminalUsageTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalUsageGraceElapsed = false;
  const write = (value: Json, beforeWrite?: () => Promise<boolean>) => {
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > 1_048_576)
      return Promise.reject(new Error("Codex RPC exceeds 1 MiB"));
    writing = writing
      .catch((error) => {
        if (!(error instanceof InputAuthorizationRejected)) throw error;
      })
      .then(async () => {
        if (beforeWrite && !(await beforeWrite())) throw new InputAuthorizationRejected();
        return process.write?.(new TextEncoder().encode(text));
      });
    return writing;
  };
  const rpc = (
    method: string,
    params: Json,
    beforeWrite?: () => Promise<boolean>,
  ): Promise<Json> => {
    if (closing || pending.size >= 32)
      return Promise.reject(new Error("Codex RPC is closed or at capacity"));
    const id = `supertag-${++nextId}`;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`Codex ${method} acknowledgement timed out; execution is uncertain`));
        },
        Math.min(request.timeoutMs, 30_000),
      );
      pending.set(id, { resolve, reject, timer });
      void write({ id, method, params }, beforeWrite).catch((error) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  };
  const fail = (error: unknown) => {
    clearTimeout(terminalUsageTimer);
    const failure = error instanceof Error ? error : new Error("Codex app-server failed");
    failed = true;
    clearUnattributed();
    queue.fail(failure);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
  };
  const registerThread = (id: string, parentId?: string) => {
    if (threads.has(id)) return;
    if (parentId !== undefined && !threads.has(parentId))
      throw new Error("Unattributed Codex child thread");
    if (parentId !== undefined && threads.size - 1 >= (options.limits?.maxAgents ?? 0))
      throw new Error("Codex native agent limit exceeded");
    threads.set(id, {
      ...(parentId ? { parentId } : {}),
      // A restored transcript may have been interrupted before its first usage
      // notification. Zero then gives a conservative lifetime upper bound, not
      // an exact Attempt delta. Never subtract the first NEW report as a baseline.
      baseline: options.usageBaselines?.[id] ?? zero(),
      conservativeBaseline:
        parentId === undefined &&
        !!request.resumeThreadId &&
        options.usageBaselines?.[id] === undefined,
      status: "running",
      usageComplete:
        parentId === undefined &&
        (!request.resumeThreadId || options.usageBaselines?.[id] !== undefined),
    });
    if (parentId !== undefined) {
      pendingSubscriptions++;
      // Resume an already-running, attributed thread to subscribe; never start a child turn.
      void rpc("thread/resume", { threadId: id })
        .then((result) => {
          if (text(object(result["thread"])["id"]) !== id)
            throw new Error("Codex subscribed to a different child");
          const metadata = object(result["thread"]);
          const childUsage = threads.get(id);
          if (childUsage) {
            if (options.usageBaselines?.[id] !== undefined) childUsage.usageComplete = true;
            else if (metadata["forkedFromId"] === null) childUsage.usageComplete = true;
            else
              throw new Error(
                "Codex forked child usage baseline unavailable; use a child without forked history",
              );
            if (childUsage.usage) emitUsage();
          }
          const turns = metadata["turns"];
          const active = Array.isArray(turns)
            ? turns.map(object).findLast((turn) => turn["status"] === "inProgress")
            : undefined;
          const child = threads.get(id);
          if (child && active) child.turnId = text(active["id"]);
          const last = Array.isArray(turns) ? object(turns.at(-1)) : undefined;
          const state = last?.["status"];
          if (
            child?.status === "running" &&
            !active &&
            object(object(result["thread"])["status"])["type"] === "idle" &&
            (state === "completed" || state === "failed" || state === "interrupted") &&
            (child.turnId === undefined || child.turnId === last?.["id"])
          ) {
            child.turnId = text(last?.["id"]);
            child.status = state;
            queue.push({
              type: "agent.updated",
              agent: { id, ...(child.parentId ? { parentId: child.parentId } : {}), status: state },
            });
          }
          pendingSubscriptions--;
          finishIfSettled();
        })
        .catch(fail);
    }
    queue.push({
      type: "agent.updated",
      agent: { id, ...(parentId ? { parentId } : {}), status: "running" },
    });
    const buffered = unattributed.get(id);
    if (buffered) {
      unattributed.delete(id);
      for (const message of buffered) {
        unattributedCount--;
        unattributedBytes -= Buffer.byteLength(JSON.stringify(message));
      }
      if (unattributedCount === 0) {
        clearTimeout(attributionTimer);
        attributionTimer = undefined;
      }
      for (const message of buffered) notification(message);
    }
  };
  let reportedModel: string | undefined;
  const emitUsage = () => {
    const usage = zero();
    let complete = true;
    for (const thread of threads.values()) {
      if (!thread.usage || !thread.baseline) {
        complete = false;
        continue;
      }
      if (!thread.usageComplete) complete = false;
      for (const key of keys) usage[key] += Math.max(0, thread.usage[key] - thread.baseline[key]);
    }
    const costFields = codexCostFields(reportedModel ?? options.model, usage);
    queue.push({
      type: "usage.updated",
      usage: {
        ...usage,
        complete,
        ...costFields,
      },
    });
    if (options.limits?.maxTokens !== undefined && usage.totalTokens >= options.limits.maxTokens) {
      interrupted = true;
      if (rootId && activeTurn)
        void rpc("turn/interrupt", { threadId: rootId, turnId: activeTurn }).catch(fail);
      // Conservative resumed totals can include prior Attempts. They still stop execution,
      // but do not prove this Attempt exhausted its allocation.
      if (!complete) throw new Error("Codex token budget exceeded with unverifiable Attempt usage");
      throw new ExecutionBudgetExceededError("Codex reported token budget exceeded");
    }
    const ceiling = options.limits?.maxTokens;
    if (
      !budgetReminderSent &&
      ceiling !== undefined &&
      usage.totalTokens >= ceiling * 0.8 &&
      ceiling - usage.totalTokens >= 4096 &&
      rootId &&
      activeTurn &&
      turnRequested &&
      !finished
    ) {
      budgetReminderSent = true;
      // Advisory input only: a rejected/late reminder must not invalidate completed
      // work or weaken the independent interrupt-on-report ceiling above.
      void rpc("turn/steer", {
        threadId: rootId,
        expectedTurnId: activeTurn,
        input: [
          {
            type: "text",
            text: `SuperTag budget: ${usage.totalTokens} of ${ceiling} reported tokens; ${ceiling - usage.totalTokens} remain. ${complete ? "Accounting is complete." : "Accounting is conservative and incomplete."} Prioritize required verification and completion using existing evidence; omit optional work. Return your result, without self-review or false completion claims. Limit unchanged; reports may arrive late.`,
          },
        ],
      }).catch(() => {});
    }
  };
  const control = new LocalHarnessExecutionControl({
    taskId: context.attempt.taskId,
    attemptId: context.attempt.attemptId,
    capabilities: { version: 1, inputMode: "steer", operations: ["input", "reply", "interrupt"] },
    authorizeInputAtTake: true,
    dispatch: async (command, signal, authorizeInput) => {
      if (command.type !== "reply" && (!rootId || !activeTurn || finished))
        return { status: "rejected", reason: "Codex has no active turn" };
      if (command.type === "input") {
        const targetTurn = activeTurn;
        // Only input that can fail the Attempt holds finishing; an advisory steer resolves
        // `unknown` later, so waiting on its RPC timeout could only fail a completed turn.
        const holdsFinish = !command.advisory;
        if (holdsFinish) pendingSteers++;
        try {
          const result = await rpc(
            "turn/steer",
            {
              threadId: rootId,
              expectedTurnId: targetTurn,
              input: [{ type: "text", text: command.text }],
            },
            async () => {
              if (authorizeInput && !(await authorizeInput())) return false;
              return !signal.aborted && !finished && !closing && activeTurn === targetTurn;
            },
          );
          if (finished || result["turnId"] !== targetTurn) {
            // Advisory input, such as Team coordination, falls back to a later digest; the
            // completed turn's result stands. Other input may be what the result depends on.
            if (!command.advisory)
              fail(new Error("Codex steer acceptance is uncertain at turn completion"));
            return {
              status: "unknown",
              reason: "Codex turn completed before steering was acknowledged",
            };
          }
          return { status: "accepted" };
        } catch (error) {
          if (error instanceof InputAuthorizationRejected)
            return {
              status: "rejected",
              reason: "Input authority or active turn was revoked before take",
            };
          if (command.advisory)
            return { status: "unknown", reason: "Codex steering was not acknowledged" };
          fail(error);
          throw error;
        } finally {
          if (holdsFinish) {
            pendingSteers--;
            finishIfSettled();
          }
        }
      }
      if (command.type === "interrupt") {
        interrupted = true;
        await rpc("turn/interrupt", { threadId: rootId, turnId: activeTurn });
        return { status: "accepted" };
      }
      const question = questions.get(command.requestId);
      if (!question) return { status: "rejected", reason: "Unknown native question" };
      const answers = object(command.response["answers"]);
      if (
        Object.keys(command.response).some((key) => key !== "answers") ||
        Object.keys(answers).length !== question.ids.size ||
        Object.entries(answers).some(
          ([id, value]) =>
            !question.ids.has(id) ||
            !Array.isArray(object(value)["answers"]) ||
            (object(value)["answers"] as unknown[]).some((answer) => typeof answer !== "string"),
        )
      )
        return { status: "rejected", reason: "Reply must answer the registered question IDs" };
      await write({ id: question.rpcId, result: { answers } });
      questions.delete(command.requestId);
      return { status: "accepted" };
    },
  });
  const serverRequest = async (message: Json) => {
    // Even a rejected tool request makes replay unsafe.
    if (turnRequested) retryFenced = true;
    const method = text(message["method"]),
      params = object(message["params"]);
    const id = message["id"];
    if (typeof id !== "string" && typeof id !== "number")
      throw new Error("Invalid native request identity");
    if (method === "item/tool/call") {
      const threadId = text(params["threadId"]);
      const turnId = text(params["turnId"]);
      if (
        threadId !== rootId ||
        turnId !== activeTurn ||
        threads.get(threadId)?.status !== "running"
      )
        throw new Error("Dynamic tool call does not belong to the active root turn");
      const namespace = text(params["namespace"]);
      const tool = text(params["tool"]);
      const callId = text(params["callId"]);
      if (dynamicCallIds.has(callId)) throw new Error("Duplicate dynamic tool call identity");
      if (dynamicCallIds.size >= 4096) throw new Error("Dynamic tool call identity limit exceeded");
      const dynamic = dynamicToolSets.find((entry) => entry.namespace === namespace);
      if (!dynamic) throw new Error("Unknown dynamic tool namespace");
      const operation = dynamic.input.capability.operations.find((entry) => entry.name === tool);
      if (!operation) throw new Error("Unknown dynamic tool operation");
      if (!isObject(params["arguments"])) throw new Error("Invalid dynamic tool arguments");
      const arguments_ = params["arguments"];
      dynamicCallIds.add(callId);
      const call = describeToolCall([dynamic.input], {
        id: callId,
        binding: { kind: dynamic.input.binding.kind, name: dynamic.input.binding.name },
        operation: operation.name,
        arguments: arguments_,
      });
      queue.push({ type: "tool.call.started", call });
      try {
        const result = dynamicToolResult(await dynamic.connected.callTool(tool, arguments_));
        await write({ id, result });
        queue.push(
          result["success"] === true
            ? { type: "tool.call.completed", call }
            : {
                type: "tool.call.failed",
                call,
                error: { message: "SuperTag coordination operation was rejected" },
              },
        );
      } catch {
        await write({
          id,
          result: {
            contentItems: [{ type: "inputText", text: "SuperTag coordination call failed" }],
            success: false,
          },
        });
        queue.push({
          type: "tool.call.failed",
          call,
          error: { message: "SuperTag coordination operation failed" },
        });
      }
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const requestingThread =
        typeof params["threadId"] === "string" ? threads.get(params["threadId"]) : undefined;
      if (
        requestingThread?.status !== "running" ||
        requestingThread.turnId !== params["turnId"] ||
        questions.size >= 32
      )
        throw new Error("Native question does not belong to a known active turn");
      const items = params["questions"];
      if (
        !Array.isArray(items) ||
        !items.length ||
        items.length > 20 ||
        JSON.stringify(items).length > 32_000
      )
        throw new Error("Invalid native questions");
      const requestId = `codex-question:${typeof id}:${id}`;
      if (questions.has(requestId)) throw new Error("Duplicate native question identity");
      const ids = new Set(items.map((item) => text(object(item)["id"])));
      if (ids.size !== items.length) throw new Error("Duplicate native question IDs");
      questions.set(requestId, { rpcId: id, ids });
      control.registerRequest(requestId);
      queue.push({
        type: "approval.requested",
        request: {
          id: requestId,
          description: "Codex requests clarification",
          data: { kind: "question", questions: items },
        },
      });
      return;
    }
    // These requests ask to exceed the native sandbox, not to exercise already-admitted tools.
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      await write({ id, result: { decision: "decline" } });
      return;
    }
    await write({
      id,
      error: { code: -32601, message: "Native request is not admitted by this Harness" },
    });
  };
  const finishIfSettled = () => {
    if (
      failed ||
      !finished ||
      pendingSubscriptions > 0 ||
      pendingSteers > 0 ||
      unattributedCount > 0 ||
      [...threads.values()].some((thread) => thread.status === "running")
    )
      return;
    // Some app-server versions publish the final counter after turn/completed.
    // Keep the stream open briefly so a terminal notification does not discard it.
    if ([...threads.values()].some((thread) => !thread.usage) && !terminalUsageGraceElapsed) {
      terminalUsageTimer ??= setTimeout(() => {
        terminalUsageGraceElapsed = true;
        terminalUsageTimer = undefined;
        try {
          finishIfSettled();
        } catch (error) {
          fail(error);
        }
      }, 250);
      return;
    }
    clearTimeout(terminalUsageTimer);
    terminalUsageTimer = undefined;
    if (
      options.limits &&
      [...threads.values()].some(
        (thread) => !thread.usage || (!thread.usageComplete && !thread.conservativeBaseline),
      )
    )
      throw new Error("Codex token budget cannot be verified without complete Attempt usage");
    queue.push({ type: "output.message", text: finalText, final: true });
    queue.finish();
  };
  const notification = (message: Json) => {
    const method = text(message["method"]),
      params = object(message["params"]);
    if (turnRequested && (method.startsWith("item/") || method === "thread/tokenUsage/updated"))
      retryFenced = true;
    if (method === "thread/environment/connected" || method === "thread/environment/disconnected") {
      const selected = options.executionEnvironment;
      if (!selected || params["environmentId"] !== selected.environmentId)
        throw new Error("Codex reported an unexpected execution environment");
      if (rootId !== undefined && params["threadId"] !== rootId)
        throw new Error("Codex execution environment belongs to another thread");
      if (method === "thread/environment/disconnected")
        throw new Error("Codex execution environment disconnected");
      return;
    }
    if (method === "thread/started") {
      const thread = object(params["thread"]),
        id = text(thread["id"]);
      reportedModel = reportedCodexModel(thread["model"]) ?? reportedModel;
      const source = object(object(thread["source"])["subAgent"]);
      const sourceParent = object(source["thread_spawn"])["parent_thread_id"];
      const directParent = thread["parentThreadId"];
      if (
        typeof directParent === "string" &&
        typeof sourceParent === "string" &&
        directParent !== sourceParent
      )
        throw new Error("Conflicting Codex child parent identities");
      const parent = directParent ?? sourceParent;
      if (typeof parent === "string") registerThread(id, parent);
      else if (awaitingRoot && rootId === undefined) {
        rootId = id;
        registerThread(id);
      } else if (!threads.has(id)) throw new Error("Unattributed Codex thread notification");
      return;
    }
    const id = params["threadId"];
    if (typeof id !== "string") return;
    const knownThread = threads.get(id);
    if (!knownThread) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      const diagnostic = `Notification from an unattributed Codex thread: ${method.slice(0, 120)} (${id.slice(0, 120)})`;
      if (unattributedCount >= 32 || unattributedBytes + bytes > 262_144)
        throw new Error(`${diagnostic}; attribution buffer limit exceeded`);
      const buffered = unattributed.get(id) ?? [];
      buffered.push(message);
      unattributed.set(id, buffered);
      if (buffered.length === 1) {
        // Read metadata only: the native server must prove lineage before subscription.
        void rpc("thread/read", { threadId: id, includeTurns: false })
          .then((result) => {
            if (!unattributed.has(id)) return;
            const thread = object(result["thread"]);
            if (thread["id"] !== id) throw new Error("Codex returned a different thread identity");
            const sourceParent = object(
              object(object(thread["source"])["subAgent"])["thread_spawn"],
            )["parent_thread_id"];
            const directParent = thread["parentThreadId"];
            if (
              typeof directParent === "string" &&
              typeof sourceParent === "string" &&
              directParent !== sourceParent
            )
              throw new Error("Conflicting Codex child parent identities");
            const parent = directParent ?? sourceParent;
            if (typeof parent !== "string" || !threads.has(parent))
              throw new Error(`${diagnostic}; thread metadata has no known parent`);
            registerThread(id, parent);
          })
          .catch(fail);
      }
      unattributedCount++;
      unattributedBytes += bytes;
      attributionTimer ??= setTimeout(
        () => fail(new Error(`${diagnostic}; attribution timed out`)),
        5000,
      );
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const thread = knownThread;
      const reported = object(object(params["tokenUsage"])["total"]),
        usage = zero();
      for (const key of keys) {
        const value = reported[key];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
          throw new Error("Invalid Codex usage counter");
        usage[key] = value;
      }
      if (!turnRequested) {
        thread.baseline = usage;
        thread.usageComplete = true;
        thread.conservativeBaseline = false;
      }
      if (thread.baseline && keys.some((key) => usage[key] < (thread.baseline?.[key] ?? 0)))
        throw new Error("Codex cumulative usage counters precede the saved baseline");
      if (thread.usage && keys.some((key) => usage[key] < (thread.usage?.[key] ?? 0)))
        throw new Error("Codex cumulative usage counters decreased");
      thread.usage = usage;
      emitUsage();
      finishIfSettled();
      return;
    }
    if (method === "turn/started") {
      reportedModel = reportedCodexModel(object(params["turn"])["model"]) ?? reportedModel;
      const turnId = text(object(params["turn"])["id"]);
      knownThread.turnId = turnId;
      if (id !== rootId) {
        knownThread.status = "running";
        return;
      }
      if (activeTurn && activeTurn !== turnId) throw new Error("Unexpected overlapping Codex turn");
      activeTurn = turnId;
      if (capacityRetries > 0)
        queue.push({ type: "agent.updated", agent: { id, status: "running" } });
      return;
    }
    if (method === "item/agentMessage/delta" && id === rootId) {
      queue.push({ type: "output.delta", text: text(params["delta"], true) });
      return;
    }
    if (method === "item/completed" || method === "item/started") {
      const item = object(params["item"]);
      if (item["type"] === "agentMessage" && id === rootId && method === "item/completed")
        finalText = text(item["text"], true);
      if (item["type"] === "commandExecution") {
        const command = codexCommandText(item["command"]);
        if (command !== undefined)
          queue.push({
            type: "command.updated",
            command: { id: text(item["id"]), command, status: codexCommandStatus(method, item) },
          });
      }
      if (item["type"] === "mcpToolCall") {
        const binding = request.toolInputs.find(
          (input) => input.binding.name === item["server"],
        )?.binding;
        if (!binding) throw new Error("Codex used an unadmitted MCP binding");
        const call = describeToolCall(request.toolInputs, {
          id: text(item["id"]),
          binding: { kind: binding.kind, name: binding.name },
          operation: text(item["tool"]),
          arguments: item["arguments"],
        });
        queue.push(
          method === "item/started"
            ? { type: "tool.call.started", call }
            : item["status"] === "failed"
              ? { type: "tool.call.failed", call, error: { message: "Native MCP tool failed" } }
              : { type: "tool.call.completed", call },
        );
      }
      if (item["type"] === "collabAgentToolCall") {
        const parent = text(item["senderThreadId"]);
        if (parent !== id) throw new Error("Native child sender mismatch");
        const receivers = item["receiverThreadIds"];
        if (!Array.isArray(receivers)) throw new Error("Invalid native child recipients");
        for (const receiver of receivers) {
          const child = text(receiver);
          if (item["tool"] === "spawnAgent") registerThread(child, parent);
          else if (!threads.has(child)) throw new Error("Unattributed native child target");
        }
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = object(params["turn"]),
        status = turn["status"];
      const state =
        status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
      const thread = knownThread;
      thread.status = state;
      queue.push({
        type: "agent.updated",
        agent: { id, ...(thread.parentId ? { parentId: thread.parentId } : {}), status: state },
      });
      if (id !== rootId) {
        finishIfSettled();
        return;
      }
      if (!activeTurn || turn["id"] !== activeTurn)
        throw new Error("Codex completed an unexpected turn");
      // Only an authoritative terminal capacity rejection is safe to retry.
      // Never replay after any item, output, tool request, or usage notification.
      const capacityMessage = object(turn["error"])["message"];
      if (
        status === "failed" &&
        !interrupted &&
        !retryFenced &&
        capacityRetries < 2 &&
        retryTurn &&
        isTransientCapacityError(capacityMessage)
      ) {
        capacityRetries += 1;
        queue.push({
          type: "progress.updated",
          progress: {
            summary: `Provider capacity is temporarily unavailable; retrying request ${capacityRetries} of 2 after ${250 * 2 ** (capacityRetries - 1)} ms.`,
          },
        });
        activeTurn = undefined;
        thread.status = "running";
        void retryTurn().catch(fail);
        return;
      }
      finished = true;
      if (status !== "completed" || interrupted) {
        const providerMessage = object(turn["error"])["message"];
        const detail = typeof providerMessage === "string" ? providerMessage.trim() : "";
        // Do not cut a credential in half before Harness/Worker full-value redaction.
        const safeLengthDetail =
          detail.length > 2048 ? "provider error exceeds 2048 characters" : detail;
        const ErrorType = status === "failed" && !interrupted ? HarnessProviderError : Error;
        throw new ErrorType(
          `Codex turn ${interrupted ? "interrupted" : String(status)}${safeLengthDetail ? `: ${safeLengthDetail}` : ""}`,
        );
      }
      if (!finalText.trim()) throw new Error("Codex completed without an agent response");
      finishIfSettled();
    }
  };
  const pump = (async () => {
    let buffer = "";
    for await (const chunk of process.output ?? []) {
      if (chunk.stream !== "stdout") continue;
      buffer += chunk.text;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 1_048_576) throw new Error("Codex RPC frame exceeds 1 MiB");
        if (line.trim()) {
          const message = object(JSON.parse(line));
          if (typeof message["method"] === "string") {
            // A request may wait on a coordination call; keep reading Codex output meanwhile.
            // Validation and its started event run synchronously, so ordering is preserved.
            if (message["id"] !== undefined) void serverRequest(message).catch(fail);
            else notification(message);
          } else {
            const entry = pending.get(String(message["id"]));
            if (entry) {
              pending.delete(String(message["id"]));
              clearTimeout(entry.timer);
              if (message["error"] !== undefined)
                entry.reject(new Error("Codex RPC rejected the request"));
              else entry.resolve(object(message["result"]));
            }
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer) > 1_048_576) throw new Error("Codex RPC frame exceeds 1 MiB");
    }
    if (buffer.trim()) throw new Error("Codex ended with an incomplete RPC frame");
    if (!closing) throw new Error("Codex app-server disconnected before cleanup");
  })();
  void pump.catch(fail);
  const processDone = process.wait();
  void processDone.then(() => {
    if (!closing) fail(new Error("Codex app-server exited unexpectedly"));
  }, fail);
  const close = () =>
    (closing ??= (async () => {
      notifyClosing();
      clearTimeout(deadlineTimer);
      clearTimeout(terminalUsageTimer);
      clearUnattributed();
      dynamicCallIds.clear();
      await control.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Codex app-server closing"));
      }
      pending.clear();
      await closeCodexResources([
        async () => {
          await process.endInput?.().catch(() => {});
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              processDone.catch((error) => {
                if (error instanceof ExecutionCleanupError) throw error;
              }),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          process.kill();
          await processDone.catch((error) => {
            if (error instanceof ExecutionCleanupError) throw error;
          });
          await pump.catch(() => {});
        },
        ...dynamicToolSets.map(
          ({ connected }) =>
            () =>
              connected.close(),
        ),
      ]);
    })());
  try {
    await rpc("initialize", {
      clientInfo: { name: "supertag", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await write({ method: "initialized", params: {} });
    if (options.executionEnvironment) {
      const selected = options.executionEnvironment;
      await rpc("environment/add", {
        environmentId: selected.environmentId,
        execServerUrl: selected.url,
        connectTimeoutMs: Math.min(request.timeoutMs, 30_000),
      });
      const info = object(await rpc("environment/info", { environmentId: selected.environmentId }));
      const shell = object(info["shell"]);
      if (typeof shell["name"] !== "string" || typeof shell["path"] !== "string")
        throw new Error("Codex exec-server did not report a valid environment identity");
      const status = object(
        await rpc("environment/status", { environmentId: selected.environmentId }),
      );
      if (status["status"] !== "ready")
        throw new Error(
          `Codex exec-server is not ready${typeof status["error"] === "string" ? `: ${status["error"]}` : ""}`,
        );
      if (typeof selected.provenance["execServerSessionId"] !== "string")
        throw new Error("Codex exec-server session identity is unavailable");
    }
    const configuration = await rpc("config/read", {
      cwd: options.executionEnvironment ? environment.rootDirectory : request.workspace,
      includeLayers: true,
    });
    const layers = configuration["layers"];
    if (!Array.isArray(layers)) throw new Error("Codex did not report configuration provenance");
    for (const value of layers) {
      const layer = object(value),
        source = object(layer["name"])["type"];
      if (
        (source === "project" || source === "user") &&
        !layer["disabledReason"] &&
        Object.keys(object(layer["config"])).length > 0
      )
        throw new Error(
          "Codex app-server refuses active project or user configuration; use Worker-owned Harness settings",
        );
    }
    awaitingRoot = true;
    // The resume identity is already validated against the Worker-owned sessionState.
    // Native servers may publish its usage/status before acknowledging resume.
    if (request.resumeThreadId) {
      rootId = request.resumeThreadId;
      registerThread(rootId);
    }
    const sandbox = codexSandboxAllowance(request.sandboxMode, request.runtimeActions);
    const sandboxMode = codexSandboxMode(sandbox);
    const protectedGitDir = options.executionEnvironment
      ? undefined
      : await codexProtectedGitDirectory(request.workspace);
    const result = await rpc(request.resumeThreadId ? "thread/resume" : "thread/start", {
      ...(request.resumeThreadId ? { threadId: request.resumeThreadId } : {}),
      ...(!request.resumeThreadId && dynamicToolSets.length
        ? { dynamicTools: dynamicToolSets.map(dynamicToolSpec) }
        : {}),
      ...(!request.resumeThreadId && options.executionEnvironment
        ? {
            environments: [
              {
                environmentId: options.executionEnvironment.environmentId,
                cwd: options.executionEnvironment.cwd,
                runtimeWorkspaceRoots: [
                  options.executionEnvironment.cwd,
                  ...(request.outputDirectory && request.runtimeActions.includes("files:write")
                    ? [request.outputDirectory]
                    : []),
                  ...(request.scratchDirectory && request.runtimeActions.includes("files:write")
                    ? [request.scratchDirectory]
                    : []),
                ],
              },
            ],
          }
        : {}),
      ...(!request.resumeThreadId ? { cwd: request.workspace } : {}),
      ...(request.model ? { model: request.model } : {}),
      approvalPolicy: "never",
      ...codexThreadConfig(
        request.effort,
        !options.executionEnvironment &&
          request.outputDirectory &&
          request.runtimeActions.includes("files:write")
          ? request.outputDirectory
          : undefined,
        sandbox,
        protectedGitDir,
        request.runtimeActions.includes("files:write") ? request.scratchDirectory : undefined,
      ),
      // A permission profile replaces the legacy sandbox mode; sending both
      // would let the legacy mode override the profile.
      ...(sandboxMode === undefined ? {} : { sandbox: sandboxMode }),
      ephemeral: false,
    });
    const returnedId = text(object(result["thread"])["id"]);
    if (rootId && rootId !== returnedId) throw new Error("Codex returned a different root thread");
    rootId = returnedId;
    registerThread(rootId);
    awaitingRoot = false;
  } catch (error) {
    const primary = executionError(error);
    await closeCodexResources([close], [primary]);
    throw primary;
  }
  return {
    ...(options.executionEnvironment
      ? { provenance: { ...options.executionEnvironment.provenance } }
      : {}),
    get session() {
      return { harnessId: "codex", id: text(rootId) };
    },
    get threadIds() {
      return [...threads.keys()];
    },
    get threadUsage() {
      return Object.fromEntries(
        [...threads].flatMap(([id, thread]) => (thread.usage ? [[id, { ...thread.usage }]] : [])),
      );
    },
    control,
    async *run(signal) {
      if (ran) throw new Error("Codex app-server execution can run only once");
      ran = true;
      const runSignal = signal ? AbortSignal.any([signal, executionSignal]) : executionSignal;
      const abort = () => {
        interrupted = true;
        notifyClosing();
        process.kill();
        fail(runSignal.reason ?? new Error("Codex execution cancelled"));
      };
      runSignal.addEventListener("abort", abort, { once: true });
      let succeeded = false;
      const executionFailures: unknown[] = [];
      try {
        runSignal.throwIfAborted();
        turnRequested = true;
        const startTurn = async () => {
          const retryGeneration = capacityRetries;
          const started = await rpc("turn/start", {
            threadId: rootId,
            input: [{ type: "text", text: request.prompt }],
            ...(options.executionEnvironment
              ? {
                  environments: [
                    {
                      environmentId: options.executionEnvironment.environmentId,
                      cwd: options.executionEnvironment.cwd,
                      runtimeWorkspaceRoots: [
                        options.executionEnvironment.cwd,
                        ...(request.outputDirectory &&
                        request.runtimeActions.includes("files:write")
                          ? [request.outputDirectory]
                          : []),
                        ...(request.scratchDirectory &&
                        request.runtimeActions.includes("files:write")
                          ? [request.scratchDirectory]
                          : []),
                      ],
                    },
                  ],
                }
              : {}),
            ...(request.sandboxMode === "external"
              ? {
                  sandboxPolicy: {
                    type: "externalSandbox",
                    networkAccess: request.externalNetworkAccess ?? "restricted",
                  },
                }
              : {}),
          });
          if (retryGeneration !== capacityRetries) return;
          const returnedTurn = text(object(started["turn"])["id"]);
          if (activeTurn && activeTurn !== returnedTurn)
            throw new Error("Codex returned a different active turn");
          activeTurn = returnedTurn;
        };
        retryTurn = async () => {
          await delay(250 * 2 ** (capacityRetries - 1), undefined, { signal: runSignal });
          runSignal.throwIfAborted();
          if (closing || retryFenced) throw new Error("Codex capacity retry is no longer safe");
          await startTurn();
        };
        await startTurn();
        yield* queue;
        runSignal.throwIfAborted();
        succeeded = true;
      } catch (error) {
        executionFailures.push(error);
        throw error;
      } finally {
        runSignal.removeEventListener("abort", abort);
        if (!succeeded) await closeCodexResources([close], executionFailures);
      }
    },
    close,
  };
}
function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function dynamicToolNamespace(name: string): string {
  if (!DYNAMIC_TOOL_NAME.test(name) || RESERVED_DYNAMIC_TOOL_NAMESPACES.has(name))
    throw new Error(`Invalid manager tool namespace: ${name}`);
  return name;
}
function dynamicToolSpec(dynamic: DynamicToolSet): Json {
  return {
    type: "namespace",
    name: dynamic.namespace,
    description: `${dynamic.input.audience === "manager" ? "Manager-only " : ""}${dynamic.input.capability.provider} operations admitted by SuperTag`,
    tools: dynamic.connected.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    })),
  };
}
function dynamicToolResult(value: unknown): Json {
  const result = object(value);
  const content = Array.isArray(result["content"]) ? result["content"] : [];
  const contentItems = content.flatMap((raw): Json[] => {
    const item = object(raw);
    if (item["type"] === "text" && typeof item["text"] === "string")
      return [{ type: "inputText", text: item["text"] }];
    if (
      item["type"] === "image" &&
      typeof item["data"] === "string" &&
      typeof item["mimeType"] === "string"
    )
      return [{ type: "inputImage", imageUrl: `data:${item["mimeType"]};base64,${item["data"]}` }];
    if (
      item["type"] === "audio" &&
      typeof item["data"] === "string" &&
      typeof item["mimeType"] === "string"
    )
      return [{ type: "inputAudio", audioUrl: `data:${item["mimeType"]};base64,${item["data"]}` }];
    return [];
  });
  if (contentItems.length === 0)
    contentItems.push({
      type: "inputText",
      text:
        result["structuredContent"] === undefined
          ? "SuperTag coordination operation returned no content"
          : JSON.stringify(result["structuredContent"]),
    });
  return { contentItems, success: result["isError"] !== true };
}
function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 65_536)
    throw new Error("Invalid Codex protocol text");
  return value;
}
class EventQueue implements AsyncIterable<HarnessEvent> {
  readonly #items: HarnessEvent[] = [];
  #bytes = 0;
  #done = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;
  push(event: HarnessEvent) {
    if (this.#done) return;
    this.#bytes += JSON.stringify(event).length;
    if (this.#items.length >= 512 || this.#bytes > 4 * 1024 * 1024)
      throw new Error("Codex event queue overflow");
    this.#items.push(event);
    this.#wake?.();
  }
  finish() {
    this.#done = true;
    this.#wake?.();
  }
  fail(error: Error) {
    this.#error = error;
    this.#done = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const event = this.#items.shift();
      if (event) {
        this.#bytes -= JSON.stringify(event).length;
        yield event;
        continue;
      }
      if (this.#error) throw this.#error;
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

/** Cleanup failure must retain the execution error that led us here. */
async function closeCodexResources(
  resources: readonly (() => Promise<void>)[],
  executionFailures: readonly unknown[] = [],
): Promise<void> {
  const results = await Promise.allSettled(resources.map((close) => Promise.resolve().then(close)));
  const cleanupFailures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (!cleanupFailures.length) return;
  const failures = [...executionFailures, ...cleanupFailures];
  throw new ExecutionCleanupError(
    `Codex cleanup failed: ${failures.map((error) => (error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown failure")).join("; ")}`,
    { cause: new AggregateError(failures, "Codex execution and cleanup failures") },
  );
}

/**
 * Thread configuration: the reasoning effort, and Attempt directories Codex may write.
 * Under the loopback permission profile these directories are profile
 * filesystem entry, because the profile ignores `sandbox_workspace_write`.
 */
export function codexThreadConfig(
  effort: "low" | "medium" | "high" | undefined,
  writableRoot: string | undefined,
  sandbox?: CodexSandboxAllowance,
  protectedGitDir?: string,
  scratchDirectory?: string,
): { readonly config?: Readonly<Record<string, unknown>> } {
  const profile = sandbox?.permissionProfile;
  const config: Record<string, unknown> = {
    ...(effort === undefined ? {} : { model_reasoning_effort: effort }),
    ...(profile === undefined
      ? writableRoot === undefined && scratchDirectory === undefined
        ? {}
        : {
            "sandbox_workspace_write.writable_roots": [writableRoot, scratchDirectory].filter(
              (path): path is string => path !== undefined,
            ),
          }
      : writableRoot === undefined &&
          protectedGitDir === undefined &&
          scratchDirectory === undefined
        ? {}
        : {
            [`permissions.${profile}.filesystem`]: {
              ...(writableRoot === undefined ? {} : { [writableRoot]: "write" }),
              ...(scratchDirectory === undefined ? {} : { [scratchDirectory]: "write" }),
              ...(protectedGitDir === undefined ? {} : { [protectedGitDir]: "read" }),
            },
          }),
  };
  return Object.keys(config).length === 0 ? {} : { config };
}

function isTransientCapacityError(message: unknown): boolean {
  if (typeof message !== "string") return false;
  if (
    /usage limit|rate[ -]?limit|quota|billing|credit|authenticat|invalid key|\b429\b/i.test(message)
  )
    return false;
  return /(?:selected model|model|provider|server) (?:is )?(?:temporarily )?(?:at |over )capacity|capacity (?:exceeded|temporarily unavailable|is full|has been reached)/i.test(
    message,
  );
}

/** No bytes were written for this input. Other queued RPCs remain usable. */
class InputAuthorizationRejected extends Error {}
