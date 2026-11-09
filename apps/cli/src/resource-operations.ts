import { fromJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { ManagedResourceKind } from "@supertag/core";
import { TagMessagingError } from "@supertag/core";
import {
  DeletionAction,
  type DiffManifestsRequest,
  ErrorReason,
  FieldChangeAction,
  ManifestOutcome,
  type ManifestPlanSchema,
  type ManifestResultSchema,
  PlanAction,
  PruneAction,
  type PruneResultSchema,
  type ResourceKind,
} from "@supertag/operator-api";
import type { PruneItem } from "./apply-set-prune.js";
import { SURFACE_PROVIDERS } from "./host-protos.js";
import {
  applyManifests,
  type DocumentPlan,
  type DocumentResult,
  diffManifests,
  isInternalFailure,
  type ManifestApplyContext,
  type ManifestInput,
  ManifestInputError,
} from "./manifest-apply.js";
import { operatorError } from "./operator-rpc-context.js";
import type { OperatorControl, OperatorQueries } from "./operator-seams.js";
import {
  deleteResourceByName,
  listResourceViews,
  ResourceInUseError,
  readResourceView,
} from "./resource-apply.js";
import {
  type ResourcePath,
  type ResourceView,
  resourceKindEntry,
  resourceKindOfName,
  resourceMessage,
} from "./resource-protos.js";
import { declaredConfiguration, isSurfaceProvider } from "./surface-account-manifest.js";

/**
 * `ResourceService` as this process's Control Plane serves it: resources read from the store as
 * operator API messages, and manifest inputs planned and applied by `manifest-apply.ts`.
 */
export function controlPlaneResourceQueries(
  context: ManifestApplyContext,
): Pick<OperatorQueries, "getResource" | "listResources" | "diffManifests"> {
  return {
    async getResource({ kind, name, manifest }) {
      const path = pathOf(kind);
      const view = await readResourceView(context, path, name);
      return resourceMessage(view, manifest ? manifestOf(view, name) : undefined);
    },
    async listResources({ kind, manifest }) {
      const path = pathOf(kind);
      const views = await listResourceViews(context, path);
      return views
        .filter((view) => !manifest || view.kind !== "SurfaceAccount" || declaredByManifest(view))
        .map((view) => resourceMessage(view, manifest ? manifestOf(view) : undefined));
    },
    async diffManifests(request) {
      const { plans, pruned } = await refusing(() =>
        diffManifests(context, inputsOf(request), optionsOf(request)),
      );
      return { plans: plans.map(planMessage), pruned: pruned.map(pruneMessage) };
    },
  };
}

export function controlPlaneResourceControl(
  context: ManifestApplyContext,
): Pick<OperatorControl, "applyManifests" | "deleteResource"> {
  return {
    async applyManifests(request, principal) {
      const { results, complete, pruned } = await refusing(() =>
        applyManifests(
          context,
          inputsOf(request),
          {
            ...optionsOf(request),
            createOnly: request.createOnly,
            imperative: request.imperative,
          },
          principal,
        ),
      );
      return {
        results: results.map(resultMessage),
        complete,
        pruned: pruned.map(pruneMessage),
      };
    },
    async deleteResource({ kind, name, dryRun }) {
      const entry = resourceKindEntry(kind);
      if (entry === undefined || entry.kind === "Objective" || entry.kind === "WorkerProfile")
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          entry?.kind === "Objective"
            ? `Objectives are cancelled, not deleted, so their history stays: supertag cancel objective ${name}`
            : "Only Tags, Roles, Permission Sets, Context Sets, Volumes, Workspaces and Surface Accounts can be deleted",
          [{ path: "kind", description: "a kind that can be deleted" }],
        );
      const deletion = await deleteResourceByName(
        context,
        entry.kind as Exclude<ManagedResourceKind, "Objective">,
        name,
        dryRun,
      ).catch((error: unknown) => {
        if (!(error instanceof ResourceInUseError)) throw error;
        throw operatorError(
          Code.FailedPrecondition,
          ErrorReason.CONFLICT,
          error.message,
          error.references.map((reference) => ({ path: "name", description: reference })),
        );
      });
      return {
        kind,
        name: deletion.name,
        dryRun: deletion.dryRun,
        action: deletion.action === "retire" ? DeletionAction.RETIRE : DeletionAction.DELETE,
        removed: [...deletion.removed],
        notes: [...deletion.notes],
      };
    },
  };
}

