import { lstat, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/**
 * A Task's path scope, as the Control Plane composed it from its Permission Sets. Workspace
 * entries are relative to the Workspace root. The semantics match `supertag_protocol::file_scope`
 * exactly; both run `core/crates/protocol/testdata/file_scope_vectors.json`.
 */
export interface FileScopeLike {
  readonly write: readonly string[];
  readonly readOnly: readonly string[];
  readonly hidden: readonly string[];
  readonly outsideWrite: readonly string[];
  readonly outsideRead: readonly string[];
}

export type FileScopeDenial = "hidden" | "read-only" | "outside-write";

export function describeDenial(denial: FileScopeDenial): string {
  switch (denial) {
    case "hidden":
      return "hidden by the Task's path scope";
    case "read-only":
      return "read-only in the Task's path scope";
    case "outside-write":
      return "outside the paths the Task may write";
  }
}

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".");
}

/** `*` matches any run within a segment and `?` one character. */
function segmentMatches(pattern: string, segment: string, fold: boolean): boolean {
  const f = (value: string) => (fold ? asciiLower(value) : value);
  const p = [...f(pattern)];
  const s = [...f(segment)];
  const close = (states: boolean[]) => {
    for (let index = 0; index < p.length; index++)
      if (states[index] && p[index] === "*") states[index + 1] = true;
  };
  let states = Array<boolean>(p.length + 1).fill(false);
  states[0] = true;
  close(states);
  for (const character of s) {
    const next = Array<boolean>(p.length + 1).fill(false);
    for (let index = 0; index < p.length; index++) {
      if (!states[index]) continue;
      const token = p[index];
      if (token === "*") next[index] = true;
      else if (token === "?" || token === character) next[index + 1] = true;
    }
    close(next);
    states = next;
  }
  return states[p.length] === true;
}

/** ASCII-only case folding, as the Rust matcher does. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function step(pattern: readonly string[], states: boolean[], segment: string, fold: boolean) {
  const next = Array<boolean>(pattern.length + 1).fill(false);
  for (let index = 0; index < pattern.length; index++) {
    if (!states[index]) continue;
    const token = pattern[index] as string;
    if (token === "**") next[index] = true;
    else if (segmentMatches(token, segment, fold)) next[index + 1] = true;
  }
  closeSegments(pattern, next);
  return next;
}

function closeSegments(pattern: readonly string[], states: boolean[]) {
  for (let index = 0; index < pattern.length; index++)
    if (states[index] && pattern[index] === "**") states[index + 1] = true;
}

function start(pattern: readonly string[]): boolean[] {
  const states = Array<boolean>(pattern.length + 1).fill(false);
  states[0] = true;
  closeSegments(pattern, states);
  return states;
}

/** Whether `pattern` matches `path` or one of its ancestors. */
function matchesSubtree(pattern: readonly string[], path: readonly string[], fold: boolean) {
  let states = start(pattern);
  for (const segment of path) {
    states = step(pattern, states, segment, fold);
    if (states[pattern.length]) return true;
  }
  return false;
}

/** The Workspace part of a scope, matching Workspace-relative, `/`-separated paths. */
export class FileScopeRules {
  readonly write: readonly string[];
  readonly readOnly: readonly string[];
  readonly hiddenEntries: readonly string[];

  constructor(scope: Partial<Pick<FileScopeLike, "write" | "readOnly" | "hidden">> = {}) {
    this.write = scope.write ?? [];
    this.readOnly = scope.readOnly ?? [];
    this.hiddenEntries = scope.hidden ?? [];
  }

  get empty(): boolean {
    return !this.write.length && !this.readOnly.length && !this.hiddenEntries.length;
  }

  hidden(path: string): boolean {
    const parts = segments(path);
    return this.hiddenEntries.some((pattern) => matchesSubtree(segments(pattern), parts, true));
  }

  readDenial(path: string): FileScopeDenial | undefined {
    return this.hidden(path) ? "hidden" : undefined;
  }

  writeDenial(path: string): FileScopeDenial | undefined {
    if (this.hidden(path)) return "hidden";
    const parts = segments(path);
    if (this.readOnly.some((entry) => matchesSubtree(segments(entry), parts, true)))
      return "read-only";
    if (
      this.write.length &&
      !this.write.some((entry) => matchesSubtree(segments(entry), parts, false))
    )
      return "outside-write";
    return undefined;
  }

  /** Whether some path inside the directory `path` could be hidden. */
  mayContainHidden(path: string): boolean {
    const parts = segments(path);
    return this.hiddenEntries.some((entry) => {
      const pattern = segments(entry);
      let states = start(pattern);
      for (const segment of parts) {
        if (states[pattern.length]) return true;
        states = step(pattern, states, segment, true);
      }
      return states.some(Boolean);
    });
  }
}

export function fileScopeEmpty(scope: FileScopeLike | undefined): boolean {
  return (
    !scope ||
    (!scope.write.length &&
      !scope.readOnly.length &&
      !scope.hidden.length &&
      !scope.outsideWrite.length &&
      !scope.outsideRead.length)
  );
}

interface TaskLike {
  readonly allowedActions: readonly string[];
  readonly workspace?: unknown;
  readonly policySnapshot?:
    | { readonly runtimeAuthority?: { readonly files?: FileScopeLike | undefined } | undefined }
    | undefined;
}

