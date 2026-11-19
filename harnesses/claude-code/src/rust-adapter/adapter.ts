import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type HookCallback,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ExecutionCleanupError } from "@supertag/worker-sdk";
import {
  type AdapterBootstrap,
  describeDenial,
  ExecutionLimitEnforcement,
  type ExecutionLimits,
  type FileScopeLike,
  FileScopeRules,
  fileScopeOf,
  fileScopeRefusal,
  harnessClient,
  LiveInputReceipt,
  NetworkRules,
  type NetworkScopeLike,
  networkCredentials,
  networkHostNames,
  networkScopeOf,
  type OutsideDirectories,
  receipt,
  redact,
  resolveOutsideDirectories,
  sessionRecap,
  TaskEventKind,
  TaskState,
  TURN_GUIDANCE,
  tagPortfolio,
  withObjectiveReport,
  workerHostFailure,
} from "@supertag/worker-sdk/internal/rust-harness";
import { claudeToolActivity, streamedText } from "../activity.js";
import { ClaudeProcessTree } from "../process-tree.js";
import {
  type ClaudeProgressItem,
  claudeApiRetryProgress,
  claudeTaskProgress,
} from "../progress.js";
import { ClaudeLiveInput, claudeQuery, isClaudeFinalResult } from "../query.js";
import { ClaudeSessionStore, readClaudeTranscripts } from "../session-store.js";
import { claudeUsageTracker } from "../usage.js";
import {
  captureCheckpoint,
  restoreCheckpoint,
  resumable,
  resumedCostUsd,
  validUsd,
} from "./checkpoint.js";
import {
  COORDINATION_PREFIX,
  COORDINATION_SERVER,
  coordinationTools,
  validCoordinationArguments,
  WORKSTREAM_POST_ACTION,
} from "./coordination.js";
import { CREDENTIAL_KEYS, nativeEnvironment } from "./environment.js";
import { taskMcpTools } from "./mcp.js";
import { REMOTE_WORKSPACE_SERVER, remoteWorkspaceTools } from "./remote.js";
import { selectSkills, stageSkills } from "./skills.js";

const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "files:read": ["Read", "Glob", "Grep"],
  "files:write": ["Write", "Edit"],
  "web:search": ["WebSearch"],
  "web:fetch": ["WebFetch"],
  [WORKSTREAM_POST_ACTION]: [],
  "mailbox:send": [],
  // Offers the `schedule` coordination tools, not a native tool.
  "schedule:create": [],
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

/**
 * Claude Code runs `Bash` as the Worker Host's user, without an operating-system sandbox, and
 * SuperTag provides none. `commands:execute` therefore needs the host's explicit
 * allow-unsandboxed-commands opt-in.
 */
export function admittedTools(
  actions: readonly string[],
  allowUnsandboxedCommands = false,
): string[] {
  const commands = actions.includes("commands:execute");
  if (commands && !allowUnsandboxedCommands)
    throw new UnsupportedPermissionError(
      "Claude Code runs commands only with the Worker Host's consent; add claude-code to sandbox-commands (Claude Code's own sandbox) or allow-unsandboxed-commands in the Worker Host's supertag.yaml service to let it run commands. Native execution did not start.",
    );
  if (actions.some((action) => action !== "commands:execute" && !Object.hasOwn(ACTIONS, action)))
    throw new UnsupportedPermissionError(
      "Claude does not support one of the accepted allowed actions.",
    );
  return [
    ...new Set([
      ...actions.flatMap((action) => ACTIONS[action] ?? []),
      ...(commands ? ["Bash"] : []),
    ]),
  ];
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

/**
 * Whether `path` names Git metadata (any `.git` entry, in any case, which a macOS filesystem
 * treats alike) inside one of `roots`. SuperTag runs `git`
 * in these directories outside any sandbox, so a file tool must never change their metadata.
 */
async function insideGitMetadata(
  cwd: string,
  path: string,
  roots: readonly string[],
): Promise<boolean> {
  const target = resolve(cwd, path);
  let existing = target;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      if (existing === dirname(existing)) break;
      existing = dirname(existing);
    }
  }
  return [target, existing].some((value) =>
    roots.some((root) => {
      const part = relative(root, value);
      return (
        part !== ".." &&
        !part.startsWith("../") &&
        !isAbsolute(part) &&
        part.split(/[\\/]/).some((name) => name.toLowerCase() === ".git")
      );
    }),
  );
}

