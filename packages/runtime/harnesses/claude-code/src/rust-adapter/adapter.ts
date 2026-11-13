import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type HookCallback,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ExecutionCleanupError } from "@supertag/worker-sdk";
import {
  type AdapterBootstrap,
  ExecutionLimitEnforcement,
  type ExecutionLimits,
  harnessClient,
  LiveInputReceipt,
  receipt,
  redact,
  TaskState,
} from "@supertag/worker-sdk/internal/rust-harness";
import { ClaudeProcessTree } from "../process-tree.js";
import {
  type ClaudeProgressItem,
  claudeApiRetryProgress,
  claudeTaskProgress,
} from "../progress.js";
import { ClaudeLiveInput, claudeQuery, isClaudeFinalResult } from "../query.js";
import { ClaudeSessionStore, readClaudeTranscripts } from "../session-store.js";
import { claudeUsageTracker } from "../usage.js";
import { captureCheckpoint, restoreCheckpoint, resumedCostUsd, validUsd } from "./checkpoint.js";
import {
  COORDINATION_PREFIX,
  COORDINATION_SERVER,
  coordinationTools,
  validCoordinationArguments,
  WORKSTREAM_POST_ACTION,
} from "./coordination.js";
import { CREDENTIAL_KEYS, nativeEnvironment } from "./environment.js";
import { taskMcpTools } from "./mcp.js";
import { selectSkills, stageSkills } from "./skills.js";

const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "files:read": ["Read", "Glob", "Grep"],
  "files:write": ["Write", "Edit"],
  "web:search": ["WebSearch"],
  "web:fetch": ["WebFetch"],
  [WORKSTREAM_POST_ACTION]: [],
  "mailbox:send": [],
};

export class UnsupportedPermissionError extends Error {}
class SafeAdapterFailure extends Error {}

