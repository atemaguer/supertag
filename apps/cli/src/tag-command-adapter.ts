import { AsyncLocalStorage } from "node:async_hooks";
import { parseArgs } from "node:util";
import type {
  GatewayCredentialVault,
  SurfaceAccount,
  SurfaceProvider,
  TagContextActivation,
  TagContextItem,
  TagContextSet,
  TagPermission,
  TagPermissionActivation,
  TagPermissionSet,
  TagRoute,
} from "@supertag/core";
import { TagAdministration, TagNotFoundError } from "./tag-administration.js";
import {
  AccountSelectionError,
  type SurfaceTarget,
  TargetValueError,
} from "./tag-surface-target.js";
import { terminalText } from "./terminal-text.js";

export type TagCommand =
  | "add"
  | "bind-worker-host"
  | "context"
  | "create"
  | "permission"
  | "list"
  | "remove"
  | "show"
  | "unbind-worker-host";

export function isTagCommand(value: string | undefined): value is TagCommand {
  return (
    value === "add" ||
    value === "bind-worker-host" ||
    value === "context" ||
    value === "create" ||
    value === "permission" ||
    value === "list" ||
    value === "remove" ||
    value === "show" ||
    value === "unbind-worker-host"
  );
}

export function tagResourceHelp(): string {
  return `Usage:
  supertag create tag NAME [--worker-host HOST ...]
  supertag list tag
  supertag get tag NAME
  supertag describe tag NAME
  supertag update tag NAME --add-location PROVIDER [provider scope flags]
  supertag update tag NAME --remove-location PROVIDER [provider scope flags]
  supertag update tag NAME --add-worker-host HOST
  supertag update tag NAME --remove-worker-host HOST
  supertag activate context-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag deactivate context-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag activate permission-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag deactivate permission-set SET --tag TAG --provider PROVIDER [provider scope flags]
`;
}

export interface TagOperationDependencies {
  readonly store: ConstructorParameters<typeof TagAdministration>[0];
  readonly credentialVault: GatewayCredentialVault;
}

const tagOutput = new AsyncLocalStorage<(text: string) => void>();

/** Compatibility decoding and rendering for the existing argv-shaped API. */
export async function renderTagOperation(
  command: TagCommand,
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<string> {
  let output = "";
  await executeTagOperation(command, args, dependencies, (text) => {
    output += text;
  });
  return output;
}

/** Shared Tag command adapter; connection lifetime belongs exclusively to the caller. */
export async function executeTagOperation(
  command: TagCommand,
  args: readonly string[],
  dependencies: TagOperationDependencies,
  write: (text: string) => void,
): Promise<void> {
  await tagOutput.run(write, async () => {
    if (args.includes("--help") || args.includes("-h")) {
      writeTagOutput(tagHelp(command));
      return;
    }
    try {
      if (command === "context") await runContextCommand(args, dependencies);
      else if (command === "permission") await runPermissionCommand(args, dependencies);
      else if (command === "create") await createTag(args, dependencies);
      else if (command === "add") await addTagToSurface(args, dependencies);
      else if (command === "remove") await removeTagFromSurface(args, dependencies);
      else if (command === "show") await showTag(args, dependencies);
      else await listTags(args, dependencies);
    } catch (error) {
      throw tagOperationError(error, command);
    }
  });
}

function writeTagOutput(text: string): void {
  const write = tagOutput.getStore();
  if (!write) throw new Error("Tag operation rendering requires an output sink");
  write(text);
}

type ContextCommand =
  | "activate"
  | "add"
  | "add-skill"
  | "add-artifacts"
  | "create"
  | "deactivate"
  | "delete"
  | "list"
  | "remove"
  | "show";

async function runContextCommand(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    writeTagOutput(contextHelp());
    return;
  }
  if (!isContextCommand(command)) {
    throw new Error(`Unknown Context Set command: ${command}\n\n${contextHelp().trim()}`);
  }
  if (command === "create") {
    await createContextSet(commandArgs, dependencies);
  } else if (command === "list") {
    await listContextSets(commandArgs, dependencies);
  } else if (command === "show") {
    await showContextSet(commandArgs, dependencies);
  } else if (command === "add") {
    await addCustomContextItem(commandArgs, dependencies);
  } else if (command === "add-artifacts") {
    await addContextArtifacts(commandArgs, dependencies);
  } else if (command === "add-skill") {
    await addContextSkill(commandArgs, dependencies);
  } else if (command === "remove") {
    await removeContextSource(commandArgs, dependencies);
  } else if (command === "activate") {
    await setContextActivation(commandArgs, dependencies, true);
  } else if (command === "deactivate") {
    await setContextActivation(commandArgs, dependencies, false);
  } else {
    await deleteContextSet(commandArgs, dependencies);
  }
}

