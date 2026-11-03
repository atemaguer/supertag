import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_INSTANCE_NAME } from "./supertag-yaml.js";

/**
 * A per-user service unit: launchd label `ai.supertag.SERVICE`, or systemd unit
 * `supertag-SERVICE.service`, with the instance name between for a file that sets `name`.
 */
export interface UnitName {
  readonly label: string;
  readonly unit: string;
}

/**
 * The unit of one supertag.yaml service; `instance` is the file's `name`, which labels the unit
 * only when it is not the default.
 */
export function unitName(instance: string, service: string): UnitName {
  if (instance === DEFAULT_INSTANCE_NAME)
    return { label: `ai.supertag.${service}`, unit: `supertag-${service}.service` };
  return {
    label: `ai.supertag.${instance}.${service}`,
    unit: `supertag-${instance}-${service}.service`,
  };
}

/** The arguments every unit this build installs runs its service with. */
export function unitArguments(service: string): readonly string[] {
  return ["up", "--foreground", service];
}

/** What a per-user service runs. */
export interface ServiceDefinition {
  readonly name: UnitName;
  /** One line describing it, for the service manager. */
  readonly description: string;
  readonly workingDirectory: string;
  /** The command and arguments that run the process in the foreground. */
  readonly command: readonly string[];
  readonly logFile: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** A per-user service manager: launchd on macOS, systemd on Linux. */
export interface ServiceManager {
  readonly kind: "launchd" | "systemd";
  /** The service definition file. */
  path(name: UnitName): string;
  /** Whether a definition is installed for this name. */
  installed(name: UnitName): Promise<boolean>;
  /** Whether the installed definition is exactly this one. */
  current(definition: ServiceDefinition): Promise<boolean>;
  /** Writes the definition, enables it at login, and starts it now. */
  install(definition: ServiceDefinition): Promise<readonly string[]>;
  start(name: UnitName): Promise<void>;
  stop(name: UnitName): Promise<void>;
  restart(name: UnitName): Promise<void>;
  /** Stops the service and removes its definition. */
  uninstall(name: UnitName): Promise<void>;
  /** Whether the installed definition's command includes `args`, in order. */
  runs(name: UnitName, args: readonly string[]): Promise<boolean>;
}

export interface ServiceEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  readonly configHome?: string;
  /** Runs launchctl or systemctl; resolves with the exit code and output. */
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly code: number; readonly output: string }>;
}

export function defaultServiceEnvironment(): ServiceEnvironment {
  const configHome = process.env["XDG_CONFIG_HOME"]?.trim();
  return {
    platform: process.platform,
    home: process.env["HOME"]?.trim() || homedir(),
    uid: process.getuid?.() ?? userInfo().uid,
    ...(configHome ? { configHome } : {}),
    run: (command, args) =>
      new Promise((resolve) =>
        execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) =>
          resolve({
            code:
              error === null
                ? 0
                : typeof (error as { code?: unknown }).code === "number"
                  ? (error as { code: number }).code
                  : 1,
            output: `${stdout}${stderr}`.trim(),
          }),
        ),
      ),
  };
}

/** The service manager for this platform, or an error that says it is not supported yet. */
export function serviceManager(environment = defaultServiceEnvironment()): ServiceManager {
  if (environment.platform === "darwin") return launchd(environment);
  if (environment.platform === "linux") return systemd(environment);
  throw new Error(
    `Running SuperTag as a service is not supported on ${environment.platform} yet. Remove restart: unless-stopped from supertag.yaml; supertag up then runs services in the background until supertag down.`,
  );
}

