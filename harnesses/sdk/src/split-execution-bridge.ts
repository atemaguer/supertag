import { posix } from "node:path";
import { describeDenial, FileScopeRules } from "./file-scope.js";
import type { ExecutionEnvironment, ProcessHandle, ProcessSpec } from "./index.js";

export type SplitExecutionToolName = "read" | "write" | "edit" | "glob" | "grep" | "ls" | "command";
export interface SplitExecutionToolDefinition {
  name: SplitExecutionToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface SplitExecutionToolResult {
  text: string;
  isError: boolean;
}
export interface SplitExecutionBridgeOptions {
  environment: ExecutionEnvironment;
  workspaceRoot: string;
  /** Staged input mounts outside the checkout. File tools may only read them. */
  readOnlyRoots?: readonly string[];
  /** Read-write Workspace Volume copies outside the checkout, writable with files:write. */
  writableRoots?: readonly string[];
  /** Worker-managed Task output directory, writable with files:write. */
  outputDirectory?: string;
  /**
   * The Tag's memory folder the Worker Host keeps for a harness with no memory of its own, outside
   * the checkout: always readable and writable, whatever `permissions` say of the Workspace.
   */
  memoryRoot?: string;
  /** `filesRead: false` refuses reads outside the memory folder; reads are allowed by default. */
  permissions: { filesRead?: boolean; filesWrite: boolean; commandsExecute: boolean };
  /**
   * The Task's path scope over the Workspace root, applied after symlinks resolve. Workspace
   * copies, staged inputs, and the output directory keep their own access.
   */
  fileScope?: { write: readonly string[]; readOnly: readonly string[]; hidden: readonly string[] };
  commandEnvironment?: Record<string, string>;
  limits?: { maxOutputBytes?: number; commandTimeoutMs?: number; maxReadBytes?: number };
}
export interface SplitExecutionBridge {
  readonly tools: readonly SplitExecutionToolDefinition[];
  call(name: string, input: unknown, signal?: AbortSignal): Promise<SplitExecutionToolResult>;
  cancelAll(): Promise<void>;
  dispose(): Promise<void>;
}

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
export const workspaceToolDefinitions: readonly SplitExecutionToolDefinition[] = [
  {
    name: "read",
    description: "Read a UTF-8 workspace file.",
    inputSchema: schema(
      {
        file_path: string,
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      ["file_path"],
    ),
  },
  {
    name: "write",
    description: "Write a UTF-8 workspace file.",
    inputSchema: schema({ file_path: string, content: string }, ["file_path", "content"]),
  },
  {
    name: "edit",
    description: "Replace exact text in a UTF-8 workspace file.",
    inputSchema: schema(
      {
        file_path: string,
        old_string: string,
        new_string: string,
        replace_all: { type: "boolean" },
      },
      ["file_path", "old_string", "new_string"],
    ),
  },
  {
    name: "glob",
    description: "List workspace files matching a glob.",
    inputSchema: schema({ pattern: string, path: string }, ["pattern"]),
  },
  {
    name: "grep",
    description: "Search UTF-8 workspace files.",
    inputSchema: schema(
      {
        pattern: string,
        path: string,
        glob: string,
        output_mode: { enum: ["content", "files_with_matches", "count"] },
        head_limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
      },
      ["pattern"],
    ),
  },
  { name: "ls", description: "List a workspace directory.", inputSchema: schema({ path: string }) },
  {
    name: "command",
    description: "Run a foreground command in the workspace.",
    inputSchema: schema(
      {
        command: string,
        timeout: { type: "integer", minimum: 1 },
        description: string,
        run_in_background: { type: "boolean" },
      },
      ["command"],
    ),
  },
];

const SAFE_ENVIRONMENT = { LANG: "C.UTF-8" };
const DEFAULT_OUTPUT = 16 * 1024;
const DEFAULT_READ = 30 * 1024;
const DEFAULT_TIMEOUT = 120_000;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
// Caller-supplied variables are deliberately narrow. Provider credentials may use new names
// or mixed case; only the Task scratch path and the bridge's own locale are needed remotely.
const SAFE_CALLER_ENVIRONMENT = new Set(["SUPERTAG_SCRATCH_DIR", "LC_ALL"]);

const READ_LINES = `
BEGIN { next_offset = start; emitted = 0; bytes = 0; truncated = 0; more = 0 }
NR >= start {
  if (emitted >= limit) { more = 1; exit }
  separator = emitted > 0 ? 1 : 0
  size = length($0) + separator
  if (bytes + size > budget) {
    truncated = 1
    more = 1
    if (emitted == 0) {
      printf "%s", substr($0, 1, budget)
      next_offset = NR + 1
    } else next_offset = NR
    exit
  }
  if (separator) printf "\\n"
  printf "%s", $0
  bytes += size
  emitted++
  next_offset = NR + 1
}
END {
  if (more) printf "NEXT_OFFSET=%d;TRUNCATED=%d\\n", next_offset, truncated > "/dev/stderr"
}`;

function field(input: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = input[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value))
    throw new Error(`${name} must be a non-empty string`);
  return value;
}
function integer(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error("Invalid numeric tool argument");
  return Math.min(value as number, maximum);
}
/**
 * Whether a path relative to a root names Git metadata. SuperTag runs `git` in the workspace and
 * its copies outside any sandbox, so no write tool may change it. Case-insensitive, because a
 * macOS or Windows filesystem treats `.GIT` as `.git`.
 */
function gitMetadata(relativePath: string): boolean {
  return relativePath.split("/").some((part) => part.toLowerCase() === ".git");
}
function contained(root: string, path: string): boolean {
  return path === root || path.startsWith(root === "/" ? root : `${root}/`);
}
function bounded(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  const marker = "\n[truncated]";
  if (bytes <= marker.length) return marker.slice(0, bytes);
  let prefix = buffer.subarray(0, bytes - marker.length).toString("utf8");
  while (Buffer.byteLength(prefix) + marker.length > bytes) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}
function readContinuation(nextOffset: string, truncated: boolean, maxBytes: number): string {
  const candidates = truncated
    ? [
        `[read truncated; next offset: ${nextOffset}]`,
        `[truncated; next: ${nextOffset}]`,
        `[next:${nextOffset}]`,
      ]
    : [
        `[more lines; next offset: ${nextOffset}]`,
        `[more; next: ${nextOffset}]`,
        `[next:${nextOffset}]`,
      ];
  const marker = candidates.find((candidate) => Buffer.byteLength(candidate) <= maxBytes);
  if (!marker) throw new Error("maxOutputBytes is too small to report the next read offset");
  return marker;
}
function globMatcher(pattern: string): (path: string) => boolean {
  if (pattern.length > 512) throw new Error("Glob pattern exceeds 512 characters");
  const characters = [...pattern];
  const tokens: string[] = [];
  let wildcards = 0;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] as string;
    if (character === "*" || character === "?") {
      if (++wildcards > 64) throw new Error("Glob pattern exceeds 64 wildcards");
      if (character === "*" && characters[index + 1] === "*") {
        tokens.push("**");
        index++;
        wildcards++;
      } else tokens.push(character);
    } else tokens.push(character);
  }
  if (wildcards > 64) throw new Error("Glob pattern exceeds 64 wildcards");
  // Dynamic programming over token and path positions avoids regex backtracking.
  const close = (states: boolean[]) => {
    for (let index = 0; index < tokens.length; index++)
      if (states[index] && (tokens[index] === "*" || tokens[index] === "**"))
        states[index + 1] = true;
  };
  return (path) => {
    let states = Array<boolean>(tokens.length + 1).fill(false);
    states[0] = true;
    close(states);
    for (const character of path) {
      const next = Array<boolean>(tokens.length + 1).fill(false);
      for (let index = 0; index < tokens.length; index++) {
        if (!states[index]) continue;
        const token = tokens[index];
        if (token === "**" || (token === "*" && character !== "/")) next[index] = true;
        else if (token === character || (token === "?" && character !== "/"))
          next[index + 1] = true;
      }
      close(next);
      states = next;
    }
    return states[tokens.length] === true;
  };
}

