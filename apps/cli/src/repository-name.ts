import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { parseWorkspaceSpec } from "@supertag/core";

/**
 * The name a repository goes by: its remote origin's last path segment, else its directory's name.
 * `supertag init` names the Workspace this way, and a new project at the repository's top level
 * takes the same name.
 */
export function workspaceNameFor(origin: string | undefined, root: string): string {
  return originName(origin) ?? (sanitizeName(basename(root)) || "workspace");
}

/** The sanitized last path segment of a remote origin, if it has a usable one. */
export function originName(origin: string | undefined): string | undefined {
  const segment = origin
    ?.replace(/[/\\]+$/u, "")
    .split(/[/:\\]/u)
    .pop()
    ?.replace(/\.git$/u, "");
  return sanitizeName(segment ?? "") || undefined;
}

/** The origin URL as a Workspace source, without credentials; undefined for a local path. */
export function remoteSource(origin: string): string | undefined {
  let source = origin.trim();
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/]/u.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return undefined;
    }
    if (url.protocol === "file:") return undefined;
    if (url.protocol === "https:" || url.protocol === "http:") {
      url.username = "";
      url.password = "";
    }
    source = url.toString();
  }
  try {
    return parseWorkspaceSpec({ source }).source;
  } catch {
    return undefined;
  }
}

/**
 * The origin repository's name when `directory` is the top level of a git checkout with a remote
 * origin. A directory below the top level gets undefined, so two projects in one repository never
 * share a name.
 */
export async function topLevelOriginName(directory: string): Promise<string | undefined> {
  const root = await git(directory, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) return undefined;
  const [top, here] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(directory).catch(() => directory),
  ]);
  if (top !== here) return undefined;
  const origin = await git(root, ["remote", "get-url", "origin"]);
  return origin === undefined ? undefined : originName(remoteSource(origin));
}

/** A name in lowercase letters, digits, hyphens, and underscores, at most 63 characters. */
export function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
}

/** Trimmed standard output of a git command, or undefined when it fails or prints nothing. */
export function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((done) =>
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) =>
      done(error ? undefined : stdout.trim() || undefined),
    ),
  );
}