function isContextCommand(value: string): value is ContextCommand {
  return [
    "activate",
    "add",
    "add-skill",
    "add-artifacts",
    "create",
    "deactivate",
    "delete",
    "list",
    "remove",
    "show",
  ].includes(value);
}

async function addCustomContextItem(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      optional: { type: "boolean" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (positionals.length !== 4) {
    throw new Error(
      "Usage: supertag tag context add TAG SET TYPE ITEM_KEY --version N [--config JSON] [--optional]",
    );
  }
  const tagName = required(positionals[0], "Tag name");
  const setName = required(positionals[1], "Context Set name");
  const type = required(positionals[2], "Context type");
  const itemKey = required(positionals[3], "Context item key");
  const version = Number(required(values.version, "--version"));
  if (!Number.isInteger(version) || version < 1)
    throw new Error("--version must be a positive integer");
  const config = values.config === undefined ? {} : JSON.parse(values.config);
  if (config === null || Array.isArray(config) || typeof config !== "object")
    throw new Error("--config must be a JSON object");
  const { contextSet, item } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).addContextItem(tagName, setName, {
    itemKey,
    type,
    version,
    required: values.optional !== true,
    config,
  });
  writeTagOutput(`Added ${item.type}@${item.version} ${item.itemKey} to ${contextSet.name}.\n`);
}

async function addContextSkill(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      digest: { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (positionals.length !== 3) {
    throw new Error("Usage: supertag tag context add-skill TAG SET SKILL_ID [options]");
  }
  const tagName = required(positionals[0], "Tag name");
  const setName = required(positionals[1], "Context Set name");
  const reference = required(positionals[2], "Skill id");
  const configuration = {
    ...(values.version === undefined ? {} : { version: required(values.version, "--version") }),
    ...(values.digest === undefined ? {} : { digest: required(values.digest, "--digest") }),
  };
  const { contextSet, item } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).addSkill(tagName, setName, reference, configuration);
  writeTagOutput(`Added skill ${reference} to ${contextSet.name} (${item.id}).\n`);
}

async function createContextSet(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName] = exactPositionals(args, 2, "supertag tag context create TAG SET");
  const { tag, contextSet } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).createContextSet(tagName, setName);
  writeTagOutput(
    `Created shared Context Set ${contextSet.name} (${contextSet.id}); activate it at a ${tag.name} location to use it.\n`,
  );
}

async function listContextSets(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName] = exactPositionals(args, 1, "supertag tag context list TAG");
  const { tag, sets, sources, activations } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).listContextSets(tagName);
  if (sets.length === 0) {
    writeTagOutput(`No Context Sets for ${tag.name}.\n`);
    return;
  }
  writeTagOutput("NAME\tITEMS\tACTIVATIONS\n");
  for (const set of sets) {
    writeTagOutput(
      `${set.name}\t${sources.filter((item) => item.contextSetId === set.id).length}\t${activations.filter((activation) => activation.contextSetId === set.id).length}\n`,
    );
  }
}

async function showContextSet(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName] = exactPositionals(args, 2, "supertag tag context show TAG SET");
  const { tag, contextSet, sources, activations, accounts, locations } =
    await new TagAdministration(dependencies.store, dependencies.credentialVault).showContextSet(
      tagName,
      setName,
    );
  writeTagOutput(`Context Set: ${contextSet.name}\nTag: ${tag.name}\nID: ${contextSet.id}\n\n`);
  writeContextItems(sources);
  writeTagOutput("\n");
  writeContextActivations(activations, locations, accounts);
}

async function addContextArtifacts(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const parsed = parseContextArtifactsCommand(args);
  const { contextSet, source, resolved } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).addArtifacts(parsed.tagName, parsed.setName, surfaceTarget(parsed.provider, parsed.values), {
    maxAgeDays: parsed.maxAgeDays,
    limit: parsed.limit,
  });
  writeTagOutput(
    `Added artifacts from ${parsed.provider} ${resolved.displayName} to ${contextSet.name} (${source.id}).\n`,
  );
}