function pathOf(kind: ResourceKind): ResourcePath {
  const entry = resourceKindEntry(kind);
  if (entry === undefined)
    throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, "kind is required", [
      { path: "kind", description: "a resource kind" },
    ]);
  return entry.path;
}

function inputsOf(request: Pick<DiffManifestsRequest, "documents">): readonly ManifestInput[] {
  return request.documents.map((document) => ({
    manifest: document.manifest ?? null,
    source: document.source,
    ...(Object.keys(document.secrets).length === 0 ? {} : { secrets: { ...document.secrets } }),
  }));
}

function optionsOf(request: Omit<DiffManifestsRequest, "documents" | "$typeName">) {
  return {
    ...(request.applySet === "" ? {} : { applySet: request.applySet }),
    prune: request.prune,
    force: request.forceConflicts,
  };
}

/** Runs an input's plan or apply, refusing as `ApplyManifests` documents its errors. */
async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ManifestInputError)) throw error;
    throw operatorError(
      error.reason === "invalid" ? Code.InvalidArgument : Code.FailedPrecondition,
      error.reason === "invalid" ? ErrorReason.INVALID_ARGUMENT : ErrorReason.CONFLICT,
      error.message,
      error.fields.map((field) => ({ ...field, manager: field.manager ?? "" })),
    );
  }
}

const PLAN_ACTIONS = {
  create: PlanAction.CREATE,
  update: PlanAction.UPDATE,
  unchanged: PlanAction.UNCHANGED,
} as const;

const CHANGE_ACTIONS = {
  add: FieldChangeAction.ADD,
  remove: FieldChangeAction.REMOVE,
  change: FieldChangeAction.CHANGE,
} as const;

const OUTCOMES = {
  applied: ManifestOutcome.APPLIED,
  existed: ManifestOutcome.EXISTED,
  failed: ManifestOutcome.FAILED,
  not_applied: ManifestOutcome.NOT_APPLIED,
} as const;

const PRUNE_ACTIONS = {
  delete: PruneAction.DELETE,
  cancel: PruneAction.CANCEL,
  skip: PruneAction.KEEP,
} as const;

function jsonValue(value: unknown) {
  return fromJson(ValueSchema, JSON.parse(JSON.stringify(value ?? null)) as JsonValue);
}

function planMessage(plan: DocumentPlan): MessageInitShape<typeof ManifestPlanSchema> {
  return {
    document: plan.document,
    kind: resourceKindOfName(plan.kind),
    name: plan.name,
    action: PLAN_ACTIONS[plan.plan.action],
    changes: plan.plan.changes.map((change) => ({
      path: change.path,
      action: CHANGE_ACTIONS[change.action],
      ...(change.action === "add" ? {} : { before: jsonValue(change.before) }),
      ...(change.action === "remove" ? {} : { after: jsonValue(change.after) }),
    })),
    conflicts: plan.plan.conflicts.map((conflict) => ({
      path: conflict.path,
      manager: conflict.manager,
    })),
    refusals: (plan.plan.refusals ?? []).map((refusal) => ({
      path: refusal.path,
      reason: refusal.reason,
    })),
    startsObjective: plan.plan.start === true,
    held: plan.plan.held ?? "",
  };
}

function resultMessage(result: DocumentResult): MessageInitShape<typeof ManifestResultSchema> {
  const failure = result.failure === undefined ? undefined : documentFailure(result.failure);
  return {
    document: result.document,
    kind: resourceKindOfName(result.kind),
    name: result.name,
    outcome: OUTCOMES[result.outcome],
    action: result.action === undefined ? PlanAction.UNSPECIFIED : PLAN_ACTIONS[result.action],
    warnings: [...result.warnings],
    startedTaskId: result.startedTaskId ?? "",
    notStarted: result.notStarted ?? "",
    ...(result.verification === undefined || result.verification.provider === "cli"
      ? {}
      : {
          verification: {
            provider: SURFACE_PROVIDERS[result.verification.provider],
            displayName: result.verification.displayName,
            externalAccountId: result.verification.externalAccountId,
          },
        }),
    failureMessage: failure?.message ?? "",
    ...(failure === undefined ? {} : { failure: { reason: failure.reason, fields: [] } }),
  };
}

