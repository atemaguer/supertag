import { parseArgs } from "node:util";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ConnectedSurfaceProvider, SurfaceProvider } from "@supertag/core";
import { ErrorDetailSchema, SetKind, type SurfaceLocationSchema } from "@supertag/operator-api";
import { SURFACE_PROVIDERS, surfaceAccountView } from "./host-protos.js";
import {
  hostClient,
  type OperatorClientOptions,
  operatorErrorMessage,
  surfaceClient,
} from "./operator-client.js";
import {
  parseContextSurfaceCommand,
  parseScopedCommand,
  type ScopedValues,
  shellWord,
  type TagCommand,
} from "./tags.js";
import { terminalText } from "./terminal-text.js";

/**
 * `update tag --add-worker-host`, `--remove-worker-host`, `--add-location` and
 * `--remove-location`, and `activate` and `deactivate` of a Context Set or Permission Set,
 * through `HostService` and `SurfaceService`.
 */
export async function runTagLocationCommand(
  options: OperatorClientOptions,
  command: Exclude<TagCommand, "create">,
  args: readonly string[],
): Promise<string> {
  if (command === "bind-worker-host" || command === "unbind-worker-host") {
    const bound = command === "bind-worker-host";
    const { name, workerHostId } = parseTagWorkerHostArgs(command, args);
    const hosts = hostClient(options);
    const change = await refused<{ readonly tag: string }>(options, undefined, () =>
      bound
        ? hosts.bindWorkerHost({ tag: name, workerHostId })
        : hosts.unbindWorkerHost({ tag: name, workerHostId }),
    );
    return `${bound ? "Bound" : "Unbound"} Worker Host ${workerHostId} ${bound ? "to" : "from"} Tag ${change.tag}.\n`;
  }
  const surfaces = surfaceClient(options);
  if (command === "add" || command === "remove") {
    const { provider, tagName, values } = parseScopedCommand(args, command);
    const location = surfaceLocation(provider, values);
    const change = await refused<{
      readonly tag: string;
      readonly location: string;
      readonly accountDisplayName: string;
      readonly changed: boolean;
    }>(options, { command, tag: tagName, provider, account: values.account }, () =>
      command === "add"
        ? surfaces.addTagLocation({ tag: tagName, location })
        : surfaces.removeTagLocation({ tag: tagName, location }),
    );
    if (command === "remove" && !change.changed)
      throw new Error(
        `${change.tag} is not configured on ${provider} ${change.location} for ${change.accountDisplayName}`,
      );
    return command === "add"
      ? `Added ${change.tag} to ${provider} ${change.location} on ${change.accountDisplayName}.\n`
      : `Removed ${change.tag} from ${provider} ${change.location} on ${change.accountDisplayName}.\n`;
  }
  const [action, ...rest] = args;
  if (
    (command === "context" || command === "permission") &&
    (action === "activate" || action === "deactivate")
  ) {
    const { tagName, setName, provider, values } = parseContextSurfaceCommand(rest);
    const request = {
      kind: command === "context" ? SetKind.CONTEXT_SET : SetKind.PERMISSION_SET,
      set: setName,
      tag: tagName,
      location: surfaceLocation(provider, values),
    };
    const change = await refused<{ readonly set: string; readonly location: string }>(
      options,
      { command, tag: tagName, provider, account: values.account },
      () =>
        action === "activate" ? surfaces.activateSet(request) : surfaces.deactivateSet(request),
    );
    return `${action === "activate" ? "Activated" : "Deactivated"} ${change.set} for ${provider} ${change.location}.\n`;
  }
  throw new Error(`Unknown Tag command: ${[command, ...args.slice(0, 1)].join(" ")}`);
}

