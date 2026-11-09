import { Code } from "@connectrpc/connect";
import {
  ArtifactCatalog,
  AuthKeyRedemptionError,
  type ControlPlane,
  resolveOwnerObjectiveRuntimeActions,
} from "@supertag/control-plane";
import {
  type AnyArtifactTransferGrantClaims,
  type GatewayCredentialVault,
  type Store,
  TagMessagingError,
  type TagMessagingGrant,
} from "@supertag/core";
import { ErrorReason } from "@supertag/operator-api";
import type { RemoteWorkletServer } from "@supertag/worker-transport";
import type { SurfaceController } from "./gateway-surfaces.js";
import type { ManifestApplyContext } from "./manifest-apply.js";
import { operatorError } from "./operator-rpc-context.js";
import type {
  OperatorControl,
  OperatorDataWrites,
  OperatorQueries,
  OperatorSurfaceLocation,
  ResolvedSurfaceLocation,
} from "./operator-seams.js";
import { controlPlaneResourceControl, controlPlaneResourceQueries } from "./resource-operations.js";
import {
  AccountSelectionError,
  type SurfaceTarget,
  SurfaceTargetResolver,
  TargetValueError,
} from "./tag-surface-target.js";

/**
 * The operator queries of this process's Control Plane. Beyond the store, the inbox view reads
 * its notification delivery configuration, the Objective view its embedded Worklet, and
 * GetStatus its controllers.
 */
export function controlPlaneQueries(
  sources: {
    readonly controlPlane: Pick<
      ControlPlane,
      "isAccepting" | "controllerStatuses" | "objectives" | "listWorkerHosts"
    >;
    readonly surfaceController: Pick<SurfaceController, "name" | "status">;
    readonly startedAt: string;
  },
  resources: ManifestApplyContext,
): OperatorQueries {
  const { controlPlane, surfaceController } = sources;
  const objectives = controlPlane.objectives;
  return {
    readCoordinationInbox: (input, principal) => objectives.readCoordinationInbox(input, principal),
    listApprovalRequests: (input, principal) => objectives.listApprovalRequests(input, principal),
    readObjectiveOverview: (input, principal) => objectives.readObjectiveOverview(input, principal),
    objectiveRunnable: (objective) => objectives.objectiveRunnable(objective),
    controlPlaneStatus: async () => ({
      accepting: controlPlane.isAccepting,
      startedAt: sources.startedAt,
      controllers: [
        ...controlPlane.controllerStatuses,
        {
          name: surfaceController.name,
          phase: surfaceController.status().errors.length === 0 ? "running" : "degraded",
        },
      ],
    }),
    listWorkerHosts: () => controlPlane.listWorkerHosts(),
    ...controlPlaneResourceQueries(resources),
  };
}

/** The operator data writes, made by this process's Control Plane. */
export function controlPlaneDataWrites(sources: {
  readonly controlPlane: Pick<ControlPlane, "inspectTaskExecution">;
}): OperatorDataWrites {
  return { inspectTaskExecution: (taskId) => sources.controlPlane.inspectTaskExecution(taskId) };
}

