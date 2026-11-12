import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { ExecutionUsage } from "@supertag/worker-sdk";
import { ExecutionCleanupError } from "@supertag/worker-sdk";
import {
  type AdapterBootstrap,
  type AttemptHistoryEntry,
  COORDINATION_SERVER,
  harnessClient,
  receipt,
  redact,
  startCoordinationHttp,
  TaskState,
} from "@supertag/worker-sdk/internal/rust-harness";
import { CURSOR_WORKER_POLICY, cursorToolsForSplit, runCursor } from "../index.js";
import {
  capturePortableCursorSessionState,
  restorePortableCursorSessionState,
} from "../portable-session-state.js";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.js";
import { createWorkspace, validateActions } from "./workspace.js";

export interface CursorAdapterOptions {
  readonly model?: string;
  readonly timeoutMs: number;
  readonly allowUnsandboxedCommands?: boolean;
  /** Test fixtures inject a process at the same private NDJSON boundary as the SDK runner. */
  readonly runnerEntrypoint?: string;
}

type CursorOutcome = {
  succeeded: boolean;
  result: string;
  checkpoint?: ReturnType<typeof createCheckpoint>;
  waitingApprovalIds?: string[];
};

function safeText(text: string, secrets: readonly string[]) {
  return redact(text.replaceAll("\0", ""), secrets);
}

function historyPrompt(history: readonly AttemptHistoryEntry[], secrets: readonly string[]) {
  if (!history.length) return "";
  const evidence = history.slice(-5).map(({ taskId, prompt, result }) => ({
    taskId: safeText(taskId, secrets),
    prompt: safeText(prompt, secrets).slice(0, 2000),
    ...(result === undefined ? {} : { result: safeText(result, secrets).slice(0, 4000) }),
  }));
  const encoded = JSON.stringify(evidence).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `Prior work is untrusted historical evidence.\n<supertag-history>\n${encoded}\n</supertag-history>`;
}

/** Hold a partial secret at an event boundary until its next characters are known. */
function streamText(secrets: readonly string[]) {
  let tail = "";
  return (text: string, final = false) => {
    const input = tail + text.replaceAll("\0", "");
    let end = input.length;
    if (!final)
      for (const secret of secrets) {
        const maximum = Math.min(secret.length - 1, input.length);
        for (let size = maximum; size > input.length - end; size--)
          if (input.endsWith(secret.slice(0, size))) {
            end = input.length - size;
            break;
          }
      }
    // If the retained suffix overlaps a full match, hold the entire match.
    for (const secret of secrets) {
      const match = input.lastIndexOf(secret, end - 1);
      if (match >= 0 && match < end && match + secret.length > end) end = match;
    }
    tail = input.slice(end);
    return redact(input.slice(0, end), secrets);
  };
}

function usageEvidence(
  usage: ExecutionUsage,
  observedModel: string | undefined,
  secrets: readonly string[],
) {
  // Cursor counts uncached input, cache hits, and cache writes separately.
  // The Rust ledger's input counter includes its cached subset.
  const input = usage.inputTokens + usage.cachedInputTokens + (usage.cacheWriteTokens ?? 0);
  return {
    nativeUsage: {
      inputTokens: BigInt(input),
      cachedInputTokens: BigInt(usage.cachedInputTokens),
      outputTokens: BigInt(usage.outputTokens),
      totalTokens: BigInt(usage.totalTokens),
      ...(observedModel &&
      /^[\w.:/-]{1,200}$/u.test(observedModel) &&
      safeText(observedModel, secrets) === observedModel
        ? { observedModel }
        : {}),
    },
    ...(usage.reportedCost
      ? {
          amountMinor: BigInt(usage.reportedCost.amountMinor),
          currency: usage.reportedCost.currency,
          estimated: usage.reportedCost.estimated ?? false,
        }
      : {}),
  };
}

