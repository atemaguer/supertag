import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  describeToolCall,
  type ExecutionEnvironment,
  type HarnessEvent,
  type ProcessHandle,
  type ToolInput,
} from "@supertag/worker-sdk";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The most of OpenCode's standard error kept to explain a failure: its last error log lines. */
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
/** The most of a reported failure's reason that crosses the Harness. */
const MAX_REASON_CHARS = 500;
/** How long OpenCode may take to exit, and log its error, after it reports a failure. */
const REPORTED_EXIT_GRACE_MS = 2000;

/**
 * A failure OpenCode reported for its run: the provider's reason, such as an expired API key or
 * a model the account may not use, or OpenCode's own, such as an unknown model. The reason is
 * stripped of controls and bounded, but may still hold a credential: redact it with
 * [`redactCredentialShapes`] and the Attempt's own values before it leaves the adapter.
 */
export class OpenCodeReportedError extends Error {
  constructor(readonly reason: string) {
    super("OpenCode reported a failure");
  }
}

/** One line of at most [`MAX_REASON_CHARS`], without controls, which can split a secret. */
function reasonLine(text: string): string {
  return [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()].slice(0, MAX_REASON_CHARS).join("");
}

/**
 * The `error` field of OpenCode's last `level=ERROR` log line on standard error (it runs with
 * `--print-logs --log-level ERROR`), without its error class: for an unknown model, "Model not
 * found: PROVIDER/MODEL.", which OpenCode's JSON event reports only as an unexpected error.
 */
export function openCodeLoggedError(diagnostics: string): string | undefined {
  let found: string | undefined;
  for (const line of diagnostics.split(/\r?\n/u)) {
    if (!/\blevel=ERROR\b/u.test(line)) continue;
    const quoted = /(?:^|\s)error="((?:[^"\\]|\\.)*)"/u.exec(line)?.[1];
    if (quoted === undefined) continue;
    let text: string;
    try {
      text = JSON.parse(`"${quoted}"`) as string;
    } catch {
      text = quoted;
    }
    text = reasonLine(text.replace(/^[A-Za-z]*Error:\s*/u, ""));
    if (text) found = text;
  }
  return found;
}

/**
 * The reason in an OpenCode `error` event (`{ name, data: { message } }`), or in its log when
 * the event carries only OpenCode's generic "unexpected server error". Never the provider's
 * response headers or body, which the event also carries.
 */
export function openCodeErrorReason(error: unknown, diagnostics = ""): string {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const data =
    record["data"] && typeof record["data"] === "object"
      ? (record["data"] as Record<string, unknown>)
      : {};
  const name = typeof record["name"] === "string" ? reasonLine(record["name"]) : "";
  const message =
    typeof data["message"] === "string"
      ? reasonLine(data["message"])
      : typeof record["message"] === "string"
        ? reasonLine(record["message"])
        : "";
  const logged = openCodeLoggedError(diagnostics);
  if (logged && (!message || name === "UnknownError")) return logged;
  return message || name || "OpenCode reported an error without a reason.";
}

/**
 * Redacts what looks like a credential in text from OpenCode or a provider: well-known API key
 * and token prefixes, `Bearer` values, `key=value` style secrets, URL user information, and long
 * runs of mixed-case letters and digits or of hexadecimal digits. Model IDs and prose stay.
 */
export function redactCredentialShapes(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"',;]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|key)\s*[:=]\s*)["']?[^\s"',;&]+["']?/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:(?:sk|rk|pk)[-_]|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|hf_|gsk_|csk-|nvapi-)[A-Za-z0-9_-]{8,}/gu,
      "[REDACTED]",
    )
    .replace(/\/\/[^\s/@]+@/gu, "//[REDACTED]@")
    .replace(
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/gu,
      "[REDACTED]",
    )
    .replace(/(?<![A-Za-z0-9])[a-f0-9]{32,}(?![A-Za-z0-9])/giu, "[REDACTED]");
}

export interface OpenCodeRunRequest {
  readonly prompt: string;
  readonly executable: string;
  readonly model: string;
  readonly workspace: string;
  readonly timeoutMs: number;
  /** Privileged process configuration; never included in model input or metadata. */
  readonly environment: Readonly<Record<string, string>>;
  readonly toolInputs?: readonly ToolInput[];
}

type OpenCodeAction = "allow" | "deny";
type OpenCodeRule = OpenCodeAction | Readonly<Record<string, OpenCodeAction>>;

