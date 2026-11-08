#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  inspectDatabaseMigrationReadiness,
  type MigrationReadiness,
  migrateDatabase,
} from "@supertag/store";
import { normalizeActionFirstCommand } from "./action-command.js";
import { approvalHelp, inboxHelp, runApprovalCommand, runInboxCommand } from "./approvals.js";
import { artifactHelp, runArtifactCommand } from "./artifacts.js";
import { auditHelp, runAuditCommand } from "./audit-command.js";
import { authKeyHelp, isAuthKeyCommand, runAuthKeyCommand } from "./auth-keys.js";
import { runConfigCommand } from "./config-command.js";
import {
  ControlPlaneClient,
  isControlPlaneManagementCommand,
  resolveControlPlaneTarget,
  resolveControlPlaneUrl,
  runControlPlaneManagementCommand,
} from "./control-plane-client.js";
import { runControlPlaneCommand } from "./control-plane-runtime.js";
import { runDeploymentCommand } from "./deploy.js";
import { runInitCommand } from "./init.js";
import { runListCommand } from "./list-command.js";
import { runMcpCommand } from "./mcp-command.js";
import { runTagMessagingCommand, tagMessagingHelp } from "./messaging.js";
import { testConfiguredNotification, testNotificationHelp } from "./notification-command.js";
import { objectiveHelp, runObjectiveCommand } from "./objectives.js";
import {
  isOperatorTokenCommand,
  operatorTokenHelp,
  runOperatorTokenCommand,
} from "./operator-tokens.js";
import { runStatusCommand } from "./organization-status.js";
import { runPsCommand } from "./ps.js";
import { isResourceCommand, runResourceCommand } from "./resources.js";
import { setupSurface } from "./setup.js";
import { runSpendCommand } from "./spend.js";
import { runTagConversationCommand, tagConversationHelp } from "./tag-conversation.js";
import { isTagCommand, tagResourceHelp } from "./tags.js";
import { isTaskCommand, runTaskCommand, taskHelp } from "./tasks.js";
import { runTeamCommand, teamHelp } from "./teams.js";
import { terminalLines, terminalText } from "./terminal-text.js";
import { opensTui, runTui, tuiBuildHint } from "./tui.js";
import { runDownCommand, runLogsCommand, runUpCommand } from "./up.js";
import { resetVersionSkewWarning, SUPERTAG_VERSION } from "./version.js";
import { runVersionCommand } from "./version-command.js";
import { runWorkletCommand, runWorkletRecoveryCommand } from "./worker.js";
import {
  isWorkerHostCommand,
  revokeOwnWorkerHostCredential,
  runWorkerHostOperation,
  workerHostOperationHelp,
} from "./worker-hosts.js";
import { listWorkstreamPosts, workstreamHelp } from "./workstreams.js";

/** The CLI release; the same value the Control Plane reports in its SuperTag-Version header. */
export const CLI_VERSION = SUPERTAG_VERSION;

