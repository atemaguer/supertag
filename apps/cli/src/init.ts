import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { JsonObject } from "@bufbuild/protobuf";
import { githubRepositoryFromSource } from "@supertag/core";
import { stateDirectory } from "@supertag/store";
import { Document, parseDocument } from "yaml";
import {
  ControlPlaneClient,
  type ControlPlaneTarget,
  ensureLocalAdminToken,
} from "./control-plane-client.js";
import { CONTROL_PLANE_API_VERSION, type TagResource } from "./control-plane-resources.js";
import {
  HARNESS_COMMANDS,
  harnessSignInInstructions,
  inspectHarnesses,
  noHarnessMessage,
  probeHarnessSignIn,
} from "./harnesses.js";
import { bindLocalTags, storedWorkerHostId } from "./host-service.js";
import { availableInitPort } from "./init-port.js";
import { type LocalProcessOptions, probeWorkerEnvironment } from "./local-process.js";
import {
  controlPlaneSlot,
  environmentOperatorToken,
  readStatus,
  runningProcess,
} from "./local-state.js";
import { machineName as machineHostname } from "./machine-name.js";
import {
  applyManifest,
  findResourceView,
  listResourceViews,
  resourceManifests,
} from "./operator-resources.js";
import { type Choice, linePrompter, type Prompter } from "./prompts.js";
import { git, remoteSource, sanitizeName, workspaceNameFor } from "./repository-name.js";
import type { ResourcePath } from "./resource-protos.js";
import {
  type ControlPlaneService,
  controlPlaneOf,
  DEFAULT_CONTROL_PLANE_PORT,
  DEFAULT_CONTROL_PLANE_SERVICE,
  databaseProblem,
  defaultDatabaseUrl,
  defaultSupertagYamlPath,
  formatDocument,
  type HostModels,
  type HostService,
  loadServicesFile,
  modelsValue,
  readEnvFile,
  serviceNameFromHostname,
  UNSANDBOXED_HARNESSES,
} from "./supertag-yaml.js";
import { bringUp, notificationNote, type UpOptions, type UpResult } from "./up.js";
import type { WorkletHarness } from "./worker.js";
import { assertGitCheckouts, parseWorkletWorkspaces } from "./worklet-workspaces.js";

/** The Tag `init` creates to own Objectives. */
export const INIT_TAG = "lead";
const INIT_ROLE = "Lead";
const INIT_PERMISSION_SET = "local-tools";
const RUNTIME_ACTIONS = ["files:write", "commands:execute"] as const;

export type Delivery = "branch" | "patch" | "pull-request";
/** What the lead Tag may do. */
export type Access = "read" | "edit" | "pull-requests";

export interface DetectedRepository {
  /** Absolute path of the checkout's top-level directory. */
  readonly root: string;
  /** Workspace name derived from the origin URL or directory. */
  readonly name: string;
  /** Origin URL when it names a remote repository. */
  readonly source?: string;
  /** Default branch, used as the base for Task branches. */
  readonly ref?: string;
  /** False before the first commit; Task worktrees need one. */
  readonly hasCommits: boolean;
}

/** Everything init sets up: the local Control Plane, this machine as a host, and the lead Tag. */
export interface InitAnswers {
  readonly port: number;
  /** Undefined for the default SQLite database in the state directory. */
  readonly database?: string;
  readonly harnesses: readonly WorkletHarness[];
  /** Harnesses allowed to run commands without an OS sandbox: allow-unsandboxed-commands. */
  readonly allowUnsandboxedCommands: readonly WorkletHarness[];
  readonly models: HostModels;
  readonly repository: DetectedRepository;
  readonly workspace: string;
  readonly delivery: Delivery;
  readonly tag: string;
  readonly access: Access;
}

export interface InitOptions {
  readonly cwd?: string;
  /** Accept every default without asking. */
  readonly yes?: boolean;
  /** Whether questions can be asked; defaults to whether stdin is a terminal. */
  readonly interactive?: boolean;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly write?: (text: string) => void;
  /** Passed to `supertag up`; tests set the CLI command and timeouts. */
  readonly up?: LocalProcessOptions;
  /** Brings up services; defaults to supertag up. */
  readonly start?: (options: UpOptions) => Promise<UpResult>;
  /** The machine's hostname, which names the host service; defaults to machineName(). */
  readonly hostname?: string;
}

export type InitResult =
  | { readonly state: "exited" }
  | {
      readonly state: "ready";
      readonly answers: InitAnswers;
      /** The host service init wrote, named after this machine. */
      readonly hostService: string;
      readonly up: UpResult;
    };

export async function runInitCommand(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(initHelp());
    return 0;
  }
  const { values } = parseArgs({ args, options: { yes: { type: "boolean" } }, strict: true });
  await initialize({ yes: values.yes === true });
  return 0;
}

/**
 * The setup wizard for a local deployment. It checks for a harness before anything else, asks a
 * few questions (or accepts the defaults), writes supertag.yaml with a control-plane service and
 * a host service named after this machine, brings them up, and creates the starter resources
 * through the Control Plane's API.
 */