/**
 * A Workspace Volume copy the Worker Host staged outside the Task worktree: a canonical
 * directory without wildcard characters, so its OpenCode permission patterns match it exactly.
 */
export interface OpenCodeCopy {
  readonly destination: string;
  readonly readWrite: boolean;
}

/** The Task's admitted Skills, staged in `root`, and the names OpenCode loads them as. */
export interface OpenCodeSkills {
  readonly root: string;
  readonly names: readonly string[];
}

/**
 * OpenCode asks `external_directory` with the absolute parent directory of each file outside the
 * worktree, followed by `/*`, and `edit` with the file's path relative to the worktree. The last
 * matching rule wins, and `*` matches across `/`.
 */
/**
 * Every spelling of `.git`: a macOS filesystem treats `.GIT` as `.git`, and OpenCode 1.15.12
 * matches permission patterns case-sensitively, without character classes.
 */
const GIT_NAMES = [".git", ".gIt", ".giT", ".gIT", ".Git", ".GiT", ".GIt", ".GIT"];

/**
 * A Task's path scope for OpenCode: Workspace entries (`write`, `readOnly`, `hidden`) as the
 * Control Plane composed them, and the outside directories the adapter already expanded and
 * canonicalized.
 */
export interface OpenCodeScope {
  readonly write: readonly string[];
  readonly readOnly: readonly string[];
  readonly hidden: readonly string[];
  readonly outsideWrite: readonly string[];
  readonly outsideRead: readonly string[];
  /** The Task Attempt's output directory, worktree-relative; writable under any scope. */
  readonly outputDirectory?: string | undefined;
}

const LETTER = /[a-z]/iu;

/** At most 2^8 = 256 spellings per path. */
const SPELLED_LETTERS = 8;

/**
 * Case spellings of a path for a case-insensitive filesystem. OpenCode 1.15.12 matches patterns
 * case-sensitively and has no character classes, so each letter is spelled out in both cases, up
 * to 8 letters per path. They are shared out one at a time across the segments, starting with
 * the last, so every segment keeps its leading letters. Each further letter becomes `?`, which
 * matches any one character: the patterns can only match more names, all of the same length,
 * which widens a denial and never lets a spelling of the entry through.
 */
function caseVariants(value: string): string[] {
  const segments = value.split("/");
  const letters = segments.map((segment) => [...segment].filter((c) => LETTER.test(c)).length);
  const spelled = segments.map(() => 0);
  let budget = SPELLED_LETTERS;
  while (budget > 0 && spelled.some((count, index) => count < (letters[index] ?? 0))) {
    for (let index = segments.length - 1; index >= 0 && budget > 0; index--) {
      if ((spelled[index] ?? 0) < (letters[index] ?? 0)) {
        spelled[index] = (spelled[index] ?? 0) + 1;
        budget--;
      }
    }
  }
  let variants = [""];
  segments.forEach((segment, index) => {
    let seen = 0;
    let options = [""];
    for (const character of segment) {
      const choices = !LETTER.test(character)
        ? [character]
        : seen++ < (spelled[index] ?? 0)
          ? [character.toLowerCase(), character.toUpperCase()]
          : ["?"];
      options = options.flatMap((prefix) => choices.map((choice) => `${prefix}${choice}`));
    }
    variants = variants.flatMap((prefix) =>
      options.map((option) => (index ? `${prefix}/${option}` : option)),
    );
  });
  return [...new Set(variants)];
}

/**
 * OpenCode patterns for one SuperTag entry: the path itself and its subtree. OpenCode's `*`
 * crosses `/`, so a SuperTag `*` translates to a broader match, which only widens a denial. A
 * `**` segment matches zero or more segments, so each one expands to both forms.
 */
export function openCodePatterns(entry: string, fold: boolean): string[] {
  let forms = [""];
  const parts = entry.replace(/\/+$/u, "").split("/");
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === "**")
      forms = forms.flatMap((form) =>
        last ? [form.replace(/\/$/u, ""), `${form}*`] : [form, `${form}*/`],
      );
    else forms = forms.map((form) => `${form}${part}${last ? "" : "/"}`);
  });
  forms = forms.map((form) => form.replace(/\/$/u, "")).filter(Boolean);
  const spelled = fold ? forms.flatMap(caseVariants) : forms;
  return [...new Set(spelled.flatMap((form) => (form === "*" ? ["*"] : [form, `${form}/*`])))];
}