/** The operator state transitions, made by this process's Control Plane. */
export function controlPlaneControl(
  sources: {
    readonly controlPlane: Pick<
      ControlPlane,
      | "createAuthKey"
      | "createOperatorToken"
      | "enrollWorkerHost"
      | "isAccepting"
      | "listWorkerHosts"
      | "messageTag"
      | "objectives"
      | "redeemAuthKey"
      | "requestTaskCancellation"
      | "revokeAuthKey"
      | "revokeOperatorToken"
      | "revokeWorkerHostCredential"
      | "rotateWorkerHostCredential"
      | "setWorkerHostDraining"
      | "setupSurfaceAccount"
      | "startObjective"
    >;
    readonly store: Store;
    /** Holds Surface Account credentials, which resolve locations named by name. */
    readonly credentialVault: GatewayCredentialVault;
    /** Signs artifact transfer grants; without it no Worker Host serves an operator directly. */
    readonly artifactTransfers?: {
      readonly sign: (claims: AnyArtifactTransferGrantClaims) => string;
    };
    /** The configured public Control Plane URL, never a request's Host header. */
    readonly publicUrl?: string | undefined;
    readonly workletApi?: Pick<RemoteWorkletServer, "isHostConnectionLoopback">;
  },
  resources: ManifestApplyContext,
): OperatorControl {
  const { controlPlane, store } = sources;
  const objectives = controlPlane.objectives;
  const artifacts = new ArtifactCatalog(
    store,
    objectives,
    sources.artifactTransfers === undefined ? undefined : { sign: sources.artifactTransfers.sign },
  );
  const changeGrant = async (grant: TagMessagingGrant, granted: boolean) => ({
    grant: { senderTagId: grant.senderTagId, recipientTagId: grant.recipientTagId },
    changed: await store.changeTagMessagingGrant(grant, granted),
  });
  return {
    accepting: async () => controlPlane.isAccepting,
    messageTag: (input) => controlPlane.messageTag(input),
    async createObjective({ objective: parsed, ownerTagId, requestedRuntimeActions, dryRun }) {
      // A retry without runtime actions returns the existing Objective, even if grants changed.
      const prior =
        requestedRuntimeActions === undefined
          ? await store.getObjective(parsed.id).catch(() => undefined)
          : undefined;
      const runtime = await resolveOwnerObjectiveRuntimeActions(store, {
        objectiveId: parsed.id,
        ownerTagId,
        ...(requestedRuntimeActions === undefined ? {} : { requested: requestedRuntimeActions }),
      });
      const objective = await store.createObjective(
        {
          ...parsed,
          runtimeActions:
            prior?.ownerTagId === ownerTagId
              ? (prior.runtimeActions ?? [])
              : runtime.runtimeActions,
          ownerTagId,
        },
        { dryRun },
      );
      return { objective, warnings: prior ? [] : runtime.warnings };
    },
    startObjective: (objectiveId) => controlPlane.startObjective(objectiveId),
    async updateObjective({ objectiveId, update, operatorId }) {
      const source = { operatorId };
      if (update.runtimeActions === undefined)
        return {
          objective: await store.updateObjectiveStatus(
            objectiveId,
            update,
            undefined,
            undefined,
            source,
          ),
          warnings: [],
        };
      // A new list is bounded by the owner's Permission Sets as they are now.
      const current = await store.getObjective(objectiveId);
      const runtime = await resolveOwnerObjectiveRuntimeActions(store, {
        objectiveId,
        ownerTagId: current.ownerTagId,
        requested: update.runtimeActions,
      });
      const objective = await store.updateObjectiveStatus(
        objectiveId,
        { ...update, runtimeActions: runtime.runtimeActions },
        undefined,
        undefined,
        source,
      );
      return { objective, warnings: runtime.warnings };
    },
    messageObjective: (input, principal) => objectives.messageObjective(input, principal),
    decideApproval: (input, principal) => objectives.decideApprovalRequest(input, principal),
    approveObjective: (input, principal) => objectives.approveObjective(input, principal),
    cancelObjective: (input, principal) => objectives.cancelObjective(input, principal),
    pauseObjective: (input, principal) => objectives.pauseObjective(input, principal),
    resumeObjective: (input, principal) => objectives.resumeObjective(input, principal),
    cancelTask: (taskId, principal) => controlPlane.requestTaskCancellation(taskId, principal),
    resolveArtifactDownload: ({ artifactId, path, operatorId, operatorAddress }) =>
      artifacts.resolveOperatorDownload(
        operatorId,
        artifactId,
        { path },
        {
          publicUrl: sources.publicUrl,
          operatorAddress,
          hostConnectionIsLoopback: (workerHostId, generation) =>
            sources.workletApi?.isHostConnectionLoopback(workerHostId, generation) === true,
        },
      ),
    createTeam: (input) => store.createTeam(input),
    updateTeam: (id, input) => store.updateTeam(id, input),
    deleteTeam: (id) => store.deleteTeam(id),
    grantMailbox: (grant) => changeGrant(grant, true),
    revokeMailbox: (grant) => changeGrant(grant, false),
    ...workerHostControl(controlPlane, store),
    ...accessControl(controlPlane),
    ...surfaceControl(controlPlane, store, sources.credentialVault),
    ...controlPlaneResourceControl(resources),
  };
}