async function removeContextSource(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName, sourceId] = exactPositionals(
    args,
    3,
    "supertag tag context remove TAG SET ENTRY_ID",
  );
  const { contextSet, source } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).removeContextItem(tagName, setName, sourceId);
  writeTagOutput(`Removed Context entry ${source.id} from ${contextSet.name}.\n`);
}

async function setContextActivation(
  args: readonly string[],
  dependencies: TagOperationDependencies,
  active: boolean,
): Promise<void> {
  const { tagName, setName, provider, values } = parseContextSurfaceCommand(args);
  const { contextSet, resolved } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).setContextActivation(tagName, setName, surfaceTarget(provider, values), active);
  writeTagOutput(
    `${active ? "Activated" : "Deactivated"} ${contextSet.name} for ${provider} ${resolved.displayName}.\n`,
  );
}

async function deleteContextSet(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName] = exactPositionals(args, 2, "supertag tag context delete TAG SET");
  const contextSet = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).deleteContextSet(tagName, setName);
  writeTagOutput(`Deleted Context Set ${contextSet.name}.\n`);
}

type PermissionCommand =
  | "activate"
  | "allow"
  | "create"
  | "deactivate"
  | "delete"
  | "list"
  | "revoke"
  | "show";

async function runPermissionCommand(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    writeTagOutput(permissionHelp());
    return;
  }
  if (!isPermissionCommand(command)) {
    throw new Error(`Unknown Permission Set command: ${command}\n\n${permissionHelp().trim()}`);
  }
  if (command === "create") {
    await createPermissionSet(commandArgs, dependencies);
  } else if (command === "list") {
    await listPermissionSets(commandArgs, dependencies);
  } else if (command === "show") {
    await showPermissionSet(commandArgs, dependencies);
  } else if (command === "allow") {
    await changePermissionSetActions(commandArgs, dependencies, true);
  } else if (command === "revoke") {
    await changePermissionSetActions(commandArgs, dependencies, false);
  } else if (command === "activate") {
    await setPermissionActivation(commandArgs, dependencies, true);
  } else if (command === "deactivate") {
    await setPermissionActivation(commandArgs, dependencies, false);
  } else {
    await deletePermissionSet(commandArgs, dependencies);
  }
}

function isPermissionCommand(value: string): value is PermissionCommand {
  return ["activate", "allow", "create", "deactivate", "delete", "list", "revoke", "show"].includes(
    value,
  );
}

async function createPermissionSet(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName] = exactPositionals(args, 2, "supertag tag permission create TAG SET");
  const { tag, permissionSet: set } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).createPermissionSet(tagName, setName);
  writeTagOutput(
    `Created shared Permission Set ${set.name} (${set.id}); activate it at a ${tag.name} location to use it.\n`,
  );
}

async function listPermissionSets(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName] = exactPositionals(args, 1, "supertag tag permission list TAG");
  const { tag, sets, permissions, activations } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).listPermissionSets(tagName);
  if (sets.length === 0) {
    writeTagOutput(`No Permission Sets for ${tag.name}.\n`);
    return;
  }
  writeTagOutput("NAME\tPERMISSIONS\tACTIVATIONS\n");
  for (const set of sets) {
    writeTagOutput(
      `${set.name}\t${permissions.filter((permission) => permission.permissionSetId === set.id).length}\t${activations.filter((activation) => activation.permissionSetId === set.id).length}\n`,
    );
  }
}

async function showPermissionSet(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName] = exactPositionals(args, 2, "supertag tag permission show TAG SET");
  const { tag, permissionSet, permissions, activations, accounts, locations } =
    await new TagAdministration(dependencies.store, dependencies.credentialVault).showPermissionSet(
      tagName,
      setName,
    );
  writeTagOutput(
    `Permission Set: ${permissionSet.name}\nTag: ${tag.name}\nID: ${permissionSet.id}\n\n`,
  );
  writePermissions(permissions, accounts);
  writeTagOutput("\n");
  writePermissionActivations(activations, locations, accounts);
}