/**
 * OpenCode's permissions for a Task: its allowed actions, Workspace Volume copies, and path scope,
 * and `memory`, the Tag's memory folder the Worker Host keeps outside the worktree, which OpenCode
 * may always read and edit, whatever the Task's file actions. The folder must be a canonical
 * directory without wildcard characters, so its patterns name exactly that directory.
 */
export function openCodePermissions(
  actions: readonly string[],
  copies: readonly OpenCodeCopy[] = [],
  worktree?: string,
  scope?: OpenCodeScope,
  memory?: string,
): Record<string, OpenCodeRule> {
  const allow = (action: string): OpenCodeAction => (actions.includes(action) ? "allow" : "deny");
  const readOnly = copies.filter(({ readWrite }) => !readWrite);
  if (scope && worktree === undefined) throw new Error("OpenCode path scopes need the worktree");
  // OpenCode asks `edit` with the path relative to the worktree; outside it that starts `..`.
  const outside = (directory: string) =>
    worktree === undefined
      ? [`${directory}/*`]
      : [`${relative(worktree, directory)}/*`, `${directory}/*`];
  const rules = (patterns: readonly string[], action: OpenCodeAction) =>
    patterns.map((pattern) => [pattern, action] as const);
  const scopedWrite = scope !== undefined && scope.write.length > 0;
  const memoryPatterns = memory === undefined ? [] : outside(memory);
  const gitDenials = GIT_NAMES.flatMap((name) =>
    rules([name, `${name}/*`, `*/${name}`, `*/${name}/*`], "deny"),
  );
  // SuperTag runs `git` in the worktree and copies outside any sandbox, so their Git metadata is
  // never editable. The last matching rule wins, so denials follow the allows.
  const edit: OpenCodeRule =
    allow("files:write") === "allow"
      ? Object.fromEntries([
          ["*", scopedWrite ? "deny" : "allow"],
          ...(scopedWrite
            ? [
                ...rules(
                  scope.write.flatMap((entry) => openCodePatterns(entry, false)),
                  "allow",
                ),
                ...rules(
                  copies
                    .filter(({ readWrite }) => readWrite)
                    .flatMap(({ destination }) => outside(destination)),
                  "allow",
                ),
                ...rules(
                  scope.outputDirectory === undefined
                    ? []
                    : openCodePatterns(scope.outputDirectory, false),
                  "allow",
                ),
              ]
            : []),
          ...rules(scope?.outsideWrite.flatMap(outside) ?? [], "allow"),
          ...rules(memoryPatterns, "allow"),
          ...rules(scope?.outsideRead.flatMap(outside) ?? [], "deny"),
          ...rules(scope?.readOnly.flatMap((entry) => openCodePatterns(entry, true)) ?? [], "deny"),
          ...rules(scope?.hidden.flatMap((entry) => openCodePatterns(entry, true)) ?? [], "deny"),
          ...gitDenials,
          ...(worktree === undefined
            ? []
            : readOnly.flatMap(({ destination }) => [
                [`${relative(worktree, destination)}/*`, "deny"] as const,
                [`${destination}/*`, "deny"] as const,
              ])),
        ])
      : memoryPatterns.length
        ? Object.fromEntries([["*", "deny"], ...rules(memoryPatterns, "allow"), ...gitDenials])
        : "deny";
  const hidden = scope?.hidden.flatMap((entry) => openCodePatterns(entry, true)) ?? [];
  // A file:read grant always restates "*": "allow", which also overrides OpenCode's built-in
  // `*.env` ask rule, and then hides the scope's entries.
  // Without files:read, only the memory folder is readable.
  const read: OpenCodeRule =
    allow("files:read") === "allow" && hidden.length
      ? Object.fromEntries([["*", "allow"], ...rules(hidden, "deny")])
      : allow("files:read") === "deny" && memoryPatterns.length
        ? Object.fromEntries([["*", "deny"], ...rules(memoryPatterns, "allow")])
        : allow("files:read");
  const external = [
    ...(memory === undefined ? [] : [memory]),
    ...copies.map(({ destination }) => destination),
    ...(scope?.outsideWrite ?? []),
    ...(scope?.outsideRead ?? []),
  ];
  for (const directory of external)
    if (!isAbsolute(directory) || /[*?\p{Cc}]/u.test(directory))
      throw new Error("OpenCode cannot confine an outside directory");
  return {
    "*": "deny",
    read,
    // OpenCode asks `glob` with the glob and `grep` with the regular expression, never a path,
    // and filters neither's results by `read` rules. Glob lists only names, as an operating
    // system sandbox's directory listing does; grep would return a hidden file's content, so a
    // scope that hides entries denies it.
    glob: allow("files:read"),
    grep: hidden.length ? "deny" : allow("files:read"),
    edit,
    bash: allow("commands:execute"),
    webfetch: allow("web:fetch"),
    websearch: allow("web:search"),
    task: "deny",
    // Only the Worker Host's copies and the scope's directories are reachable outside the
    // worktree.
    external_directory: external.length
      ? {
          "*": "deny",
          ...Object.fromEntries(external.map((directory) => [`${directory}/*`, "allow"])),
        }
      : "deny",
    question: "deny",
    skill: "deny",
    lsp: "deny",
  };
}