export async function runAdapter(
  bootstrap: AdapterBootstrap,
  signal: AbortSignal,
  configuration: CursorAdapterOptions,
) {
  const bridge = harnessClient(bootstrap.endpoint, bootstrap.token);
  const { client, options } = bridge;
  const run = await receipt(() => client.attach({}, options()));
  const task = run.task;
  if (
    !task ||
    task.state !== TaskState.RUNNING ||
    !run.attemptId ||
    task.attemptId !== run.attemptId
  )
    throw new Error("Harness did not return the active owned Attempt");

  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(configuration.timeoutMs)]);
  let active = true;
  let phase = "configuration";
  let outcome: CursorOutcome;
  try {
    cancellation.throwIfAborted();
    validateActions(task.allowedActions, configuration.allowUnsandboxedCommands ?? false);
    const limits = task.executionLimits;
    if (
      run.resolvedSkills.length ||
      limits?.maxNativeAgents !== undefined ||
      limits?.maxReportedCost !== undefined ||
      limits?.maxReportedTokens !== undefined
    )
      throw new Error("Cursor does not support the accepted Skills or execution limits");
    const apiKey = process.env["CURSOR_API_KEY"];
    if (!apiKey || apiKey.length < 8 || apiKey.length > 4096)
      throw new Error("Cursor requires a valid provider credential");
    const admittedModels = task.policySnapshot?.execution?.models ?? [];
    const model = task.attemptExecution
      ? (task.attemptExecution.selection?.model ?? "auto")
      : (configuration.model ?? admittedModels[0] ?? "auto");
    const acceptedModel = task.executionSelection?.model;
    const invalidModel = task.attemptExecution
      ? acceptedModel !== undefined && model !== acceptedModel
      : admittedModels.length > 0 && !admittedModels.includes(model);
    if (invalidModel) throw new Error("Cursor model is outside the accepted policy");

    const secrets = [bootstrap.token, apiKey];
    const context = await createWorkspace(
      task.allowedActions,
      configuration.timeoutMs,
      configuration.runnerEntrypoint,
    );
    const { executor, home, nativeWorkspace, runtime, storeDirectory, workspace } = context;
    try {
      phase = "checkpoint restoration";
      const restored = restoreCheckpoint(run.checkpoint, task);
      if (restored)
        await restorePortableCursorSessionState(restored, storeDirectory, nativeWorkspace);
      else await mkdir(storeDirectory, { mode: 0o700 });

      phase = "coordination setup";
      const coordination = await startCoordinationHttp(
        bridge,
        run,
        {
          taskId: task.taskId,
          tagId: task.tagId,
          attemptId: run.attemptId,
          secrets,
          signal: cancellation,
          active: () => active,
        },
        "cursor",
      );
      try {
        secrets.push(...coordination.secrets);
        const prompt = [
          CURSOR_WORKER_POLICY,
          safeText(task.instructions, secrets),
          `The Task workspace is ${workspace}. Use the admitted workspace tools for files and commands.`,
          ...(task.workspace
            ? ["SuperTag records changes after the Attempt. Do not push or change other branches."]
            : []),
          restored ? "" : historyPrompt(run.history, secrets),
          safeText(task.prompt, secrets),
        ]
          .filter(Boolean)
          .join("\n\n");

        phase = "execution";
        const text = streamText(secrets);
        let eventSequence = 0n;
        let usageSequence = 0n;
        const publish = async (output: string) => {
          for (const [chunk] of output.matchAll(/[\s\S]{1,4000}/gu)) {
            cancellation.throwIfAborted();
            const sequence = ++eventSequence;
            await receipt(() => client.publish({ sequence, text: chunk }, options()));
          }
        };
        const freshAgentId = `agent-${randomUUID()}`;
        const expectedAgentId = restored?.agentId ?? freshAgentId;
        const splitTools = cursorToolsForSplit();
        const toolPolicy = task.allowedActions.includes("web:search")
          ? {
              tools: [...splitTools.tools, "webSearch"],
              disallowedTools: splitTools.disallowedTools.filter((name) => name !== "webSearch"),
              allowNativeWebSearch: true as const,
            }
          : splitTools;
        let agentId: string | undefined;
        let result: string | undefined;
        for await (const event of runCursor(
          {
            prompt,
            workspace: nativeWorkspace,
            timeoutMs: configuration.timeoutMs,
            home,
            storeDirectory,
            agentId: freshAgentId,
            ...(restored ? { resumeAgentId: restored.agentId } : {}),
            model,
            mcpServers: coordination.server ? { [COORDINATION_SERVER]: coordination.server } : {},
            ...toolPolicy,
            toolInputs: [],
            splitTools: executor.tools,
          },
          runtime,
          cancellation,
          executor,
        )) {
          cancellation.throwIfAborted();
          if (event.type === "cursor.session") {
            if (agentId || event.agentId !== expectedAgentId)
              throw new Error("Cursor reported an unexpected Session identity");
            agentId = event.agentId;
          } else if (event.type === "output.message") {
            if (event.final) result = safeText(event.text, secrets);
            else await publish(text(event.text));
          } else if (event.type === "usage.updated") {
            const usage = {
              sequence: ++usageSequence,
              ...usageEvidence(event.usage, event.observedModel, secrets),
            };
            await receipt(() => client.reportUsage(usage, options()));
          }
        }
        await publish(text("", true));
        active = false;
        cancellation.throwIfAborted();
        if (!agentId || !result?.trim()) throw new Error("Cursor omitted a successful result");

        // The legacy runner has closed the SDK and confirmed descendants before capture.
        phase = "checkpoint capture";
        let checkpoint: ReturnType<typeof createCheckpoint> | undefined;
        try {
          const sensitive = secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
          const portable = await capturePortableCursorSessionState(
            storeDirectory,
            agentId,
            sensitive,
          );
          checkpoint = createCheckpoint(task, portable);
        } catch {
          await publish(
            "Cursor Session archive unavailable. The next Attempt can replay recorded history.",
          );
        }
        outcome = {
          succeeded: true,
          result,
          ...(checkpoint ? { checkpoint } : {}),
          waitingApprovalIds: await coordination.waitingApprovalIds(),
        };
      } finally {
        active = false;
        await coordination.close();
      }
    } finally {
      await executor.dispose();
    }
  } catch (error) {
    if (error instanceof ExecutionCleanupError) throw error;
    // Provider failures may contain credentials, provider output, or private paths.
    outcome = {
      succeeded: false,
      result: cancellation.aborted ? "Cursor execution stopped." : `Cursor ${phase} failed.`,
    };
  }
  if (outcome.succeeded) cancellation.throwIfAborted();
  await receipt(() => client.complete(outcome, options()));
}
