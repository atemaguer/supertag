import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
const stateDirectory = await mkdtemp(join(tmpdir(), "supertag-package-cli-"));
const cli = new URL("dist/cli.js", packageRoot);

try {
  const version = (await execute([cli.pathname, "--version"])).trim();
  if (version !== manifest.version) {
    throw new Error(`CLI reported ${version || "no version"}; expected ${manifest.version}`);
  }
  const recoveryHelp = await execute([cli.pathname, "recover", "worklet", "--help"]);
  if (
    !recoveryHelp.includes("--confirm-stopped") ||
    !recoveryHelp.includes("outcome remains unknown")
  )
    throw new Error("CLI is missing explicit offline cleanup recovery guidance");
  const setupHelp = await execute([cli.pathname, "setup", "surface", "slack", "--help"]);
  for (const label of ["Guide", "Manifest"]) {
    const path = setupHelp.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1];
    if (!path?.startsWith(new URL("dist/docs/", packageRoot).pathname))
      throw new Error(`Packaged ${label} must resolve to bundled documentation`);
    if (!(await readFile(path, "utf8")).trim()) throw new Error(`Empty packaged ${label}`);
  }
  const help = await execute([cli.pathname, "worklet", "connect", "--help"]);
  if (!help.includes("opencode")) throw new Error("CLI is missing OpenCode Harness selection");
  if (!help.includes("cursor")) throw new Error("CLI is missing Cursor Harness selection");
  const cursor = await import(new URL("dist/harnesses/cursor.js", packageRoot));
  if (typeof cursor.createCursorWorker !== "function")
    throw new Error("Missing public Cursor export");
  // The bundled Cursor harness launches dist/runner.js; a malformed frame proves it runs.
  const runnerOutput = await runWithInput(
    new URL("dist/runner.js", packageRoot).pathname,
    "not json\n",
  );
  if (!runnerOutput.includes('"PROTOCOL_ERROR"'))
    throw new Error("Packaged Cursor runner did not start");
  // It also launches dist/stop-watchdog-main.js; an armed watchdog acknowledges, then exits on release.
  const watchdogOutput = await runWithInput(
    new URL("dist/stop-watchdog-main.js", packageRoot).pathname,
    "done\n",
    [String(process.pid), "package-test"],
  );
  if (watchdogOutput !== "ready\n") throw new Error("Packaged Cursor stop watchdog did not start");
  const opencode = await import(new URL("dist/harnesses/opencode.js", packageRoot));
  if (typeof opencode.createOpenCodeWorker !== "function")
    throw new Error("Missing public OpenCode export");
  const workerSdk = await import(new URL("dist/worker.js", packageRoot));
  if (
    typeof workerSdk.SandboxExecutionEnvironmentProvider !== "function" ||
    typeof workerSdk.ExecutionCleanupError !== "function"
  )
    throw new Error("Missing public sandbox lifecycle exports");
  const controlPlaneSdk = await import(new URL("dist/control-plane.js", packageRoot));
  if (typeof controlPlaneSdk.ControlPlane !== "function")
    throw new Error("Missing public Control Plane export");
  const { runCodex } = await import(new URL("dist/harnesses/codex.js", packageRoot));
  const previousKey = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = "package-test-no-provider-call";
  let selectedCommand;
  try {
    const environment = {
      placement: "local",
      rootDirectory: stateDirectory,
      resolvePath: (path) => join(stateDirectory, path),
      async spawn(spec) {
        selectedCommand = spec.command;
        return {
          output: (async function* () {
            yield {
              stream: "stdout",
              text: `${[
                { type: "thread.started", thread_id: "package-test" },
                {
                  type: "item.completed",
                  item: { id: "result", type: "agent_message", text: "Packaged adapter works" },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            };
          })(),
          async wait() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          kill() {},
        };
      },
    };
    for await (const _ of runCodex(
      {
        prompt: "Packaging check",
        command: "codex",
        workspace: stateDirectory,
        timeoutMs: 1000,
        model: "gpt-5.6-luna",
        mcpServers: [],
        toolInputs: [],
        runtimeActions: [],
      },
      environment,
    )) {
    }
    if (!selectedCommand?.includes("vendor"))
      throw new Error("Packaged Codex must resolve its pinned native CLI");
  } finally {
    if (previousKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousKey;
  }
  await execute([cli.pathname, "migrate"], { SUPERTAG_STATE_DIR: stateDirectory });
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}

function runWithInput(script, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function execute(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