type HostControl = Pick<
  OperatorControl,
  | "enrollWorkerHost"
  | "rotateWorkerHostCredential"
  | "revokeWorkerHostCredential"
  | "setWorkerHostDraining"
  | "setTagWorkerHost"
  | "joinWorkerHost"
  | "createAuthKey"
  | "revokeAuthKey"
>;

function workerHostControl(
  controlPlane: Pick<
    ControlPlane,
    | "createAuthKey"
    | "enrollWorkerHost"
    | "listWorkerHosts"
    | "redeemAuthKey"
    | "revokeAuthKey"
    | "revokeWorkerHostCredential"
    | "rotateWorkerHostCredential"
    | "setWorkerHostDraining"
  >,
  store: Store,
): HostControl {
  const missingHost = () =>
    operatorError(Code.NotFound, ErrorReason.NOT_FOUND, "Worker Host does not exist", [
      { path: "id", description: "an enrolled Worker Host's ID" },
    ]);
  const hostById = async (id: string) =>
    (await controlPlane.listWorkerHosts()).find((host) => host.id === id);
  return {
    async enrollWorkerHost(id) {
      const enrolled = () =>
        operatorError(Code.AlreadyExists, ErrorReason.CONFLICT, "Worker Host is already enrolled", [
          { path: "id", description: "a Worker Host ID never enrolled before" },
        ]);
      // The embedded Worklet's own host is not stored, yet its ID is taken.
      if ((await hostById(id)) !== undefined) throw enrolled();
      try {
        return await controlPlane.enrollWorkerHost({ id });
      } catch (error) {
        if (error instanceof Error && /^Worker Host .+ is already enrolled$/u.test(error.message))
          throw enrolled();
        throw error;
      }
    },
    async rotateWorkerHostCredential({ id, expectedCredentialRevision }) {
      const issued = await controlPlane.rotateWorkerHostCredential(id, expectedCredentialRevision);
      if (issued !== undefined) return issued;
      if ((await store.findWorkerHostById(id)) === undefined) throw missingHost();
      throw operatorError(
        Code.FailedPrecondition,
        ErrorReason.CONFLICT,
        "A revoked Worker Host must be enrolled under a new ID",
      );
    },
    async revokeWorkerHostCredential({ id, reason }) {
      const revoked = await controlPlane.revokeWorkerHostCredential(id, reason);
      if (revoked === undefined) throw missingHost();
      return revoked;
    },
    async setWorkerHostDraining({ id, draining }) {
      if (!(await controlPlane.setWorkerHostDraining(id, draining))) throw missingHost();
      const host = await hostById(id);
      if (host === undefined) throw missingHost();
      return host;
    },
    async setTagWorkerHost({ tagId, workerHostId, bound }) {
      const before = (await store.listTagWorkerHostBindings(tagId)).some(
        (binding) => binding.workerHostId === workerHostId,
      );
      if (bound && !before) {
        if ((await hostById(workerHostId)) === undefined)
          throw operatorError(
            Code.NotFound,
            ErrorReason.NOT_FOUND,
            `Worker Host ${workerHostId} does not exist`,
            [{ path: "worker_host_id", description: "an enrolled Worker Host's ID" }],
          );
        await store.bindTagWorkerHost(tagId, workerHostId);
      }
      const changed =
        bound === before
          ? false
          : bound
            ? true
            : await store.unbindTagWorkerHost(tagId, workerHostId);
      const workerHostIds = (await store.listTagWorkerHostBindings(tagId))
        .map((binding) => binding.workerHostId)
        .toSorted();
      return { workerHostIds, changed };
    },
    async joinWorkerHost({ authKey, name, idempotencyKey }) {
      try {
        return await controlPlane.redeemAuthKey(authKey, name, idempotencyKey);
      } catch (error) {
        if (!(error instanceof AuthKeyRedemptionError)) throw error;
        if (error.reason === "invalid")
          throw operatorError(Code.Unauthenticated, ErrorReason.UNAUTHENTICATED, error.message);
        if (error.reason === "tag-missing")
          throw operatorError(Code.FailedPrecondition, ErrorReason.CONFLICT, error.message);
        if (error.reason === "joined")
          throw operatorError(Code.AlreadyExists, ErrorReason.CONFLICT, error.message);
        throw operatorError(Code.PermissionDenied, ErrorReason.PERMISSION_DENIED, error.message);
      }
    },
    async createAuthKey(input) {
      try {
        return await controlPlane.createAuthKey(input);
      } catch (error) {
        if (error instanceof TagMessagingError && error.statusCode === 409)
          throw operatorError(Code.AlreadyExists, ErrorReason.CONFLICT, error.message, [
            { path: "name", description: "a name no Auth Key has had" },
          ]);
        throw error;
      }
    },
    revokeAuthKey: (name) => controlPlane.revokeAuthKey(name),
  };
}

