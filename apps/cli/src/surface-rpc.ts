import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type {
  ConnectedSurfaceProvider,
  SurfaceAccount as SurfaceAccountRecord,
} from "@supertag/core";
import {
  ErrorReason,
  type FieldViolationSchema,
  SetKind,
  SurfaceAccountSchema,
  type SurfaceLocation,
  type SurfaceService,
} from "@supertag/operator-api";
import { surfaceAccountResource } from "./control-plane-resources.js";
import { nameOf, SURFACE_PROVIDERS, surfaceAccountMessage } from "./host-protos.js";
import { assertAccepting } from "./inbox-rpc.js";
import { pageOf } from "./operator-pages.js";
import { noteAuditTarget, operatorError, requiredField } from "./operator-rpc-context.js";
import type {
  OperatorControl,
  OperatorReadStore,
  OperatorSurfaceLocation,
  ResolvedSurfaceLocation,
} from "./operator-seams.js";

export interface SurfaceServiceDependencies {
  readonly store: Pick<
    OperatorReadStore,
    "findSurfaceAccount" | "findSurfaceAccountByName" | "listSurfaceAccounts"
  >;
  /** Saves Surface Accounts, and changes where Tags answer and which sets apply there. */
  readonly control: Pick<
    OperatorControl,
    "accepting" | "setSetActivation" | "setTagLocation" | "setUpSurface"
  >;
}

/** The location fields each provider takes; at least one of each inner list is required. */
const LOCATION_FIELDS: Readonly<
  Record<ConnectedSurfaceProvider, readonly (readonly LocationField[])[]>
> = {
  slack: [["channelId"]],
  lark: [["chatId"]],
  teams: [["teamId"], ["channelId"]],
  github: [["repo", "repoId"]],
  linear: [["team", "teamId"]],
};

type LocationField = "channelId" | "chatId" | "teamId" | "team" | "repoId" | "repo";

const FIELD_PATHS: Readonly<Record<LocationField, string>> = {
  channelId: "channel_id",
  chatId: "chat_id",
  teamId: "team_id",
  team: "team",
  repoId: "repo_id",
  repo: "repo",
};

/** `SurfaceService`: collaboration surface accounts, and where Tags answer on them. */
export function surfaceService(
  dependencies: SurfaceServiceDependencies,
): ServiceImpl<typeof SurfaceService> {
  const { store, control } = dependencies;
  const message = (account: SurfaceAccountRecord) =>
    create(SurfaceAccountSchema, surfaceAccountMessage(surfaceAccountResource(account)));

  const locationChange = async (
    request: { readonly tag: string; readonly location?: SurfaceLocation | undefined },
    context: HandlerContext,
    present: boolean,
  ) => {
    noteAuditTarget(context, "Tag");
    const tag = requiredField(request.tag, "tag", "a Tag's name");
    const location = surfaceLocation(request.location);
    await assertAccepting(control);
    const change = await control.setTagLocation({ tag, location, present });
    noteAuditTarget(context, `Tag/${change.tag.name}`);
    return { ...resolvedLocation(change), changed: change.changed };
  };

  const activation = async (
    request: {
      readonly kind: SetKind;
      readonly set: string;
      readonly tag: string;
      readonly location?: SurfaceLocation | undefined;
    },
    context: HandlerContext,
    active: boolean,
  ) => {
    noteAuditTarget(context, "Tag");
    const kind =
      request.kind === SetKind.CONTEXT_SET
        ? "context-set"
        : request.kind === SetKind.PERMISSION_SET
          ? "permission-set"
          : undefined;
    if (kind === undefined)
      throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, "kind is required", [
        { path: "kind", description: "a Context Set or a Permission Set" },
      ]);
    const set = requiredField(request.set, "set", "a set's name");
    const tag = requiredField(request.tag, "tag", "a Tag's name");
    const location = surfaceLocation(request.location);
    await assertAccepting(control);
    const change = await control.setSetActivation({ kind, set, tag, location, active });
    noteAuditTarget(context, `Tag/${change.tag.name}`);
    const { tagId: _tagId, accountDisplayName: _account, ...view } = resolvedLocation(change);
    return { ...view, kind: request.kind, set: change.set };
  };

  return {
    async setUpSurface(request, context) {
      noteAuditTarget(context, "SurfaceAccount");
      const violations: MessageInitShape<typeof FieldViolationSchema>[] = [];
      const provider = nameOf(SURFACE_PROVIDERS, request.provider);
      if (provider === undefined)
        violations.push({ path: "provider", description: "a collaboration surface" });
      for (const [path, value] of [
        ["external_account_id", request.externalAccountId],
        ["display_name", request.displayName],
        ["auth_method", request.authMethod],
      ] as const)
        if (value.trim() === "") violations.push({ path, description: "must not be empty" });
      if (provider === undefined || violations.length > 0)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          `Set ${violations.map((violation) => violation.path).join(", ")}`,
          violations,
        );
      await assertAccepting(control);
      const account = await control.setUpSurface({
        provider,
        externalAccountId: request.externalAccountId,
        displayName: request.displayName,
        authMethod: request.authMethod,
        configuration: request.configuration ?? {},
        secrets: { ...request.secrets },
      });
      noteAuditTarget(context, `SurfaceAccount/${account.id}`);
      return message(account);
    },

    async listSurfaceAccounts(request) {
      const { page, nextPageToken } = pageOf(await store.listSurfaceAccounts(), request);
      return { surfaceAccounts: page.map(message), nextPageToken };
    },

    async getSurfaceAccount(request) {
      const name = requiredField(request.name, "name", "a Surface Account's name");
      const account = await findSurfaceAccount(store, name);
      if (account === undefined)
        throw operatorError(
          Code.NotFound,
          ErrorReason.NOT_FOUND,
          `Surface Account ${name} does not exist`,
          [{ path: "name", description: "a manifest name, or PROVIDER:EXTERNAL_ACCOUNT_ID" }],
        );
      return message(account);
    },

    addTagLocation: (request, context) => locationChange(request, context, true),
    removeTagLocation: (request, context) => locationChange(request, context, false),
    activateSet: (request, context) => activation(request, context, true),
    deactivateSet: (request, context) => activation(request, context, false),
  };
}

