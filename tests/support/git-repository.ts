import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolates git from the developer's configuration: no system or global config, hooks, or
 * signing. Returns a restore function for the environment it changed.
 */
export async function isolateGitConfiguration(): Promise<() => void> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-git-config-"));
  const global = join(directory, "gitconfig");
  await writeFile(global, "[user]\n\tname = Test User\n\temail = test@example.com\n");
  const keys = [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_NAME",
  ];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env["GIT_CONFIG_GLOBAL"] = global;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  delete process.env["GIT_AUTHOR_NAME"];
  delete process.env["GIT_COMMITTER_NAME"];
  return () => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A repository on `main` with one commit and a .gitignore that ignores `*.log`. */
export async function createRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "supertag-checkout-"));
  git(path, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(path, "README.md"), "# App\n");
  await writeFile(join(path, ".gitignore"), "*.log\n");
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "Initial commit");
  return path;
}
