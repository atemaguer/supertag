import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import {
  type ControlPlaneTarget,
  resolveControlPlaneTarget,
  resolveLocalControlPlaneTarget,
  resolveSavedControlPlaneTarget,
  savedControlPlaneConnectionNames,
} from "./control-plane-client.js";
import { SUPERTAG_VERSION } from "./version.js";

export interface TuiOptions {
  /** The global `--control-plane` selection. */
  readonly override?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveTarget?: (override?: string) => Promise<ControlPlaneTarget | undefined>;
  /** Every Control Plane the terminal UI may switch to: this machine's and each saved connection. */
  readonly resolveContexts?: () => Promise<readonly ControlPlaneTarget[]>;
  /** The CLI release the binary must match. */
  readonly version?: string;
}

const installCommand =
  "curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh";

/** Credential variables the CLI reads; the TUI receives tokens on fd 3 only. */
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
 * Opens the terminal UI against the selected Control Plane, with every other Control Plane it can
 * switch to, and returns its exit code, or
 * undefined when no TUI binary is installed for this platform, so the caller shows help instead.
 * A binary from another release is refused with how to fix it, and without a Control Plane it
 * says to run `supertag init`; both return 1.
 */
export async function runTui(options: TuiOptions = {}): Promise<number | undefined> {
  const env = options.env ?? process.env;
  const binary = findTuiBinary(env);
  if (binary === undefined) return undefined;
  const mismatch = versionMismatch(binary, options.version ?? SUPERTAG_VERSION, env);
  if (mismatch !== undefined) {
    process.stderr.write(mismatch);
    return 1;
  }
  const target = await (options.resolveTarget ?? resolveControlPlaneTarget)(options.override);
  if (target === undefined) {
    process.stderr.write(
      "No Control Plane is set up yet. Run supertag init in your repository to get started.\n" +
        "To use an existing Control Plane, run supertag connect control-plane URL.\n",
    );
    return 1;
  }
  // A token from the environment belongs to the one Control Plane it selects, so it goes nowhere else.
  const pinned = credentialVariables.some((name) => env[name]?.trim());
  const contexts = pinned ? [] : await (options.resolveContexts ?? savedControlPlaneTargets)();
  return launch(binary, tuiHandover(target, contexts), env);
}

/** What the terminal UI reads from fd 3: every Control Plane it may use, and which one is current. */
export interface TuiHandover {
  readonly contexts: readonly ControlPlaneTarget[];
  readonly current: number;
}

/**
 * The handover for the selected target and the Control Planes it may switch to, without
 * duplicates. The selected target is listed first when it is none of them, as for a URL.
 */
export function tuiHandover(
  target: ControlPlaneTarget,
  contexts: readonly ControlPlaneTarget[],
): TuiHandover {
  const same = (left: ControlPlaneTarget, right: ControlPlaneTarget) =>
    left.name === right.name && left.url === right.url;
  const unique = contexts.filter(
    (context, index) => contexts.findIndex((other) => same(context, other)) === index,
  );
  const current = unique.findIndex((context) => same(context, target));
  if (current === -1) return { contexts: [target, ...unique], current: 0 };
  return {
    contexts: unique.map((context, index) => (index === current ? target : context)),
    current,
  };
}

/**
 * This machine's Control Plane when it has a local operator credential, then each saved
 * connection by name. One whose credential cannot be read is left out, so the terminal UI
 * still opens on the others.
 */
async function savedControlPlaneTargets(): Promise<ControlPlaneTarget[]> {
  const targets: ControlPlaneTarget[] = [];
  const local = await resolveLocalControlPlaneTarget().catch(() => undefined);
  if (local !== undefined) targets.push(local);
  const names = await savedControlPlaneConnectionNames().catch(() => []);
  for (const name of names) {
    const target = await resolveSavedControlPlaneTarget(name).catch(() => undefined);
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

/**
 * How to get the TUI when no binary is found: build it in a checkout that has its sources,
 * otherwise reinstall with the curl installer.
 */
export function tuiBuildHint(checkout: boolean = inCheckout()): string {
  return checkout
    ? "The terminal UI is not built in this checkout. Build it with: cd apps/tui && ./build.sh\n"
    : `The terminal UI is not installed. Reinstall SuperTag with the curl installer to get it: ${installCommand}\n`;
}

function inCheckout(): boolean {
  return executable(fileURLToPath(new URL("../../tui/build.sh", import.meta.url)));
}

/** The refusal for a binary whose release differs from the CLI's, or undefined when they match. */
function versionMismatch(
  binary: string,
  cliVersion: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let reported: string;
  try {
    reported = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env: withoutCredentials(env),
    }).trim();
  } catch {
    reported = "";
  }
  if (reported === cliVersion) return undefined;
  const fix = env["SUPERTAG_TUI_BINARY"]?.trim()
    ? `Point SUPERTAG_TUI_BINARY at a ${cliVersion} build, or unset it.`
    : inCheckout()
      ? "Rebuild it with: cd apps/tui && ./build.sh"
      : `Reinstall SuperTag with the curl installer: ${installCommand}`;
  return `The terminal UI at ${binary} is ${reported === "" ? "an unknown version" : reported} but this CLI is ${cliVersion}, and they must match. ${fix}\n`;
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

function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const name of credentialVariables) delete childEnv[name];
  return childEnv;
}

function launch(binary: string, handover: TuiHandover, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: withoutCredentials(env),
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
      contexts: handover.contexts.map((target) => ({
        url: target.url,
        token: target.token,
        ...(target.name === undefined ? {} : { name: target.name }),
      })),
      current: handover.current,
    };
    handoff.end(`${JSON.stringify(payload)}\n`);
  });
}