/** Workspace copies the Worker Host staged: readable, and writable when read-write. */
export interface MountRoots {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** The staged Workspace copy paths of an accepted Task. */
export function mountRoots(
  mounts: readonly { readonly destination: string; readonly readWrite: boolean }[] = [],
): MountRoots {
  return {
    read: mounts.filter((mount) => !mount.readWrite).map((mount) => mount.destination),
    write: mounts.filter((mount) => mount.readWrite).map((mount) => mount.destination),
  };
}

/** A Task's path scope, ready for the file-tool hook. */
export interface HookScope {
  readonly rules: FileScopeRules;
  readonly outside: OutsideDirectories;
  /** The Task Attempt's output directory, which stays writable under any scope. */
  readonly output?: string | undefined;
  /** The Task's network scope, which `WebFetch` must stay inside. */
  readonly network?: NetworkRules | undefined;
  /**
   * The Tag's native memory directory, readable and writable under any scope: Tag-private
   * state, not the Workspace. `only` names file tools the Task's actions did not admit, which
   * reach nothing else.
   */
  readonly memory?: { readonly root: string; readonly only: ReadonlySet<string> } | undefined;
}

/**
 * Claude Code's sandbox settings for a Task with a network scope. Sandboxed commands reach only
 * the Worker Host's egress proxy, which enforces the scope; filesystem isolation stays off, so
 * commands keep needing the host's allow-unsandboxed-commands opt-in. Claude Code fails the run
 * instead of running commands unsandboxed when its sandbox cannot start.
 */
export function networkSandbox(scope: NetworkScopeLike, proxy: string) {
  const port = Number(new URL(proxy).port);
  if (!Number.isInteger(port) || port <= 0)
    throw new SafeAdapterFailure(
      "The Worker Host's egress proxy address is invalid. Native execution did not start.",
    );
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: networkHostNames(scope),
      strictAllowlist: true,
      httpProxyPort: port,
      socksProxyPort: port,
    },
    filesystem: { disabled: true },
  };
}

/**
 * Workspace entries no sandboxed command may change, whatever the Task's write grant: Git
 * metadata (the Worker Host commits after the harness finishes) and harness configuration.
 */
const PROTECTED_ENTRIES = [
  ".git",
  ".codex",
  ".agents",
  ".aws",
  ".claude",
  ".cursor",
  ".opencode",
  ".supertag",
] as const;

/** Credential locations in the Worker Host user's home that sandboxed commands may not read. */
const HOME_SECRETS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".kube",
  ".codex",
  ".claude",
  ".claude.json",
  ".config/gh",
  ".config/opencode",
  ".supertag",
  "Library/Keychains",
] as const;

/** What a Task's commands may reach under Claude Code's sandbox. */
export interface CommandSandboxInput {
  readonly cwd: string;
  /** Whether the Task has `files:write`. Without it, commands write only temporary files. */
  readonly write: boolean;
  readonly scope: FileScopeLike | undefined;
  readonly mounts: MountRoots;
  readonly outside: OutsideDirectories;
  /** The Worker Host user's real home, whose credential locations stay unreadable. */
  readonly home: string;
  /** `undefined`: no network; `"open"`: any origin (`web:fetch` without a network scope). */
  readonly network:
    | undefined
    | "open"
    | { readonly scope: NetworkScopeLike; readonly proxy: string };
}

/**
 * Claude Code's own sandbox, with filesystem isolation on, for a Worker Host that opted into
 * sandboxed commands. Commands write only the Workspace (and its read-write copies and outside
 * write directories), never its protected entries, read-only or hidden paths; they cannot read
 * hidden paths or the home's credential locations; their network is off unless the Task has
 * `web:fetch`, and a network scope routes it through the egress proxy. Claude Code fails the
 * run rather than run a command unsandboxed, and ignores the model's request to skip it.
 *
 * `paths` that narrow Workspace writes stay enforced at delivery: Claude Code's sandbox lets a
 * deny outrank an allow, so it cannot grant `src/` inside an otherwise read-only Workspace.
 */