function accessControl(
  controlPlane: Pick<ControlPlane, "createOperatorToken" | "revokeOperatorToken">,
): Pick<OperatorControl, "createOperatorToken" | "revokeOperatorToken"> {
  return {
    async createOperatorToken(name) {
      try {
        return await controlPlane.createOperatorToken({ name });
      } catch (error) {
        if (error instanceof TagMessagingError && error.statusCode === 409)
          throw operatorError(Code.AlreadyExists, ErrorReason.CONFLICT, error.message, [
            { path: "name", description: "a name no Operator Token has had" },
          ]);
        throw error;
      }
    },
    revokeOperatorToken: (name) => controlPlane.revokeOperatorToken(name),
  };
}

function surfaceControl(
  controlPlane: Pick<ControlPlane, "setupSurfaceAccount">,
  store: Store,
  credentialVault: GatewayCredentialVault,
): Pick<OperatorControl, "setUpSurface" | "setTagLocation" | "setSetActivation"> {
  const targets = new SurfaceTargetResolver(store, credentialVault);
  const resolve = async (tagName: string, location: OperatorSurfaceLocation) => {
    const tag = await store.findTagByName(tagName);
    if (tag === undefined || tag.status !== "active")
      throw operatorError(
        Code.NotFound,
        ErrorReason.NOT_FOUND,
        `Tag ${JSON.stringify(tagName)} does not exist`,
        [{ path: "tag", description: "a Tag's name" }],
      );
    const resolved = await resolvedTarget(() => targets.resolve(surfaceTarget(location)));
    const view: ResolvedSurfaceLocation = {
      tag: { id: tag.id, name: tag.name },
      provider: location.provider,
      location: resolved.displayName,
      surfaceAccountId: resolved.account.id,
      accountDisplayName: resolved.account.displayName,
    };
    return { tag, resolved, view };
  };
  const routeOf = async (tagId: string, surfaceAccountId: string, scope: string) =>
    (await store.listTagRoutes({ tagId, surfaceAccountId })).find((route) => route.scope === scope);
  return {
    setUpSurface: (verified) => controlPlane.setupSurfaceAccount(verified),
    async setTagLocation({ tag: tagName, location, present }) {
      const { tag, resolved, view } = await resolve(tagName, location);
      const route = await routeOf(tag.id, resolved.account.id, resolved.scope);
      if (!present)
        return {
          ...view,
          changed: route === undefined ? false : await store.removeTagRoute(route.id),
        };
      if (route !== undefined) return { ...view, changed: false };
      const holder = await store.resolveTagRoute(resolved.account.id, resolved.scope);
      if (holder !== undefined)
        throw operatorError(
          Code.FailedPrecondition,
          ErrorReason.CONFLICT,
          `Another Tag already answers in ${location.provider} ${resolved.displayName} on ${resolved.account.displayName}`,
          [{ path: "location", description: "a location no other Tag has" }],
        );
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: resolved.account.id,
        scope: resolved.scope,
      });
      return { ...view, changed: true };
    },
    async setSetActivation({ kind, set: setName, tag: tagName, location, active }) {
      const { tag, resolved, view } = await resolve(tagName, location);
      const label = kind === "context-set" ? "Context Set" : "Permission Set";
      const set =
        kind === "context-set"
          ? await store.findTagContextSetByName(setName)
          : await store.findTagPermissionSetByName(setName);
      if (set === undefined)
        throw operatorError(
          Code.NotFound,
          ErrorReason.NOT_FOUND,
          `${label} ${JSON.stringify(setName)} does not exist for ${tag.name}`,
          [{ path: "set", description: `a ${label}'s name` }],
        );
      const route = await routeOf(tag.id, resolved.account.id, resolved.scope);
      if (route === undefined)
        throw operatorError(
          Code.FailedPrecondition,
          ErrorReason.CONFLICT,
          `${tag.name} is not available in ${location.provider} ${resolved.displayName}`,
          [{ path: "location", description: "one of the Tag's locations" }],
        );
      if (kind === "context-set") {
        if (active)
          await store.activateTagContextSet({ contextSetId: set.id, tagRouteId: route.id });
        else await store.deactivateTagContextSet(set.id, route.id);
      } else if (active)
        await store.activateTagPermissionSet({ permissionSetId: set.id, tagRouteId: route.id });
      else await store.deactivateTagPermissionSet(set.id, route.id);
      return { ...view, set: set.name };
    },
  };
}