export async function main(args = process.argv.slice(2)): Promise<number> {
  resetVersionSkewWarning();
  const rawSelection = parseGlobalControlPlaneSelection(args);
  const selection = {
    ...rawSelection,
    args: normalizeActionFirstCommand(rawSelection.args),
  };
  const [command, provider, ...commandArgs] = selection.args;
  if (opensTui(selection.args)) {
    const code = await runTui({ override: selection.controlPlaneOverride });
    if (code !== undefined) return code;
    process.stdout.write(`${helpText()}\n${tuiBuildHint() ?? ""}`);
    return 0;
  }
  if (command === "test" && provider === "notification") {
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      process.stdout.write(testNotificationHelp);
      return 0;
    }
    process.stdout.write(await testConfiguredNotification(commandArgs));
    return 0;
  }
  if (command === "up") return runUpCommand(selection.args.slice(1));
  if (command === "version")
    return runVersionCommand(selection.args.slice(1), selection.controlPlaneOverride);
  if (command === "down") return runDownCommand(selection.args.slice(1));
  if (command === "logs") return runLogsCommand(selection.args.slice(1));
  if (command === "init") return runInitCommand(selection.args.slice(1));
  if (command === "config") return runConfigCommand(selection.args.slice(1));
  if (command === "mcp") return runMcpCommand(selection.args.slice(1));
  if (command === "ps") return runPsCommand(selection.args.slice(1));
  if (command === "status") {
    if (provider === "--help" || provider === "-h") {
      process.stdout.write(await runStatusCommand({ url: "", token: "" }, [provider]));
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runStatusCommand(target, selection.args.slice(1)));
    return 0;
  }
  if (command === "spend") {
    if (provider === "--help" || provider === "-h") {
      process.stdout.write(await runSpendCommand({ url: "", token: "" }, [provider]));
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runSpendCommand(target, selection.args.slice(1)));
    return 0;
  }
  if (command === "deploy") {
    process.stdout.write(await runDeploymentCommand(selection.args.slice(1)));
    return 0;
  }
  if (command === "migrate") {
    if (provider === "--help" || provider === "-h") {
      process.stdout.write(migrateHelp());
      return 0;
    }
    const { values } = parseArgs({
      args: selection.args.slice(1),
      options: {
        check: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (values.check) {
      const readiness = await inspectDatabaseMigrationReadiness();
      process.stdout.write(formatMigrationReadiness(readiness));
      return readiness.state === "current" ? 0 : 1;
    }
    const before = await inspectDatabaseMigrationReadiness();
    await migrateDatabase();
    process.stdout.write(
      before.state === "current"
        ? "SuperTag database migrations were already current; no changes were needed.\n"
        : "SuperTag database schema updated; pending migrations are now current.\n",
    );
    return 0;
  }
  if (command === "control-plane") {
    if (isControlPlaneManagementCommand(provider)) {
      await runControlPlaneManagementCommand(provider, commandArgs);
      return 0;
    }
    await runControlPlaneCommand(selection.args.slice(1));
    return 0;
  }
  if (command === "worklet" && provider === "recover") {
    await runWorkletRecoveryCommand(commandArgs);
    return 0;
  }
  if (command === "worklet" && provider === "connect") {
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      await runWorkletCommand(commandArgs);
      return 0;
    }
    const hasExplicitControlPlane = commandArgs.some(
      (argument) => argument === "--worklet-url" || argument.startsWith("--worklet-url="),
    );
    const controlPlaneUrl = hasExplicitControlPlane
      ? undefined
      : await resolveControlPlaneUrl(selection.controlPlaneOverride);
    // Joining needs the management API. The global --control-plane selection or
    // SUPERTAG_CONTROL_PLANE names it explicitly; otherwise the Worklet command derives it from
    // the Worklet URL, falling back to the saved Control Plane for a separate gRPC listener.
    const savedUrl =
      controlPlaneUrl ??
      (await resolveControlPlaneUrl(selection.controlPlaneOverride).catch(() => undefined));
    const explicitManagement =
      controlPlaneUrl !== undefined ||
      selection.controlPlaneOverride !== undefined ||
      Boolean(process.env["SUPERTAG_CONTROL_PLANE"]?.trim());
    await runWorkletCommand(
      controlPlaneUrl === undefined
        ? commandArgs
        : ["--worklet-url", controlPlaneUrl, ...commandArgs],
      {
        ...(explicitManagement && savedUrl !== undefined ? { managementUrl: savedUrl } : {}),
        ...(savedUrl === undefined ? {} : { defaultManagementUrl: savedUrl }),
        operatorTarget: () => resolveControlPlaneTarget(selection.controlPlaneOverride),
      },
    );
    return 0;
  }
  if (command === "auth-key") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(authKeyHelp());
      return 0;
    }
    if (!isAuthKeyCommand(provider)) {
      process.stderr.write(`Unknown Auth Key command: ${provider}\n\n${authKeyHelp()}`);
      return 1;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      await runAuthKeyCommand(new ControlPlaneClient(target), provider, commandArgs, target.url),
    );
    return 0;
  }
  if (command === "operator-token") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(operatorTokenHelp());
      return 0;
    }
    if (!isOperatorTokenCommand(provider)) {
      process.stderr.write(`Unknown Operator Token command: ${provider}\n\n${operatorTokenHelp()}`);
      return 1;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      await runOperatorTokenCommand(
        new ControlPlaneClient(target),
        provider,
        commandArgs,
        target.url,
      ),
    );
    return 0;
  }
  if (command === "audit") {
    const auditArgs = selection.args.slice(1);
    if (auditArgs.includes("--help") || auditArgs.includes("-h")) {
      process.stdout.write(auditHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runAuditCommand(new ControlPlaneClient(target), auditArgs));
    return 0;
  }
  if (command === "worker-host") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(workerHostOperationHelp());
      return 0;
    }
    if (!isWorkerHostCommand(provider)) {
      process.stderr.write(
        `Unknown Worker Host command: ${provider}\n\n${workerHostOperationHelp()}`,
      );
      return 1;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride).catch(
      (error: unknown) => {
        if (provider === "revoke") return undefined;
        throw error;
      },
    );
    // Without operator credentials, a Worker Host may revoke itself with its own credential.
    if (target === undefined && provider === "revoke") {
      process.stdout.write(await revokeOwnWorkerHostCredential(commandArgs));
      return 0;
    }
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      await runWorkerHostOperation(new ControlPlaneClient(target), provider, commandArgs),
    );
    return 0;
  }
  if (
    command === "setup" &&
    (provider === "slack" ||
      provider === "github" ||
      provider === "lark" ||
      provider === "linear" ||
      provider === "teams")
  ) {
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      await setupSurface(provider, commandArgs);
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    await setupSurface(provider, commandArgs, {
      enroll: async (verified) => {
        const resource = await new ControlPlaneClient(target).setupSurface(verified);
        return resource.spec;
      },
    });
    return 0;
  }
  if (
    rawSelection.args[0] === "list" &&
    rawSelection.args[1] !== "control-plane" &&
    !rawSelection.args.includes("--help") &&
    !rawSelection.args.includes("-h")
  ) {
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runListCommand(target, rawSelection.args.slice(1)));
    return 0;
  }
  if (command === "inbox") {
    if (
      (provider !== "list" && provider !== "watch") ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(inboxHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runInboxCommand(target, provider, commandArgs));
    return 0;
  }
  if (command === "team" && rawSelection.args[0] !== "team") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(teamHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      await runTeamCommand(new ControlPlaneClient(target), [provider, ...commandArgs]),
    );
    return 0;
  }
  if (command === "objective") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help")
    ) {
      process.stdout.write(objectiveHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runObjectiveCommand(target, [provider, ...commandArgs]));
    return 0;
  }
  if (command === "approval") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(approvalHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runApprovalCommand(target, [provider, ...commandArgs]));
    return 0;
  }
  if (command === "workstream") {
    if (provider !== "posts" || commandArgs.includes("--help") || commandArgs.includes("-h")) {
      process.stdout.write(workstreamHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      `${JSON.stringify(await listWorkstreamPosts(new ControlPlaneClient(target), commandArgs), null, 2)}\n`,
    );
    return 0;
  }
  if (command === "tag" && provider === "messaging") {
    if (commandArgs.length === 0 || commandArgs.includes("--help") || commandArgs.includes("-h")) {
      process.stdout.write(tagMessagingHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(await runTagMessagingCommand(target, commandArgs));
    return 0;
  }
  if (command === "tag" && provider === "message") {
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      process.stdout.write(tagConversationHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    // Ctrl-C stops showing the reply without cancelling the Task.
    const detach = new AbortController();
    const stop = () => detach.abort();
    process.once("SIGINT", stop);
    try {
      process.stdout.write(
        await runTagConversationCommand(target, commandArgs, {
          signal: detach.signal,
          write: (text) => process.stdout.write(text),
          warn: (text) => process.stderr.write(text),
          interactive: process.stdout.isTTY === true,
        }),
      );
    } finally {
      process.removeListener("SIGINT", stop);
    }
    return detach.signal.aborted ? 130 : 0;
  }
  if (command === "tag") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(tagResourceHelp());
      return 0;
    }
    if (isTagCommand(provider)) {
      const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
      if (target === undefined) throw controlPlaneRequiredError();
      process.stdout.write(
        await new ControlPlaneClient(target).runTagCommand(provider, commandArgs),
      );
      return 0;
    }
    process.stderr.write(`Unknown Tag command: ${provider}\n\n${tagResourceHelp()}`);
    return 1;
  }
  if (command === "artifact") {
    if (
      !provider ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(artifactHelp());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (!target) throw controlPlaneRequiredError();
    process.stdout.write(
      await runArtifactCommand(new ControlPlaneClient(target), provider, commandArgs),
    );
    return 0;
  }
  if (command === "task") {
    if (
      provider === undefined ||
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(taskHelp());
      return 0;
    }
    if (!isTaskCommand(provider)) {
      process.stderr.write(`Unknown Task command: ${provider}\n\n${taskHelp()}`);
      return 1;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      await runTaskCommand(new ControlPlaneClient(target), provider, commandArgs),
    );
    return 0;
  }
  if (isResourceCommand(command)) {
    if (
      provider === "--help" ||
      provider === "-h" ||
      commandArgs.includes("--help") ||
      commandArgs.includes("-h")
    ) {
      process.stdout.write(helpText());
      return 0;
    }
    const target = await resolveControlPlaneTarget(selection.controlPlaneOverride);
    if (target === undefined) throw controlPlaneRequiredError();
    process.stdout.write(
      await runResourceCommand(
        new ControlPlaneClient(target),
        command,
        [provider, ...commandArgs].filter((value): value is string => value !== undefined),
      ),
    );
    return 0;
  }

  if (command === "setup") {
    process.stderr.write(`Unknown surface: ${provider ?? "(missing)"}\n\n${helpText()}`);
    return 1;
  }

  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  });

  if (values.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(helpText());
    return 0;
  }

  process.stderr.write(
    `Unknown command: ${terminalText(positionals.join(" "))}\nRun supertag --help for available commands.\n`,
  );
  return 1;
}