export interface OpenCodeMcpTool {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly operations: readonly string[];
  readonly audience?: "manager";
}

/** Project only admitted tools and operations into OpenCode's native permission layers. */
export function openCodeConfigurationEnvironment(
  model: string,
  actions: readonly string[],
  tools: readonly OpenCodeMcpTool[],
  disableAuxiliaryProcesses = false,
  copies: readonly OpenCodeCopy[] = [],
  worktree?: string,
  scope?: OpenCodeScope,
  /** The Tag's memory folder, which OpenCode may always read and edit. */
  memory?: string,
  /** The Task's admitted Skills, the only ones OpenCode may load; their files are read-only. */
  skills?: OpenCodeSkills,
): Readonly<Record<string, string>> {
  if (skills && (!isAbsolute(skills.root) || /[*?\p{Cc}]/u.test(skills.root)))
    throw new Error("OpenCode cannot confine the Skill directory");
  const admittedPermission = {
    ...openCodePermissions(
      actions,
      skills ? [...copies, { destination: skills.root, readWrite: false }] : copies,
      worktree,
      scope,
      memory,
    ),
    // OpenCode asks `skill` with the Skill's name; the last matching rule wins.
    skill: skills?.names.length
      ? Object.fromEntries([["*", "deny"], ...skills.names.map((name) => [name, "allow"])])
      : "deny",
  };
  const permission: Record<string, unknown> = {
    ...admittedPermission,
    task: { "*": "deny", general: "allow", explore: "allow" },
  };
  const mcp: Record<string, unknown> = Object.create(null);
  const childToolDenials: Record<string, "deny"> = {};
  for (const tool of tools) {
    if (!/^[\w-]+$/u.test(tool.name)) throw new Error("Invalid MCP server name");
    const aliases = new Set([tool.name, tool.name.replace(/[^a-zA-Z0-9_]/gu, "_")]);
    for (const alias of aliases) {
      if (tool.audience === "manager") childToolDenials[`${alias}_*`] = "deny";
      // The Control Plane independently checks execution authority for each invocation.
      for (const operation of tool.operations) permission[`${alias}_${operation}`] = "allow";
    }
    mcp[tool.name] = {
      type: "remote",
      url: tool.url,
      headers: tool.headers,
      enabled: true,
      oauth: false,
    };
  }
  const generalPermission = {
    ...admittedPermission,
    ...childToolDenials,
    ...(tools.some(({ audience }) => audience === "manager")
      ? { bash: "deny", webfetch: "deny", websearch: "deny" }
      : {}),
    task: "deny",
  };
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    share: "disabled",
    autoupdate: false,
    plugin: [],
    // File tools also invoke these integrations outside the bash permission check.
    ...(disableAuxiliaryProcesses ? { formatter: false, lsp: false } : {}),
    // With external Skills and project configuration off, these are the only Skills it finds.
    ...(skills ? { skills: { paths: [skills.root] } } : {}),
    mcp,
    permission,
    agent: {
      build: { mode: "primary", permission },
      plan: { disable: true },
      general: {
        mode: "subagent",
        description: "Execute a bounded local subtask without SuperTag coordination authority",
        permission: generalPermission,
      },
      explore: {
        mode: "subagent",
        description: "Inspect the admitted workspace without modifying it",
        permission: { ...generalPermission, edit: "deny", bash: "deny" },
      },
    },
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    // No Skills from the home directory or the worktree's `.claude` and `.agents`.
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    // The Task worktree may contain untrusted OpenCode configuration and plugins.
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  };
}