/** A location as the surface resolver names it. */
function surfaceTarget(location: OperatorSurfaceLocation): SurfaceTarget {
  const common = location.account === undefined ? {} : { accountSelector: location.account };
  switch (location.provider) {
    case "slack":
      return { ...common, provider: "slack", channelId: location.channelId ?? "" };
    case "lark":
      return { ...common, provider: "lark", chatId: location.chatId ?? "" };
    case "teams":
      return {
        ...common,
        provider: "teams",
        teamId: location.teamId ?? "",
        channelId: location.channelId ?? "",
      };
    case "github":
      return location.repoId === undefined
        ? { ...common, provider: "github", repositoryName: location.repo ?? "" }
        : { ...common, provider: "github", repositoryId: location.repoId };
    case "linear":
      return location.teamId === undefined
        ? { ...common, provider: "linear", teamName: location.team ?? "" }
        : { ...common, provider: "linear", teamId: location.teamId };
  }
}

const TARGET_FIELDS: Readonly<Record<TargetValueError["field"], string>> = {
  channelId: "channel_id",
  chatId: "chat_id",
  teamId: "team_id",
  teamName: "team",
  repositoryId: "repo_id",
  repositoryName: "repo",
};

/**
 * Resolves a location on its Surface Account. A missing value, an ambiguous account, and a
 * repository or team the provider does not know are the caller's refusals.
 */
async function resolvedTarget<T>(resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (error instanceof TargetValueError) {
      const path = `location.${TARGET_FIELDS[error.field]}`;
      throw operatorError(
        Code.InvalidArgument,
        ErrorReason.INVALID_ARGUMENT,
        `${path} is required`,
        [{ path, description: "required by the provider" }],
      );
    }
    if (error instanceof AccountSelectionError)
      throw operatorError(Code.FailedPrecondition, ErrorReason.CONFLICT, error.message, [
        {
          path: "location.account",
          description:
            error.selection.matches.length === 0
              ? "selects no connected Surface Account"
              : "selects more than one connected Surface Account",
        },
      ]);
    if (error instanceof Error) {
      if (/HTTP 404|does not exist|not found/iu.test(error.message))
        throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, error.message);
      if (/lookup failed|fetch failed/iu.test(error.message))
        throw operatorError(Code.Unavailable, ErrorReason.UNAVAILABLE, error.message);
      throw operatorError(Code.FailedPrecondition, ErrorReason.CONFLICT, error.message);
    }
    throw error;
  }
}
