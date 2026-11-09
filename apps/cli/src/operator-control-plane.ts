import {
  ArtifactCatalog,
  type ControlPlane,
  resolveOwnerObjectiveRuntimeActions,
} from "@supertag/control-plane";
import type { AnyArtifactTransferGrantClaims, Store, TagMessagingGrant } from "@supertag/core";
import type { RemoteWorkletServer } from "@supertag/worker-transport";
import type { SurfaceController } from "./gateway-surfaces.js";
import type { OperatorControl, OperatorDataWrites, OperatorQueries } from "./operator-seams.js";

/**
 * The operator queries of this process's Control Plane. Beyond the store, the inbox view reads
 * its notification delivery configuration, the Objective view its embedded Worklet, and
 * GetStatus its controllers.
 */
export function controlPlaneQueries(sources: {
  readonly controlPlane: Pick<ControlPlane, "isAccepting" | "controllerStatuses" | "objectives">;
  readonly surfaceController: Pick<SurfaceController, "name" | "status">;
  readonly startedAt: string;
}): OperatorQueries {
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
  };
}

/** The operator data writes, made by this process's Control Plane. */
export function controlPlaneDataWrites(sources: {
  readonly controlPlane: Pick<ControlPlane, "inspectTaskExecution">;
}): OperatorDataWrites {
  return { inspectTaskExecution: (taskId) => sources.controlPlane.inspectTaskExecution(taskId) };
}

/** The operator state transitions, made by this process's Control Plane. */
export function controlPlaneControl(sources: {
  readonly controlPlane: Pick<
    ControlPlane,
    "isAccepting" | "messageTag" | "objectives" | "requestTaskCancellation" | "startObjective"
  >;
  readonly store: Store;
  /** Signs artifact transfer grants; without it no Worker Host serves an operator directly. */
  readonly artifactTransfers?: {
    readonly sign: (claims: AnyArtifactTransferGrantClaims) => string;
  };
  /** The configured public Control Plane URL, never a request's Host header. */
  readonly publicUrl?: string | undefined;
  readonly workletApi?: Pick<RemoteWorkletServer, "isHostConnectionLoopback">;
}): OperatorControl {
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
  };
}