async function changePermissionSetActions(
  args: readonly string[],
  dependencies: TagOperationDependencies,
  allow: boolean,
): Promise<void> {
  const [tagName, setName, ...scopedArgs] = args;
  const normalizedTagName = required(tagName, "Tag name");
  const normalizedSetName = required(setName, "Permission Set name");
  if (scopedArgs[0] === "runtime") {
    const { values, positionals } = parseArgs({
      args: scopedArgs.slice(1),
      allowPositionals: true,
      options: { actions: { type: "string" } },
      strict: true,
    });
    if (positionals.length > 0) throw new Error(permissionHelp().trim());
    const actions = parsePermissionActions(values.actions);
    const permissionSet = await new TagAdministration(
      dependencies.store,
      dependencies.credentialVault,
    ).changeRuntimePermissions(normalizedTagName, normalizedSetName, actions, allow);
    writeTagOutput(
      `${allow ? "Allowed" : "Revoked"} ${actions.join(", ")} ${allow ? "in" : "from"} Permission Set ${permissionSet.name}.\n`,
    );
    return;
  }
  const { provider, values } = parseScopedCommand(
    [normalizedTagName, ...scopedArgs],
    allow ? "allow" : "revoke",
  );
  const actions = parsePermissionActions(values.actions);
  const permissionSet = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).changeSurfacePermissions(
    normalizedTagName,
    normalizedSetName,
    surfaceTarget(provider, values),
    actions,
    allow,
  );
  writeTagOutput(
    `${allow ? "Allowed" : "Revoked"} ${actions.join(", ")} ${allow ? "in" : "from"} Permission Set ${permissionSet.name}.\n`,
  );
}

async function setPermissionActivation(
  args: readonly string[],
  dependencies: TagOperationDependencies,
  active: boolean,
): Promise<void> {
  const { tagName, setName, provider, values } = parseContextSurfaceCommand(args);
  const { permissionSet, resolved } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).setPermissionActivation(tagName, setName, surfaceTarget(provider, values), active);
  writeTagOutput(
    `${active ? "Activated" : "Deactivated"} ${permissionSet.name} for ${provider} ${resolved.displayName}.\n`,
  );
}

async function deletePermissionSet(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const [tagName, setName] = exactPositionals(args, 2, "supertag tag permission delete TAG SET");
  const permissionSet = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).deletePermissionSet(tagName, setName);
  writeTagOutput(`Deleted Permission Set ${permissionSet.name}.\n`);
}

async function createTag(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== 1) throw new Error("Usage: supertag create tag NAME");
  const tag = await new TagAdministration(dependencies.store, dependencies.credentialVault).create(
    required(positionals[0], "Tag name"),
  );
  writeTagOutput(`Created Tag ${tag.name} (${tag.id}).\n`);
}

async function addTagToSurface(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { provider, tagName, values } = parseScopedCommand(args, "add");
  const { tag, resolved } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).addRoute(tagName, surfaceTarget(provider, values));
  const account = resolved.account;
  writeTagOutput(
    `Added ${tag.name} to ${provider} ${resolved.displayName} on ${account.displayName}.\n`,
  );
}

async function removeTagFromSurface(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { provider, tagName, values } = parseScopedCommand(args, "remove");
  const { tag, resolved } = await new TagAdministration(
    dependencies.store,
    dependencies.credentialVault,
  ).removeRoute(tagName, surfaceTarget(provider, values));
  const account = resolved.account;
  writeTagOutput(
    `Removed ${tag.name} from ${provider} ${resolved.displayName} on ${account.displayName}.\n`,
  );
}

async function showTag(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {},
    strict: true,
  });
  if (positionals.length !== 1) {
    throw new Error("Usage: supertag tag show NAME");
  }
  const name = required(positionals[0], "Tag name");
  const { tag, accounts, locations, permissionSets, permissions, contextSets } =
    await new TagAdministration(dependencies.store, dependencies.credentialVault).show(name);
  writeTagOutput(`Tag: ${tag.name}\nID: ${tag.id}\nStatus: ${tag.status}\n\n`);
  writeAvailability(locations, accounts);
  writeTagOutput("\n");
  writePermissionSetSummary(permissionSets);
  writeTagOutput("\n");
  writePermissions(permissions, accounts);
  writeTagOutput("\n");
  writeContextSetSummary(contextSets);
}