function parseTagWorkerHostArgs(
  command: "bind-worker-host" | "unbind-worker-host",
  args: readonly string[],
): { readonly name: string; readonly workerHostId: string } {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== 2) {
    throw new Error(
      `Usage: supertag update tag NAME --${command === "bind-worker-host" ? "add" : "remove"}-worker-host HOST`,
    );
  }
  return {
    name: required(positionals[0], "Tag name"),
    workerHostId: required(positionals[1], "Worker Host ID"),
  };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function surfaceLocation(
  provider: SurfaceProvider,
  values: ScopedValues,
): MessageInitShape<typeof SurfaceLocationSchema> {
  if (provider === "cli") throw new Error("A CLI conversation is not a location");
  return {
    provider: SURFACE_PROVIDERS[provider],
    account: values.account ?? "",
    ...(provider === "slack" || provider === "teams"
      ? { channelId: values["channel-id"] ?? "" }
      : {}),
    ...(provider === "lark" ? { chatId: values["chat-id"] ?? "" } : {}),
    ...(provider === "teams" || (provider === "linear" && values["team-id"] !== undefined)
      ? { teamId: values["team-id"] ?? "" }
      : {}),
    ...(provider === "linear" && values["team-id"] === undefined
      ? { team: values.team ?? "" }
      : {}),
    ...(provider === "github" && values["repo-id"] !== undefined
      ? { repoId: values["repo-id"] }
      : {}),
    ...(provider === "github" && values["repo-id"] === undefined
      ? { repo: values.repo ?? "" }
      : {}),
  };
}

/** The `--add-location` flag of each location field. */
const LOCATION_FLAGS: Readonly<Record<string, string>> = {
  "location.channel_id": "--channel-id",
  "location.chat_id": "--chat-id",
  "location.team_id": "--team-id",
  "location.team": "--team",
  "location.repo_id": "--repo-id",
  "location.repo": "--repo",
};

/** Runs an RPC, printing its refusal as the Tag commands always have. */
async function refused<T>(
  options: OperatorClientOptions,
  location:
    | {
        readonly command: TagCommand;
        readonly tag: string;
        readonly provider: SurfaceProvider;
        readonly account: string | undefined;
      }
    | undefined,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ConnectError)) throw error;
    const paths = error
      .findDetails(ErrorDetailSchema)
      .flatMap((detail) => detail.fields.map((field) => field.path));
    if (location !== undefined) {
      if (error.code === Code.NotFound && paths.includes("tag") && location.command === "add")
        throw new Error(
          `${error.rawMessage}. Create it with: supertag create tag ${shellWord(location.tag)}`,
        );
      const flag = paths.map((path) => LOCATION_FLAGS[path]).find((value) => value !== undefined);
      if (error.code === Code.InvalidArgument && flag !== undefined)
        throw new Error(`${flag} is required`);
      if (error.code === Code.FailedPrecondition && paths.includes("location.account"))
        throw new Error(await accountSelectionMessage(options, location));
    }
    throw new Error(operatorErrorMessage(error));
  }
}

/** Why `--account` selected no connected account of the provider, or more than one. */
async function accountSelectionMessage(
  options: OperatorClientOptions,
  location: { readonly provider: SurfaceProvider; readonly account: string | undefined },
): Promise<string> {
  const { provider, account: selector } = location;
  const accounts = (
    await surfaceClient(options).listSurfaceAccounts({ pageSize: 500 })
  ).surfaceAccounts
    .map(surfaceAccountView)
    .filter(
      (account) =>
        account.spec.provider === (provider as ConnectedSurfaceProvider) &&
        (selector === undefined ||
          account.metadata.id === selector ||
          account.spec.externalAccountId === selector ||
          account.metadata.name === selector),
    );
  if (accounts.length === 0)
    return selector === undefined
      ? `No connected ${provider} account exists. Run supertag setup surface ${provider}.`
      : `No connected ${provider} account matches --account ${JSON.stringify(selector)}`;
  return `Multiple connected ${provider} accounts exist; select one with --account ID:\n${accounts.map((account) => `  ${terminalText(account.spec.externalAccountId)}\t${terminalText(account.spec.displayName)}`).join("\n")}`;
}