function acceptedBudgetUsd(limits: ExecutionLimits | undefined): number | undefined {
  if (limits?.maxReportedTokens !== undefined || limits?.maxNativeAgents !== undefined)
    throw new SafeAdapterFailure(
      "Claude does not support the accepted token or native agent limit. Native execution did not start.",
    );
  const cost = limits?.maxReportedCost;
  if (!cost) return undefined;
  if (cost.currency !== "USD" || cost.amountMinor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SafeAdapterFailure(
      "Claude requires an accepted USD budget in its supported range. Native execution did not start.",
    );
  if (cost.amountMinor === 0n)
    throw new SafeAdapterFailure(
      "Claude reported USD budget is zero. Native execution did not start.",
    );
  return Number(cost.amountMinor) / 100;
}

export function admittedTools(actions: readonly string[]): string[] {
  if (actions.includes("commands:execute"))
    throw new UnsupportedPermissionError(
      "Claude commands:execute is unsupported until its native sandbox policy is verified.",
    );
  if (actions.some((action) => !Object.hasOwn(ACTIONS, action)))
    throw new UnsupportedPermissionError(
      "Claude does not support one of the accepted allowed actions.",
    );
  return [...new Set(actions.flatMap((action) => ACTIONS[action] ?? []))];
}

async function withinRoots(cwd: string, path: unknown, roots: readonly string[]): Promise<boolean> {
  if (typeof path !== "string" || path.includes("\0")) return false;
  const target = resolve(cwd, path);
  const inside = (value: string) =>
    roots.some((root) => {
      const part = relative(root, value);
      return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
    });
  if (!inside(target)) return false;
  let existing = target;
  for (;;) {
    try {
      return inside(await realpath(existing));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === dirname(existing))
        return false;
      // realpath also returns ENOENT for a dangling symlink. Such a link must not be
      // treated as a new ordinary file inside the workspace.
      try {
        if ((await lstat(existing)).isSymbolicLink()) return false;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      existing = dirname(existing);
    }
  }
}

export function permissionHook(
  tools: readonly string[],
  cwd: string,
  signal: AbortSignal,
  skills: ReadonlySet<string> = new Set(),
  skillRoots: readonly string[] = [],
  mcpToolServers: ReadonlyMap<string, string> = new Map(),
): HookCallback {
  return async (hook) => {
    if (hook.hook_event_name !== "PreToolUse") return {};
    let allowed = !signal.aborted && tools.includes(hook.tool_name) && hook.agent_id === undefined;
    if (allowed && hook.tool_name === "Skill") {
      const input = hook.tool_input;
      allowed =
        input !== null &&
        typeof input === "object" &&
        "skill" in input &&
        typeof input.skill === "string" &&
        skills.has(input.skill);
    }
    if (allowed && hook.tool_name.startsWith(COORDINATION_PREFIX)) {
      allowed =
        hook.mcp_server?.source === "sdk" &&
        hook.mcp_server.name === COORDINATION_SERVER &&
        validCoordinationArguments(hook.tool_name, hook.tool_input);
    } else if (allowed && hook.tool_name.startsWith("mcp__")) {
      const server = mcpToolServers.get(hook.tool_name);
      allowed =
        server !== undefined &&
        hook.mcp_server?.source === "sdk" &&
        hook.mcp_server.name === server;
    }
    if (allowed && ["Read", "Write", "Edit", "Glob", "Grep"].includes(hook.tool_name)) {
      const input = hook.tool_input as Record<string, unknown>;
      const path = ["Read", "Write", "Edit"].includes(hook.tool_name)
        ? input["file_path"]
        : (input["path"] ?? cwd);
      const writes = hook.tool_name === "Write" || hook.tool_name === "Edit";
      allowed = await withinRoots(cwd, path, writes ? [cwd] : [cwd, ...skillRoots]);
      if (allowed && ["Glob", "Grep"].includes(hook.tool_name)) {
        const pattern = input[hook.tool_name === "Glob" ? "pattern" : "glob"];
        if (
          typeof pattern === "string" &&
          (isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))
        )
          allowed = false;
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allowed ? "allow" : "deny",
        permissionDecisionReason: allowed
          ? "Accepted Task permission"
          : "Outside the accepted Task permissions or allowed paths",
      },
    };
  };
}

export interface AdapterOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

function verifiedSkillQuery(names: ReadonlySet<string>): typeof query {
  if (!names.size) return query;
  return ({ prompt, options }) => {
    if (typeof prompt === "string") throw new Error("Skill verification requires a prompt stream");
    const gate = Promise.withResolvers<void>();
    const execution = query({
      prompt: (async function* () {
        await gate.promise;
        yield* prompt;
      })(),
      options: { ...options, pluginDelivery: "initialize" },
    });
    const refuse = () => {
      gate.reject(new Error("Claude could not verify the admitted native Skills"));
      options?.abortController?.abort();
    };
    void gate.promise.catch(() => {});
    void execution.initializationResult().then((result) => {
      const commands = new Set(result.commands?.map(({ name }) => name));
      if (
        result.plugins_applied !== true ||
        result.hooks_applied === false ||
        [...names].some((name) => !commands.has(name))
      ) {
        refuse();
        return;
      }
      gate.resolve();
    }, refuse);
    return execution;
  };
}