async function listTags(
  args: readonly string[],
  dependencies: TagOperationDependencies,
): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== 0) {
    throw new Error("Usage: supertag tag list");
  }
  const rows = await new TagAdministration(dependencies.store, dependencies.credentialVault).list();
  if (rows.length === 0) {
    writeTagOutput("No Tags.\n");
    return;
  }
  writeTagOutput("NAME\tSTATUS\tAVAILABLE_IN\tPERMISSION_SETS\tCONTEXTS\n");
  for (const row of rows) {
    writeTagOutput(
      `${[
        row.tag.name,
        row.tag.status,
        row.locationCount,
        row.permissionSetCount,
        row.contextSetCount,
      ].join("\t")}\n`,
    );
  }
}

function writePermissionSetSummary(permissionSets: readonly TagPermissionSet[]): void {
  if (permissionSets.length === 0) {
    writeTagOutput("Permission Sets: none\n");
    return;
  }
  writeTagOutput("PERMISSION_SET\tID\n");
  for (const permissionSet of permissionSets) {
    writeTagOutput(`${permissionSet.name}\t${permissionSet.id}\n`);
  }
}

function writeContextSetSummary(contextSets: readonly TagContextSet[]): void {
  if (contextSets.length === 0) {
    writeTagOutput("Context Sets: none\n");
    return;
  }
  writeTagOutput("CONTEXT_SET\tID\n");
  for (const contextSet of contextSets) {
    writeTagOutput(`${contextSet.name}\t${contextSet.id}\n`);
  }
}

function writePermissions(
  permissions: readonly TagPermission[],
  accounts: readonly SurfaceAccount[],
): void {
  if (permissions.length === 0) {
    writeTagOutput("Additional access: none\n");
    return;
  }
  writeTagOutput("ACTION\tRESOURCE\tACCOUNT\n");
  for (const permission of permissions) {
    if (permission.target === "runtime") {
      writeTagOutput(`${permission.action}\truntime\t-\n`);
      continue;
    }
    if (permission.target === "mcp") {
      writeTagOutput(
        `${permission.action}\tmcp${permission.resource ? `:${permission.resource}` : ""}\t-\n`,
      );
      continue;
    }
    const account = accountById(accounts, permission.surfaceAccountId);
    const provider = account?.provider ?? "unknown";
    const accountName = account?.displayName ?? permission.surfaceAccountId;
    writeTagOutput(
      `${[permission.action, `${provider}:${permission.reference ?? permission.scope}`, accountName].join("\t")}\n`,
    );
  }
}

function writeAvailability(
  locations: readonly TagRoute[],
  accounts: readonly SurfaceAccount[],
): void {
  if (locations.length === 0) {
    writeTagOutput("Available in: none\n");
    return;
  }
  writeTagOutput("LOCATION\tACCOUNT\tSTATUS\n");
  for (const route of locations) {
    const account = accountById(accounts, route.surfaceAccountId);
    const provider = account?.provider ?? "unknown";
    const accountName = account?.displayName ?? route.surfaceAccountId;
    writeTagOutput(
      `${[`${provider}:${route.scope}`, accountName, route.enabled ? "enabled" : "disabled"].join("\t")}\n`,
    );
  }
}

function writeContextItems(sources: readonly TagContextItem[]): void {
  if (sources.length === 0) {
    writeTagOutput("Context entries: none\n");
    return;
  }
  writeTagOutput("ENTRY_ID\tTYPE\tVERSION\tREQUIRED\tCONFIG\n");
  for (const source of sources) {
    writeTagOutput(
      `${[
        source.id,
        source.type,
        source.version,
        source.required,
        JSON.stringify(source.config),
      ].join("\t")}\n`,
    );
  }
}

function writeContextActivations(
  activations: readonly TagContextActivation[],
  locations: readonly TagRoute[],
  accounts: readonly SurfaceAccount[],
): void {
  if (activations.length === 0) {
    writeTagOutput("Activations: none\n");
    return;
  }
  writeTagOutput("ACTIVE_FROM\tACCOUNT\n");
  for (const activation of activations) {
    const route = locations.find((candidate) => candidate.id === activation.tagRouteId);
    const account = route === undefined ? undefined : accountById(accounts, route.surfaceAccountId);
    writeTagOutput(
      `${account?.provider ?? "unknown"}:${route?.scope ?? activation.tagRouteId}\t${account?.displayName ?? "unknown"}\n`,
    );
  }
}