export function commandSandbox(input: CommandSandboxInput) {
  const { cwd, scope } = input;
  const inside = (root: string, entry: string) => join(root, entry.replace(/\/+$/u, ""));
  const writeRoots = input.write ? [cwd, ...input.mounts.write, ...input.outside.write] : [];
  const denyWrite = [
    ...(input.write ? [] : [cwd]),
    ...[cwd, ...input.mounts.write].flatMap((root) =>
      PROTECTED_ENTRIES.map((entry) => inside(root, entry)),
    ),
    ...(scope?.readOnly ?? []).map((entry) => inside(cwd, entry)),
    ...(scope?.hidden ?? []).map((entry) => inside(cwd, entry)),
  ];
  const denyRead = [
    ...(scope?.hidden ?? []).map((entry) => inside(cwd, entry)),
    ...HOME_SECRETS.map((entry) => join(input.home, entry)),
  ];
  // Commands may listen on loopback, as Codex's do, so a test suite can start a local server.
  const network: Record<string, unknown> = {
    ...(input.network === undefined
      ? { allowedDomains: [], strictAllowlist: true }
      : input.network === "open"
        ? { allowedDomains: ["*"], strictAllowlist: true }
        : networkSandbox(input.network.scope, input.network.proxy).network),
    allowLocalBinding: true,
  };
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network,
    filesystem: { allowWrite: writeRoots, denyWrite, denyRead },
  };
}

/** Certificate variables for commands behind the egress proxy, which intercepts TLS. */
export function egressCertificateEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bundle = environment["SUPERTAG_EGRESS_CA_BUNDLE"];
  const certificate = environment["SUPERTAG_EGRESS_CA_CERTIFICATE"];
  if (!bundle || !certificate)
    throw new SafeAdapterFailure(
      "Claude Code cannot apply this Task's network scope without the Worker Host's egress proxy. Native execution did not start.",
    );
  return {
    SSL_CERT_FILE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    CURL_CA_BUNDLE: bundle,
    PIP_CERT: bundle,
    GIT_SSL_CAINFO: bundle,
    NODE_EXTRA_CA_CERTS: certificate,
  };
}

export const NO_SCOPE: HookScope = {
  rules: new FileScopeRules(),
  outside: { write: [], read: [] },
};

/**
 * The real path of `path`: its deepest existing ancestor resolved through symlinks, followed by
 * the rest. `undefined` when a dangling symlink or an unreadable entry is on the way.
 */
