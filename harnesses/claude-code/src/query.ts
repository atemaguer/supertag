import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  HookCallback,
  HookJSONOutput,
  Options,
  query,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { ExecutionCleanupError } from "@supertag/worker-sdk";
import { ClaudeProcessTree } from "./process-tree.js";

const MAX_CHECK_INS = 3;

/** Outcome of offering one message to a query's open prompt stream. */
export type ClaudeLiveInputStatus = "accepted" | "rejected" | "unknown";

type PeerOrigin = Extract<NonNullable<SDKUserMessage["origin"]>, { kind: "peer" }>;

export interface ClaudeLiveSendOptions {
  /**
   * Called at most once, after `send` resolved `accepted`, when the model never read the input:
   * the Attempt's final result came first and Claude Code was stopped. The caller then treats
   * the input as not delivered.
   */
  readonly onWithdrawn?: () => void;
  /**
   * Checked when the Agent SDK requests this input from the prompt stream, just before it is
   * written to Claude Code. `false` rejects the input without exposing its text.
   */
  readonly authorizeInput?: () => Promise<boolean>;
  /**
   * The stored sender of teammate input. Not yet written to Claude Code: see `userMessage`.
   */
  readonly origin?: PeerOrigin;
}

type ClaudeLivePush = (
  text: string,
  signal?: AbortSignal,
  options?: ClaudeLiveSendOptions,
) => Promise<ClaudeLiveInputStatus>;

/**
 * Live input for the queries of one Attempt, bound by at most one running query at a time.
 * `send` resolves `accepted` only after the Agent SDK has taken the message from the prompt
 * stream and asked for the next one, and Claude Code has produced output, so the process that
 * reads it exists. It resolves `rejected` when the message was never handed over, including
 * when `signal` aborts while the message still waits in the stream. It resolves `unknown` when
 * the stream ends between handoff and confirmation, including a final result during the write.
 */
export class ClaudeLiveInput {
  #push: ClaudeLivePush | undefined;
  #authorizesAtTake = false;