function controlPlaneRequiredError(): Error {
  return new Error(
    "No Control Plane is available. Start one locally or run: supertag connect control-plane URL",
  );
}

function helpText(): string {
  return `SuperTag ${CLI_VERSION}

Usage:
  supertag                                       (in a terminal: opens the terminal UI)
  supertag [--help] [--version]
  supertag [--control-plane NAME] ACTION RESOURCE [PRIMARY_TARGET] [flags]

Get started on this machine:
  supertag init [--yes]
  supertag up [SERVICE...] [-f PATH...] [--foreground|--dry-run] [--force]
  supertag down [SERVICE...] [-f PATH...] [--remove-services] [--force]
  supertag logs [-f] [SERVICE...]
  supertag status [--output text|json]
  supertag ps [-f PATH...] [--output text|json]
  supertag spend [--by tag|objective|day] [--since ISO] [--output text|json]
  supertag config [-f PATH...] [--services]
  supertag mcp list
  supertag mcp login NAME [--export]

Read resources:
  supertag list tag|role|permission-set|context-set|volume|workspace|surface|worker-host|worker-profile|auth-key|operator-token|task|session [--output text|json|yaml]
  supertag get tag|role|permission-set|context-set|volume|workspace|surface|worker-host|worker-profile|auth-key|operator-token|task|session NAME
  supertag get tag|role|permission-set|context-set|volume|workspace|surface [NAME] --output yaml
  supertag get objective ID --output yaml
  supertag describe task|tag|volume|workspace|worker-host|session ID [--output text|json]
  supertag watch tag|role|permission-set|context-set|workspace|worker-host|worker-profile|task|session [NAME]
  supertag watch objective ID [--output text|json]

Configure the organization:
  supertag create tag NAME [--worker-host HOST ...]
  supertag update tag NAME --add-worker-host HOST
  supertag update tag NAME --remove-worker-host HOST
  supertag update tag NAME --add-location PROVIDER [provider scope flags]
  supertag update tag NAME --remove-location PROVIDER [provider scope flags]
  supertag activate context-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag deactivate context-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag activate permission-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag deactivate permission-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag create team NAME --member TAG [--member TAG ...] [--max-concurrency N]
  supertag list team
  supertag get team NAME
  supertag update team NAME [--member TAG ...] [--max-concurrency N] [--name TEXT] [--revision N]
  supertag delete team NAME
  supertag apply -f manifest.yaml|DIRECTORY [--set NAME [--prune]] [--force-conflicts]
  supertag diff -f manifest.yaml|DIRECTORY [--set NAME [--prune]] [--force-conflicts]
  supertag delete tag|role|permission-set|context-set|volume|workspace|surface NAME [--dry-run]

Direct and inspect work:
  supertag message tag NAME TEXT|- [--session NAME] [--output text|json]
  supertag create objective [ID] --outcome TEXT --owner TAG [--team TEAM] [--budget-minor N --budget-currency CODE] [--deadline ISO] [--runtime-action ACTION ...] [--workspace NAME ...] [--ongoing] [--dry-run]
  supertag list objective [--owner TAG] [--limit N]
  supertag get objective ID
  supertag describe objective ID [--output text|json]
  supertag message objective ID TEXT|- [--output text|json]
  supertag approve objective ID
  supertag update objective ID --status STATUS [--revision N]
  supertag update objective ID [--revision N] [--deadline ISO] [--budget-minor N] [--runtime-action ACTION ...]
  supertag complete objective ID --summary-file FILE|- [--revision N]
  supertag cancel objective ID [--reason TEXT]
  supertag pause objective ID
  supertag resume objective ID
  supertag list workstream-post --team TEAM [--after-sequence N] [--limit N]
  supertag list artifact [--task ID] [--limit N] [--cursor CURSOR]
  supertag get artifact ID
  supertag download artifact ID --path PATH --out FILE [--output json]
  supertag get|describe|events|cancel task ID

Decide what waits on you:
  supertag list inbox [--objective ID] [--kind approval|question|objective-budget|objective-limit|task-attention|mcp-login] [--all] [--output json|text]
  supertag watch inbox [--objective ID] [--kind KIND] [--output text|json]
  supertag list approval [--objective ID] [--status pending|approved|denied|expired|all] [--output text|json]
  supertag approve request ID [--scope once|objective] [--until ISO-8601]
  supertag deny request ID --reason TEXT
  supertag test notification [--objective ID]

Let Tags message each other:
  supertag grant mailbox RECIPIENT --sender SENDER
  supertag revoke mailbox RECIPIENT --sender SENDER
  supertag list mailbox-grant --mailbox TAG
  supertag list message --mailbox TAG [--limit N]

Connect services and compute:
  supertag setup surface slack|github|lark|linear|teams [provider options]
  supertag create auth-key NAME --tag TAG [--tag TAG ...] [--label LABEL ...] [--reusable] [--ephemeral]
  supertag revoke auth-key NAME
  supertag connect worklet [--worklet-url URL] [--auth-key KEY|file:PATH] [--worker-host ID] [--transport websocket|grpc] [--harness claude-code|codex|cursor|opencode ...] [--model [HARNESS=]MODEL] [--codex-execution-mode exec|app-server] [--worker-profile NAME] [--workspace [NAME=]PATH ...] [--label LABEL ...] [--concurrency N]
  supertag rotate worker-host-credential ID --out PATH
  supertag revoke worker-host-credential ID
  supertag drain|resume worker-host ID
  supertag enroll worker-host ID --out PATH      (a credential file for a custom Worker)
  supertag recover worklet --worker-id ID --task ID --attempt ID --confirm-stopped --reason TEXT [--host NAME]

Operate SuperTag:
  supertag version [--output text|json]          (CLI and Control Plane versions)
  supertag start control-plane [--host HOST] [--port PORT]
  supertag connect control-plane URL [--name NAME] [--replace]
  supertag create operator-token NAME            (admin token only)
  supertag revoke operator-token NAME            (admin token only)
  supertag audit [--since ISO] [--actor NAME] [--limit N] [--output text|json]
  supertag list control-plane [--output text|json|yaml]
  supertag get control-plane --current
  supertag status control-plane
  supertag use|remove control-plane NAME
  supertag migrate database [--check]
  supertag setup|check deployment --platform railway|render|cloudflare|fly|modal [--transport websocket|grpc]
  supertag verify deployment URL [--env-file PATH] [--require-ready] [--grpc-url URL]

Resource list output is a text table by default; --output json|yaml gives structured data. Get returns JSON; describe defaults to readable text for supported resources.
Commands that create or change something print a one-line summary; --output json prints the record.
delete refuses a resource that is still in use and lists what uses it. Deleting a Tag retires it:
its history stays, it receives no more work, and its name becomes free.
Manifests may declare Objectives with a Team of their own or a Team name. Applying one creates and
starts it; --prune cancels a declared Objective that left the input, keeping its history. Objectives
are never deleted. Tags in a Team message each other; a grant mailbox or a Tag manifest's
acceptsMessagesFrom lets a Tag accept messages from Tags outside its Teams.
Reconnect the original Worker Host to check interrupted work.
Until SuperTag confirms that work stopped, it keeps the host slot reserved to avoid running it twice.
For temporary (ephemeral) Worker Hosts, removing the host lets interrupted work run elsewhere.
Use recover worklet only after checking that all commands from the interrupted work have stopped.
Use resume worker-host to let a drained host accept new work again; it does not restart interrupted work.
Use --worklet-url for a separate execution listener; the saved Control Plane remains the management endpoint.
connect worklet uses a stored host credential first, then an Auth Key, then operator credentials.
connect worklet runs one harness in the foreground from its flags; it never reads supertag.yaml.
supertag up runs the services in ~/.supertag/supertag.yaml: a control-plane service and host services
(this machine as a Worker Host). Environment variables override the file; supertag config shows the result.
Worker Host labels (connect worklet --label, create auth-key --label, and automatic OS, CPU, harness:NAME,
and workspace:NAME labels) place work only: a Tag's manifest runsOn keeps its Tasks on bound hosts with every label.
A manifest location's workspaces name the Workspaces of Objectives created there (@SuperTag objective); GitHub
locations without any match Workspaces whose source is the repository. --add-location cannot set them.

Lasting credentials are read from masked prompts or provider environment variables, never flags.
connect control-plane reads an admin token or Operator Token from a masked prompt or SUPERTAG_OPERATOR_TOKEN.
--auth-key is a one-time join secret; SUPERTAG_AUTH_KEY or --auth-key file:PATH keeps it out of ps and history.
`;
}