/**
 * OpenCode in a remote Workspace, such as a local-vm container: every built-in tool is off,
 * because each would run on the Worker Host, and the Task's tools are the MCP servers in `tools`,
 * the Workspace's among them. No subagent runs.
 */
export function openCodeRemoteConfigurationEnvironment(
  model: string,
  tools: readonly OpenCodeMcpTool[],
): Readonly<Record<string, string>> {
  // The last matching rule wins: "*" denies every built-in, then each served tool is allowed.
  const permission: Record<string, unknown> = { "*": "deny" };
  const enabled: Record<string, boolean> = { "*": false };
  const mcp: Record<string, unknown> = Object.create(null);
  for (const tool of tools) {
    if (!/^[\w-]+$/u.test(tool.name)) throw new Error("Invalid MCP server name");
    const aliases = new Set([tool.name, tool.name.replace(/[^a-zA-Z0-9_]/gu, "_")]);
    for (const alias of aliases)
      for (const operation of tool.operations) {
        permission[`${alias}_${operation}`] = "allow";
        enabled[`${alias}_${operation}`] = true;
      }
    mcp[tool.name] = {
      type: "remote",
      url: tool.url,
      headers: tool.headers,
      enabled: true,
      oauth: false,
    };
  }
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    share: "disabled",
    autoupdate: false,
    plugin: [],
    formatter: false,
    lsp: false,
    mcp,
    tools: enabled,
    permission,
    agent: {
      build: { mode: "primary", permission, tools: enabled },
      plan: { disable: true },
      general: { disable: true },
      explore: { disable: true },
    },
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    // No Skills from the home directory or the worktree's `.claude` and `.agents`.
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  };
}

export interface OpenCodeCompletionPart {
  readonly id: string;
  readonly text: string;
}

type RecoverOpenCodeCompletion = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<readonly OpenCodeCompletionPart[]>;

