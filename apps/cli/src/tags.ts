import { parseArgs } from "node:util";
import type { SurfaceProvider } from "@supertag/core";

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

export interface ScopedValues {
  readonly actions?: string;
  readonly account?: string;
  readonly "chat-id"?: string;
  readonly "channel-id"?: string;
  readonly repo?: string;
  readonly "repo-id"?: string;
  readonly team?: string;
  readonly "team-id"?: string;
}

export function parseContextSurfaceCommand(args: readonly string[]): {
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

export function parseScopedCommand(
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

export function shellWord(value: string): string {
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