function parseGlobalControlPlaneSelection(args: readonly string[]): {
  readonly args: readonly string[];
  readonly controlPlaneOverride?: string;
} {
  const first = args[0];
  if (first === "--control-plane") {
    const controlPlaneOverride = args[1]?.trim();
    if (!controlPlaneOverride)
      throw new Error("--control-plane requires a configured Control Plane name or URL");
    return { args: args.slice(2), controlPlaneOverride };
  }
  if (first?.startsWith("--control-plane=")) {
    const controlPlaneOverride = first.slice("--control-plane=".length).trim();
    if (!controlPlaneOverride)
      throw new Error("--control-plane requires a configured Control Plane name or URL");
    return { args: args.slice(1), controlPlaneOverride };
  }
  return { args };
}

function migrateHelp(): string {
  return `Usage: supertag migrate database [--check]

Applies pending migrations to SUPERTAG_DATABASE_URL. Without that variable, SuperTag
uses supertag.db under SUPERTAG_STATE_DIR, which defaults to ~/.supertag.

  --check  Report schema readiness without changing the database
`;
}

function formatMigrationReadiness(readiness: MigrationReadiness): string {
  const current = readiness.currentTag ?? "none";
  const pending = readiness.pendingTags.length > 0 ? readiness.pendingTags.join(", ") : "none";
  return `Database schema: ${readiness.state}\nCurrent migration: ${current}\nTarget migration: ${readiness.targetTag}\nPending migrations: ${pending}\n${readiness.detail}\n`;
}