/** The accepted Task's scope, or `undefined` when it has none. */
export function fileScopeOf(task: TaskLike): FileScopeLike | undefined {
  const scope = task.policySnapshot?.runtimeAuthority?.files;
  return fileScopeEmpty(scope) ? undefined : scope;
}

/** A harness adapter and, for Cursor, where its tools run. */
export type ScopedHarness =
  | "claude-code"
  | "opencode"
  | "cursor-local"
  | "cursor-remote"
  | "cursor-shared";

const HARNESS_NAMES: Record<ScopedHarness, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  "cursor-local": "Cursor",
  "cursor-remote": "Cursor",
  "cursor-shared": "Cursor",
};

function listed(values: readonly string[]): string {
  const shown = values.slice(0, 4);
  if (values.length > shown.length) shown.push("…");
  return shown.join(", ");
}

/**
 * Why this harness cannot apply the Task's scope, or `undefined`. Mirrors
 * `supertag_protocol::file_scope::reason`, which also keeps such Tasks from being claimed.
 */
export function fileScopeRefusal(task: TaskLike, harness: ScopedHarness): string | undefined {
  const scope = fileScopeOf(task);
  if (!scope) return undefined;
  const name = HARNESS_NAMES[harness];
  const commands = task.allowedActions.includes("commands:execute");
  const restrictedWrite = scope.write.length > 0 || scope.readOnly.length > 0;
  if (harness.startsWith("cursor-")) {
    if (scope.outsideWrite.length || scope.outsideRead.length)
      return "Cursor's tools reach only the Workspace, so it cannot grant additionalDirectories; run the Tag on Codex, Claude Code, or OpenCode";
    if (harness === "cursor-shared" && commands && (restrictedWrite || scope.hidden.length))
      return "Cursor shared execution cannot keep commands inside a path scope; remove commands:execute or the path scope from the Tag's Permission Sets";
    if (harness === "cursor-local")
      return "Cursor's local tools cannot apply path scopes yet; run the Tag on a Worker Host with a remote Cursor Workspace or shared execution, or on Codex";
    return undefined;
  }
  if (commands && scope.hidden.length)
    return `${name} cannot keep commands from reading hidden paths (${listed(scope.hidden)}); run the Tag on Codex, or remove commands:execute from its Permission Sets`;
  if (commands && restrictedWrite && task.workspace === undefined)
    return `${name} cannot keep commands inside the write paths without a Workspace whose changes it checks at delivery; run the Tag on Codex, give the Task a Workspace, or remove commands:execute`;
  return undefined;
}

export interface OutsideDirectories {
  /** Canonical directories the Task may write. */
  readonly write: readonly string[];
  /** Canonical directories the Task may only read. */
  readonly read: readonly string[];
}

function overlaps(left: string, right: string): boolean {
  const inside = (root: string, path: string) => {
    const part = relative(root, path);
    return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
  };
  return inside(left, right) || inside(right, left);
}

/**
 * Expand and verify the scope's outside directories. `~/` is the Worker Host user's home from
 * the password database, not `$HOME`, which adapters point at private harness state. Each must
 * exist as a directory, and none may overlap the Workspace, its Git metadata, or `reserved`
 * (the harness's private configuration and home directories).
 */
export async function resolveOutsideDirectories(
  scope: FileScopeLike | undefined,
  workspace: string,
  reserved: readonly string[] = [],
): Promise<OutsideDirectories> {
  if (!scope) return { write: [], read: [] };
  const home = userInfo().homedir;
  const canonicalWorkspace = await realpath(workspace);
  const protectedRoots = [canonicalWorkspace, workspace];
  for (const path of reserved.filter(Boolean)) {
    protectedRoots.push(path);
    try {
      protectedRoots.push(await realpath(path));
    } catch {
      // A reserved directory that does not exist yet still reserves its lexical path.
    }
  }
  const resolveEntry = async (entry: string): Promise<string> => {
    const expanded = entry.startsWith("~/") ? join(home, entry.slice(2)) : entry;
    if (!isAbsolute(expanded) || expanded.includes("\0"))
      throw new Error(`Path scope directory ${entry} is not absolute`);
    let canonical: string;
    try {
      canonical = await realpath(expanded);
    } catch {
      throw new Error(`Path scope directory ${entry} does not exist on this Worker Host`);
    }
    if (!(await stat(canonical)).isDirectory())
      throw new Error(`Path scope directory ${entry} is not a directory`);
    if (protectedRoots.some((root) => overlaps(root, canonical)))
      throw new Error(
        `Path scope directory ${entry} overlaps the Workspace or harness state on this Worker Host`,
      );
    const homeInside = relative(canonical, home);
    if (homeInside === "" || (!homeInside.startsWith("..") && !isAbsolute(homeInside)))
      throw new Error(`Path scope directory ${entry} is or contains the home directory`);
    // Git metadata anywhere on the path stays read-only.
    if (canonical.split("/").some((part) => part.toLowerCase() === ".git"))
      throw new Error(`Path scope directory ${entry} is Git metadata`);
    const supertagState = await lstat(join(canonical, ".supertag")).then(
      () => true,
      () => false,
    );
    if (supertagState) throw new Error(`Path scope directory ${entry} holds SuperTag state`);
    return canonical;
  };
  const write = await Promise.all(scope.outsideWrite.map(resolveEntry));
  const read = await Promise.all(scope.outsideRead.map(resolveEntry));
  return {
    write: [...new Set(write)],
    read: [...new Set(read.filter((path) => !write.includes(path)))],
  };
}