/** A Surface Account by manifest name, or else by `PROVIDER:EXTERNAL_ACCOUNT_ID`. */
async function findSurfaceAccount(
  store: Pick<OperatorReadStore, "findSurfaceAccount" | "findSurfaceAccountByName">,
  name: string,
): Promise<SurfaceAccountRecord | undefined> {
  const named = await store.findSurfaceAccountByName(name);
  if (named !== undefined) return named;
  const separator = name.indexOf(":");
  const provider = name.slice(0, separator);
  if (separator <= 0 || !(provider in SURFACE_PROVIDERS)) return undefined;
  return store.findSurfaceAccount(provider as ConnectedSurfaceProvider, name.slice(separator + 1));
}

/**
 * A request's location, checked against what its provider takes: `InvalidArgument` names each
 * field it lacks or does not use.
 */
function surfaceLocation(location: SurfaceLocation | undefined): OperatorSurfaceLocation {
  const provider =
    location === undefined ? undefined : nameOf(SURFACE_PROVIDERS, location.provider);
  if (location === undefined || provider === undefined)
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      "location.provider is required",
      [{ path: "location.provider", description: "a collaboration surface" }],
    );
  const groups = LOCATION_FIELDS[provider];
  const allowed = new Set(groups.flat());
  const violations: MessageInitShape<typeof FieldViolationSchema>[] = [];
  for (const field of Object.keys(FIELD_PATHS) as LocationField[])
    if (!allowed.has(field) && location[field] !== "")
      violations.push({
        path: `location.${FIELD_PATHS[field]}`,
        description: `not used by ${provider}`,
      });
  for (const group of groups) {
    const set = group.filter((field) => location[field] !== "");
    if (set.length === 0)
      violations.push({
        path: `location.${FIELD_PATHS[group[0] as LocationField]}`,
        description: `required by ${provider}`,
      });
    for (const extra of set.slice(1))
      violations.push({
        path: `location.${FIELD_PATHS[extra]}`,
        description: `set only one of ${group.map((field) => FIELD_PATHS[field]).join(" and ")}`,
      });
  }
  if (violations.length > 0)
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      violations.map((violation) => `${violation.path} is ${violation.description}`).join("; "),
      violations,
    );
  const fields = Object.fromEntries(
    [...allowed].flatMap((field) => (location[field] === "" ? [] : [[field, location[field]]])),
  ) as Partial<Record<LocationField, string>>;
  return {
    provider,
    ...(location.account === "" ? {} : { account: location.account }),
    ...fields,
  };
}

function resolvedLocation(change: ResolvedSurfaceLocation) {
  return {
    tag: change.tag.name,
    tagId: change.tag.id,
    provider: SURFACE_PROVIDERS[change.provider],
    location: change.location,
    surfaceAccountId: change.surfaceAccountId,
    accountDisplayName: change.accountDisplayName,
  };
}