export async function initialize(options: InitOptions = {}): Promise<InitResult> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const yes = options.yes === true;
  // First, before any question or side effect: a harness must be installed.
  const { found: installed, problems } = await inspectHarnesses();
  if (installed.length === 0)
    throw new Error(
      `${[...problems, noHarnessMessage()].join("\n")}\nThen run supertag init again.`,
    );
  for (const problem of problems) write(`${problem}\n`);
  if (yes && installed.length === 1 && installed[0] === "opencode")
    throw new Error(
      "OpenCode is the only harness on this machine, and it needs a model. Run supertag init in a terminal, without --yes, to enter one as provider/model, or install Claude Code or Codex.",
    );
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  if (!yes && !interactive)
    throw new Error(
      "supertag init asks a few questions, so it needs a terminal. Run it in one, or pass --yes to accept the defaults.",
    );
  const cwd = resolve(options.cwd ?? process.cwd());
  const repository = await detectRepository(cwd);
  const prompter = yes
    ? undefined
    : linePrompter(options.input ?? process.stdin, options.output ?? process.stdout);
  try {
    return await wizard(options, write, prompter, installed, repository);
  } finally {
    prompter?.close();
  }
}

async function wizard(
  options: InitOptions,
  write: (text: string) => void,
  ask: Prompter | undefined,
  installed: readonly WorkletHarness[],
  repository: DetectedRepository,
): Promise<InitResult> {
  write(`SuperTag setup for ${repository.root}\n`);
  if (ask !== undefined) write("Press Enter to accept the default in [brackets].\n");
  const yamlPath = defaultSupertagYamlPath();
  const existing = (await exists(yamlPath))
    ? await loadServicesFile({ files: [yamlPath] })
    : undefined;
  const resolved = existing ?? (await loadServicesFile());
  // Before init writes supertag.yaml, loadServicesFile has no file beside which to discover
  // the default .env. The host will read it after init writes the YAML.
  const envPath = resolve(yamlPath, "../.env");
  const probeFile =
    existing === undefined && (await exists(envPath))
      ? { envFile: await readEnvFile(envPath) }
      : resolved;
  const hostForProbe = resolved.services.find(
    (service) => service.type === "host" && "service" in service.controlPlane,
  );
  const probeEnvironment = probeWorkerEnvironment(
    probeFile,
    hostForProbe?.restart === "unless-stopped",
  );
  const signIns = new Map<string, Promise<boolean>>();
  const checkSignIn: typeof probeHarnessSignIn = (harness, model) => {
    const key = JSON.stringify([harness, model]);
    let result = signIns.get(key);
    if (result === undefined) {
      write(`Checking ${harness} sign-in with the Worker Host credentials...\n`);
      result = probeHarnessSignIn(harness, model, probeEnvironment);
      signIns.set(key, result);
    }
    return result;
  };
  const controlPlane = controlPlaneOf(resolved);
  const hosts = (existing?.services ?? []).filter(
    (service): service is HostService => service.type === "host",
  );
  const shared = hosts.find((service) => "url" in service.controlPlane);
  if (existing !== undefined && controlPlane === undefined && shared !== undefined)
    throw new Error(
      `${yamlPath} connects host service ${shared.name} to a shared Control Plane at ${"url" in shared.controlPlane ? shared.controlPlane.url : ""}. supertag init sets up a local Control Plane instead. Edit ${yamlPath} to add Workspaces, or move it aside first.`,
    );
  const host = hosts.find((service) => "service" in service.controlPlane);
  const current: Defaults = {
    port: controlPlane?.ports.port ?? DEFAULT_CONTROL_PLANE_PORT,
    ...(controlPlane === undefined || controlPlane.database.url === defaultDatabaseUrl()
      ? {}
      : { database: controlPlane.database.url }),
  };
  const checkout = Object.entries(host?.workspaces ?? {}).find(
    ([, path]) => path === repository.root,
  );

  let answers: InitAnswers;
  let update = true;
  if (existing !== undefined) {
    write(`\nSuperTag is already set up on this machine:\n${await summary(controlPlane, host)}`);
    const choices: Choice<"keep" | "add" | "change" | "exit">[] = [
      checkout !== undefined || host === undefined
        ? { value: "keep", label: "Keep it, and make sure everything is running" }
        : {
            value: "add",
            label: `Add this repository to host service ${host.name} as a Workspace`,
          },
      { value: "change", label: "Change the setup" },
      { value: "exit", label: "Exit without changes" },
    ];
    const fallback = choices[0]?.value ?? "keep";
    const choice =
      ask === undefined
        ? fallback
        : await ask.choose("What would you like to do?", choices, fallback);
    if (choice === "exit") {
      write("Nothing was changed.\n");
      return { state: "exited" };
    }
    const tag = (await currentTag(host)) ?? INIT_TAG;
    const access = await currentAccess();
    if ((choice === "keep" || choice === "add") && host !== undefined) {
      update = false;
      const name =
        checkout?.[0] ??
        (ask === undefined
          ? uniqueName(repository.name, host.workspaces)
          : await ask.text(
              "Workspace name",
              uniqueName(repository.name, host.workspaces),
              workspaceProblem,
            ));
      answers = {
        port: current.port,
        ...(current.database === undefined ? {} : { database: current.database }),
        harnesses: host.harnesses,
        allowUnsandboxedCommands: host.allowUnsandboxedCommands,
        models: host.models,
        repository,
        workspace: name,
        delivery: checkout !== undefined ? "branch" : await chooseDelivery(ask, repository),
        tag,
        access,
      };
    } else
      answers = await askEverything(
        ask,
        write,
        installed,
        repository,
        {
          ...current,
          ...(host === undefined ? {} : { harnesses: host.harnesses, models: host.models }),
          ...(checkout === undefined ? {} : { workspace: checkout[0] }),
          tag,
          access,
        },
        checkSignIn,
        options.yes === true,
      );
  } else
    answers = await askEverything(
      ask,
      write,
      installed,
      repository,
      current,
      checkSignIn,
      options.yes === true,
    );

  let runnable = false;
  for (const harness of answers.harnesses) {
    const signedIn = await checkSignIn(harness, answers.models[harness]?.[0]);
    runnable ||= signedIn;
    write(
      `  ${harness}: ${signedIn ? "signed in" : "not signed in (the credential check did not succeed)"}\n`,
    );
  }
  if (!runnable)
    throw new Error(
      `No selected harness could complete the sign-in check. Check your sign-in, model access, and network connection, then run supertag init again.${ask === undefined ? `\n${installed.map(harnessSignInInstructions).join("\n")}` : ""}`,
    );

  const environment = { ...resolved.envFile, ...process.env };
  const portVariable = environment["SUPERTAG_GATEWAY_PORT"]?.trim()
    ? "SUPERTAG_GATEWAY_PORT"
    : environment["SUPERTAG_DEPLOYMENT_PLATFORM"]?.trim() && environment["PORT"]?.trim()
      ? "PORT"
      : undefined;
  const port = await availableInitPort({
    port: portVariable === undefined ? answers.port : Number(environment[portVariable]),
    host: environment["SUPERTAG_GATEWAY_HOST"]?.trim().replace(/^\[|\]$/gu, "") || "127.0.0.1",
    yes: options.yes === true,
    ...(portVariable === undefined ? {} : { portVariable }),
    write,
  });
  answers = { ...answers, port };

  // Nothing above wrote anything; from here on, set up.
  ask?.close();
  write("\n");
  const taken = new Set((existing?.services ?? []).map((service) => service.name));
  let hostService = host?.name ?? serviceNameFromHostname(options.hostname ?? machineHostname());
  if (host === undefined)
    for (let index = 2; taken.has(hostService); index += 1)
      hostService = `${serviceNameFromHostname(options.hostname ?? machineHostname())}-${index}`;
  const controlPlaneService = controlPlane?.name ?? DEFAULT_CONTROL_PLANE_SERVICE;
  const names = {
    controlPlane: controlPlaneService,
    host: hostService,
    workspaces: host?.workspaces ?? {},
  };
  // The host service and its new Workspace are written after the starter resources exist, so
  // up does not create the Workspace with defaults first.
  let wrote = await writeServicesYaml(yamlPath, answers, { ...names, host: undefined });
  const start = options.start ?? bringUp;
  // The Control Plane first, so the starter resources exist before the host serves them.
  const first = await start({ ...options.up, names: [controlPlaneService], write, brief: {} });
  const url = first.services.find((service) => service.service === controlPlaneService)?.status
    ?.url;
  if (url === undefined) throw new Error("The local Control Plane did not report its URL");
  const target: ControlPlaneTarget = {
    url,
    token: environmentOperatorToken() || (await ensureLocalAdminToken()),
  };
  const client = new ControlPlaneClient(target);
  for (const line of await ensureResources(client, answers, update)) write(`${line}\n`);
  wrote = (await writeServicesYaml(yamlPath, answers, names)) || wrote;
  if (wrote) write(`Wrote ${yamlPath}.\n`);
  // The Control Plane was reported above; this call reports only what it starts or changes.
  const all = await start({ ...options.up, write, brief: { reported: [controlPlaneService] } });
  const workerHostId = all.services.find((service) => service.service === hostService)?.status
    ?.workerHostId;
  if (workerHostId !== undefined)
    await bindLocalTags(target, workerHostId, [answers.tag], (line) => write(`${line}\n`));
  const controlPlaneConfig = all.file.services.find(
    (service) => service.name === controlPlaneService,
  );
  if (controlPlaneConfig !== undefined) notificationNote(controlPlaneConfig, write);

  if (answers.access === "pull-requests" || answers.delivery === "pull-request")
    write(
      `Opening pull requests also needs a GitHub surface and the pull-requests:create permission: run supertag setup surface github, then add that permission to Permission Set ${INIT_PERMISSION_SET} with a manifest and supertag apply -f.\n`,
    );
  if (!answers.repository.hasCommits)
    write("This repository has no commits yet. Commit once before creating an Objective.\n");
  write(`
SuperTag is ready. Run this in your terminal to open the UI.
  supertag
Select ${answers.tag}, type "Read this repository and tell me what you would improve first.",
and press Enter. Use Ctrl-K and choose Create Objective to give ${answers.tag} an outcome to own.

${yamlPath} runs two services in the background: ${controlPlaneService} (the Control Plane)
and ${hostService} (this machine as a Worker Host).
  supertag ps          List them
  supertag logs -f     Follow their logs
  supertag down        Stop them
  supertag up          Start them again
To keep them running after restarts, add restart: unless-stopped to both services in
${yamlPath}, then run supertag up.
`);
  return { state: "ready", answers, hostService, up: all };
}

