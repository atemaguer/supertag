import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Power facts about a laptop that can stop Task Attempts. Undefined for a machine without one. */
export interface LaptopPower {
  /** The laptop runs on its battery, so it can run down or sleep on low power. */
  readonly onBattery: boolean;
  /** Closing the lid sleeps the laptop; keeping it awake does not prevent that. */
  readonly lidSleep: boolean;
}

/**
 * Reads `pmset -g batt` and `pmset -g` output from macOS. A Mac without an internal battery is
 * not a laptop. Lid close sleeps a laptop unless sleep is disabled (`pmset disablesleep 1`).
 */
export function parseDarwinPower(battery: string, settings: string): LaptopPower | undefined {
  if (!/InternalBattery/u.test(battery)) return undefined;
  return {
    onBattery: /drawing from 'Battery Power'/u.test(battery),
    lidSleep: !/^\s*SleepDisabled\s+1\b/mu.test(settings),
  };
}

/** One entry of `/sys/class/power_supply`: its `type` and, for mains, `online`. */
export interface LinuxPowerSupply {
  readonly type: string;
  readonly online?: string;
}

/**
 * Reads Linux power supplies and logind.conf. A machine without a battery is not a laptop. Lid
 * close suspends by default; `HandleLidSwitch` (or `HandleLidSwitchExternalPower` on mains power)
 * set to `ignore` or `lock` prevents that.
 */
export function parseLinuxPower(
  supplies: readonly LinuxPowerSupply[],
  logind: string,
): LaptopPower | undefined {
  if (!supplies.some((supply) => supply.type.trim() === "Battery")) return undefined;
  const onBattery = !supplies.some(
    (supply) => supply.type.trim() === "Mains" && supply.online?.trim() === "1",
  );
  const setting = (key: string) =>
    [...logind.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "gmu"))].at(-1)?.[1];
  const action =
    (onBattery ? undefined : setting("HandleLidSwitchExternalPower")) ??
    setting("HandleLidSwitch") ??
    "suspend";
  return { onBattery, lidSleep: action !== "ignore" && action !== "lock" };
}

export interface PowerReaders {
  readonly run?: (command: string, args: readonly string[]) => Promise<string>;
  readonly readText?: (path: string) => Promise<string>;
  readonly list?: (path: string) => Promise<readonly string[]>;
}

/** This machine's laptop power facts, or undefined when it is not a laptop or they are unknown. */
export async function readLaptopPower(
  platform: NodeJS.Platform = process.platform,
  readers: PowerReaders = {},
): Promise<LaptopPower | undefined> {
  const run =
    readers.run ??
    ((command: string, args: readonly string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(command, [...args], { timeout: 2_000 }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        ),
      ));
  const readText = readers.readText ?? ((path: string) => readFile(path, "utf8"));
  const list = readers.list ?? ((path: string) => readdir(path));
  try {
    if (platform === "darwin")
      return parseDarwinPower(await run("pmset", ["-g", "batt"]), await run("pmset", ["-g"]));
    if (platform === "linux") {
      const root = "/sys/class/power_supply";
      const supplies: LinuxPowerSupply[] = [];
      for (const name of await list(root)) {
        const type = await readText(join(root, name, "type")).catch(() => "");
        const online = await readText(join(root, name, "online")).catch(() => undefined);
        supplies.push({ type, ...(online === undefined ? {} : { online }) });
      }
      const logind = await readText("/etc/systemd/logind.conf").catch(() => "");
      return parseLinuxPower(supplies, logind);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The `supertag ps` warning for a laptop running Task Attempts, or undefined when none applies. */
export function laptopPowerWarning(power: LaptopPower | undefined): string | undefined {
  if (power === undefined) return undefined;
  const risks = [
    ...(power.onBattery ? ["the laptop is on battery power"] : []),
    ...(power.lidSleep ? ["closing the lid will sleep it"] : []),
  ];
  if (risks.length === 0) return undefined;
  return `warning: Task Attempts are running, but ${risks.join(" and ")}. A long sleep can fail them; plug in and keep the lid open.`;
}