async function resolvedTarget(target: string): Promise<string | undefined> {
  let existing = target;
  let suffix = "";
  for (;;) {
    try {
      return join(await realpath(existing), suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === dirname(existing))
        return undefined;
      try {
        if ((await lstat(existing)).isSymbolicLink()) return undefined;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      suffix = suffix ? join(basename(existing), suffix) : basename(existing);
      existing = dirname(existing);
    }
  }
}

/** `path` relative to `root`, `/`-separated, or `undefined` when it lies outside. */
function insideRoot(root: string, path: string): string | undefined {
  const part = relative(root, path);
  if (part === ".." || part.startsWith("../") || isAbsolute(part)) return undefined;
  return part.split(sep).join("/");
}

/**
 * Why the path scope refuses this file-tool call, or `undefined`. Both the path as written and
 * the path after symlinks resolve must pass, so neither a link nor `..` reaches a hidden or
 * read-only entry.
 */
async function scopeDenial(
  cwd: string,
  path: string,
  write: boolean,
  rules: FileScopeRules,
  output?: string,
): Promise<string | undefined> {
  if (rules.empty) return undefined;
  const lexical = resolve(cwd, path);
  const real = await resolvedTarget(lexical);
  if (real === undefined) return "a dangling or unreadable link";
  const root = await realpath(cwd);
  // The output directory is a system grant: writable whatever the write paths, unless hidden.
  const intoOutput =
    write &&
    output !== undefined &&
    insideRoot(output, lexical) !== undefined &&
    insideRoot(output, real) !== undefined;
  for (const candidate of [insideRoot(cwd, lexical), insideRoot(root, real)]) {
    if (candidate === undefined) continue;
    const denial =
      write && !intoOutput ? rules.writeDenial(candidate) : rules.readDenial(candidate);
    if (denial) return describeDenial(denial);
  }
  return undefined;
}

/**
 * Native Claude Code deny rules for the scope, as defense in depth beside the hook. Claude Code
 * 2.1.280 turns `Read()` denies into ripgrep exclusions for Grep and Glob, so a search over a
 * directory holding a hidden file leaves that file out (native-deny-search.test.ts runs the
 * bundled binary to check this; one live Claude Code 2.1.323 turn confirmed it on 2026-11-17).
 */
export function nativeDenyRules(cwd: string, scope: FileScopeLike | undefined): string[] {
  if (!scope) return [];
  const absolute = (entry: string) => {
    const body = entry.replace(/\/+$/u, "");
    return [`/${cwd}/${body}`, `/${cwd}/${body}/**`];
  };
  return [
    ...scope.hidden.flatMap((entry) =>
      absolute(entry).flatMap((path) => [`Read(${path})`, `Edit(${path})`]),
    ),
    ...scope.readOnly.flatMap((entry) => absolute(entry).map((path) => `Edit(${path})`)),
  ];
}

export function permissionHook(
  tools: readonly string[],
  cwd: string,
  signal: AbortSignal,
  skills: ReadonlySet<string> = new Set(),
  skillRoots: readonly string[] = [],
  mcpToolServers: ReadonlyMap<string, string> = new Map(),
  mounts: MountRoots = { read: [], write: [] },
  scope: HookScope = NO_SCOPE,
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
    let reason: string | undefined;
    if (allowed && hook.tool_name === "WebFetch" && scope.network) {
      const url = (hook.tool_input as Record<string, unknown>)["url"];
      let parsed: URL | undefined;
      try {
        parsed = typeof url === "string" ? new URL(url) : undefined;
      } catch {
        parsed = undefined;
      }
      allowed = parsed !== undefined && scope.network.allows("GET", parsed);
      if (!allowed) reason = "outside the Task's network scope";
    }
    if (allowed && ["Read", "Write", "Edit", "Glob", "Grep"].includes(hook.tool_name)) {
      const input = hook.tool_input as Record<string, unknown>;
      const path = ["Read", "Write", "Edit"].includes(hook.tool_name)
        ? input["file_path"]
        : (input["path"] ?? cwd);
      const writes = hook.tool_name === "Write" || hook.tool_name === "Edit";
      const inMemory =
        scope.memory !== undefined && (await withinRoots(cwd, path, [scope.memory.root]));
      if (scope.memory?.only.has(hook.tool_name) && !inMemory) allowed = false;
      else if (inMemory) allowed = true;
      else
        allowed = await withinRoots(
          cwd,
          path,
          writes
            ? [cwd, ...mounts.write, ...scope.outside.write]
            : [
                cwd,
                ...skillRoots,
                ...mounts.read,
                ...mounts.write,
                ...scope.outside.read,
                ...scope.outside.write,
              ],
        );
      if (allowed && writes && !inMemory)
        allowed = !(await insideGitMetadata(cwd, path as string, [
          cwd,
          ...mounts.write,
          ...scope.outside.write,
        ]));
      if (allowed && !inMemory) {
        reason = await scopeDenial(cwd, path as string, writes, scope.rules, scope.output);
        allowed = reason === undefined;
      }
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
          : reason
            ? hook.tool_name === "WebFetch"
              ? `The URL is ${reason}`
              : `The path is ${reason}`
            : "Outside the accepted Task permissions or allowed paths",
      },
    };
  };
}