const entryPoint = process.argv[1];
if (
  process.env["SUPERTAG_EMBEDDED_CLI"] !== "1" &&
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(formatCliFailure(error));
      process.exitCode = cliFailureExitCode(error);
    },
  );
}

export function formatCliFailure(
  error: unknown,
  args: readonly string[] = process.argv.slice(2),
): string {
  if (isPromptExitError(error)) return "Setup canceled. No credentials were saved.\n";
  const message = error instanceof Error ? error.message : String(error);
  const json = args.some(
    (arg, index) => arg === "--output=json" || (arg === "--output" && args[index + 1] === "json"),
  );
  const usageError = message.startsWith("Usage:");
  const requiredFlagError =
    /--[a-z][a-z-]*/.test(message) &&
    /\b(required|requires|must be supplied together)\b/.test(message);
  if (!json && (usageError || requiredFlagError)) {
    let commandArgs = args;
    try {
      commandArgs = parseGlobalControlPlaneSelection(args).args;
    } catch {
      // A missing global flag value must not make error reporting throw.
    }
    const usages = (usageError ? message : helpText())
      .split("\n")
      .map((line) => line.replace(/^Usage:\s*/, "").trim())
      .filter((line) => line.startsWith("supertag "));
    const usage =
      usages.find((line) => {
        const words = line.split(/\s+/).slice(1);
        const end = words.findIndex((part) => !/^[a-z][a-z-]*$/.test(part));
        const command = end === -1 ? words : words.slice(0, end);
        return command.length > 0 && command.every((word, index) => commandArgs[index] === word);
      }) ?? (usages.length === 1 ? usages[0] : undefined);
    if (usage) {
      // Optional groups do not declare required flags.
      const required = usage.replace(/\[[^\]]*\]/g, "").match(/--[a-z][a-z-]*/g) ?? [];
      const missing = required.filter(
        (flag) => !commandArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
      );
      const detail = !usageError
        ? terminalLines(message)
        : missing.length > 0
          ? `Missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`
          : "Invalid command arguments";
      return `SuperTag failed: ${detail}\nUsage: ${terminalText(usage)}\n`;
    }
    if (usageError) {
      return "SuperTag failed: Invalid command arguments\nRun supertag --help for available commands.\n";
    }
  }
  // JSON callers read one line from stderr; people read the message's own line breaks.
  return `SuperTag failed: ${json ? terminalText(message) : terminalLines(message)}\n`;
}

export function cliFailureExitCode(error: unknown): number {
  return isPromptExitError(error) ? 130 : 1;
}

function isPromptExitError(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}
