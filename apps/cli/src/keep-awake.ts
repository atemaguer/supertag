import { type ChildProcess, spawn as spawnProcess } from "node:child_process";

/** What a host service records while it keeps the machine awake. */
export interface KeepAwakeHold {
  /** The command holding the assertion, such as `caffeinate -i`. */
  readonly tool: string;
  readonly since: string;
}

/** The OS command that keeps the machine awake while it runs. */
export interface KeepAwakeCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Short form shown to people, such as `caffeinate -i`. */
  readonly label: string;
}

export type KeepAwakeSpawn = (command: string, args: readonly string[]) => ChildProcess;

export interface KeepAwakeOptions {
  readonly platform?: NodeJS.Platform;
  /** The process whose exit also ends the hold, so a crashed host never leaves one behind. */
  readonly pid?: number;
  /** Replaceable for tests, which must never hold a real assertion. */
  readonly spawn?: KeepAwakeSpawn;
  readonly now?: () => Date;
  /** Called whenever the hold starts or ends. */
  readonly onChange?: (hold: KeepAwakeHold | undefined) => void;
  /** Called once if the OS command cannot run. */
  readonly onUnavailable?: (message: string) => void;
}

/**
 * The command that prevents idle sleep on this platform: `caffeinate -i` on macOS and
 * `systemd-inhibit` on Linux. Both also end when process `pid` exits. Undefined elsewhere.
 */
export function keepAwakeCommand(
  platform: NodeJS.Platform,
  pid: number,
): KeepAwakeCommand | undefined {
  if (platform === "darwin")
    return { command: "caffeinate", args: ["-i", "-w", String(pid)], label: "caffeinate -i" };
  if (platform === "linux")
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=SuperTag",
        "--why=Running Task Attempts",
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
      label: "systemd-inhibit",
    };
  return undefined;
}

/** How many times one hold restarts its OS command after it exits unexpectedly. */
export const MAX_KEEP_AWAKE_RESTARTS = 3;

/**
 * Keeps the machine awake while a host service runs Task Attempts. `update` takes the number of
 * running Task Attempts: the first one starts the OS command, and the last one to finish stops it.
 */
export class KeepAwake {
  readonly #command: KeepAwakeCommand | undefined;
  readonly #spawn: KeepAwakeSpawn;
  readonly #now: () => Date;
  readonly #onChange: (hold: KeepAwakeHold | undefined) => void;
  readonly #onUnavailable: (message: string) => void;
  #child: ChildProcess | undefined;
  #hold: KeepAwakeHold | undefined;
  #unavailable = false;
  #running = 0;
  #restarts = 0;

  constructor(options: KeepAwakeOptions = {}) {
    this.#command = keepAwakeCommand(
      options.platform ?? process.platform,
      options.pid ?? process.pid,
    );
    this.#spawn =
      options.spawn ??
      ((command, args) => spawnProcess(command, [...args], { stdio: "ignore", detached: false }));
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => undefined);
    this.#onUnavailable = options.onUnavailable ?? (() => undefined);
  }

  /** The current hold, if the OS command is running. */
  get hold(): KeepAwakeHold | undefined {
    return this.#hold;
  }

  update(running: number): void {
    this.#running = running;
    if (running > 0) this.#start();
    else this.release();
  }

  /** Stops the OS command, if it runs. */
  release(): void {
    this.#running = 0;
    this.#restarts = 0;
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    this.#set(undefined);
  }

  #start(): void {
    const command = this.#command;
    if (command === undefined || this.#child !== undefined || this.#unavailable) return;
    let child: ChildProcess;
    try {
      child = this.#spawn(command.command, command.args);
    } catch (error) {
      this.#fail(command, error);
      return;
    }
    this.#child = child;
    child.once("spawn", () => {
      if (this.#child === child)
        this.#set({ tool: command.label, since: this.#now().toISOString() });
    });
    child.once("error", (error) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#set(undefined);
      this.#fail(command, error);
    });
    child.once("exit", () => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#set(undefined);
      // The OS command ended on its own while Task Attempts still run: start it again, a bounded
      // number of times so a command that keeps exiting cannot spin.
      if (this.#running > 0 && this.#restarts < MAX_KEEP_AWAKE_RESTARTS) {
        this.#restarts += 1;
        this.#start();
      }
    });
  }

  #fail(command: KeepAwakeCommand, error: unknown): void {
    this.#unavailable = true;
    this.#onUnavailable(
      `Cannot keep the machine awake with ${command.label}: ${error instanceof Error ? error.message : String(error)}. Task Attempts still run, but the machine may sleep during them.`,
    );
  }

  #set(hold: KeepAwakeHold | undefined): void {
    if (hold === undefined && this.#hold === undefined) return;
    this.#hold = hold;
    this.#onChange(hold);
  }
}