export async function* runOpenCode(
  request: OpenCodeRunRequest,
  environment: Pick<ExecutionEnvironment, "spawn">,
  signal?: AbortSignal,
  recoverCompletion?: RecoverOpenCodeCompletion,
): AsyncIterable<HarnessEvent> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
  cancellation.throwIfAborted();
  let handle: ProcessHandle | undefined;
  const completion: { sessionId?: string; latestStepHasText: boolean } = {
    latestStepHasText: false,
  };
  const streamedParts = new Map<string, string>();
  const anonymousText = new Set<string>();
  try {
    handle = await environment.spawn(
      {
        command: request.executable,
        // Error logs go to standard error: the only place OpenCode names an unknown model.
        args: [
          "run",
          "--format",
          "json",
          "--model",
          request.model,
          "--agent",
          "build",
          "--pure",
          "--print-logs",
          "--log-level",
          "ERROR",
        ],
        cwd: request.workspace,
        environment: request.environment,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        streamOutput: true,
      },
      cancellation,
    );
    if (!handle.output) throw new Error("OpenCode requires environment process output streaming");
    let pending = "",
      diagnostics = "",
      responseBytes = 0,
      textSeen = false,
      finished = false;
    // OpenCode's `error` event; the rest of its output is drained, but not parsed, for the log.
    let reported: { readonly error: unknown } | undefined;
    // OpenCode emits a text part each time it is updated after it ends, and may repeat a tool
    // call's update: each is published once.
    const reportedCalls = new Set<string>();
    const parse = (line: string): HarnessEvent | undefined => {
      if (!line.trim()) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new Error("OpenCode emitted malformed JSON");
      }
      if (!raw || typeof raw !== "object") throw new Error("Invalid OpenCode event");
      const record = raw as Record<string, unknown>;
      if (record["type"] === "error") {
        reported = { error: record["error"] };
        // OpenCode exits after its error; one that doesn't is stopped, and the error stands.
        setTimeout(() => handle?.kill(), REPORTED_EXIT_GRACE_MS).unref();
        return;
      }
      const part = record["part"] as Record<string, unknown> | undefined;
      if (recoverCompletion) {
        if (
          Array.isArray(raw) ||
          typeof record["type"] !== "string" ||
          (record["type"] === "text" && typeof part?.["text"] !== "string") ||
          (record["type"] === "step_finish" && typeof part?.["reason"] !== "string")
        )
          throw new Error("Invalid OpenCode event");
        for (const identity of [record["sessionID"], part?.["sessionID"]]) {
          if (identity === undefined) continue;
          if (typeof identity !== "string" || !/^ses_[A-Za-z0-9]{1,120}$/u.test(identity))
            throw new Error("Invalid OpenCode Session identity");
          if (completion.sessionId !== undefined && identity !== completion.sessionId)
            throw new Error("OpenCode stream mixed Session identities");
          completion.sessionId = identity;
        }
      }
      if (record["type"] === "step_start") {
        finished = false;
        completion.latestStepHasText = false;
      }
      if (record["type"] === "step_finish") finished = part?.["reason"] === "stop";
      if (
        record["type"] === "tool_use" &&
        typeof part?.["tool"] === "string" &&
        typeof part["callID"] === "string"
      ) {
        const toolName = part["tool"];
        const input = request.toolInputs?.find((tool) =>
          tool.capability.operations.some(
            (operation) =>
              toolName === `${tool.binding.name}_${operation.name}` ||
              toolName === `${tool.binding.name.replace(/[^a-zA-Z0-9_]/gu, "_")}_${operation.name}`,
          ),
        );
        if (input) {
          const operation = input.capability.operations.find((operation) =>
            toolName.endsWith(`_${operation.name}`),
          );
          if (!operation) throw new Error("Unknown OpenCode MCP operation");
          const call = describeToolCall([input], {
            id: part["callID"],
            binding: { kind: input.binding.kind, name: input.binding.name },
            operation: operation.name,
          });
          const state = part["state"] as Record<string, unknown> | undefined;
          if (state?.["status"] === "error")
            return {
              type: "tool.call.failed",
              call,
              error: { message: "OpenCode MCP operation failed" },
            };
          if (state?.["status"] === "completed") return { type: "tool.call.completed", call };
        }
      }
      if (record["type"] === "tool_use" && typeof part?.["tool"] === "string") {
        // What the Tag did, as one activity line from the call's input, never its output.
        const state = part["state"] as Record<string, unknown> | undefined;
        if (typeof part["callID"] === "string") {
          const report = `${part["callID"]}\0${String(state?.["status"])}`;
          if (reportedCalls.has(report)) return;
          reportedCalls.add(report);
        }
        return {
          type: "progress.updated",
          progress: { summary: openCodeToolActivity(part["tool"], state?.["input"]) },
        };
      }
      if (record["type"] === "text" && typeof part?.["text"] === "string") {
        const text = part["text"];
        responseBytes += Buffer.byteLength(text);
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("OpenCode response exceeds limit");
        textSeen ||= Boolean(text.trim());
        const id = part["id"];
        const identified = typeof id === "string" && /^prt_[A-Za-z0-9]{1,120}$/u.test(id);
        if (identified && text) {
          const previous = streamedParts.get(id);
          if (previous !== undefined && previous !== text)
            throw new Error("OpenCode stream changed a completed text part");
          // The same ended part again: already published.
          if (previous === text) return;
          streamedParts.set(id, text);
        }
        if (recoverCompletion && text) {
          completion.latestStepHasText ||= Boolean(text.trim());
          if (!identified) anonymousText.add(text);
          if (streamedParts.size + anonymousText.size > 4096)
            throw new Error("OpenCode response has too many text parts");
        }
        return { type: "output.message", text };
      }
    };
    for await (const chunk of handle.output) {
      cancellation.throwIfAborted();
      if (chunk.stream === "stderr") {
        diagnostics = (diagnostics + chunk.text).slice(-MAX_DIAGNOSTIC_BYTES);
        continue;
      }
      if (chunk.stream !== "stdout" || reported) continue;
      pending += chunk.text;
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !reported) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES)
          throw new Error("OpenCode event exceeds limit");
        const event = parse(line);
        if (event) yield event;
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES)
        throw new Error("OpenCode event exceeds limit");
    }
    if (pending.trim() && !reported) {
      const event = parse(pending);
      if (event) yield event;
    }
    const result = await handle.wait();
    cancellation.throwIfAborted();
    if (reported) throw new OpenCodeReportedError(openCodeErrorReason(reported.error, diagnostics));
    if (result.exitCode !== 0 || result.signal) {
      const logged = openCodeLoggedError(diagnostics);
      throw logged ? new OpenCodeReportedError(logged) : new Error("OpenCode process failed");
    }
    if (finished && (recoverCompletion ? completion.latestStepHasText : textSeen)) return;
  } finally {
    if (handle) {
      handle.kill();
      // The environment owns termination escalation; do not release the Worker
      // until it confirms process cleanup, including on parse/cancellation errors.
      await handle.wait();
    }
  }
  if (!recoverCompletion || !completion.sessionId)
    throw new Error("OpenCode ended without a complete final response");
  const recovered = await recoverCompletion(completion.sessionId, cancellation);
  cancellation.throwIfAborted();
  for (const { id, text } of recovered) {
    const previous = streamedParts.get(id);
    if (previous !== undefined && previous !== text)
      throw new Error("OpenCode export changed a streamed text part");
    if (previous === undefined && !anonymousText.has(text)) yield { type: "output.message", text };
  }
}