  send(
    text: string,
    signal?: AbortSignal,
    options?: ClaudeLiveSendOptions,
  ): Promise<ClaudeLiveInputStatus> {
    if (options?.authorizeInput && !this.#authorizesAtTake) return Promise.resolve("rejected");
    return this.#push ? this.#push(text, signal, options) : Promise.resolve("rejected");
  }

  bind(push: ClaudeLivePush, authorizesAtTake = false): () => void {
    if (this.#push) throw new Error("Claude live input is already bound to a query");
    this.#push = push;
    this.#authorizesAtTake = authorizesAtTake;
    return () => {
      if (this.#push === push) this.#push = undefined;
    };
  }
}

export interface ClaudeQueryOptions {
  /** How long a cancelled query lets Claude Code finish its turn before it ends the process. */
  readonly drainMs?: number;
  /**
   * How long Claude Code may take to exit after the final result or after it is told to stop,
   * before it and its descendants are killed with SIGKILL, and how long process inventory
   * and termination confirmation may take. Unconfirmed termination fails cleanup without
   * publishing the result.
   */
  readonly exitMs?: number;
  /** Worker receipt gate, called synchronously before the SDK can delay result delivery. */
  readonly claimFinalResponse?: () => boolean;
  readonly checkInMs?: number;
  readonly input?: ClaudeLiveInput;
}

interface PendingInput {
  readonly message: SDKUserMessage;
  readonly authorizeInput?: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly settle?: (status: ClaudeLiveInputStatus) => void;
  readonly withdraw?: () => void;
}

const finalResults = new WeakSet<SDKMessage>();

/**
 * Whether a result is the Attempt's final one: received before cancellation, with no background
 * work running. The query ends only after confirmed cleanup. Later output cannot change the outcome.
 */
export function isClaudeFinalResult(message: SDKMessage): boolean {
  return finalResults.has(message);
}

// The message stream is part of the process contract: preserve normal completion while a
// cancellation request drains, then enforce process termination if it does not.
export async function* claudeQuery(
  run: typeof query,
  prompt: string,
  options: Options,
  signal: AbortSignal,
  {
    drainMs = 5_000,
    exitMs = 10_000,
    checkInMs = 30 * 60_000,
    input: live,
    claimFinalResponse,
  }: ClaudeQueryOptions = {},
): AsyncIterable<SDKMessage> {
  signal.throwIfAborted();
  const processController = new AbortController();
  // Claude Code kills background subagents and commands when a turn ends with its input closed.
  // Keep input open until a turn has ended with none running; each one that finishes starts a
  // new turn, whose result is checked again.
  //
  // Check-ins bound how long background work can hold input open, as Claude Code's /goal does.
  // Once a turn has ended with background work still running, a check-in turn is sent after the
  // current interval, asking the model to inspect that work and stop anything stuck. Model
  // activity cancels a pending check-in, and the next turn that ends with background work still
  // running schedules one again. Each interval doubles the previous one, capped at four times the
  // first, and never resets within the query. After three check-ins, the next interval that
  // elapses while background work still holds the session idle closes input instead: Claude Code
  // ends the turn and stops that work, and the Attempt ends normally.
  //
  // Live input (Harness control `input`, mode `queue`) joins the same stream while input is open.
  // Claude Code queues it and the model reads it at its next turn boundary: between tool calls,
  // or as a new turn once the current one has ended. Each live message carries a client uuid,
  // and Claude Code stamps the replies of the turn that read it with that uuid.
  //
  // The final result, one whose turn ended with no background work running, ends live input:
  // input not yet taken is rejected, so it waits for a later activation's digest. If Claude Code
  // holds taken input or a check-in that no reply names yet, it would answer it in a new turn with
  // tools, whose failure or edits would follow the Attempt's real result. Instead the process is
  // killed, and the query waits for it to exit, before that result is yielded; the query ends
  // with it. Unconfirmed writes resolve unknown, and accepted input is withdrawn, so both
  // fall back to the digest. `isClaudeFinalResult` marks the final result.
  //
  // After the final result the query only waits for Claude Code to exit, since anything it does
  // then, such as a turn a Stop hook continues or a SessionEnd hook, could edit the Task worktree
  // that SuperTag commits once the Attempt ends. Its PreToolUse hooks deny every tool, root or
  // subagent. Any message other than passive session state kills the process and is not passed
  // on; only a mirror failure is, since it decides whether the session can resume. A process that
  // hasn't exited `exitMs` after the final result is killed too. Descendant tracking includes
  // detached shells and reparented children. The final result is passed on when it arrives, so
  // a cancellation after it cannot discard it, but the stream ends only once the leader has exited
  // and inventory confirms cleanup. Unknown ownership or inspection failure then throws
  // ExecutionCleanupError, which fails the Attempt despite its final result.
  const pending: PendingInput[] = [];
  // Live input taken before Claude Code produced any output. A resumed query buffers writes until
  // it spawns the process, so taking input proves delivery only once the process has spoken.
  const unconfirmed: PendingInput[] = [];
  // Taken live input and check-ins, by uuid, until a reply names them.
  const unanswered = new Map<string, PendingInput>();
  // Live input written to the SDK whose next request, confirming the write, has not come yet.
  let handedOver: PendingInput | undefined;
  let started = false;
  // Whether the final result has been seen.
  let final = false;
  let finalMessage: SDKMessage | undefined;
  let finalExitDeadline = 0;
  let mirrorError: SDKMessage | undefined;
  // The SDK dispatches hooks without waiting for our message consumer. Track finality on
  // stdout too, before the SDK can read a later hook request (even in the same chunk).
  let finalOnRead = false;
  let finalBeforeCancellation = false;
  let backgroundOnRead = false;
  let observedOutput: Readable | undefined;
  const claimResult = (message: SDKMessage) => {
    if (signal.aborted) return false;
    // Errors never produce final output. An empty resumed turn may be retried by the harness;
    // it must not consume the Worker's one claim before the actual response arrives.
    if (
      message.type !== "result" ||
      message.subtype !== "success" ||
      message.is_error === true ||
      !message.result?.trim()
    )
      return true;
    return claimFinalResponse?.() ?? true;
  };
  const observe = (message: SDKMessage) => {
    if (finalOnRead) return;
    if (message.type === "system" && message.subtype === "background_tasks_changed")
      backgroundOnRead = message.tasks.some((task) => !task.ambient);
    else if (message.type === "result" && !backgroundOnRead) {
      finalOnRead = true;
      finalBeforeCancellation = claimResult(message);
    }
  };
  let closed = false;
  let wake = () => {};
  let checkInTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelCheckIn = () => {
    clearTimeout(checkInTimer);
    checkInTimer = undefined;
  };
  const closeInput = () => {
    closed = true;
    cancelCheckIn();
    for (const entry of pending.splice(0)) entry.settle?.("rejected");
    wake();
  };
  async function* input(): AsyncIterable<SDKUserMessage> {
    try {
      yield userMessage(prompt);
      while (!closed) {
        const entry = pending.shift();
        if (entry) {
          // Check only when the SDK requests the next input, never when it joins our queue. The
          // final result closes input meanwhile, so a check still running then rejects the input.
          if (
            entry.authorizeInput &&
            (!(await entry.authorizeInput()) || closed || entry.signal?.aborted)
          ) {
            entry.settle?.("rejected");
            continue;
          }
          if (entry.message.uuid) unanswered.set(entry.message.uuid, entry);
          handedOver = entry;
          yield entry.message;
          // The SDK asks for the next message only after writing this one to Claude Code.
          handedOver = undefined;
          if (!entry.settle) continue;
          if (started) entry.settle("accepted");
          else unconfirmed.push(entry);
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } finally {
      handedOver?.settle?.("unknown");
      handedOver = undefined;
    }
  }
  const unbindInput = live?.bind(
    (text, abort, sendOptions) =>
      new Promise<ClaudeLiveInputStatus>((resolve) => {
        if (closed || abort?.aborted) {
          resolve("rejected");
          return;
        }
        // Input withdrawn before the SDK takes it is removed, so it can never arrive later.
        const withdraw = () => {
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1);
          entry.settle?.("rejected");
        };
        const entry: PendingInput = {
          message: userMessage(text, true),
          ...(sendOptions?.authorizeInput ? { authorizeInput: sendOptions.authorizeInput } : {}),
          ...(abort ? { signal: abort } : {}),
          settle: (status) => {
            abort?.removeEventListener("abort", withdraw);
            resolve(status);
          },
          ...(sendOptions?.onWithdrawn ? { withdraw: sendOptions.onWithdrawn } : {}),
        };
        abort?.addEventListener("abort", withdraw, { once: true });
        pending.push(entry);
        wake();
      }),
    true,
  );
  // Live non-ambient background tasks by ID, with their descriptions.
  const background = new Map<string, string>();
  let idle = false;
  let checkIns = 0;
  let interval = checkInMs;
  const scheduleCheckIn = () => {
    if (closed || checkInTimer !== undefined) return;
    const waited = interval;
    checkInTimer = setTimeout(() => {
      checkInTimer = undefined;
      if (checkIns >= MAX_CHECK_INS) {
        closeInput();
        return;
      }
      checkIns++;
      interval = Math.min(interval * 2, checkInMs * 4);
      // A uuid lets a reply name it, like live input, so one left unread at the final result
      // stops Claude Code too.
      pending.push({
        message: {
          ...userMessage(checkInPrompt([...background.values()], waited)),
          uuid: randomUUID(),
        },
      });
      wake();
    }, waited);
    checkInTimer.unref?.();
  };
  // The Claude Code process, so SuperTag can stop it and wait for its exit itself: aborting the
  // SDK's controller only ends stdin and signals the process seconds later, and the SDK stops
  // waiting for its exit about two seconds after that.
  let child: SpawnedProcess | undefined;
  // Inventory belongs only to our local launcher; custom launchers own their supervision.
  let tree: ClaudeProcessTree | undefined;
  let preparationError: unknown;
  if (!options.spawnClaudeCodeProcess) {
    try {
      tree = await boundedCleanup(ClaudeProcessTree.prepare(), exitMs);
    } catch (error) {
      preparationError = error;
    }
  }
  let exited: Promise<void> = Promise.resolve();
  let stderrTail = "";
  const spawnProcess =
    options.spawnClaudeCodeProcess ??
    ((spawnOptions: SpawnOptions) => {
      if (!tree)
        throw new ExecutionCleanupError("Claude Code process inventory is unavailable", {
          cause: preparationError,
          hostUnsafe: false,
        });
      const spawned = spawnClaudeCode(
        {
          ...spawnOptions,
          env: { ...spawnOptions.env, SUPERTAG_INTERNAL_PROCESS_MARKER: tree.marker },
        },
        (text) => {
          stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL_CHARACTERS);
          options.stderr?.(text);
        },
      );
      if (spawned.pid) tree.start(spawned.pid, () => !hasExited(spawned));
      return spawned;
    });
  // PreToolUse hooks run in this process before any root or subagent tool, so they deny every
  // tool once the final result exists, whatever the Agent SDK still lets Claude Code do.
  const guard =
    (hook: HookCallback): HookCallback =>
    async (...args) => {
      if (final || finalOnRead) return DENY_AFTER_FINAL;
      const decision = await hook(...args);
      // A hook already in flight must not return an allow after the result arrives either.
      return final || finalOnRead ? DENY_AFTER_FINAL : decision;
    };
  // Whether the process exited within `ms`.
  const exitWithin = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  let ending: Promise<void> | undefined;
  // A group disappearing proves nothing about detached shells or double forks. Stop the
  // leader through its live ChildProcess handle; signal descendants only by checked identity.
  // Never signal a negative PID: an exited leader's PGID may already belong to another Task.
  const endProcess = (graceMs: number) =>
    (ending ??= (async () => {
      const running = child;
      if (!running) {
        tree?.close();
        return;
      }
      let killAttempted = false;
      const killLeader = () => {
        if (killAttempted || hasExited(running)) return;
        killAttempted = true;
        running.kill("SIGKILL");
      };
      try {
        if (graceMs > 0) await exitWithin(graceMs);
        const deadline = Date.now() + exitMs;
        await boundedCleanup(
          (async () => {
            try {
              if (tree) {
                if (!hasExited(running)) running.kill("SIGSTOP");
                await tree.terminate(deadline);
              }
            } finally {
              // Inspection failure must still stop the process whose handle we own.
              killLeader();
            }
            if (!(await exitWithin(Math.max(0, deadline - Date.now()))))
              throw new Error("Timed out waiting for Claude Code to exit");
            await tree?.confirm(deadline);
          })(),
          exitMs,
        );
      } catch (cause) {
        try {
          killLeader();
        } catch {}
        throw new ExecutionCleanupError("Claude Code process termination could not be confirmed", {
          cause,
        });
      } finally {
        tree?.close();
      }
    })());
  let execution: ReturnType<typeof query>;
  try {
    execution = run({
      prompt: input(),
      options: {
        ...options,
        abortController: processController,
        hooks: {
          ...options.hooks,
          // The last matcher has no tool pattern, so it covers every tool.
          PreToolUse: [
            ...(options.hooks?.PreToolUse ?? []).map((matcher) => ({
              ...matcher,
              hooks: matcher.hooks.map(guard),
            })),
            { hooks: [guard(async () => ({}))] },
          ],
        },
        spawnClaudeCodeProcess: (spawnOptions) => {
          const spawned = spawnProcess(spawnOptions);
          child = spawned;
          exited = hasExited(spawned)
            ? Promise.resolve()
            : new Promise((resolve) => spawned.once("exit", () => resolve()));
          observedOutput = Readable.from(observeClaudeOutput(spawned.stdout, observe), {
            objectMode: false,
          });
          spawned.stdout = observedOutput;
          return spawned;
        },
      },
    });
  } catch (error) {
    closeInput();
    unbindInput?.();
    await endProcess(0);
    throw error;
  }
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let abandonTimer: ReturnType<typeof setTimeout> | undefined;
  let abandon = () => {};
  let abandonFailed = (_error: unknown) => {};
  const abandoned = new Promise<"abandoned">((resolve, reject) => {
    abandon = () => resolve("abandoned");
    abandonFailed = reject;
  });
  // Cleanup can finish while the consumer is paused at an earlier message.
  void abandoned.catch(() => {});
  // Kills the process `exitMs` from now unless the query has ended, then stops waiting for its
  // stream: a process with running background subagents can keep it open.
  const abandonAfterExitMs = () => {
    if (abandonTimer !== undefined) return;
    abandonTimer = setTimeout(() => void endProcess(0).then(abandon, abandonFailed), exitMs);
    abandonTimer.unref?.();
  };
  const stop = () => {
    if (final || finalOnRead) return;
    closeInput();
    drainTimer = setTimeout(() => {
      processController.abort(signal.reason);
      abandonAfterExitMs();
    }, drainMs);
    // Older or custom SDK implementations may not support graceful interruption.
    void Promise.resolve()
      .then(() => execution.interrupt())
      .catch(() => processController.abort(signal.reason));
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const iterator = execution[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const next = await Promise.race([
        iterator.next().catch((error: unknown) => {
          // A later SDK failure cannot replace the final result, but cleanup still must pass.
          if (final) return { done: true as const, value: undefined };
          throw withStderr(error, stderrTail);
        }),
        abandoned,
      ]);
      if (next === "abandoned") {
        if (!final) signal.throwIfAborted();
        break;
      }
      if (next.done) {
        finished = true;
        break;
      }
      const message = next.value;
      if (final) {
        // A mirror failure decides whether the session can resume; passive session state is
        // dropped. Anything else is Claude Code still at work, so it is stopped.
        if (message.type === "system" && message.subtype === "mirror_error") mirrorError = message;
        else if (!isPassiveAfterFinal(message)) {
          await endProcess(0);
          break;
        }
        continue;
      }
      if (!started) {
        started = true;
        for (const entry of unconfirmed.splice(0)) entry.settle?.("accepted");
      }
      if (message.type === "system" && message.subtype === "background_tasks_changed") {
        background.clear();
        for (const task of message.tasks)
          if (!task.ambient) background.set(task.task_id, task.description);
      } else if (message.type === "result") {
        idle = true;
      } else if (message.type === "assistant") {
        idle = false;
        for (const uuid of message.user_message_uuids ?? [message.user_message_uuid])
          if (uuid !== undefined) unanswered.delete(uuid);
      }
      if (idle && background.size === 0) {
        // The Attempt's work is done; a result now is its final one.
        closeInput();
        if (message.type === "result") {
          finalMessage = message;
          // Cancellation after receipt cannot discard the result while shutdown completes.
          if (!finalOnRead) {
            finalOnRead = true;
            finalBeforeCancellation = claimResult(message);
          }
          finalExitDeadline = Date.now() + exitMs;
          final = true;
          clearTimeout(drainTimer);
          if (unanswered.size > 0 || handedOver !== undefined || unconfirmed.length > 0) {
            // Claude Code would answer taken input in a new turn: stop it before that starts.
            // Stopping signals the process at once; the stream awaits its exit after the result,
            // so a cancellation during that wait arrives after the result and cannot discard it.
            void endProcess(0).catch(() => {});
            processController.abort(new Error("Claude Code session ended at the final result"));
            // Unconfirmed writes can already be persisted in the opaque native transcript.
            // Preserve their uncertainty so no caller promotes it alongside the next digest.
            const notConfirmed = [...unconfirmed.splice(0), ...(handedOver ? [handedOver] : [])];
            handedOver = undefined;
            for (const entry of notConfirmed) {
              if (entry.message.uuid) unanswered.delete(entry.message.uuid);
              entry.settle?.("unknown");
            }
            for (const entry of unanswered.values()) entry.withdraw?.();
            unanswered.clear();
            if (finalBeforeCancellation) finalResults.add(message);
            yield message;
            break;
          }
          // Claude Code now exits on its own; one that doesn't is stopped.
          abandonAfterExitMs();
          // Pass the result on when it arrives, so a later cancellation cannot discard it. The
          // stream still ends only after confirmed cleanup, and cleanup failure throws then.
          if (finalBeforeCancellation) finalResults.add(message);
          yield message;
          continue;
        }
      } else if (!idle) cancelCheckIn();
      // Each result starts a new idle period; one whose check-in already fired has none pending.
      else if (message.type === "result") scheduleCheckIn();
      yield message;
      if (signal.aborted && message.type === "result") return;
    }
    await endProcess(final ? Math.max(0, finalExitDeadline - Date.now()) : exitMs);
    // Preserve ordering: this failure concerns only transcript entries after the result.
    if (finalMessage && mirrorError) yield mirrorError;
  } finally {
    unbindInput?.();
    closeInput();
    handedOver?.settle?.("unknown");
    for (const entry of unconfirmed.splice(0)) entry.settle?.("unknown");
    signal.removeEventListener("abort", stop);
    clearTimeout(drainTimer);
    clearTimeout(abandonTimer);
    // Release an unfinished stream, as a for-await loop would when its consumer stops early.
    if (!finished)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => {});
    // Also terminate a still-running process when the consumer rejects a message.
    processController.abort(signal.reason);
    // Nothing the process does may outlive the query.
    try {
      await endProcess(exitMs);
    } finally {
      observedOutput?.destroy();
    }
  }
}

/** Inspect complete wire messages before forwarding their bytes to the SDK's hook dispatcher. */
export async function* observeClaudeOutput(
  output: Readable,
  observe: (message: SDKMessage) => void,
): AsyncIterable<Buffer | string> {
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  const inspect = (text: string) => {
    let start = 0;
    for (;;) {
      // Search only the new chunk. Join a fragmented line once, when it is complete.
      const end = text.indexOf("\n", start);
      if (end === -1) {
        if (start < text.length) pending.push(text.slice(start));
        return;
      }
      pending.push(text.slice(start, end));
      const line = pending.join("");
      pending = [];
      start = end + 1;
      let message: SDKMessage;
      try {
        message = JSON.parse(line);
      } catch {
        // The SDK ignores non-JSON stdout. Forward it unchanged for its diagnostics.
        continue;
      }
      if (message && typeof message === "object") observe(message);
    }
  };
  for await (const chunk of output) {
    inspect(typeof chunk === "string" ? chunk : decoder.write(chunk));
    yield chunk;
  }
  // Like the SDK's readline reader, accept a last line without a trailing newline.
  inspect(`${decoder.end()}\n`);
}

const STDERR_TAIL_CHARACTERS = 2_048;

// Keep Claude Code in a separate session. Cleanup uses process identities, since its Bash
// tools and hooks create their own sessions and are not contained by this group.
const PROCESS_GROUPS = process.platform !== "win32";

const DENY_AFTER_FINAL = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "This Attempt has its final result; no more tools run.",
  },
} as const satisfies HookJSONOutput;