export function createWorkspaceToolBridge(
  options: Omit<SplitExecutionBridgeOptions, "environment"> & {
    environment: Pick<ExecutionEnvironment, "rootDirectory" | "resolvePath" | "read" | "spawn">;
  },
): SplitExecutionBridge {
  const { environment, permissions } = options;
  const root = environment.resolvePath(options.workspaceRoot);
  const environmentRoot = environment.resolvePath(environment.rootDirectory);
  const memoryRoot =
    options.memoryRoot === undefined ? undefined : environment.resolvePath(options.memoryRoot);
  const roots = [
    { path: root, writable: true },
    ...(memoryRoot === undefined ? [] : [{ path: memoryRoot, writable: true }]),
    ...(options.outputDirectory === undefined
      ? []
      : [{ path: environment.resolvePath(options.outputDirectory), writable: true }]),
    ...(options.writableRoots ?? []).map((path) => ({
      path: environment.resolvePath(path),
      writable: true,
    })),
    ...(options.readOnlyRoots ?? []).map((path) => ({
      path: environment.resolvePath(path),
      writable: false,
    })),
  ].sort((left, right) => right.path.length - left.path.length);
  const scope = new FileScopeRules(options.fileScope);
  /** Whether `path` is in the Workspace itself, outside every longer root such as a copy. */
  const workspaceRelative = (path: string): string | undefined => {
    const selected = roots.find(({ path: allowed }) => contained(allowed, path));
    return selected?.path === root ? posix.relative(root, path) : undefined;
  };
  const visible = (path: string) => {
    const relativePath = workspaceRelative(path);
    return relativePath === undefined || !scope.hidden(relativePath);
  };
  const maxOutput = options.limits?.maxOutputBytes ?? DEFAULT_OUTPUT;
  const maxRead = options.limits?.maxReadBytes ?? DEFAULT_READ;
  const maxTimeout = options.limits?.commandTimeoutMs ?? DEFAULT_TIMEOUT;
  if (![maxOutput, maxRead, maxTimeout].every((limit) => Number.isSafeInteger(limit) && limit > 0))
    throw new Error("Split execution limits must be positive");
  const running = new Set<ProcessHandle>();
  const spawning = new Set<Promise<ProcessHandle>>();
  const commandEnvironment = {
    ...SAFE_ENVIRONMENT,
    ...Object.fromEntries(
      Object.entries(options.commandEnvironment ?? {}).filter(([name]) =>
        SAFE_CALLER_ENVIRONMENT.has(name),
      ),
    ),
  };
  const physicalRoots = new Map<string, Promise<string>>();
  let physicalEnvironmentRoot: Promise<string> | undefined;
  let disposed = false;
  const filesRead = permissions.filesRead !== false;
  const memory = memoryRoot !== undefined;
  const available = workspaceToolDefinitions.filter(
    ({ name }) =>
      ((name !== "write" && name !== "edit") || permissions.filesWrite || memory) &&
      (!["read", "glob", "grep", "ls"].includes(name) || filesRead || memory) &&
      (name !== "command" || (permissions.filesWrite && permissions.commandsExecute)),
  );

  async function run(
    spec: ProcessSpec,
    signal?: AbortSignal,
  ): Promise<import("./index.js").ProcessResult> {
    if (disposed) throw new Error("Split execution bridge is disposed");
    signal?.throwIfAborted();
    const start = environment.spawn(
      {
        ...spec,
        environment: {
          ...commandEnvironment,
          ...Object.fromEntries(
            Object.entries(spec.environment ?? {}).filter(([name]) =>
              SAFE_CALLER_ENVIRONMENT.has(name),
            ),
          ),
        },
        replaceEnvironment: true,
        timeoutMs: Math.min(spec.timeoutMs ?? maxTimeout, maxTimeout),
      },
      signal,
    );
    spawning.add(start);
    let process: ProcessHandle;
    try {
      process = await start;
    } finally {
      spawning.delete(start);
    }
    running.add(process);
    const abort = () => process.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || disposed) abort();
    try {
      return await process.wait();
    } finally {
      running.delete(process);
      signal?.removeEventListener("abort", abort);
    }
  }
  async function checked(
    spec: ProcessSpec,
    signal?: AbortSignal,
    exits: readonly number[] = [0],
  ): Promise<SplitExecutionToolResult> {
    const result = await run(spec, signal);
    const output = bounded([result.stdout, result.stderr].filter(Boolean).join("\n"), maxOutput);
    return {
      text: bounded(
        result.exitCode === null || !exits.includes(result.exitCode)
          ? `Execution failed (exit ${result.exitCode ?? result.signal ?? "unknown"}): ${output}`
          : output || "(no output)",
        maxOutput,
      ),
      isError: result.exitCode === null || !exits.includes(result.exitCode),
    };
  }
  async function realPath(path: string, signal?: AbortSignal): Promise<string> {
    // Resolve existing ancestors inside the execution environment, including symlinks.
    // The sentinel preserves whitespace removed by shell command substitution.
    const result = await run(
      {
        command: "sh",
        args: [
          "-c",
          `target=$1; suffix=''; while [ ! -e "$target" ] && [ ! -L "$target" ]; do suffix="/$(basename "$target")$suffix"; target=$(dirname "$target"); done; resolved=$(realpath "$target" && printf x) || exit 1; resolved=\${resolved%??}; printf '%s%s\\n' "$resolved" "$suffix"`,
          "split-path",
          path,
        ],
      },
      signal,
    );
    if (result.exitCode !== 0 || !result.stdout.startsWith("/") || !result.stdout.endsWith("\n"))
      throw new Error(`Cannot resolve execution path: ${path}`);
    return result.stdout.slice(0, -1);
  }
  async function resolvePath(
    inputPath: string,
    signal?: AbortSignal,
    write = false,
  ): Promise<string> {
    if (!inputPath.trim() || /[\r\n\0]/u.test(inputPath))
      throw new Error("Execution path must be non-empty and contain no control characters");
    if (inputPath.split("/").includes(".."))
      throw new Error(`Execution path escapes workspace or allowed roots: ${inputPath}`);
    const candidate = environment.resolvePath(
      posix.isAbsolute(inputPath) ? inputPath : posix.join(root, inputPath),
    );
    const selected = roots.find(({ path }) => contained(path, candidate));
    if (!selected)
      throw new Error(`Execution path escapes workspace or allowed roots: ${inputPath}`);
    // The memory folder is the Tag's own; everything else follows the Task's file permissions.
    if (selected.path !== memoryRoot) {
      if (write && !permissions.filesWrite) throw new Error("files:write permission is required");
      if (!write && !filesRead) throw new Error("files:read permission is required");
    }
    if (write && !selected.writable) throw new Error(`Execution path is read-only: ${inputPath}`);
    if (!contained(environmentRoot, selected.path))
      throw new Error(`Execution root escapes environment: ${selected.path}`);
    physicalEnvironmentRoot ??= realPath(environmentRoot, signal).catch((error: unknown) => {
      physicalEnvironmentRoot = undefined;
      throw error;
    });
    let physicalRootPromise = physicalRoots.get(selected.path);
    physicalRootPromise ??= realPath(selected.path, signal).catch((error: unknown) => {
      physicalRoots.delete(selected.path);
      throw error;
    });
    physicalRoots.set(selected.path, physicalRootPromise);
    const [physicalEnvironment, physicalRoot, physicalPath] = await Promise.all([
      physicalEnvironmentRoot,
      physicalRootPromise,
      realPath(candidate, signal),
    ]);
    if (
      physicalRoot !==
      posix.join(physicalEnvironment, posix.relative(environmentRoot, selected.path))
    )
      throw new Error(`Execution root is redirected: ${selected.path}`);
    if (!contained(physicalRoot, physicalPath))
      throw new Error(`Execution path escapes workspace or allowed roots: ${inputPath}`);
    if (
      write &&
      (gitMetadata(posix.relative(selected.path, candidate)) ||
        gitMetadata(posix.relative(physicalRoot, physicalPath)))
    )
      throw new Error(`Execution path is Git metadata: ${inputPath}`);
    if (selected.path === root && !scope.empty) {
      for (const relativePath of [
        posix.relative(selected.path, candidate),
        posix.relative(physicalRoot, physicalPath),
      ]) {
        const denial = write ? scope.writeDenial(relativePath) : scope.readDenial(relativePath);
        if (denial) throw new Error(`Execution path is ${describeDenial(denial)}: ${inputPath}`);
      }
    }
    if (write) {
      for (const readonlyRoot of roots.filter((allowed) => !allowed.writable)) {
        const resolvedReadOnlyRoot = await realPath(readonlyRoot.path, signal);
        if (contained(resolvedReadOnlyRoot, physicalPath))
          throw new Error(`Execution path is read-only: ${inputPath}`);
      }
    }
    // Use the resolved path, expressed under the lexical root the environment confines to,
    // so a symlink swapped in after the check cannot redirect the read or write.
    return posix.join(selected.path, posix.relative(physicalRoot, physicalPath));
  }
  async function write(
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<SplitExecutionToolResult> {
    const destination = await resolvePath(path, signal, true);
    const result = await checked(
      {
        command: "sh",
        args: ["-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "split-write", destination],
        cwd: root,
        stdin: content,
      },
      signal,
    );
    return result.isError ? result : { text: bounded(`Wrote ${path}`, maxOutput), isError: false };
  }
  async function invoke(
    name: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SplitExecutionToolResult> {
    if (disposed) throw new Error("Split execution bridge is disposed");
    signal?.throwIfAborted();
    if (!workspaceToolDefinitions.some((definition) => definition.name === name))
      throw new Error(`Unknown split execution tool: ${name}`);
    if ((name === "write" || name === "edit") && !permissions.filesWrite && !memory)
      throw new Error("files:write permission is required");
    if (name === "command" && (!permissions.filesWrite || !permissions.commandsExecute))
      throw new Error("files:write and commands:execute permissions are required");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Tool input must be an object");
    const input = value as Record<string, unknown>;
    if (name === "read") {
      const path = await resolvePath(field(input, "file_path") as string, signal);
      const start = integer(input["offset"], 1, 1_000_000, 1);
      const limit = integer(input["limit"], 2_000, 10_000, 1);
      const largestOffset = String(start + limit);
      const reserve =
        Math.max(
          readContinuation(largestOffset, true, maxOutput).length,
          readContinuation(largestOffset, false, maxOutput).length,
        ) + 1;
      const budget = Math.min(maxRead, Math.max(0, maxOutput - reserve));
      const result = await run(
        {
          command: "awk",
          args: [
            "-v",
            `start=${start}`,
            "-v",
            `limit=${limit}`,
            "-v",
            `budget=${budget}`,
            READ_LINES,
            path,
          ],
          cwd: root,
          environment: { LC_ALL: "C" },
        },
        signal,
      );
      if (result.exitCode !== 0)
        return {
          text: bounded(`Execution failed (exit ${result.exitCode}): ${result.stderr}`, maxOutput),
          isError: true,
        };
      const continuation = /^NEXT_OFFSET=(\d+);TRUNCATED=([01])\s*$/u.exec(result.stderr);
      const marker = continuation
        ? readContinuation(continuation[1] as string, continuation[2] === "1", maxOutput)
        : "";
      return {
        text: bounded(
          `${result.stdout || (marker ? "" : "(no output)")}${marker && result.stdout ? "\n" : ""}${marker}`,
          maxOutput,
        ),
        isError: false,
      };
    }
    if (name === "write")
      return write(
        field(input, "file_path") as string,
        field(input, "content", false) ?? "",
        signal,
      );
    if (name === "edit") {
      const path = field(input, "file_path") as string;
      const originalPath = await resolvePath(path, signal, true);
      const original = await environment.read(originalPath);
      if (Buffer.byteLength(original) > MAX_EDIT_BYTES)
        throw new Error(`File exceeds split execution edit limit (${MAX_EDIT_BYTES} bytes)`);
      const oldString = field(input, "old_string") as string;
      const newString = field(input, "new_string", false) ?? "";
      const count = original.split(oldString).length - 1;
      if (!count) throw new Error("old_string was not found");
      if (count !== 1 && input["replace_all"] !== true)
        throw new Error("old_string is not unique; set replace_all");
      const result = await write(
        path,
        input["replace_all"] === true
          ? original.split(oldString).join(newString)
          : original.replace(oldString, () => newString),
        signal,
      );
      return result.isError
        ? result
        : { text: bounded(`Edited ${path}`, maxOutput), isError: false };
    }
    if (name === "glob" || name === "grep" || name === "ls") {
      const path = await resolvePath(field(input, "path", false) ?? ".", signal);
      if (name === "ls") {
        const listing = await checked(
          { command: "ls", args: ["-la", "--", path], cwd: root },
          signal,
        );
        if (
          listing.isError ||
          !scope.hiddenEntries.length ||
          !scope.mayContainHidden(posix.relative(root, path))
        )
          return listing;
        // Leave out the rows of hidden entries directly inside the listed directory.
        const children = await run(
          {
            command: "find",
            args: [path, "-mindepth", "1", "-maxdepth", "1", "-print0"],
            cwd: root,
          },
          signal,
        );
        if (children.exitCode !== 0) throw new Error("Cannot list the directory's entries");
        const hiddenNames = children.stdout
          .split("\0")
          .filter((child) => child && !visible(child))
          .map((child) => posix.basename(child));
        return {
          text:
            listing.text
              .split("\n")
              .filter(
                (row) =>
                  !hiddenNames.some(
                    (hiddenName) =>
                      row.endsWith(` ${hiddenName}`) || row.includes(` ${hiddenName} -> `),
                  ),
              )
              .join("\n") || "(no output)",
          isError: false,
        };
      }
      if (name === "glob") {
        const pattern = globMatcher(field(input, "pattern") as string);
        const searchRoot =
          roots.find(({ path: allowed }) => contained(allowed, path))?.path ?? root;
        const result = await checked(
          { command: "find", args: [path, "-type", "f", "-print"], cwd: root },
          signal,
        );
        if (result.isError) return result;
        const truncated = result.text.includes("[truncated]");
        const lines = result.text
          .split("\n")
          .filter(
            (file) =>
              contained(path, file) && visible(file) && pattern(posix.relative(searchRoot, file)),
          );
        return {
          text:
            bounded(
              `${lines
                .map((file) => posix.relative(searchRoot, file))
                .slice(0, 2_000)
                .join("\n")}${truncated ? "\n[truncated]" : ""}`,
              maxOutput,
            ) || "(no output)",
          isError: false,
        };
      }
      const pattern = field(input, "pattern") as string;
      const mode = input["output_mode"];
      if (mode !== undefined && !["content", "files_with_matches", "count"].includes(String(mode)))
        throw new Error("Invalid output_mode");
      const filtered = !scope.empty && scope.mayContainHidden(posix.relative(root, path));
      const args = [
        "-r",
        mode === "files_with_matches" ? "-l" : mode === "count" ? "-c" : "-n",
        // Under a path scope, name each file and end its name with a NUL byte, so results from
        // hidden files can be left out whatever their names contain.
        ...(filtered ? ["-H", "--null"] : []),
        ...(input["glob"] === undefined ? [] : [`--include=${field(input, "glob")}`]),
        "--",
        pattern,
        path,
      ];
      let result: SplitExecutionToolResult;
      if (filtered) {
        const raw = await run({ command: "grep", args, cwd: root }, signal);
        if (raw.exitCode === null || ![0, 1].includes(raw.exitCode))
          return {
            text: bounded(
              `Execution failed (exit ${raw.exitCode ?? raw.signal ?? "unknown"}): ${raw.stderr}`,
              maxOutput,
            ),
            isError: true,
          };
        const rows =
          mode === "files_with_matches"
            ? raw.stdout
                .split(/[\0\n]/u)
                .filter((file) => file && contained(root, file) && visible(file))
            : raw.stdout.split("\n").flatMap((line) => {
                let end = line.indexOf("\0");
                // BSD grep ignores --null with -c and prints `file:count`.
                if (end < 0 && mode === "count" && /:\d+$/u.test(line)) end = line.lastIndexOf(":");
                if (end < 0) return [];
                const file = line.slice(0, end);
                return contained(root, file) && visible(file)
                  ? [`${file}:${line.slice(end + 1)}`]
                  : [];
              });
        result = { text: bounded(rows.join("\n") || "(no output)", maxOutput), isError: false };
      } else {
        result = await checked({ command: "grep", args, cwd: root }, signal, [0, 1]);
        if (result.isError) return result;
      }
      const offset = integer(input["offset"], 0, 1_000_000);
      const limit = integer(input["head_limit"], 2_000, 10_000, 1);
      return {
        text: bounded(
          result.text
            .split("\n")
            .slice(offset, offset + limit)
            .join("\n"),
          maxOutput,
        ),
        isError: false,
      };
    }
    if (input["run_in_background"] === true)
      throw new Error("Background commands are not supported");
    const command = field(input, "command") as string;
    return checked(
      {
        command: "sh",
        args: ["-lc", command],
        cwd: root,
        timeoutMs: integer(input["timeout"], maxTimeout, maxTimeout, 1),
      },
      signal,
    );
  }
  return {
    tools: available,
    call: invoke,
    async cancelAll() {
      await Promise.allSettled([...spawning]);
      await Promise.all(
        [...running].map(async (process) => {
          process.kill();
          try {
            await process.wait();
          } catch {
            /* cancellation may reject */
          }
        }),
      );
    },
    async dispose() {
      disposed = true;
      await this.cancelAll();
    },
  };
}