export interface AdapterOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** The Worker Host's allow-unsandboxed-commands opt-in for `commands:execute`. */
  readonly allowUnsandboxedCommands?: boolean;
  /**
   * The Worker Host's sandbox-commands opt-in: `commands:execute` runs `Bash` under Claude
   * Code's own sandbox, confined to the Task's Workspace and permissions.
   */
  readonly sandboxCommands?: boolean;
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
  // How many text blocks of the message Claude is writing have streamed.
  const streamed = { blocks: 0 };
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
  // A command sandbox's temporary directory, private to this Task Attempt.
  let commandTemporary: string | undefined;
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
    // In a remote Workspace (E2B or Modal), Claude Code keeps no built-in file or command tool:
    // its Workspace tools run in the sandbox, so commands need no unsandboxed opt-in.
    const remote = run.remoteWorkspace;
    const sandboxCommands = !remote && (configuration.sandboxCommands ?? false);
    const admitted = admittedTools(
      task.allowedActions,
      remote || sandboxCommands || (configuration.allowUnsandboxedCommands ?? false),
    );
    // WebFetch and WebSearch would run here, on the Worker Host and its network, so a remote
    // Workspace offers none; placement keeps web actions off remote lanes.
    // A scoped web:fetch is the exception: the sandbox's commands reach it through the relay.
    if (
      remote &&
      task.allowedActions.some(
        (action) =>
          action.startsWith("web:") &&
          !(
            action === "web:fetch" &&
            networkScopeOf(task) &&
            task.allowedActions.includes("commands:execute")
          ),
      )
    )
      throw new SafeAdapterFailure(
        "A remote Workspace cannot carry web actions yet. Native execution did not start.",
      );
    const tools = remote ? [] : admitted;
    const refusal = fileScopeRefusal(
      task,
      remote ? "claude-code-remote" : sandboxCommands ? "claude-code-sandboxed" : "claude-code",
    );
    if (refusal) throw new SafeAdapterFailure(`${refusal}. Native execution did not start.`);
    const fileScope = fileScopeOf(task);
    const networkScope = networkScopeOf(task);
    // In a remote Workspace, commands carry the proxy credential through the sandbox's relay.
    if (!remote && networkScope && networkCredentials(networkScope).length > 0)
      throw new SafeAdapterFailure(
        "Claude Code's sandbox cannot authenticate to SuperTag's egress proxy, so it cannot carry network credentials. Native execution did not start.",
      );
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
    const { env, cwd, memory } = await nativeEnvironment(environment, task.outputPolicy?.directory);
    // Claude Code keeps its memories with its own file tools, which run on this host. A Task whose
    // actions admit none of them (read-only, or in a remote Workspace, where every Workspace tool
    // runs in the sandbox) still gets them, confined to the memory directory on this host: the
    // sandbox never reaches it.
    const memoryOnly = new Set(
      memory ? ["Read", "Write", "Edit"].filter((tool) => !tools.includes(tool)) : [],
    );
    tools.push(...memoryOnly);
    const workspace = remote
      ? remoteWorkspaceTools(harness, task.allowedActions, controller.signal)
      : undefined;
    phase = "Skill preparation";
    const { plugins, names, roots } = await stageSkills(
      selected,
      env["CLAUDE_CONFIG_DIR"] ?? "",
      controller.signal,
    );
    if (names.size > 0) tools.push("Skill");
    const allowedTools = [
      ...tools,
      ...(workspace?.tools ?? []),
      ...coordination.tools,
      ...mcp.toolServers.keys(),
    ];
    const toolServers = new Map([
      ...mcp.toolServers,
      ...(workspace?.tools ?? []).map((name) => [name, REMOTE_WORKSPACE_SERVER] as const),
    ]);
    const mounts = mountRoots(task.workspace?.mounts);
    phase = "path scope preparation";
    let outside: OutsideDirectories;
    try {
      outside = await resolveOutsideDirectories(fileScope, cwd, [
        env["CLAUDE_CONFIG_DIR"] ?? "",
        memory ?? "",
        ...(env["HOME"] && env["HOME"] !== environment["HOME"] ? [env["HOME"]] : []),
      ]);
    } catch (error) {
      throw new SafeAdapterFailure(
        `${error instanceof Error ? error.message : "Path scope directories are invalid"}. Native execution did not start.`,
      );
    }
    const scope: HookScope = {
      rules: new FileScopeRules(fileScope),
      outside,
      output: env["SUPERTAG_OUTPUT_DIR"],
      network: networkScope ? new NetworkRules(networkScope) : undefined,
      memory: memory ? { root: memory, only: memoryOnly } : undefined,
    };
    // Commands under a network scope run in Claude Code's sandbox, which sends their traffic
    // only to the Worker Host's egress proxy.
    let sandbox: ReturnType<typeof networkSandbox> | ReturnType<typeof commandSandbox> | undefined;
    if (sandboxCommands && tools.includes("Bash")) {
      // Claude Code otherwise points sandboxed commands at /tmp/claude-UID, which every Claude
      // Code session of this user shares. A short path keeps its sockets within AF_UNIX limits.
      commandTemporary = await mkdtemp("/tmp/supertag-claude-");
      env["CLAUDE_CODE_TMPDIR"] = commandTemporary;
      const proxy = environment["SUPERTAG_EGRESS_PROXY"];
      if (networkScope && !proxy)
        throw new SafeAdapterFailure(
          "Claude Code cannot apply this Task's network scope without the Worker Host's egress proxy. Native execution did not start.",
        );
      sandbox = commandSandbox({
        cwd,
        write: task.allowedActions.includes("files:write"),
        scope: fileScope,
        mounts,
        outside,
        home: userInfo().homedir,
        network:
          networkScope && proxy
            ? { scope: networkScope, proxy }
            : task.allowedActions.includes("web:fetch")
              ? "open"
              : undefined,
      });
      if (networkScope) Object.assign(env, egressCertificateEnvironment(environment));
    } else if (networkScope && tools.includes("Bash")) {
      const proxy = environment["SUPERTAG_EGRESS_PROXY"];
      if (!proxy)
        throw new SafeAdapterFailure(
          "Claude Code cannot apply this Task's network scope without the Worker Host's egress proxy. Native execution did not start.",
        );
      sandbox = networkSandbox(networkScope, proxy);
      Object.assign(env, egressCertificateEnvironment(environment));
    }
    phase = "checkpoint validation";
    const checkpointed = restoreCheckpoint(run.checkpoint, task, cwd);
    // A resumed Claude Code Session keeps the tools it started with, so a turn whose admitted
    // tools changed, such as one newly granted commands:execute, starts fresh from the recap.
    const restored = resumable(checkpointed, tools) ? checkpointed : undefined;
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
      additionalDirectories: [
        ...mounts.read,
        ...mounts.write,
        ...outside.read,
        ...outside.write,
        ...(memory ? [memory] : []),
      ],
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
      mcpServers: { ...coordination.servers, ...mcp.servers, ...(workspace?.servers ?? {}) },
      settings: {
        syncClaudeAiSkills: false,
        syncClaudeAiPlugins: false,
        disableSkillShellExecution: true,
        // Claude Code's auto-memory lives in the Tag's native memory directory, which the
        // Worker Host keeps across Tasks. A turn granted none (the Tag keeps no memory, or an
        // outside event started it) keeps none, rather than one lost with the Attempt.
        ...(memory ? { autoMemoryDirectory: memory } : { autoMemoryEnabled: false }),
        ...(fileScope ? { permissions: { deny: nativeDenyRules(cwd, fileScope) } } : {}),
        ...(sandbox ? { sandbox } : {}),
      },
      systemPrompt: [
        task.instructions,
        TURN_GUIDANCE,
        tagPortfolio(run),
        remote
          ? `The Task workspace is in a sandbox. Use the mcp__workspace tools, with paths relative to the workspace, for every file and command in it.${memory ? " Your memory folder is not in the sandbox: it is on this Worker Host, so keep your memories there with Read, Write, and Edit." : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      env,
      stderr: () => {},
      includePartialMessages: true,
      sessionStore: store,
      sessionStoreFlush: "eager",
      hooks: {
        PreToolUse: [
          {
            hooks: [
              permissionHook(
                allowedTools,
                cwd,
                controller.signal,
                names,
                roots,
                toolServers,
                mounts,
                scope,
              ),
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
      restored
        ? task.prompt
        : [
            sessionRecap(
              run.history,
              task.sessionId,
              secrets,
              (run.coordination?.mayReadTagSessions || run.coordination?.mayReadOwnSession) ??
                false,
            ),
            task.prompt,
          ]
            .filter(Boolean)
            .join("\n\n"),
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
        await receipt(() =>
          client.publish({ sequence, text: event, kind: TaskEventKind.PROGRESS }, options()),
        );
      }
      if (message.type === "stream_event") {
        // The reply text as Claude writes it, shown while the turn runs. The Worker Host batches
        // and redacts it; the completed assistant message below replaces it. Text is shown
        // only, so a lost send never fails the turn.
        const text = streamedText(message.event, streamed);
        if (text)
          await client
            .publishText({ afterSequence: eventSequence, text }, options())
            .catch(() => {});
      }
      if (message.type === "assistant") {
        streamed.blocks = 0;
        // Each completed assistant message is its own conversation message, shown at once: the
        // sentence saying what Claude is about to do arrives before its first tool call.
        const text = message.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const safe = redact(text, secrets).replaceAll("\0", "");
        if (safe.trim())
          for (const chunk of utf8Chunks(safe, 16000)) {
            const sequence = ++eventSequence;
            await receipt(() =>
              client.publish({ sequence, text: chunk, kind: TaskEventKind.MESSAGE }, options()),
            );
          }
        // Then one activity line per tool call it starts, from the call's input only.
        for (const part of message.message.content) {
          if (part.type !== "tool_use") continue;
          const line = claudeToolActivity(part, (text) =>
            redact(text, secrets).replaceAll("\0", ""),
          );
          if (!line) continue;
          const sequence = ++eventSequence;
          await receipt(() =>
            client.publish({ sequence, text: line, kind: TaskEventKind.ACTIVITY }, options()),
          );
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
    // A quiet turn may end without final text; its note becomes the result.
    const quiet = await coordination.quietNote();
    if (!finalSeen || (!result && quiet === undefined))
      throw new SafeAdapterFailure("Claude ended without a successful final response.");
    if (!nativeSessionId)
      throw new SafeAdapterFailure("Claude ended without a native Session identity.");
    const final = result ?? "";
    if (Buffer.byteLength(final) > 262144) throw new Error("Claude result exceeds its limit");
    phase = "checkpoint capture";
    const checkpoint = captureCheckpoint(
      task,
      nativeSessionId,
      store.snapshot(),
      secrets,
      lastTotalCostUsd,
      tools,
    );
    const outcome = withObjectiveReport(
      {
        result: final,
        succeeded: true,
        ...(checkpoint ? { checkpoint } : {}),
        waitingApprovalIds: [
          ...new Set([
            ...(await coordination.waitingApprovalIds()),
            ...(await mcp.waitingApprovalIds()),
          ]),
        ].sort(),
      },
      await coordination.objectiveReport(),
      quiet,
    );
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
    // Provider failures can contain credentials, so only a fixed description crosses Harness,
    // or a failed Worker Host call's status, redacted with this Attempt's values.
    const hostFailure = workerHostFailure(error);
    const detail = hostFailure
      ? `: ${redact(hostFailure, secrets).replaceAll("\0", "").slice(0, 600)}`
      : "";
    const failure =
      error instanceof UnsupportedPermissionError || error instanceof SafeAdapterFailure
        ? error.message
        : !started
          ? `Claude ${phase} failed${detail}. Native execution did not start.`
          : wasStopped
            ? "Claude execution stopped. No checkpoint was accepted."
            : `Claude ${phase} failed${detail}. No checkpoint was accepted.`;
    await receipt(() => client.complete({ succeeded: false, result: failure }, options()));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    tree?.close();
    if (commandTemporary)
      await rm(commandTemporary, { recursive: true, force: true }).catch(() => {});
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