/** Normal Node application boundary: the native SDK remains the vendor implementation. */
export async function runAdapter(
  bootstrap: AdapterBootstrap,
  signal: AbortSignal,
  configuration: AdapterOptions = {},
) {
  const harness = harnessClient(bootstrap.endpoint, bootstrap.token);
  const { client, options } = harness;
  const run = await receipt(() => client.attach({}, options()));
  const task = run.task;
  if (
    !task ||
    task.state !== TaskState.RUNNING ||
    !run.attemptId ||
    task.attemptId !== run.attemptId
  )
    throw new Error("Harness did not return the active owned Attempt");
  const environment = configuration.environment ?? process.env;
  const secrets = [
    bootstrap.token,
    ...CREDENTIAL_KEYS.flatMap((key) => (environment[key] ? [environment[key]] : [])),
  ];
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Claude execution stopped"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, configuration.timeoutMs ?? 600_000);
  let tree: ClaudeProcessTree | undefined;
  let started = false;
  let finalSeen = false;
  let result: string | undefined;
  let nativeSessionId: string | undefined;
  let mirrorFailed = false;
  let eventSequence = 0n;
  const progressItems = new Map<string, ClaudeProgressItem>();
  let nativeUsageSequence = 0n;
  let costOnlySequence = 0n;
  let lastTotalCostUsd: number | undefined;
  let observedNativeUsage = false;
  const live = new ClaudeLiveInput();
  let polling: Promise<void> | undefined;
  let stopPolling = false;
  let completionProposed = false;
  let backgroundError: unknown;
  let phase = "configuration";
  const pendingSettlements: Promise<unknown>[] = [];
  try {
    const maxBudgetUsd = acceptedBudgetUsd(task.executionLimits);
    let selected: ReturnType<typeof selectSkills>;
    try {
      selected = selectSkills(task, run.resolvedSkills);
    } catch {
      throw new SafeAdapterFailure(
        "Claude could not verify a required Context Item or delivered Skill. Native execution did not start.",
      );
    }
    const tools = admittedTools(task.allowedActions);
    const model = task.attemptExecution
      ? task.attemptExecution.selection?.model
      : (task.policySnapshot?.execution?.models[0] ?? configuration.model);
    const effort = task.attemptExecution?.selection?.effort;
    const validEffort = effort === "low" || effort === "medium" || effort === "high";
    if (effort !== undefined && !validEffort)
      throw new SafeAdapterFailure("Claude received an invalid reasoning effort.");
    phase = "MCP tool preparation";
    const mcp = await taskMcpTools(harness, task, controller.signal, () => !finalSeen, secrets);
    const coordination = coordinationTools(harness, run, {
      taskId: task.taskId,
      tagId: task.tagId,
      attemptId: run.attemptId,
      secrets,
      signal: controller.signal,
      active: () => !finalSeen,
      nativeSessionId: () => nativeSessionId,
      hasPendingExternalApprovals: mcp.hasPendingApprovals,
    });
    const { env, cwd } = await nativeEnvironment(environment, task.outputPolicy?.directory);
    phase = "Skill preparation";
    const { plugins, names, roots } = await stageSkills(
      selected,
      env["CLAUDE_CONFIG_DIR"] ?? "",
      controller.signal,
    );
    if (names.size > 0) tools.push("Skill");
    const allowedTools = [...tools, ...coordination.tools, ...mcp.toolServers.keys()];
    phase = "checkpoint validation";
    const restored = restoreCheckpoint(run.checkpoint, task, cwd);
    nativeSessionId = restored?.nativeSessionId;
    let costBaseline: number | undefined;
    try {
      costBaseline = resumedCostUsd(restored);
    } catch {
      if (maxBudgetUsd !== undefined)
        throw new SafeAdapterFailure(
          "Claude budget could not verify the resumed cost baseline. Native execution did not start.",
        );
    }
    const store = new ClaudeSessionStore(
      async (_session, transcripts) => {
        readClaudeTranscripts(transcripts);
      },
      restored?.transcripts,
      [],
    );
    const usage = claudeUsageTracker();
    if (maxBudgetUsd !== undefined) {
      await receipt(() =>
        client.confirmExecutionLimits(
          {
            limits: task.executionLimits,
            reportedCost: ExecutionLimitEnforcement.PROVIDER_BUDGET,
          },
          options(),
        ),
      );
    }
    phase = "process supervision";
    tree = await ClaudeProcessTree.prepare();
    const ownedTree = tree;
    const sdkOptions: Options = {
      cwd,
      tools,
      allowedTools,
      disallowedTools: [
        "Agent",
        "Task",
        "TaskOutput",
        "TaskStop",
        ...(names.size ? [] : ["Skill"]),
      ],
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [...names],
      plugins,
      strictMcpConfig: true,
      mcpServers: { ...coordination.servers, ...mcp.servers },
      settings: {
        syncClaudeAiSkills: false,
        syncClaudeAiPlugins: false,
        disableSkillShellExecution: true,
      },
      systemPrompt: task.instructions,
      env,
      stderr: () => {},
      includePartialMessages: true,
      sessionStore: store,
      sessionStoreFlush: "eager",
      hooks: {
        PreToolUse: [
          {
            hooks: [
              permissionHook(allowedTools, cwd, controller.signal, names, roots, mcp.toolServers),
            ],
          },
        ],
      },
      ...(restored ? { resume: restored.nativeSessionId } : {}),
      ...(configuration.executable ? { pathToClaudeCodeExecutable: configuration.executable } : {}),
      ...(model ? { model } : {}),
      ...(validEffort ? { effort } : {}),
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      spawnClaudeCodeProcess: (spawnOptions) => {
        // Keep the native leader in the Rust Guardian's process group. SDK env may contain
        // ambient process.env, so discard it and forward only our selected provider config.
        const nativeConfig = spawnOptions.env["CLAUDE_CONFIG_DIR"];
        // SessionStore resume materializes an SDK-owned temporary config and changes this one
        // env key. Validate that private directory, otherwise the resumed transcript is lost.
        if (nativeConfig !== env["CLAUDE_CONFIG_DIR"]) {
          if (
            !restored ||
            !nativeConfig ||
            !/^claude-resume-[a-f0-9-]{36}$/.test(basename(nativeConfig)) ||
            realpathSync(dirname(nativeConfig)) !== realpathSync(tmpdir())
          )
            throw new Error("Untrusted SDK resume directory");
          const stat = lstatSync(nativeConfig);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (stat.mode & 0o077) !== 0 ||
            (process.getuid && stat.uid !== process.getuid())
          )
            throw new Error("Unsafe SDK resume directory");
        }
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd,
          env: {
            ...env,
            CLAUDE_CONFIG_DIR: nativeConfig,
            SUPERTAG_INTERNAL_PROCESS_MARKER: ownedTree.marker,
          },
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        started = true;
        if (child.pid)
          ownedTree.start(child.pid, () => child.exitCode === null && child.signalCode === null);
        child.stderr.resume();
        return child;
      },
    };
    const settle = (inputId: string, status: LiveInputReceipt) =>
      receipt(() => client.settleLiveInput({ inputId, receipt: status }, options()));
    const poll = async () => {
      while (!stopPolling && !controller.signal.aborted && !finalSeen) {
        const begin = performance.now();
        const taken = await receipt(() => client.takeLiveInput({}, options()));
        if (taken.input) {
          const deadline = begin + Number(taken.validForMs);
          const inputId = taken.input.inputId;
          const status = await live.send(taken.input.text, controller.signal, {
            authorizeInput: async () =>
              !controller.signal.aborted && !finalSeen && performance.now() < deadline,
            onWithdrawn: () => {
              pendingSettlements.push(
                settle(inputId, LiveInputReceipt.WITHDRAWN).catch((error: unknown) => {
                  backgroundError ??= error;
                  controller.abort(error);
                }),
              );
            },
          });
          await settle(
            inputId,
            status === "accepted"
              ? LiveInputReceipt.ACCEPTED
              : status === "rejected"
                ? LiveInputReceipt.REJECTED
                : LiveInputReceipt.UNKNOWN,
          );
        } else await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    phase = "native SDK execution";
    for await (const message of claudeQuery(
      verifiedSkillQuery(names),
      task.prompt,
      sdkOptions,
      controller.signal,
      {
        input: live,
        drainMs: 500,
        exitMs: 5000,
      },
    )) {
      if ("session_id" in message && typeof message.session_id === "string" && message.session_id) {
        if (nativeSessionId && nativeSessionId !== message.session_id)
          throw new Error("Claude changed the approved native Session");
        nativeSessionId = message.session_id;
        await store.observeSession(nativeSessionId);
      }
      if (!polling && message.type === "system" && message.subtype === "init")
        polling = poll().catch((error: unknown) => {
          backgroundError ??= error;
          controller.abort(error);
        });
      if (message.type === "system" && message.subtype === "mirror_error") mirrorFailed = true;
      const totals = usage(message);
      const rawCost = message.type === "result" ? message.total_cost_usd : undefined;
      const currentCostUsd =
        validUsd(rawCost) && costBaseline !== undefined && rawCost >= costBaseline
          ? rawCost - costBaseline
          : undefined;
      if (currentCostUsd !== undefined) lastTotalCostUsd = rawCost;
      const hasNativeUsage: boolean =
        totals !== undefined &&
        (observedNativeUsage ||
          message.type === "assistant" ||
          (message.type === "result" && message.usage !== undefined));
      observedNativeUsage ||= hasNativeUsage;
      if (hasNativeUsage || currentCostUsd !== undefined) {
        const sequence = hasNativeUsage ? ++nativeUsageSequence : ++costOnlySequence;
        const nativeUsage =
          hasNativeUsage && totals
            ? {
                inputTokens: BigInt(totals.inputTokens + (totals.cachedInputTokens ?? 0)),
                cachedInputTokens: BigInt(totals.cachedInputTokens ?? 0),
                outputTokens: BigInt(totals.outputTokens),
                totalTokens: BigInt(totals.totalTokens),
                ...(observedModel(message) ? { observedModel: observedModel(message) } : {}),
              }
            : undefined;
        await receipt(() =>
          client.reportUsage(
            {
              sequence,
              nativeUsage,
              ...(currentCostUsd !== undefined
                ? { amountMinor: BigInt(Math.round(currentCostUsd * 100)), currency: "USD" }
                : {}),
            },
            options(),
          ),
        );
      }
      if (maxBudgetUsd !== undefined && currentCostUsd !== undefined) {
        // Subtract native lifetime totals before rounding to minor units.
        // Permit only floating-point subtraction noise at the exact boundary.
        const roundingNoise = Math.min(1e-9, Number.EPSILON * Math.max(1, Math.abs(rawCost ?? 0)));
        if (currentCostUsd - maxBudgetUsd > roundingNoise)
          throw new SafeAdapterFailure("Claude reported USD budget exceeded.");
      }
      // Background tasks and API retries reach the surface as `progress.updated` Task events,
      // as the TypeScript Worker yields them. A progress event too large for one Task event is
      // skipped: progress is cosmetic and never fails the Attempt.
      for (const progress of [
        claudeApiRetryProgress(message),
        claudeTaskProgress(message, progressItems),
      ]) {
        if (progress === undefined) continue;
        const safe = (text: string) => redact(text, secrets).replaceAll("\0", "");
        const event = JSON.stringify({
          type: "progress.updated",
          progress: {
            summary: safe(progress.summary),
            ...(progress.items
              ? { items: progress.items.map((item) => ({ ...item, text: safe(item.text) })) }
              : {}),
          },
        });
        if (Buffer.byteLength(event) > 16000) continue;
        const sequence = ++eventSequence;
        await receipt(() => client.publish({ sequence, text: event }, options()));
      }
      if (message.type === "assistant") {
        const text = message.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const safe = redact(text, secrets).replaceAll("\0", "");
        if (safe)
          for (const chunk of utf8Chunks(safe, 16000)) {
            const sequence = ++eventSequence;
            await receipt(() => client.publish({ sequence, text: chunk }, options()));
          }
      }
      if (isClaudeFinalResult(message) && message.type === "result") {
        finalSeen = true;
        if (message.subtype === "error_max_budget_usd")
          throw new SafeAdapterFailure("Claude reported USD budget exceeded.");
        if (message.subtype !== "success" || message.is_error)
          throw new SafeAdapterFailure(nativeFailure(message));
        if (maxBudgetUsd !== undefined && currentCostUsd === undefined)
          throw new SafeAdapterFailure("Claude budget could not verify reported USD usage.");
        result = redact(message.result, secrets).replaceAll("\0", "");
      }
    }
    stopPolling = true;
    await polling;
    await Promise.all(pendingSettlements);
    if (backgroundError)
      throw new SafeAdapterFailure("Claude live-input receipt could not be confirmed.");
    // Complete is never sent before both native SDK shutdown and descendant confirmation.
    await stopTree(tree);
    tree = undefined;
    phase = "session mirroring";
    await store.flush();
    if (mirrorFailed)
      throw new SafeAdapterFailure("Claude session mirroring failed. No checkpoint was accepted.");
    if (!finalSeen || !result)
      throw new SafeAdapterFailure("Claude ended without a successful final response.");
    if (!nativeSessionId)
      throw new SafeAdapterFailure("Claude ended without a native Session identity.");
    if (Buffer.byteLength(result) > 262144) throw new Error("Claude result exceeds its limit");
    phase = "checkpoint capture";
    const checkpoint = captureCheckpoint(
      task,
      nativeSessionId,
      store.snapshot(),
      secrets,
      lastTotalCostUsd,
    );
    const outcome = {
      result,
      succeeded: true,
      checkpoint,
      waitingApprovalIds: [
        ...new Set([
          ...(await coordination.waitingApprovalIds()),
          ...(await mcp.waitingApprovalIds()),
        ]),
      ].sort(),
    };
    completionProposed = true;
    await receipt(() => client.complete(outcome, options()));
  } catch (error) {
    const wasStopped = controller.signal.aborted;
    stopPolling = true;
    controller.abort();
    await polling?.catch(() => {});
    await Promise.allSettled(pendingSettlements);
    if (tree) {
      try {
        await stopTree(tree);
        tree = undefined;
      } catch (cause) {
        throw new ExecutionCleanupError("Claude process cleanup is unconfirmed", { cause });
      }
    }
    if (error instanceof ExecutionCleanupError) throw error;
    if (completionProposed) throw error;
    // Provider failures can contain credentials. Only this fixed description crosses Harness.
    const failure =
      error instanceof UnsupportedPermissionError || error instanceof SafeAdapterFailure
        ? error.message
        : !started
          ? `Claude ${phase} failed. Native execution did not start.`
          : wasStopped
            ? "Claude execution stopped. No checkpoint was accepted."
            : `Claude ${phase} failed. No checkpoint was accepted.`;
    await receipt(() => client.complete({ succeeded: false, result: failure }, options()));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    tree?.close();
  }
}

async function stopTree(tree: ClaudeProcessTree) {
  const deadline = Date.now() + 5000;
  try {
    await tree.terminate(deadline);
    await tree.confirm(deadline);
  } finally {
    tree.close();
  }
}

function observedModel(message: SDKMessage): string | undefined {
  return message.type === "assistant" ? message.message.model : undefined;
}

function nativeFailure(message: SDKMessage): string {
  const text = JSON.stringify(message).toLowerCase();
  if (/not logged in|authentication|invalid.api.key|oauth|please.*login|credentials/.test(text))
    return "Claude native authentication failed.";
  if (/rate.limit|overloaded/.test(text))
    return "Claude native provider capacity limit was reached.";
  if (/budget|max.turns/.test(text)) return "Claude native execution limit was reached.";
  return "Claude native result reported execution failure.";
}

function* utf8Chunks(text: string, bytes: number): Generator<string> {
  let chunk = "";
  let length = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (length + size > bytes) {
      yield chunk;
      chunk = "";
      length = 0;
    }
    chunk += character;
    length += size;
  }
  if (chunk) yield chunk;
}