// Session state Claude Code reports while it shuts down, which involves no model or tool work.
const PASSIVE_AFTER_FINAL = new Set([
  "session_state_changed",
  "files_persisted",
  "worker_shutting_down",
]);

function isPassiveAfterFinal(message: SDKMessage): boolean {
  return (
    message.type === "rate_limit_event" ||
    (message.type === "system" && PASSIVE_AFTER_FINAL.has(message.subtype))
  );
}

function hasExited(process: SpawnedProcess): boolean {
  return process.exitCode !== null || (process.signalCode ?? null) !== null;
}

/** Spawns Claude Code as the Agent SDK's own local spawn does, keeping the process handle. */
function spawnClaudeCode(
  { command, args, cwd, env, signal }: SpawnOptions,
  onStderr: (text: string) => void,
): SpawnedProcess & { readonly pid?: number | undefined } {
  const child = spawn(command, args, {
    cwd,
    env,
    signal,
    stdio: ["pipe", "pipe", "pipe"],
    detached: PROCESS_GROUPS,
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", onStderr);
  child.stderr.on("error", () => {});
  return child;
}

/** A custom spawn gets no stderr in the SDK's exit errors; add the tail it would have shown. */
function withStderr(error: unknown, stderrTail: string): unknown {
  const tail = stderrTail.trim();
  if (
    tail &&
    error instanceof Error &&
    /^Claude Code process (exited with code|terminated by signal)/.test(error.message) &&
    !error.message.includes(". stderr: ")
  )
    error.message = `${error.message}. stderr: ${tail}`;
  return error;
}

function userMessage(content: string, live = false): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    // CLI 2.1.280 has a native peer-input path with a gate that can hold/refuse input,
    // marks it isMeta, and excludes meta input from queued-message UUID attribution.
    // A stdin write cannot acknowledge that path. Keep the Control Plane's labelled,
    // untrusted Team envelope, but omit native origin until the CLI exposes a usable receipt.
    // Live input is delivered as written: no slash-command dispatch or `@path` expansion. Its
    // uuid lets replies name the input they answer.
    ...(live
      ? { priority: "next" as const, client_composed: true as const, uuid: randomUUID() }
      : {}),
  };
}

function checkInPrompt(tasks: string[], waitedMs: number): string {
  const minutes = Math.round(waitedMs / 60_000);
  const waited =
    minutes >= 1
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : `${Math.round(waitedMs / 1_000)} seconds`;
  return [
    `SuperTag check-in: background work has kept this session waiting for ${waited}. Still running:`,
    ...tasks.map((task) => `- ${task}`),
    "",
    "Read each task's output. Keep waiting for any that are making progress, and fix or stop any " +
      "that are stuck. If background work still holds this session after repeated check-ins, the " +
      "Attempt ends and stops it. Work that must outlive this Attempt belongs in SuperTag Tasks.",
  ].join("\n");
}

/** Bound inventory operations too: an inspection that stalls is not proof of cleanup. */
async function boundedCleanup<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code process cleanup timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
