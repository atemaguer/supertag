/**
 * The local services and onboarding, ported from the Tauri app's `local_start.rs`,
 * `onboarding.rs` and `gateway/local.rs` tests. Stand-in CLIs are shell scripts.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseLocalGateway } from "../gateway/local";
import {
  bundledCli,
  cliVersion,
  installCommand,
  isThisApp,
  markedPath,
  PATH_MARK,
  parseVersion,
  selectCli,
  usableCli,
  versionMismatch,
} from "./cli";
import { type LocalDependencies, localHandlers } from "./handlers";
import { checkWith } from "./onboarding";
import { jsonOf, MAX_REASON_CHARS, reason } from "./run";
import {
  addWorkspace,
  localUpgrade,
  older,
  type RestartStep,
  restart,
  shouldStart,
  up,
} from "./services";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-local-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function directory(name: string): Promise<string> {
  const made = path.join(root, name);
  await mkdir(made, { recursive: true });
  return made;
}

async function tool(dir: string, name: string, body = "", mode = 0o755): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return file;
}

const NOT_THE_APP = "/nonexistent/SuperTag";

it("installs this app's release, not the latest", () => {
  expect(installCommand("0.3.2")).toBe(
    "curl -fsSL https://github.com/atemaguer/supertag/releases/download/v0.3.2/install.sh | sh",
  );
});

it("prefers the bundled CLI, then PATH, then the installer's directory", async () => {
  const [app, first, second, installed] = await Promise.all(
    ["select/app", "select/first", "select/second", "select/local-bin"].map(directory),
  );
  const bundled = await tool(app as string, "supertag");
  await tool(first as string, "supertag", "", 0o644); // not executable
  const onPath = await tool(second as string, "supertag");
  const search = ["relative", first, second].join(path.delimiter);
  expect(selectCli(bundled, search, [], NOT_THE_APP)).toBe(bundled);
  expect(selectCli(path.join(app as string, "missing"), search, [], NOT_THE_APP)).toBe(onPath);
  expect(selectCli(undefined, search, [], NOT_THE_APP)).toBe(onPath);
  expect(selectCli(undefined, first, [], NOT_THE_APP)).toBeUndefined();
  expect(selectCli(undefined, undefined, [], NOT_THE_APP)).toBeUndefined();
  // Opened from Finder, PATH lacks the installer's directory: it is looked in last.
  const linked = await tool(installed as string, "supertag");
  expect(selectCli(undefined, "/usr/bin:/bin", [installed as string], NOT_THE_APP)).toBe(linked);
  expect(selectCli(undefined, search, [installed as string], NOT_THE_APP)).toBe(onPath);
});

it("finds the bundled CLI in the resources, never beside the app's executable", () => {
  expect(bundledCli("/Applications/SuperTag.app/Contents/Resources")).toBe(
    "/Applications/SuperTag.app/Contents/Resources/supertag/supertag",
  );
  expect(bundledCli("/opt/SuperTag/resources")).toBe("/opt/SuperTag/resources/supertag/supertag");
  expect(bundledCli(undefined)).toBeUndefined();
});

it("never runs the app itself as the CLI, through a link or a name differing in case", async () => {
  // A stand-in app bundle whose executable is SuperTag, as in Contents/MacOS.
  const macos = await directory("guard/SuperTag.app/Contents/MacOS");
  const exe = await tool(macos, "SuperTag", "echo 'supertag 0.3.2'");
  // A link to it named supertag is refused, on PATH or as the bundled copy.
  const linkDir = await directory("guard/links");
  const link = path.join(linkDir, "supertag");
  await symlink(exe, link);
  expect(selectCli(link, undefined, [], exe)).toBeUndefined();
  expect(selectCli(undefined, linkDir, [], exe)).toBeUndefined();
  // On a case-insensitive disk, MacOS/supertag is the app; on a case-sensitive one it is
  // missing. Either way it is never chosen, from PATH or the installer's directories.
  expect(selectCli(path.join(macos, "supertag"), macos, [macos], exe)).toBeUndefined();
  if (existsSync(path.join(macos, "supertag"))) {
    // The collision is real here: only the identity check refuses it.
    expect(isThisApp(path.join(macos, "supertag"), exe)).toBe(true);
    expect(selectCli(path.join(macos, "supertag"), undefined, [], NOT_THE_APP)).toBe(
      path.join(macos, "supertag"),
    );
  }
  // The running test process stands in for the app too.
  const self = path.join(await directory("guard/self"), "supertag");
  await symlink(process.execPath, self);
  expect(selectCli(self, undefined, [], process.execPath)).toBeUndefined();
});

it("names another CLI version with the update command", () => {
  expect(parseVersion("supertag 0.3.0\n")).toBe("0.3.0");
  expect(parseVersion("something else")).toBeUndefined();
  expect(parseVersion("supertag 0.3.0 extra")).toBeUndefined();
  expect(versionMismatch("0.3.0", "0.3.0")).toBeUndefined();
  expect(versionMismatch("0.2.0", "0.3.0")).toBe(
    `This SuperTag CLI is 0.2.0, the app expects 0.3.0. Update with: ${installCommand("0.3.0")}`,
  );
  expect(versionMismatch(undefined, "0.3.0")).toContain("an unknown version");
});

it("reads the version the CLI reports", async () => {
  const dir = await directory("version");
  const cli = await tool(dir, "supertag", `test "$1" = --version && echo 'supertag 0.2.9'`);
  expect(await cliVersion(cli)).toBe("0.2.9");
  await writeFile(cli, "#!/bin/sh\nexit 1\n");
  expect(await cliVersion(cli)).toBeUndefined();
});

it("runs only a CLI of the app's version, and says how to get one", async () => {
  const dir = await directory("usable");
  await tool(dir, "supertag", "echo 'supertag 0.3.1'");
  const app = { version: "0.3.2", execPath: NOT_THE_APP, env: { PATH: dir } };
  await expect(usableCli(app)).rejects.toBe(
    `${versionMismatch("0.3.1", "0.3.2")}\n(It is ${path.join(dir, "supertag")}.)`,
  );
  await expect(usableCli({ ...app, version: "0.3.1" })).resolves.toEqual({
    cli: path.join(dir, "supertag"),
    path: dir,
  });
  await expect(usableCli({ ...app, env: { PATH: "/nonexistent" } })).rejects.toBe(
    `Could not find the supertag command. Install it with: ${installCommand("0.3.2")}`,
  );
});

it("reads the login shell's PATH between its marks", () => {
  expect(markedPath(`motd line\n${PATH_MARK}/opt/homebrew/bin:/usr/bin${PATH_MARK}trailing`)).toBe(
    "/opt/homebrew/bin:/usr/bin",
  );
  expect(markedPath("no marks")).toBeUndefined();
  expect(markedPath(`${PATH_MARK}${PATH_MARK}`)).toBeUndefined();
});

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
echo 'Error: Worker Host laptop did not report readiness: no Node' >&2
exit 1`,
  );
  const error = await up(failing, state, undefined).catch((e: unknown) => e);
  expect(error).toContain("did not report readiness: no Node");
  expect(error).toContain(`Logs: ${path.join(state, "logs")}`);
  expect(String(error).startsWith("Could not start SuperTag:\n")).toBe(true);
  const working = await tool(dir, "working", `test "$1" = up && echo ready`);
  await expect(up(working, state, undefined)).resolves.toBeUndefined();
});

it("restarts by stopping then starting the same state directory", async () => {
  const dir = await directory("restart");
  const state = path.join(dir, "state");
  const calls = path.join(dir, "calls");
  const cli = await tool(dir, "supertag", `echo "$*" >> '${calls}'`);
  const steps: RestartStep[] = [];
  await restart(cli, state, undefined, (step) => steps.push(step));
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
  const error = await restart(cli, state, undefined, (step) => failed.push(step)).catch(
    (e: unknown) => e,
  );
  expect(String(error).startsWith("Could not stop SuperTag:\n")).toBe(true);
  expect(error).toContain("drain Worker Host laptop: timed out");
  expect((await readFile(calls, "utf8")).split("\n").filter(Boolean)).toEqual([
    `down --state-directory ${state}`,
  ]);
  expect(failed).toEqual(["stopping"]);
});

it("adds a folder with the CLI and reads its JSON, or its error and fix", async () => {
  const dir = await directory("workspace");
  const runs = path.join(dir, "runs");
  const script = (body: string) =>
    `#!/bin/sh\necho "$*" >> '${runs}'\necho 'Added Workspace site.' >&2\n${body}\n`;
  const cli = await tool(dir, "supertag");
  await writeFile(
    cli,
    script(`echo '{"version":1,"workspace":"site","ref":"trunk","added":true}'`),
  );
  expect(await addWorkspace(cli, undefined, "/tmp/state", "/work/My Site")).toEqual({
    workspace: "site",
    workspaceRef: "trunk",
  });
  expect(await readFile(runs, "utf8")).toBe(
    "workspace add --json --state-directory /tmp/state /work/My Site\n",
  );
  await writeFile(
    cli,
    script(
      `echo '{"version":1,"error":"/work/x is not in a git repository.","fix":"Choose one."}'; exit 1`,
    ),
  );
  await expect(addWorkspace(cli, undefined, "/tmp/state", "/work/My Site")).rejects.toBe(
    "/work/x is not in a git repository. Choose one.",
  );
  await writeFile(cli, script(`echo '{"version":1,"workspace":"site","baseCommit":"abc123"}'`));
  expect(await addWorkspace(cli, undefined, "/tmp/state", "/work/x")).toEqual({
    workspace: "site",
    workspaceCommit: "abc123",
  });
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
  const value = await checkWith(cli, undefined, "install", "/tmp/My Project", "codex");
  expect(value).toEqual({ version: 1, ready: false, cli });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await readFile(runs, "utf8")).toBe(
    "init --check --json --directory /tmp/My Project --harness codex\n",
  );
  // A CLI older than the app has no check: it is named as outdated.
  await writeFile(cli, "#!/bin/sh\necho \"error: unexpected argument '--check'\" >&2\nexit 2\n");
  expect(await checkWith(cli, undefined, "install", undefined, undefined)).toEqual({
    cli: null,
    outdated: cli,
    install: "install",
  });
});

it("bounds a failure reason to its last lines", () => {
  expect(reason({ success: false, stdout: "", stderr: "one\ntwo\n\nthree\nfour\nfive\n" })).toBe(
    "two three four five",
  );
  const long = reason({ success: false, stdout: "x".repeat(2000), stderr: "" });
  expect([...long]).toHaveLength(MAX_REASON_CHARS + 1);
  expect(reason({ success: false, stdout: "", stderr: "" })).toBe(
    "The command failed without saying why.",
  );
});

it("reads the local Gateway as __local-gateway reports it", () => {
  const running = parseLocalGateway(
    JSON.stringify({
      protocol: "local-gateway.v2",
      running: true,
      state_directory: "/s",
      set_up: true,
      machine_id: "m",
      url: "http://127.0.0.1:1",
      token: "t",
    }),
  );
  expect(running).toEqual({
    running: true,
    stateDirectory: "/s",
    setUp: true,
    machineId: "m",
    url: "http://127.0.0.1:1",
    token: "t",
  });
  expect(() => parseLocalGateway('{"protocol":"local-gateway.v1","running":false}')).toThrow();
  expect(() => parseLocalGateway("nope")).toThrow();
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

/** A stand-in CLI of version 0.3.2 whose `__local-gateway` prints `discovery`. */
async function fakeCli(name: string, discovery: object) {
  const dir = await directory(name);
  const calls = path.join(dir, "calls");
  await tool(
    dir,
    "supertag",
    `echo "$*" >> '${calls}'
case "$1" in
  --version) echo 'supertag 0.3.2' ;;
  __local-gateway) echo '${JSON.stringify(discovery)}' ;;
esac`,
  );
  const deps: LocalDependencies = {
    app: { version: "0.3.2", execPath: NOT_THE_APP, env: { PATH: dir } },
    protocolVersions: [6],
    probe: async () => ({ build: "0.3.0", versions: [5] }),
    chooseWorkspaceFolder: async () => "/work/site",
    localStateOf: async () => {
      throw "not the local Gateway";
    },
  };
  return { calls, deps };
}

