/**
 * The local services through the `supertag` CLI. Stand-in CLIs are shell scripts.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  checkSetup,
  failureReason,
  jsonOf,
  localUpgrade,
  MAX_REASON_CHARS,
  older,
  type RestartStep,
  restartLocal,
  runSupertag,
  shouldStart,
  startLocal,
} from "./local-services";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-local-services-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function directory(name: string): Promise<string> {
  const made = path.join(root, name);
  await mkdir(made, { recursive: true });
  return made;
}

async function tool(dir: string, name: string, body = ""): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

it("starts only a set-up machine whose services are stopped", () => {
  // Nothing set up yet, or no CLI to say: first launch belongs to onboarding.
  expect(shouldStart({ running: false, setUp: false })).toBe(false);
  expect(shouldStart(undefined)).toBe(false);
  expect(shouldStart({ running: false, setUp: true })).toBe(true);
  // Already running: just connect.
  expect(shouldStart({ running: true, setUp: true })).toBe(false);
});

it("says what a failed up printed and where the logs are", async () => {
  const dir = await directory("up");
  const state = path.join(dir, "state");
  const failing = await tool(
    dir,
    "failing",
    `test "$1 $2" = 'up --state-directory' || exit 9
echo 'Starting SuperTag'
echo 'Error: Worklet laptop did not report readiness: no Node' >&2
exit 1`,
  );
  const error = await startLocal(failing, state).catch((e: unknown) => e);
  expect(error).toContain("did not report readiness: no Node");
  expect(error).toContain(`Logs: ${path.join(state, "logs")}`);
  expect(String(error).startsWith("Could not start SuperTag:\n")).toBe(true);
  const working = await tool(dir, "working", `test "$1" = up && echo ready`);
  await expect(startLocal(working, state)).resolves.toBeUndefined();
});

it("restarts by stopping then starting the same state directory", async () => {
  const dir = await directory("restart");
  const state = path.join(dir, "state");
  const calls = path.join(dir, "calls");
  const cli = await tool(dir, "supertag", `echo "$*" >> '${calls}'`);
  const steps: RestartStep[] = [];
  await restartLocal(cli, state, {}, (step) => steps.push(step));
  expect(await readFile(calls, "utf8")).toBe(
    `down --state-directory ${state}\nup --state-directory ${state}\n`,
  );
  expect(steps).toEqual(["stopping", "starting"]);

  // A failed down never starts up, and says what down printed.
  await rm(calls);
  await writeFile(
    cli,
    `#!/bin/sh\necho "$*" >> '${calls}'\ntest "$1" = down && echo 'Error: drain Worker Host laptop: timed out' >&2 && exit 1\nexit 0\n`,
  );
  const failed: RestartStep[] = [];
  const error = await restartLocal(cli, state, {}, (step) => failed.push(step)).catch(
    (e: unknown) => e,
  );
  expect(String(error).startsWith("Could not stop SuperTag:\n")).toBe(true);
  expect(error).toContain("drain Worker Host laptop: timed out");
  expect((await readFile(calls, "utf8")).split("\n").filter(Boolean)).toEqual([
    `down --state-directory ${state}`,
  ]);
  expect(failed).toEqual(["stopping"]);
});

it("reads the JSON line after any progress", () => {
  expect(jsonOf('Starting SuperTag…\n{"version":1,"tag":"lead"}\n')?.["tag"]).toBe("lead");
  expect(jsonOf('{\n  "ready": true\n}')?.["ready"]).toBe(true);
  expect(jsonOf("no json here")).toBeUndefined();
});

it("runs the CLI exactly once for a check", async () => {
  const dir = await directory("check");
  const runs = path.join(dir, "runs");
  const cli = await tool(
    dir,
    "supertag",
    `echo "$*" >> '${runs}'\necho '{"version":1,"ready":false}'`,
  );
  const value = await checkSetup(cli, {}, "install", "/tmp/My Project", "codex");
  expect(value).toEqual({ version: 1, ready: false, cli });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await readFile(runs, "utf8")).toBe(
    "init --check --json --directory /tmp/My Project --harness codex\n",
  );
  // A CLI older than the app has no check: it is named as outdated.
  await writeFile(cli, "#!/bin/sh\necho \"error: unexpected argument '--check'\" >&2\nexit 2\n");
  expect(await checkSetup(cli, {}, "install", undefined, undefined)).toEqual({
    cli: null,
    outdated: cli,
    install: "install",
  });
});

it("bounds a failure reason to its last lines", () => {
  expect(
    failureReason({ success: false, stdout: "", stderr: "one\ntwo\n\nthree\nfour\nfive\n" }),
  ).toBe("two three four five");
  const long = failureReason({ success: false, stdout: "x".repeat(2000), stderr: "" });
  expect([...long]).toHaveLength(MAX_REASON_CHARS + 1);
  expect(failureReason({ success: false, stdout: "", stderr: "" })).toBe(
    "The command failed without saying why.",
  );
});

it("offers a restart only to a release that speaks older protocols", async () => {
  expect(older([2], [6])).toBe(true);
  expect(older([2, 5], [6, 7])).toBe(true);
  expect(older([7], [6])).toBe(false);
  expect(older([5, 6], [6])).toBe(false);
  expect(older([], [6])).toBe(false);

  const local = { running: true, stateDirectory: "/s", setUp: true, machineId: null };
  const at = { ...local, url: "http://127.0.0.1:9", token: "t" };
  const peer = (build?: string, versions?: number[]) => async () => ({ build, versions });
  expect(await localUpgrade(at, peer("0.3.0", [5]), [6], "0.3.2")).toEqual({
    running: "0.3.0",
    version: "0.3.2",
  });
  // A newer Gateway, one that names no release, one that agrees, or none running: no offer.
  expect(await localUpgrade(at, peer("0.4.0", [7]), [6], "0.3.2")).toBeNull();
  expect(await localUpgrade(at, peer(undefined, [5]), [6], "0.3.2")).toBeNull();
  expect(await localUpgrade(at, async () => undefined, [6], "0.3.2")).toBeNull();
  expect(await localUpgrade(local, peer("0.3.0", [5]), [6], "0.3.2")).toBeNull();
  expect(
    await localUpgrade(
      at,
      async () => {
        throw new Error("unreachable");
      },
      [6],
      "0.3.2",
    ),
  ).toBeNull();
});

it("runs the CLI with the environment it is given", async () => {
  const dir = await directory("env");
  const cli = await tool(dir, "supertag", 'echo "$SUPERTAG_STATE_DIR $PATH"');
  const env = { SUPERTAG_STATE_DIR: "/tmp/given", PATH: "/usr/bin" };
  const ran = await runSupertag(cli, [], { env, timeoutMs: 5_000 });
  expect(ran.stdout.trim()).toBe("/tmp/given /usr/bin");
  const pathed = await runSupertag(cli, [], { env, path: "/bin", timeoutMs: 5_000 });
  expect(pathed.stdout.trim()).toBe("/tmp/given /bin");
  await expect(runSupertag(path.join(dir, "missing"), [], { timeoutMs: 5_000 })).rejects.toContain(
    "Could not run",
  );
});
