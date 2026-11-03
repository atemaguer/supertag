import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseWorkspaceName } from "@supertag/core";
import type { GitWorkspaceCheckout } from "@supertag/worker-sdk";

export interface WorkletWorkspaces {
  /** The unnamed `--workspace PATH`: the folder Tasks without a Workspace may inspect. */
  readonly defaultPath?: string;
  /** Named Workspace checkouts from `--workspace NAME=PATH`. */
  readonly checkouts: readonly GitWorkspaceCheckout[];
}

/**
 * Splits repeated `--workspace` values. `NAME=PATH` declares a checkout of Workspace NAME; any
 * other value is the unnamed default folder, which keeps its original meaning. A leading `~`
 * expands, since shells do not expand it after `=`.
 */
export function parseWorkletWorkspaces(
  values: readonly string[] | undefined,
  base = process.cwd(),
): WorkletWorkspaces {
  let defaultPath: string | undefined;
  const checkouts: GitWorkspaceCheckout[] = [];
  for (const value of values ?? []) {
    const separator = value.indexOf("=");
    const name = separator > 0 ? value.slice(0, separator) : undefined;
    if (name !== undefined && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(name)) {
      const path = value.slice(separator + 1);
      if (!path) throw new Error(`--workspace ${name}= needs a checkout path`);
      if (checkouts.some((checkout) => checkout.name === name))
        throw new Error(`--workspace ${name} is declared more than once`);
      checkouts.push({ name: parseWorkspaceName(name), path: expandPath(path, base) });
      continue;
    }
    if (name !== undefined && /^[A-Za-z0-9_-]+$/u.test(name))
      throw new Error(
        `--workspace ${name}=... names an invalid Workspace; use lowercase letters, digits, hyphens, or underscores`,
      );
    if (defaultPath !== undefined)
      throw new Error("Only one unnamed --workspace PATH may be given; name the others NAME=PATH");
    defaultPath = expandPath(value, base);
  }
  return { ...(defaultPath === undefined ? {} : { defaultPath }), checkouts };
}

function expandPath(path: string, base: string): string {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** Fails fast when a declared checkout is missing or is not a git repository. */
export async function assertGitCheckouts(checkouts: readonly GitWorkspaceCheckout[]) {
  for (const checkout of checkouts) {
    const status = await stat(checkout.path).catch(() => undefined);
    if (!status?.isDirectory())
      throw new Error(`Workspace ${checkout.name} checkout ${checkout.path} is not a directory`);
    const inside = await new Promise<string>((done) =>
      execFile(
        "git",
        ["-C", checkout.path, "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf8" },
        (error, stdout) => done(error ? "" : stdout.trim()),
      ),
    );
    if (inside !== "true")
      throw new Error(
        `Workspace ${checkout.name} checkout ${checkout.path} is not a git repository. SuperTag serves only git checkouts as Workspaces; run git init there or declare a git checkout.`,
      );
  }
}