/** Why OpenCode's auth file cannot be used, in fixed text that names no credential. */
export class OpenCodeAuthFileError extends Error {}

/**
 * The API key for `provider` in OpenCode's auth file (`{ PROVIDER: { "type": "api", "key": KEY } }`),
 * or `undefined` when the file has no entry for it: that provider then takes its key from the
 * environment, or needs none, as OpenCode Zen's free `opencode/...` models.
 */
export async function readProviderApiKey(
  path: string,
  provider: string,
  privateFile = false,
): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new OpenCodeAuthFileError(
      code === "ENOENT"
        ? "OpenCode auth file does not exist"
        : code === "ELOOP"
          ? "OpenCode auth file must be a regular file without a symlink"
          : "OpenCode auth file cannot be opened",
    );
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new OpenCodeAuthFileError(
        "OpenCode auth file must be a regular file no larger than 1 MiB",
      );
    if (
      privateFile &&
      ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    )
      throw new OpenCodeAuthFileError("OpenCode auth file must be privately owned (chmod 600)");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > 1024 * 1024)
      throw new OpenCodeAuthFileError("OpenCode auth file exceeds 1 MiB");
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    } catch {
      throw new OpenCodeAuthFileError("OpenCode auth file is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new OpenCodeAuthFileError("OpenCode auth file is not a JSON object");
    if (!Object.hasOwn(parsed, provider)) return undefined;
    const credential = (parsed as Record<string, unknown>)[provider];
    const record =
      credential && typeof credential === "object" ? (credential as Record<string, unknown>) : {};
    if (record["type"] !== "api" || typeof record["key"] !== "string" || !record["key"].trim())
      throw new OpenCodeAuthFileError(
        `OpenCode auth file's ${provider} sign-in is not an API key; only API-key sign-ins are supported, not OAuth`,
      );
    return record["key"];
  } finally {
    await file.close();
  }
}

/** The most an activity line shows before it is cut short. */
const MAX_ACTIVITY = 160;

/** One line saying what an OpenCode tool call did, such as `Running pnpm test`. */
export function openCodeToolActivity(tool: string, input: unknown): string {
  const fields = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const target = (verb: string, ...names: string[]) => {
    for (const name of names) {
      const value = fields[name];
      if (typeof value === "string" && value.trim()) return `${verb} ${value}`;
    }
    return verb;
  };
  const line = (() => {
    switch (tool) {
      case "bash":
        return target("Running", "command");
      case "read":
        return target("Reading", "filePath");
      case "edit":
      case "write":
      case "patch":
        return target("Editing", "filePath");
      case "grep":
      case "glob":
        return target("Searching for", "pattern");
      case "list":
        return target("Listing", "path");
      case "webfetch":
        return target("Fetching", "url");
      case "todowrite":
        return "Updating its plan";
      default:
        return `Using ${tool}`;
    }
  })();
  // Only the first line, still at full length: the adapter cuts it with `shortenActivity` once
  // it is redacted, so a cut never leaves part of a secret that redaction cannot match.
  const lines = line.split(/\r?\n/u).filter((text) => text.trim());
  const first = (lines[0] ?? "").trim();
  return lines.length > 1 ? `${first}…` : first;
}

/** An activity line cut to its length. Call it on redacted text. */
export function shortenActivity(line: string): string {
  const chars = [...line];
  if (chars.length <= MAX_ACTIVITY) return line;
  return `${chars.slice(0, MAX_ACTIVITY - 1).join("")}…`;
}
