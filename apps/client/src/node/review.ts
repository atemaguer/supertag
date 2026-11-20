/**
 * Reviewing a Work Session's delivery on this machine: `git diff BASE...HEAD` in a checkout of
 * the Workspace (the Gateway keeps no repository contents), fetching the branch from the
 * checkout's `origin` (or its first remote) when the checkout lacks it, and opening its pull
 * request in the browser. Git runs without a terminal, so a fetch that needs credentials fails
 * instead of prompting.
 */
import { execFile, spawn } from "node:child_process";
import type { WorkBranch, WorkDiff } from "../model/coordination";

const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 16 << 20;

export type Git = (directory: string, args: string[], timeoutMs: number) => Promise<string>;

/** Runs git in `directory` with no terminal prompt; rejects with its first line of stderr. */
export const runGit: Git = (directory, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: directory,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if ((error as { killed?: boolean }).killed) {
          reject("git took too long");
          return;
        }
        const line = stderr.split("\n").find((text) => text.trim() !== "");
        reject(line?.trim() || error.message);
      },
    );
  });

const COMMIT = /^[0-9a-f]{7,64}$/u;
const REF = /^[A-Za-z0-9._/+-]+$/u;

/** Whether `name` is safe to pass to git as a ref: no option, no `..`, no lock file. */
export function validRef(name: string): boolean {
  return (
    REF.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//")
  );
}

/**
 * The diff of what a Work Session delivered, computed in `directory`: from its recorded base
 * commit (or its base branch) to its recorded head commit (or the branch itself).
 */
export async function deliveryDiff(
  directory: string,
  delivered: WorkBranch,
  git: Git = runGit,
): Promise<WorkDiff> {
  const run = (args: string[], timeout = GIT_TIMEOUT_MS) => git(directory, args, timeout);
  if (!directory) return { reason: "The terminal UI could not tell which directory it runs in." };
  try {
    await run(["rev-parse", "--git-dir"]);
  } catch {
    return {
      reason:
        "The current directory is not in a git repository. Start supertag in a checkout of the Workspace to see the diff here.",
    };
  }
  const { branch } = delivered;
  if (!validRef(branch)) return { reason: `The branch name ${branch} cannot be passed to git.` };
  const resolve = async (rev: string) =>
    (await run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).catch(() => "")).trim();
  const remotes: string[] = [];
  for (const remote of (await run(["remote"]).catch(() => "")).split(/\s+/u)) {
    if (remote === "origin") remotes.unshift(remote);
    else if (remote && validRef(remote)) remotes.push(remote);
  }
  const recorded = COMMIT.test(delivered.headCommit);
  let head = "";
  if (recorded) head = await resolve(delivered.headCommit);
  else {
    head = await resolve(`refs/heads/${branch}`);
    for (const remote of remotes)
      if (!head) head = await resolve(`refs/remotes/${remote}/${branch}`);
  }
  const result: WorkDiff = {};
  if (!head) {
    const remote = remotes[0];
    if (!remote) {
      return {
        reason: `This checkout does not have branch ${branch} and has no remote to fetch it from.`,
      };
    }
    try {
      await run(
        ["fetch", "--no-tags", "--quiet", remote, `refs/heads/${branch}`],
        FETCH_TIMEOUT_MS,
      );
    } catch (error) {
      return {
        reason: `This checkout does not have branch ${branch}, and fetching it from ${remote} failed: ${String(error)}`,
      };
    }
    if (recorded) head = await resolve(delivered.headCommit);
    if (!head) {
      head = await resolve("FETCH_HEAD");
      if (recorded) {
        result.note = `The branch no longer has the commit ${delivered.headCommit} the Worker recorded; this is the diff of its current head.`;
      }
    }
    if (!head)
      return { reason: `Fetching branch ${branch} from ${remote} gave no commit to diff.` };
  }
  let base = COMMIT.test(delivered.baseCommit) ? await resolve(delivered.baseCommit) : "";
  const ref = delivered.baseRef;
  if (!base && ref && validRef(ref)) {
    for (const remote of remotes) if (!base) base = await resolve(`refs/remotes/${remote}/${ref}`);
    if (!base) base = await resolve(`refs/heads/${ref}`);
  }
  if (!base) {
    const what = delivered.baseCommit || ref;
    return {
      reason: what
        ? `This checkout does not have the branch's base ${what}.`
        : "The Worker recorded no base for the branch, so there is nothing to diff it against.",
    };
  }
  try {
    result.text = await run(["diff", "--no-color", "--no-ext-diff", `${base}...${head}`]);
  } catch (error) {
    return { reason: `git diff failed: ${String(error)}` };
  }
  return result;
}

/**
 * Opens a web address in the browser: `open` on macOS, `xdg-open` elsewhere, detached in its
 * own session so it outlives the terminal UI and never reads its terminal.
 */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  if (!/^https?:\/\//u.test(url)) throw "Only a web address can be opened.";
  const opener = platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
