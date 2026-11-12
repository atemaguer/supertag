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
import { ClaudeProcessTree } from "../process-tree.js";
import { ClaudeLiveInput, claudeQuery, isClaudeFinalResult } from "../query.js";
import { ClaudeSessionStore, readClaudeTranscripts } from "../session-store.js";
import { claudeUsageTracker } from "../usage.js";
import { captureCheckpoint, redact, restoreCheckpoint } from "./checkpoint.js";
import { harnessClient, receipt } from "./client.js";
import {
  COORDINATION_PREFIX,
  COORDINATION_SERVER,
  coordinationTools,
  validCoordinationArguments,
  WORKSTREAM_POST_ACTION,
} from "./coordination.js";
import { CREDENTIAL_KEYS, nativeEnvironment } from "./environment.js";
import {
  type AdapterBootstrap,
  LiveInputReceipt,
  TaskState,
} from "./gen/supertag/runtime/v2/runtime_pb.js";

const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "files:read": ["Read", "Glob", "Grep"],
  "files:write": ["Write", "Edit"],
  "web:search": ["WebSearch"],
  "web:fetch": ["WebFetch"],
  [WORKSTREAM_POST_ACTION]: [],
};

export class UnsupportedPermissionError extends Error {}
class SafeAdapterFailure extends Error {}

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

async function withinWorkspace(cwd: string, path: unknown): Promise<boolean> {
  if (typeof path !== "string" || path.includes("\0")) return false;
  const target = resolve(cwd, path);
  const inside = (value: string) => {
    const part = relative(cwd, value);
    return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
  };
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
): HookCallback {
  return async (hook) => {
    if (hook.hook_event_name !== "PreToolUse") return {};
    let allowed = !signal.aborted && tools.includes(hook.tool_name) && hook.agent_id === undefined;
    if (allowed && hook.tool_name.startsWith(COORDINATION_PREFIX)) {
      allowed =
        hook.mcp_server?.source === "sdk" &&
        hook.mcp_server.name === COORDINATION_SERVER &&
        validCoordinationArguments(hook.tool_name, hook.tool_input);
    }
    if (allowed && ["Read", "Write", "Edit", "Glob", "Grep"].includes(hook.tool_name)) {
      const input = hook.tool_input as Record<string, unknown>;
      const path = ["Read", "Write", "Edit"].includes(hook.tool_name)
        ? input["file_path"]
        : (input["path"] ?? cwd);
      allowed = await withinWorkspace(cwd, path);
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
          : "Outside the accepted Task permissions or workspace",
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
  let usageSequence = 0n;
  const live = new ClaudeLiveInput();
  let polling: Promise<void> | undefined;
  let stopPolling = false;
  let completionProposed = false;
  let backgroundError: unknown;
  let phase = "configuration";
  const pendingSettlements: Promise<unknown>[] = [];
  try {
    if (task.policySnapshot?.contextSets.some((set) => set.items.some((item) => item.required)))
      throw new SafeAdapterFailure(
        "Claude has no resolver for a required Context Item. Native execution did not start.",
      );
    const tools = admittedTools(task.allowedActions);
    const model = task.policySnapshot?.execution?.models[0] ?? configuration.model;
    const coordination = coordinationTools(harness, run, {
      taskId: task.taskId,
      tagId: task.tagId,
      attemptId: run.attemptId,
      secrets,
      signal: controller.signal,
      active: () => !finalSeen,
    });
    const allowedTools = [...tools, ...coordination.tools];
    const { env, cwd } = await nativeEnvironment(environment);
    phase = "checkpoint validation";
    const restored = restoreCheckpoint(run.checkpoint, task, cwd);
    nativeSessionId = restored?.nativeSessionId;
    const store = new ClaudeSessionStore(
      async (_session, transcripts) => {
        readClaudeTranscripts(transcripts);
      },
      restored?.transcripts,
      [],
    );
    const usage = claudeUsageTracker();
    phase = "process supervision";
    tree = await ClaudeProcessTree.prepare();
    const ownedTree = tree;
    const sdkOptions: Options = {
      cwd,
      tools,
      allowedTools,
      disallowedTools: ["Agent", "Task", "Skill", "TaskOutput", "TaskStop"],
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [],
      plugins: [],
      strictMcpConfig: true,
      mcpServers: coordination.servers,
      settings: { syncClaudeAiSkills: false, syncClaudeAiPlugins: false },
      systemPrompt: task.instructions,
      env,
      stderr: () => {},
      includePartialMessages: true,
      sessionStore: store,
      sessionStoreFlush: "eager",
      hooks: { PreToolUse: [{ hooks: [permissionHook(allowedTools, cwd, controller.signal)] }] },
      ...(restored ? { resume: restored.nativeSessionId } : {}),
      ...(configuration.executable ? { pathToClaudeCodeExecutable: configuration.executable } : {}),
      ...(model ? { model } : {}),
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
    for await (const message of claudeQuery(query, task.prompt, sdkOptions, controller.signal, {
      input: live,
      drainMs: 500,
      exitMs: 5000,
    })) {
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
      if (totals) {
        const sequence = ++usageSequence;
        const nativeUsage = {
          inputTokens: BigInt(totals.inputTokens + (totals.cachedInputTokens ?? 0)),
          cachedInputTokens: BigInt(totals.cachedInputTokens ?? 0),
          outputTokens: BigInt(totals.outputTokens),
          ...(observedModel(message) ? { observedModel: observedModel(message) } : {}),
        };
        await receipt(() => client.reportUsage({ sequence, nativeUsage }, options()));
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
        if (message.subtype !== "success" || message.is_error)
          throw new SafeAdapterFailure(nativeFailure(message));
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
    const checkpoint = captureCheckpoint(task, nativeSessionId, store.snapshot(), secrets);
    const outcome = {
      result,
      succeeded: true,
      checkpoint,
      waitingApprovalIds: await coordination.waitingApprovalIds(),
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
