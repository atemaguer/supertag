import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { type ControlPlaneTarget, resolveControlPlaneTarget } from "./control-plane-client.js";

export interface TuiOptions {
  /** The global `--control-plane` selection. */
  readonly override?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveTarget?: (override?: string) => Promise<ControlPlaneTarget | undefined>;
}

/** Credential variables the CLI reads; the TUI receives the token on fd 3 only. */
const credentialVariables = ["SUPERTAG_OPERATOR_TOKEN", "SUPERTAG_ADMIN_TOKEN"];

/**
 * Whether `supertag` should open the terminal UI: no arguments, in an interactive terminal on
 * both ends. Anything else, such as piped output, `--help`, or a command, keeps the CLI.
 */
export function opensTui(
  args: readonly string[],
  stdinIsTTY: boolean | undefined = process.stdin.isTTY,
  stdoutIsTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  return args.length === 0 && stdinIsTTY === true && stdoutIsTTY === true;
}

/**
 * Opens the terminal UI against the selected Control Plane and returns its exit code, or
 * undefined when no TUI binary is installed for this platform, so the caller shows help instead.
 * Without a Control Plane it says to run `supertag init` and returns 1.
 */
export async function runTui(options: TuiOptions = {}): Promise<number | undefined> {
  const env = options.env ?? process.env;
  const binary = findTuiBinary(env);
  if (binary === undefined) return undefined;
  const target = await (options.resolveTarget ?? resolveControlPlaneTarget)(options.override);
  if (target === undefined) {
    process.stderr.write(
      "No Control Plane is set up yet. Run supertag init in your repository to start one, or connect to your team's with: supertag connect control-plane URL\n",
    );
    return 1;
  }
  return launch(binary, target, env);
}

/** How to build the TUI, when this CLI runs from a checkout that has its sources. */
export function tuiBuildHint(): string | undefined {
  const script = fileURLToPath(new URL("../../tui/build.sh", import.meta.url));
  return executable(script)
    ? "The terminal UI is not built in this checkout. Build it with: cd apps/tui && ./build.sh\n"
    : undefined;
}

/** SUPERTAG_TUI_BINARY, else the checkout's apps/tui/dist build, else the packaged tui/ binary. */
export function findTuiBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env["SUPERTAG_TUI_BINARY"]?.trim();
  if (configured) return executable(configured) ? configured : undefined;
  const name = platformBinaryName();
  if (name === undefined) return undefined;
  const candidates = [
    // apps/cli/{src,dist}/tui.* -> apps/tui/dist
    fileURLToPath(new URL(`../../tui/dist/${name}`, import.meta.url)),
    // <package>/dist/tui.js -> <package>/tui
    fileURLToPath(new URL(`../tui/${name}`, import.meta.url)),
  ];
  return candidates.find(executable);
}

function platformBinaryName(): string | undefined {
  const goos = { darwin: "darwin", linux: "linux" }[process.platform as string];
  const goarch = { arm64: "arm64", x64: "amd64" }[process.arch as string];
  return goos && goarch ? `supertag-tui-${goos}-${goarch}` : undefined;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function launch(
  binary: string,
  target: ControlPlaneTarget,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const childEnv = { ...env };
  for (const name of credentialVariables) delete childEnv[name];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: childEnv,
    });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const cleanup = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new Error(`Could not start the SuperTag terminal UI at ${binary}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1));
    });
    const handoff = child.stdio[3];
    if (handoff === null || handoff === undefined || !("write" in handoff)) return;
    // The child may exit before reading; its exit code reports that, not a pipe error.
    handoff.on("error", () => {});
    const payload = {
      url: target.url,
      token: target.token,
      ...(target.name === undefined ? {} : { name: target.name }),
    };
    handoff.end(`${JSON.stringify(payload)}\n`);
  });
}