const FAILURE_REASONS: Readonly<Record<number, ErrorReason>> = {
  403: ErrorReason.PERMISSION_DENIED,
  404: ErrorReason.NOT_FOUND,
  409: ErrorReason.CONFLICT,
  413: ErrorReason.RESOURCE_EXHAUSTED,
  429: ErrorReason.RESOURCE_EXHAUSTED,
  503: ErrorReason.UNAVAILABLE,
};

/**
 * Why a document failed to apply. A failure of the Control Plane itself, such as a lost database
 * connection, names no internal detail, as operator RPC errors do.
 */
function documentFailure(error: Error): { readonly reason: ErrorReason; readonly message: string } {
  if (error instanceof TagMessagingError) {
    const reason =
      FAILURE_REASONS[error.statusCode] ??
      (error.statusCode >= 400 && error.statusCode < 500
        ? ErrorReason.INVALID_ARGUMENT
        : undefined);
    if (reason !== undefined) return { reason, message: error.message };
  } else if (!isInternalFailure(error))
    return { reason: ErrorReason.INVALID_ARGUMENT, message: error.message };
  return { reason: ErrorReason.INTERNAL, message: "Control Plane internal error" };
}

function pruneMessage(item: PruneItem): MessageInitShape<typeof PruneResultSchema> {
  return {
    kind: resourceKindOfName(item.kind),
    name: item.name,
    action: PRUNE_ACTIONS[item.action],
    reason: item.reason ?? "",
  };
}

/** A Surface Account a manifest applied records where its secrets came from. */
function declaredByManifest(view: ResourceView): boolean {
  return view.kind === "SurfaceAccount" && view.spec.secrets !== undefined;
}

/**
 * The apply-able form of a stored resource: identity and declarable fields, without what the
 * Control Plane sets. A Surface Account's has its secret references, never a value.
 */
function manifestOf(view: ResourceView, name?: string): Record<string, unknown> {
  if (view.kind === "WorkerProfile")
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      "Worker Profiles are observed, so they have no manifest",
      [{ path: "manifest", description: "not for Worker Profiles" }],
    );
  if (view.kind === "SurfaceAccount" && !declaredByManifest(view))
    throw operatorError(
      Code.FailedPrecondition,
      ErrorReason.CONFLICT,
      `Surface Account ${name ?? view.metadata.name} was set up with supertag setup surface, so it has no manifest or secret references to export. To manage it declaratively, write a SurfaceAccount manifest for the same provider account and apply it; apply adopts the account once its credentials verify.`,
      [{ path: "manifest", description: "a Surface Account a manifest applied" }],
    );
  return JSON.parse(
    JSON.stringify({
      apiVersion: view.apiVersion,
      kind: view.kind,
      metadata: { name: view.metadata.name },
      spec:
        view.kind === "Objective"
          ? objectiveManifestSpec(view.spec)
          : view.kind === "SurfaceAccount"
            ? surfaceAccountManifestSpec(view.spec)
            : pruneManagedFields(view.spec),
    }),
  ) as Record<string, unknown>;
}

/**
 * A Surface Account's declarable fields: the options verification recorded, in manifest form,
 * and the secret references from the last apply.
 */
function surfaceAccountManifestSpec(
  spec: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const provider = spec["provider"];
  if (!isSurfaceProvider(provider)) throw new Error("Surface Account provider is invalid");
  return {
    provider,
    displayName: spec["displayName"],
    configuration: declaredConfiguration({
      provider,
      authMethod: String(spec["authMethod"]),
      externalAccountId: String(spec["externalAccountId"]),
      configuration: isRecord(spec["configuration"]) ? spec["configuration"] : {},
    }),
    secrets: spec["secrets"],
  };
}

/** An Objective's declarable fields, leaving out defaults so the manifest stays short. */
function objectiveManifestSpec(spec: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const empty = (value: unknown) =>
    value === undefined ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0);
  return Object.fromEntries(
    Object.entries(spec).filter(([field, value]) => field === "runtimeActions" || !empty(value)),
  );
}

/** A resource spec without the identifiers and timestamps the Control Plane adds. */
function pruneManagedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneManagedFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== "id" &&
          key !== "createdAt" &&
          key !== "updatedAt" &&
          key !== "createdBy" &&
          key !== "permissionSetId" &&
          key !== "contextSetId",
      )
      .map(([key, child]) => [key, pruneManagedFields(child)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