function launchd(environment: ServiceEnvironment): ServiceManager {
  const label = (name: UnitName) => name.label;
  const directory = join(environment.home, "Library", "LaunchAgents");
  const path = (name: UnitName) => join(directory, `${label(name)}.plist`);
  const domain = `gui/${environment.uid}`;
  const check = async (args: readonly string[]) => {
    const result = await environment.run("launchctl", args);
    if (result.code !== 0)
      throw new Error(
        `launchctl ${args.join(" ")} failed: ${result.output || `exit ${result.code}`}`,
      );
  };
  const loaded = async (name: UnitName) =>
    (await environment.run("launchctl", ["print", `${domain}/${label(name)}`])).code === 0;
  const bootout = async (name: UnitName) => {
    if (await loaded(name)) await check(["bootout", `${domain}/${label(name)}`]);
  };
  return {
    kind: "launchd",
    path,
    installed: (name) => exists(path(name)),
    current: async (definition) =>
      (await readFile(path(definition.name), "utf8").catch(() => undefined)) ===
      launchdPlist(label(definition.name), definition),
    install: async (definition) => {
      const file = path(definition.name);
      await mkdir(dirname(file), { recursive: true });
      await bootout(definition.name);
      await writeFile(file, launchdPlist(label(definition.name), definition), "utf8");
      await check(["bootstrap", domain, file]);
      return [`Installed ${file}; it starts the ${definition.description} when you log in.`];
    },
    start: async (name) => {
      if (!(await loaded(name))) await check(["bootstrap", domain, path(name)]);
      else await check(["kickstart", `${domain}/${label(name)}`]);
    },
    stop: bootout,
    restart: async (name) => {
      if (await loaded(name)) await check(["kickstart", "-k", `${domain}/${label(name)}`]);
      else await check(["bootstrap", domain, path(name)]);
    },
    uninstall: async (name) => {
      await bootout(name);
      await unlink(path(name)).catch(() => undefined);
    },
    runs: async (name, args) =>
      (await readFile(path(name), "utf8").catch(() => "")).includes(launchdStrings(args)),
  };
}

function systemd(environment: ServiceEnvironment): ServiceManager {
  const unit = (name: UnitName) => name.unit;
  const directory = join(
    environment.configHome ?? join(environment.home, ".config"),
    "systemd",
    "user",
  );
  const path = (name: UnitName) => join(directory, unit(name));
  const systemctl = async (...args: string[]) => {
    const result = await environment.run("systemctl", ["--user", ...args]);
    if (result.code !== 0)
      throw new Error(
        `systemctl --user ${args.join(" ")} failed: ${result.output || `exit ${result.code}`}`,
      );
  };
  return {
    kind: "systemd",
    path,
    installed: (name) => exists(path(name)),
    current: async (definition) =>
      (await readFile(path(definition.name), "utf8").catch(() => undefined)) ===
      systemdUnit(definition),
    install: async (definition) => {
      const file = path(definition.name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, systemdUnit(definition), "utf8");
      await systemctl("daemon-reload");
      await systemctl("enable", unit(definition.name));
      await systemctl("restart", unit(definition.name));
      return [
        `Installed ${file}; it starts the ${definition.description} when you log in.`,
        "To keep it running while you are logged out and after a reboot, enable lingering once: loginctl enable-linger $USER",
      ];
    },
    start: (name) => systemctl("start", unit(name)),
    stop: (name) => systemctl("stop", unit(name)),
    restart: (name) => systemctl("restart", unit(name)),
    uninstall: async (name) => {
      await systemctl("disable", "--now", unit(name)).catch(() => undefined);
      await unlink(path(name)).catch(() => undefined);
      await systemctl("daemon-reload");
    },
    runs: async (name, args) => {
      const text = await readFile(path(name), "utf8").catch(() => "");
      const command = /^ExecStart=(.*)$/mu.exec(text)?.[1] ?? "";
      return ` ${command} `.includes(` ${args.map(systemdQuote).join(" ")} `);
    },
  };
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() === true;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function launchdStrings(values: readonly string[]): string {
  return values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
}

export function launchdPlist(label: string, definition: ServiceDefinition): string {
  const strings = launchdStrings;
  const environment = Object.entries(definition.environment)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(definition.command)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(definition.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(definition.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(definition.logFile)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function systemdUnit(definition: ServiceDefinition): string {
  const environment = Object.entries(definition.environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=SuperTag ${definition.description}

[Service]
Type=simple
WorkingDirectory=${systemdQuote(definition.workingDirectory)}
ExecStart=${definition.command.map(systemdQuote).join(" ")}
${environment}
Restart=on-failure
RestartSec=5
StandardOutput=append:${definition.logFile}
StandardError=append:${definition.logFile}

[Install]
WantedBy=default.target
`;
}