const stream = <U>(sent: U[]) => ({
  send: (update: U) => sent.push(update),
  end() {},
  ended: false,
  onEnd() {},
});

it("starts stopped services that were set up, and only those", async () => {
  const stopped = {
    protocol: "local-gateway.v2",
    running: false,
    state_directory: "/tmp/st-state",
    set_up: true,
    machine_id: null,
  };
  const { calls, deps } = await fakeCli("start", stopped);
  const local = localHandlers(deps);
  expect(await local.localStartNeeded({})).toBe(true);
  expect(await local.startLocalServices({})).toBe(true);
  expect(await readFile(calls, "utf8")).toContain("up --state-directory /tmp/st-state\n");

  const fresh = await fakeCli("fresh", { ...stopped, set_up: false });
  expect(await localHandlers(fresh.deps).localStartNeeded({})).toBe(false);
  expect(await localHandlers(fresh.deps).startLocalServices({})).toBe(false);
  expect(await readFile(fresh.calls, "utf8")).not.toContain("up --state-directory");
});

it("restarts only an older local release, reporting each step", async () => {
  const running = {
    protocol: "local-gateway.v2",
    running: true,
    state_directory: "/tmp/rs-state",
    set_up: true,
    machine_id: null,
    url: "http://127.0.0.1:9",
    token: "t",
  };
  const { calls, deps } = await fakeCli("restart-older", running);
  const local = localHandlers(deps);
  expect(await local.localGatewayUpgrade({})).toEqual({ running: "0.3.0", version: "0.3.2" });
  const steps: RestartStep[] = [];
  await local.restartLocalServices({}, stream(steps));
  expect(steps).toEqual(["stopping", "starting"]);
  expect(
    (await readFile(calls, "utf8"))
      .split("\n")
      .filter((line) => line.includes("--state-directory")),
  ).toEqual(["down --state-directory /tmp/rs-state", "up --state-directory /tmp/rs-state"]);

  // The same release: never restarted.
  const same = localHandlers({ ...deps, probe: async () => undefined });
  expect(await same.localGatewayUpgrade({})).toBeNull();
  await expect(same.restartLocalServices({}, stream([]))).rejects.toContain(
    "does not run an older release",
  );
});

it("reports the CLI problem, and checks setup without a CLI", async () => {
  const deps = (await fakeCli("problem", {})).deps;
  const none = localHandlers({ ...deps, app: { ...deps.app, env: { PATH: "/nonexistent" } } });
  expect(await none.localCliProblem({})).toContain("Could not find the supertag command");
  expect(await none.localStartNeeded({})).toBe(false);
  expect(await none.checkSetup({})).toEqual({
    cli: null,
    problem: `Could not find the supertag command. Install it with: ${installCommand("0.3.2")}`,
    install: installCommand("0.3.2"),
  });
  expect(await localHandlers(deps).localCliProblem({})).toBeNull();
});

it("adds a Workspace only for the local Gateway's connection", async () => {
  const { deps } = await fakeCli("add", {});
  await expect(localHandlers(deps).addLocalWorkspace({ connectionId: "1" })).rejects.toBe(
    "not the local Gateway",
  );
  const cancelled = localHandlers({
    ...deps,
    localStateOf: async () => "/tmp/state",
    chooseWorkspaceFolder: async () => null,
  });
  expect(await cancelled.addLocalWorkspace({ connectionId: "1" })).toBeNull();
});