function writePermissionActivations(
  activations: readonly TagPermissionActivation[],
  locations: readonly TagRoute[],
  accounts: readonly SurfaceAccount[],
): void {
  if (activations.length === 0) {
    writeTagOutput("Activations: none\n");
    return;
  }
  writeTagOutput("ACTIVE_FROM\tACCOUNT\n");
  for (const activation of activations) {
    const route = locations.find((candidate) => candidate.id === activation.tagRouteId);
    const account = route === undefined ? undefined : accountById(accounts, route.surfaceAccountId);
    writeTagOutput(
      `${account?.provider ?? "unknown"}:${route?.scope ?? activation.tagRouteId}\t${account?.displayName ?? "unknown"}\n`,
    );
  }
}

interface ScopedValues {
  readonly actions?: string;
  readonly account?: string;
  readonly "chat-id"?: string;
  readonly "channel-id"?: string;
  readonly repo?: string;
  readonly "repo-id"?: string;
  readonly team?: string;
  readonly "team-id"?: string;
}

function parseContextArtifactsCommand(args: readonly string[]): {
  readonly tagName: string;
  readonly setName: string;
  readonly provider: SurfaceProvider;
  readonly values: ScopedValues;
  readonly maxAgeDays: number;
  readonly limit: number;
} {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...scopedOptions(),
      match: { type: "string" },
      "max-age-days": { type: "string" },
      limit: { type: "string" },
    },
    strict: true,
  });
  if (positionals.length !== 3) {
    throw new Error(contextHelp().trim());
  }
  const tagName = required(positionals[0], "Tag name");
  const setName = required(positionals[1], "Context Set name");
  const provider = parseProvider(required(positionals[2], "artifact source provider"));
  validateScopedValues(provider, values);
  if ((values.match ?? "shared-resource") !== "shared-resource") {
    throw new Error("--match must be shared-resource");
  }
  return {
    tagName,
    setName,
    provider,
    values,
    maxAgeDays: positiveCliInteger(values["max-age-days"] ?? "30", "--max-age-days", 3_650),
    limit: positiveCliInteger(values.limit ?? "5", "--limit", 5),
  };
}

function parseContextSurfaceCommand(args: readonly string[]): {
  readonly tagName: string;
  readonly setName: string;
  readonly provider: SurfaceProvider;
  readonly values: ScopedValues;
} {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: scopedOptions(),
    strict: true,
  });
  if (positionals.length !== 3) {
    throw new Error(contextHelp().trim());
  }
  const provider = parseProvider(positionals[2]);
  validateScopedValues(provider, values);
  return {
    tagName: required(positionals[0], "Tag name"),
    setName: required(positionals[1], "Context Set name"),
    provider,
    values,
  };
}

function scopedOptions() {
  return {
    account: { type: "string" as const },
    "chat-id": { type: "string" as const },
    "channel-id": { type: "string" as const },
    repo: { type: "string" as const },
    "repo-id": { type: "string" as const },
    team: { type: "string" as const },
    "team-id": { type: "string" as const },
  };
}

function exactPositionals(args: readonly string[], count: 1, usage: string): readonly [string];
function exactPositionals(
  args: readonly string[],
  count: 2,
  usage: string,
): readonly [string, string];
function exactPositionals(
  args: readonly string[],
  count: 3,
  usage: string,
): readonly [string, string, string];
function exactPositionals(
  args: readonly string[],
  count: number,
  usage: string,
): readonly string[] {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== count) {
    throw new Error(`Usage: ${usage}`);
  }
  return positionals.map((value, index) => required(value, `Argument ${index + 1}`));
}

function parseScopedCommand(
  args: readonly string[],
  command: "add" | "allow" | "remove" | "revoke",
): {
  readonly provider: SurfaceProvider;
  readonly tagName: string;
  readonly values: ScopedValues;
} {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...scopedOptions(), actions: { type: "string" } },
    strict: true,
  });
  if (positionals.length !== 2) {
    throw new Error(
      (command === "allow" || command === "revoke" ? permissionHelp() : tagHelp(command)).trim(),
    );
  }
  const tagName = required(positionals[0], "Tag name");
  const provider = parseProvider(positionals[1]);
  if (command === "allow" || command === "revoke") {
    required(values.actions, "--actions");
  } else if (values.actions !== undefined) {
    throw new Error(`--actions is only valid with tag permission allow or tag permission revoke`);
  }
  validateScopedValues(provider, values);
  return { provider, tagName, values };
}