interface Defaults {
  readonly port: number;
  readonly database?: string;
  readonly harnesses?: readonly WorkletHarness[];
  readonly models?: HostModels;
  readonly workspace?: string;
  readonly tag?: string;
  readonly access?: Access;
}

/** Every question, with `defaults` in brackets. Without a prompter, the defaults themselves. */
async function askEverything(
  ask: Prompter | undefined,
  write: (text: string) => void,
  installed: readonly WorkletHarness[],
  repository: DetectedRepository,
  defaults: Defaults,
  checkSignIn: typeof probeHarnessSignIn,
  yes: boolean,
): Promise<InitAnswers> {
  write("\nControl Plane\n");
  const checkPort = (port: number) => availableInitPort({ port, host: "127.0.0.1", yes, write });
  const port =
    ask === undefined
      ? await checkPort(defaults.port)
      : Number(
          await ask.text("Port", String(defaults.port), async (value) => {
            const problem = portProblem(value);
            if (problem !== undefined) return problem;
            try {
              await checkPort(Number(value));
              return undefined;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        );
  const databaseDefault = defaults.database ?? "";
  const database =
    ask === undefined
      ? defaults.database
      : (normalizeDatabase(
          await ask.text(
            `Database (a file: path or postgresql:// URL; Enter keeps ${databaseDefault ? databaseDefault : `SQLite in ${displayHome(stateDirectory())}`})`,
            "",
            (value) => (value === "" ? undefined : databaseProblem(normalizeDatabase(value) ?? "")),
          ),
        ) ??
        (databaseDefault || undefined));
  if (ask === undefined)
    write(`  Port ${port}; database ${database ?? `SQLite in ${displayHome(stateDirectory())}`}\n`);

  write("\nThis machine as a Worker Host\n");
  const { harnesses, models } = await chooseHarnesses(ask, write, installed, defaults, checkSignIn);
  const allowUnsandboxedCommands = await chooseUnsandboxed(ask, write, harnesses);
  let chosen = repository;
  if (ask !== undefined) {
    const directory = await ask.text("Directory to work in", repository.root, (value) =>
      value.trim() ? undefined : "Enter a directory.",
    );
    chosen = await askableRepository(directory, repository);
  } else write(`  Directory ${repository.root}\n`);
  const workspace =
    ask === undefined
      ? (defaults.workspace ?? chosen.name)
      : await ask.text("Workspace name", defaults.workspace ?? chosen.name, workspaceProblem);
  const delivery = await chooseDelivery(ask, chosen);
  if (ask === undefined)
    write(`  Workspace ${workspace}; finished work comes back as a ${delivery}\n`);

  write("\nLead Tag\n");
  const tag =
    ask === undefined
      ? (defaults.tag ?? INIT_TAG)
      : await ask.text("Name", defaults.tag ?? INIT_TAG, tagProblem);
  const access = await chooseAccess(ask, chosen, delivery, defaults.access ?? "edit");
  if (ask === undefined) write(`  Tag ${tag}; may ${accessLabel(access).toLowerCase()}\n`);
  return {
    port,
    ...(database === undefined ? {} : { database }),
    harnesses,
    allowUnsandboxedCommands,
    models,
    repository: chosen,
    workspace,
    delivery,
    tag,
    access,
  };
}

async function askableRepository(
  directory: string,
  fallback: DetectedRepository,
): Promise<DetectedRepository> {
  const path = resolve(expandHome(directory.trim()));
  if (path === fallback.root) return fallback;
  await assertGitCheckouts(parseWorkletWorkspaces([`workspace=${path}`]).checkouts);
  return detectRepository(path);
}

/**
 * The harnesses this machine serves, and models for those that need one. OpenCode runs only with
 * a model, so the default leaves it out unless it is the only harness, and choosing it asks.
 */
async function chooseHarnesses(
  ask: Prompter | undefined,
  write: (text: string) => void,
  installed: readonly WorkletHarness[],
  defaults: Defaults,
  checkSignIn: typeof probeHarnessSignIn,
): Promise<{
  readonly harnesses: readonly WorkletHarness[];
  readonly models: HostModels;
}> {
  const choices: Choice<WorkletHarness>[] = [];
  const signedInHarnesses: WorkletHarness[] = [];
  for (const harness of installed) {
    const needsModel = harness === "opencode" && !defaults.models?.opencode?.[0];
    const signedIn = needsModel
      ? false
      : await checkSignIn(harness, defaults.models?.[harness]?.[0]);
    if (signedIn) signedInHarnesses.push(harness);
    choices.push({
      value: harness,
      label: `${harness} (${HARNESS_COMMANDS[harness]})${needsModel ? ", sign-in not checked (choose a model)" : signedIn ? ", signed in" : ", not signed in"}`,
    });
    if (!signedIn && ask !== undefined)
      write(`${harness}: ${harnessSignInInstructions(harness)}\n`);
  }
  const configured = (defaults.harnesses ?? []).filter((harness) =>
    signedInHarnesses.includes(harness),
  );
  const preferred = configured.length > 0 ? configured : signedInHarnesses;
  const fallback = preferred;
  let selected: readonly WorkletHarness[];
  if (ask === undefined) {
    selected = fallback;
    write(`  Harnesses ${selected.join(", ")}\n`);
    if (installed.includes("opencode") && !selected.includes("opencode"))
      write(
        "  OpenCode is installed too; choose it in an interactive supertag init to name its model.\n",
      );
  } else if (installed.length === 1) {
    write(`  Harness found: ${choices[0]?.label}\n`);
    selected =
      fallback.length > 0
        ? fallback
        : await ask.chooseMany("Harnesses this machine serves", choices, fallback);
  } else selected = await ask.chooseMany("Harnesses this machine serves", choices, fallback);
  const models: Partial<Record<WorkletHarness, readonly string[]>> = { ...(defaults.models ?? {}) };
  if (selected.includes("opencode")) {
    if (ask === undefined && !models.opencode)
      throw new Error(
        "OpenCode needs a model. Run supertag init in a terminal, without --yes, to enter one as provider/model.",
      );
    if (ask !== undefined) {
      const prior = models.opencode ?? [];
      const chosen = await ask.text("OpenCode model, as provider/model", prior[0] ?? "", (value) =>
        /^[^\s/]+\/\S+$/u.test(value)
          ? undefined
          : "Enter the model OpenCode should use as provider/model, such as one opencode models lists.",
      );
      models.opencode = [chosen, ...prior.filter((model) => model !== chosen)];
    }
  }
  return { harnesses: selected, models };
}

/**
 * Claude Code and OpenCode run commands as the host user, without an OS sandbox, so a host runs
 * Tasks that may run commands on them only after an opt-in. init is a single-user local setup,
 * so it defaults to yes; --yes opts in for each such harness chosen and says how to undo it.
 */
async function chooseUnsandboxed(
  ask: Prompter | undefined,
  write: (text: string) => void,
  harnesses: readonly WorkletHarness[],
): Promise<readonly WorkletHarness[]> {
  const unsandboxed: readonly WorkletHarness[] = UNSANDBOXED_HARNESSES;
  const found = harnesses.filter((harness) => unsandboxed.includes(harness));
  if (found.length === 0) return [];
  const names = found.join(" and ");
  const setting = "allow-unsandboxed-commands";
  if (ask === undefined) {
    write(
      `  Allowed ${names} to run commands without a sandbox (${setting} in supertag.yaml); remove ${found.length === 1 ? "it" : "them"} there and run supertag up to undo.\n`,
    );
    return found;
  }
  write(
    `${names} ${found.length === 1 ? "runs" : "run"} commands as you, without a sandbox, so give ${found.length === 1 ? "its" : "their"} Tags only trusted work. Codex sandboxes its commands.\n`,
  );
  const allowed = await ask.confirm(`Allow ${names} to run commands without a sandbox?`, true);
  if (!allowed)
    write(
      `  Tasks that run commands will not run on ${names}. To allow it later, add ${found.length === 1 ? "it" : "them"} to ${setting} in supertag.yaml.\n`,
    );
  return allowed ? found : [];
}

async function chooseDelivery(
  ask: Prompter | undefined,
  repository: DetectedRepository,
): Promise<Delivery> {
  if (ask === undefined) return "branch";
  const choices: Choice<Delivery>[] = [
    { value: "branch", label: "branch: leave each Task's commits on a local branch" },
    { value: "patch", label: "patch: return each Task's changes as a patch file" },
  ];
  if (isGitHub(repository.source))
    choices.push({
      value: "pull-request",
      label: "pull-request: open a draft pull request on GitHub for each Task",
    });
  return ask.choose("How finished work comes back", choices, "branch");
}

async function chooseAccess(
  ask: Prompter | undefined,
  repository: DetectedRepository,
  delivery: Delivery,
  fallback: Access,
): Promise<Access> {
  if (ask === undefined) return fallback;
  const choices: Choice<Access>[] = [
    { value: "read", label: accessLabel("read") },
    { value: "edit", label: accessLabel("edit") },
  ];
  if (delivery === "pull-request" || isGitHub(repository.source))
    choices.push({ value: "pull-requests", label: accessLabel("pull-requests") });
  return ask.choose(
    "What the lead Tag may do",
    choices,
    choices.some((choice) => choice.value === fallback) ? fallback : "edit",
  );
}

function accessLabel(access: Access): string {
  return access === "read"
    ? "Read only"
    : access === "edit"
      ? "Edit files and run commands"
      : "Edit files, run commands, and open pull requests (needs a GitHub surface)";
}

/** A short description of the existing setup. */
async function summary(
  controlPlane: ControlPlaneService | undefined,
  host: HostService | undefined,
): Promise<string> {
  const running = (await runningProcess(controlPlaneSlot())).pid;
  const url = running === undefined ? undefined : (await readStatus(controlPlaneSlot()))?.url;
  const database = controlPlane?.database.url ?? defaultDatabaseUrl();
  const lines = [
    controlPlane === undefined
      ? "  Control Plane: none"
      : `  Control Plane ${controlPlane.name}: port ${controlPlane.ports.port}, database ${database === defaultDatabaseUrl() ? `SQLite in ${displayHome(stateDirectory())}` : database}${url === undefined ? "; not running" : `; running at ${url}`}`,
    host === undefined
      ? "  Host service: none"
      : `  Host service ${host.name}: ${host.harnesses.join(", ")}; ${host.concurrency} Task Attempts per harness at once (${host.concurrencySource === "file" ? "from supertag.yaml" : "from this machine"});${host.allowUnsandboxedCommands.length > 0 ? ` runs commands unsandboxed: ${host.allowUnsandboxedCommands.join(", ")};` : ""} Workspaces ${
          Object.entries(host.workspaces)
            .map(([name, path]) => `${name} (${path})`)
            .join(", ") || "none"
        }`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the choices to supertag.yaml in the state directory: a control-plane service and a host
 * service for this machine. An existing file keeps its comments, other services, and settings.
 * Returns whether the file changed.
 */
async function writeServicesYaml(
  path: string,
  answers: InitAnswers,
  names: {
    readonly controlPlane: string;
    /** Undefined writes only the control-plane service. */
    readonly host: string | undefined;
    readonly workspaces: Readonly<Record<string, string>>;
  },
): Promise<boolean> {
  const existing = await readFile(path, "utf8").catch(() => undefined);
  const document =
    existing === undefined
      ? (() => {
          const created = new Document({ services: {} });
          created.commentBefore = ` The services supertag up runs on this machine. Resources are manifests: supertag apply -f FILE.`;
          return created;
        })()
      : parseDocument(existing);
  const controlPlane = ["services", names.controlPlane];
  document.setIn([...controlPlane, "type"], "control-plane");
  if (answers.port === DEFAULT_CONTROL_PLANE_PORT) document.deleteIn([...controlPlane, "ports"]);
  else document.setIn([...controlPlane, "ports"], document.createNode([String(answers.port)]));
  if (answers.database === undefined || answers.database === defaultDatabaseUrl())
    document.deleteIn([...controlPlane, "database"]);
  else document.setIn([...controlPlane, "database", "url"], answers.database);
  if (names.host === undefined) return writeDocument(path, document, existing);
  const host = ["services", names.host];
  document.setIn([...host, "type"], "host");
  document.setIn([...host, "harnesses"], document.createNode([...answers.harnesses]));
  if (answers.allowUnsandboxedCommands.length > 0)
    document.setIn(
      [...host, "allow-unsandboxed-commands"],
      document.createNode([...answers.allowUnsandboxedCommands]),
    );
  else document.deleteIn([...host, "allow-unsandboxed-commands"]);
  if (Object.keys(answers.models).length > 0)
    document.setIn([...host, "models"], document.createNode(modelsValue(answers.models)));
  else document.deleteIn([...host, "models"]);
  document.setIn(
    [...host, "workspaces"],
    document.createNode(
      Object.fromEntries(
        Object.entries({ ...names.workspaces, [answers.workspace]: answers.repository.root }).map(
          ([name, checkout]) => [name, displayHome(checkout)],
        ),
      ),
    ),
  );
  return writeDocument(path, document, existing);
}

async function writeDocument(
  path: string,
  document: Document,
  existing: string | undefined,
): Promise<boolean> {
  const text = formatDocument(document);
  if (text === existing) return false;
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return true;
}

/**
 * Creates the starter resources through the API: the Workspace, Permission Set, Role, and Tag.
 * Existing resources stay as they are, so a rerun never undoes changes made with manifests;
 * with `update`, a changed answer updates only the fields init owns.
 */
async function ensureResources(
  client: ControlPlaneClient,
  answers: InitAnswers,
  update: boolean,
): Promise<readonly string[]> {
  const lines: string[] = [];
  const read = async (path: ResourcePath, name: string) =>
    (await findResourceView(client.operator, path, name)) === undefined
      ? undefined
      : {
          spec:
            (
              (await resourceManifests(client.operator, path, name))[0] as {
                readonly spec?: Record<string, unknown>;
              }
            ).spec ?? {},
        };
  const apply = async (
    _path: ResourcePath,
    kind: string,
    name: string,
    spec: Record<string, unknown>,
  ) =>
    applyManifest(client.operator, {
      applySet: "init",
      manifest: {
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind,
        metadata: { name },
        spec: JSON.parse(JSON.stringify(spec)) as JsonObject,
      },
      source: `supertag init ${kind}/${name}`,
    });
  const ensure = async (
    path: ResourcePath,
    kind: string,
    label: string,
    name: string,
    spec: Record<string, unknown>,
    /** The updated spec when a changed answer differs from it, else undefined. */
    merge?: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
  ) => {
    const current = await read(path, name);
    if (current === undefined) {
      await apply(path, kind, name, spec);
      lines.push(`+ ${label} ${name}`);
      return;
    }
    const merged = update ? merge?.(current.spec) : undefined;
    if (merged === undefined) return;
    await apply(path, kind, name, merged);
    lines.push(`~ ${label} ${name}`);
  };
  const { repository } = answers;
  const workspace: Record<string, unknown> = {
    ...(repository.source === undefined ? {} : { source: repository.source }),
    ...(repository.ref === undefined ? {} : { ref: repository.ref }),
    delivery: answers.delivery,
  };
  await ensure("workspaces", "Workspace", "Workspace", answers.workspace, workspace, (current) =>
    Object.entries(workspace).every(([field, value]) => current[field] === value)
      ? undefined
      : { ...current, ...workspace },
  );
  const actions: readonly string[] = answers.access === "read" ? [] : RUNTIME_ACTIONS;
  const isRuntime = (permission: unknown) =>
    isRecord(permission) &&
    permission["target"] === "runtime" &&
    (RUNTIME_ACTIONS as readonly unknown[]).includes(permission["action"]);
  await ensure(
    "permission-sets",
    "PermissionSet",
    "Permission Set",
    INIT_PERMISSION_SET,
    { permissions: actions.map((action) => ({ target: "runtime", action })) },
    (current) => {
      // Only the runtime actions are init's; other permissions, such as a surface's, stay.
      const permissions = Array.isArray(current["permissions"]) ? current["permissions"] : [];
      const present = permissions
        .filter(isRuntime)
        .map((permission) => String((permission as Record<string, unknown>)["action"]));
      if (present.toSorted().join() === [...actions].toSorted().join()) return undefined;
      return {
        ...current,
        permissions: [
          ...permissions.filter((permission) => !isRuntime(permission)),
          ...actions.map((action) => ({ target: "runtime", action })),
        ],
      };
    },
  );
  await ensure("roles", "Role", "Role", INIT_ROLE, {
    purpose: "Own Objectives: plan the work, do or delegate each part, and review the results.",
    instructions:
      "Work from repository evidence. Keep changes small and tested, and report uncertainty clearly.",
    contextSets: [],
    permissionSets: [INIT_PERMISSION_SET],
  });
  await ensure("tags", "Tag", "Tag", answers.tag, { roles: [INIT_ROLE] });
  return lines;
}

/** What the lead Tag may do now, from Permission Set local-tools when the Control Plane runs. */
async function currentAccess(): Promise<Access> {
  const running = (await runningProcess(controlPlaneSlot())).pid;
  const url = running === undefined ? undefined : (await readStatus(controlPlaneSlot()))?.url;
  if (url === undefined) return "edit";
  const token = environmentOperatorToken() || (await ensureLocalAdminToken());
  const resource = (await findResourceView(
    { url, token },
    "permission-sets",
    INIT_PERMISSION_SET,
  ).catch(() => undefined)) as
    | { readonly spec: { readonly permissions?: readonly unknown[] } }
    | undefined;
  const actions = (resource?.spec.permissions ?? []).map((permission) =>
    isRecord(permission) ? permission["action"] : undefined,
  );
  return resource !== undefined && !RUNTIME_ACTIONS.some((action) => actions.includes(action))
    ? "read"
    : "edit";
}

/** The first Tag the host service serves on the running local Control Plane, if any. */
async function currentTag(host: HostService | undefined): Promise<string | undefined> {
  if (host === undefined) return undefined;
  const workerHostId = await storedWorkerHostId(host.name);
  const running = (await runningProcess(controlPlaneSlot())).pid;
  const url = running === undefined ? undefined : (await readStatus(controlPlaneSlot()))?.url;
  if (workerHostId === undefined || url === undefined) return undefined;
  const token = environmentOperatorToken() || (await ensureLocalAdminToken());
  const tags = (await listResourceViews({ url, token }, "tags").catch(() => undefined)) as
    | { readonly items: readonly TagResource[] }
    | undefined;
  return tags?.items.find((tag) => (tag.spec.workerHosts ?? []).includes(workerHostId))?.metadata
    .name;
}

export async function detectRepository(cwd: string): Promise<DetectedRepository> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === undefined)
    throw new Error(
      "supertag init runs inside a git repository, which becomes the first Workspace. Change to your repository, or run git init first.",
    );
  const real = await realpath(root).catch(() => root);
  const origin = await git(real, ["remote", "get-url", "origin"]);
  const source = origin === undefined ? undefined : remoteSource(origin);
  const originHead = await git(real, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const ref =
    (originHead?.includes("/") ? originHead.slice(originHead.indexOf("/") + 1) : undefined) ??
    (await git(real, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const hasCommits = (await git(real, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== undefined;
  return {
    root: real,
    name: workspaceNameFor(source, real),
    ...(source === undefined ? {} : { source }),
    ...(ref ? { ref } : {}),
    hasCommits,
  };
}

export { sanitizeName as sanitizeWorkspaceName, workspaceNameFor };

/** A Workspace name for a new repository that does not collide with one already served. */
function uniqueName(name: string, workspaces: Readonly<Record<string, string>>): string {
  if (!(name in workspaces)) return name;
  for (let index = 2; ; index += 1)
    if (!(`${name}-${index}` in workspaces)) return `${name}-${index}`;
}

function normalizeDatabase(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("~"))
    return `file:${resolve(expandHome(trimmed))}`;
  return trimmed;
}

function expandHome(path: string): string {
  const home = process.env["HOME"]?.trim() || homedir();
  return path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : path;
}

function displayHome(path: string): string {
  const home = process.env["HOME"]?.trim() || homedir();
  return isAbsolute(path) && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

function isGitHub(source: string | undefined): boolean {
  return source !== undefined && githubRepositoryFromSource(source) !== undefined;
}

function portProblem(value: string): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535
    ? undefined
    : "Enter a port from 0 through 65535.";
}

function tagProblem(value: string): string | undefined {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)
    ? undefined
    : "Use 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.";
}

function workspaceProblem(value: string): string | undefined {
  return tagProblem(value);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function initHelp(): string {
  return `Usage: supertag init [--yes]

Sets up SuperTag on this machine for the git repository in the current directory: a local
Control Plane, this machine as a Worker Host, and a lead Tag.

init first checks for a harness (claude, codex, or opencode on PATH; Cursor through
CURSOR_API_KEY, cursor-agent, or an agent binary verified as Cursor). Claude Code and Codex Tasks
run those installed CLIs, so each must be at least the version SuperTag's SDK targets; an older
one is reported with its upgrade command and not offered. init stops with
install guidance, before asking or changing anything, if there is none. It then asks, with the
default in [brackets]:
  1. Control Plane: its port [3434] and database [SQLite in the state directory]. An occupied
     port asks for another number immediately; --yes chooses the next free port.
  2. This machine as a Worker Host: which harnesses it serves (OpenCode asks for a model as
     provider/model), whether Claude Code or OpenCode may run commands without a sandbox [yes],
     the directory to work in [this repository], the Workspace name [the repository's name],
     and how finished work comes back: branch (default), patch, or pull-request (GitHub
     origins only).
  3. The lead Tag: its name [lead] and what it may do: read only, edit files and run commands
     (default), or also open pull requests, which needs a GitHub surface.

init checks sign-in through the bundled Claude Agent SDK, Codex SDK, Cursor SDK, or OpenCode with its
selected model. API keys use a short model request and a small amount of provider allowance.
Codex file-backed sign-in uses a read-only credential check to protect its refresh token; that
check cannot confirm account access. The menu marks sign-in status, selects only signed-in
harnesses by default, and gives sign-in steps for others. Network or model-access problems
can also fail a model check. At least one
selected harness must pass before setup continues.
${harnessSignInInstructions("claude-code")}
${harnessSignInInstructions("codex")}
${harnessSignInInstructions("cursor")}

init then writes ~/.supertag/supertag.yaml (or $SUPERTAG_STATE_DIR/supertag.yaml) with two
services: control-plane, and a host service named after this machine. It brings up the Control
Plane with supertag up, creates the Workspace, Permission Set local-tools, Role Lead, and the Tag
through its API, brings up the host service, which joins with its own credential, binds it to
the Tag, and checks that each harness Worker registered. Run supertag in your terminal to talk
to the lead Tag. Select an Objective and press m to message it. init writes nothing in the repository.

Rerunning shows the current setup. In another repository, init offers to add it as another
Workspace of the same host service; it never starts a second Control Plane. Existing resources
are never deleted, and a rerun only changes what you choose to change.

  --yes   Accept every default without asking; required when stdin is not a terminal. It lets
          Claude Code and OpenCode run commands without a sandbox and prints how to turn the sandbox back on.
`;
}