function validateScopedValues(provider: SurfaceProvider, values: ScopedValues): void {
  if (provider === "lark") {
    if (values["chat-id"] === undefined) {
      throw new Error("--chat-id is required for Lark");
    }
    if (
      values["channel-id"] !== undefined ||
      values.repo !== undefined ||
      values["repo-id"] !== undefined ||
      values.team !== undefined ||
      values["team-id"] !== undefined
    ) {
      throw new Error("Slack, GitHub, Linear, and Teams scope options cannot be used with Lark");
    }
    return;
  }
  if (provider === "slack") {
    if (values["channel-id"] === undefined) {
      throw new Error("--channel-id is required for Slack; channel names are not stable IDs");
    }
    if (
      values["chat-id"] !== undefined ||
      values.repo !== undefined ||
      values["repo-id"] !== undefined ||
      values.team !== undefined ||
      values["team-id"] !== undefined
    ) {
      throw new Error("Lark, GitHub, Linear, and Teams scope options cannot be used with Slack");
    }
    return;
  }
  if (provider === "github") {
    const repositoryOptionCount =
      Number(values.repo !== undefined) + Number(values["repo-id"] !== undefined);
    if (repositoryOptionCount !== 1) {
      throw new Error("GitHub requires exactly one of --repo owner/name or --repo-id ID");
    }
    if (values["chat-id"] !== undefined || values["channel-id"] !== undefined) {
      throw new Error("--chat-id and --channel-id cannot be used with GitHub");
    }
    if (values.team !== undefined || values["team-id"] !== undefined) {
      throw new Error("Linear team options cannot be used with GitHub");
    }
    return;
  }
  if (provider === "teams") {
    if (values["team-id"] === undefined || values["channel-id"] === undefined) {
      throw new Error("Teams requires both --team-id ID and --channel-id ID");
    }
    if (
      values["chat-id"] !== undefined ||
      values.team !== undefined ||
      values.repo !== undefined ||
      values["repo-id"] !== undefined
    ) {
      throw new Error("Lark, GitHub, and Linear scope options cannot be used with Teams");
    }
    return;
  }
  const teamOptionCount =
    Number(values.team !== undefined) + Number(values["team-id"] !== undefined);
  if (teamOptionCount !== 1) {
    throw new Error("Linear requires exactly one of --team NAME|KEY or --team-id UUID");
  }
  if (
    values["chat-id"] !== undefined ||
    values["channel-id"] !== undefined ||
    values.repo !== undefined ||
    values["repo-id"] !== undefined
  ) {
    throw new Error("Slack, Lark, and GitHub scope options cannot be used with Linear");
  }
}

function parsePermissionActions(value: string | undefined): readonly string[] {
  const actions = [
    ...new Set(
      required(value, "--actions")
        .split(",")
        .map((action) => action.trim())
        .filter((action) => action.length > 0),
    ),
  ];
  if (actions.length === 0) {
    throw new Error("--actions must contain at least one action");
  }
  return actions;
}

function parseProvider(value: string | undefined): SurfaceProvider {
  if (
    value === "github" ||
    value === "lark" ||
    value === "linear" ||
    value === "slack" ||
    value === "teams"
  ) {
    return value;
  }
  throw new Error(
    `Surface provider must be slack, github, lark, linear, or teams, received ${JSON.stringify(value)}`,
  );
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function positiveCliInteger(value: string, label: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function accountById(accounts: readonly SurfaceAccount[], id: string): SurfaceAccount | undefined {
  return accounts.find((account) => account.id === id);
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_.-]+$/u.test(value) ? value : JSON.stringify(value);
}

function tagHelp(command: TagCommand): string {
  if (command === "context") {
    return contextHelp();
  }
  if (command === "permission") {
    return permissionHelp();
  }
  if (command === "create") {
    return "Usage: supertag create tag NAME [--worker-host HOST ...]\n";
  }
  if (command === "bind-worker-host" || command === "unbind-worker-host") {
    return `Usage: supertag update tag NAME --${command === "bind-worker-host" ? "add" : "remove"}-worker-host HOST\n`;
  }
  if (command === "add") {
    return `Usage:
  supertag update tag NAME --add-location slack --channel-id ID [--account ID]
  supertag update tag NAME --add-location github (--repo owner/name | --repo-id ID) [--account ID]
  supertag update tag NAME --add-location lark --chat-id ID [--account ID]
  supertag update tag NAME --add-location linear (--team NAME|KEY | --team-id UUID) [--account ID]
  supertag update tag NAME --add-location teams --team-id ID --channel-id ID [--account ID]
`;
  }
  if (command === "remove") {
    return `Usage:
  supertag update tag NAME --remove-location slack --channel-id ID [--account ID]
  supertag update tag NAME --remove-location github (--repo owner/name | --repo-id ID) [--account ID]
  supertag update tag NAME --remove-location lark --chat-id ID [--account ID]
  supertag update tag NAME --remove-location linear (--team NAME|KEY | --team-id UUID) [--account ID]
  supertag update tag NAME --remove-location teams --team-id ID --channel-id ID [--account ID]
`;
  }
  if (command === "show") {
    return "Usage: supertag describe tag NAME\n";
  }
  return "Usage: supertag list tag\n";
}

function permissionHelp(): string {
  return `Usage:
  supertag list permission-set
  supertag get permission-set SET
  supertag describe permission-set SET
  supertag activate permission-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag deactivate permission-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag apply -f manifest.yaml

Permission Sets authorize surface resources and Harness/runtime tools. Standard runtime
actions are commands:execute, files:write, web:fetch, web:search, and browser:use.
They never select knowledge or skills; configure those with a Context Set.
`;
}

function contextHelp(): string {
  return `Usage:
  supertag list context-set
  supertag get context-set SET
  supertag describe context-set SET
  supertag activate context-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag deactivate context-set SET --tag TAG --provider PROVIDER [provider scope flags]
  supertag apply -f manifest.yaml

Same-Session continuity is automatic. Context Sets compose Skills, shared artifacts, and
namespaced custom types handled by compatible Workers. Context selection does not authorize
surface access; operational permissions remain in Permission Sets.
`;
}

function surfaceTarget(provider: SurfaceProvider, values: ScopedValues): SurfaceTarget {
  const common = values.account === undefined ? {} : { accountSelector: values.account };
  switch (provider) {
    case "slack":
      return { ...common, provider, channelId: values["channel-id"] ?? "" };
    case "lark":
      return { ...common, provider, chatId: values["chat-id"] ?? "" };
    case "teams":
      return {
        ...common,
        provider,
        teamId: values["team-id"] ?? "",
        channelId: values["channel-id"] ?? "",
      };
    case "github":
      return values["repo-id"] === undefined
        ? { ...common, provider, repositoryName: values.repo ?? "" }
        : { ...common, provider, repositoryId: values["repo-id"] };
    case "linear":
      return values["team-id"] === undefined
        ? { ...common, provider, teamName: values.team ?? "" }
        : { ...common, provider, teamId: values["team-id"] };
    case "cli":
      throw new Error("A CLI conversation is not a location");
  }
}

function tagOperationError(error: unknown, command: TagCommand): unknown {
  if (error instanceof TagNotFoundError && command === "add")
    return new Error(
      `${error.message}. Create it with: supertag create tag ${shellWord(error.tagName)}`,
    );
  if (error instanceof TargetValueError) {
    const labels = {
      channelId: "--channel-id",
      chatId: "--chat-id",
      teamId: "--team-id",
      teamName: "--team",
      repositoryId: "--repo-id",
      repositoryName: "--repo",
    };
    return new Error(`${labels[error.field]} is required`);
  }
  if (error instanceof AccountSelectionError) {
    const { provider, selector, matches } = error.selection;
    if (matches.length === 0)
      return new Error(
        selector === undefined
          ? `No connected ${provider} account exists. Run supertag setup surface ${provider}.`
          : `No connected ${provider} account matches --account ${JSON.stringify(selector)}`,
      );
    return new Error(
      `Multiple connected ${provider} accounts exist; select one with --account ID:\n${matches.map((account) => `  ${terminalText(account.externalAccountId)}\t${terminalText(account.displayName)}`).join("\n")}`,
    );
  }
  return error;
}
