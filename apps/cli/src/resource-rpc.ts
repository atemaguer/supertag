import { create } from "@bufbuild/protobuf";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  type ApplyManifestsResponse,
  ApplyManifestsResponseSchema,
  ErrorReason,
  type ManifestDocument,
  ManifestOutcome,
  PruneAction,
  ResourceKind,
  type ResourceService,
} from "@supertag/operator-api";
import { assertAccepting } from "./inbox-rpc.js";
import { pageOf } from "./operator-pages.js";
import {
  noteAuditChanges,
  noteAuditPreview,
  noteAuditTarget,
  type OperatorAuditChange,
  operatorError,
  operatorPrincipal,
  requiredField,
} from "./operator-rpc-context.js";
import type { OperatorControl, OperatorQueries } from "./operator-seams.js";

export interface ResourceServiceDependencies {
  /** Reads resources and plans inputs; a Gateway replica forwards these to the Control Plane. */
  readonly queries: Pick<OperatorQueries, "getResource" | "listResources" | "diffManifests">;
  /** Applies inputs and deletes resources. */
  readonly control: Pick<OperatorControl, "accepting" | "applyManifests" | "deleteResource">;
}

/** The manifest kinds' names in audit targets, by kind. */
const AUDIT_KINDS: Readonly<Partial<Record<ResourceKind, string>>> = {
  [ResourceKind.TAG]: "Tag",
  [ResourceKind.ROLE]: "Role",
  [ResourceKind.PERMISSION_SET]: "PermissionSet",
  [ResourceKind.CONTEXT_SET]: "ContextSet",
  [ResourceKind.VOLUME]: "Volume",
  [ResourceKind.WORKSPACE]: "Workspace",
  [ResourceKind.SURFACE_ACCOUNT]: "SurfaceAccount",
  [ResourceKind.OBJECTIVE]: "Objective",
};

/** `supertag apply`, `diff`, `get`, `list`, `describe` and `delete` for the configuration kinds. */
export function resourceService({
  queries,
  control,
}: ResourceServiceDependencies): ServiceImpl<typeof ResourceService> {
  return {
    async getResource(request) {
      const kind = requiredKind(request.kind);
      const name = requiredField(request.name, "name", "the resource's name");
      return queries.getResource({ kind, name, manifest: request.manifest });
    },

    async listResources(request) {
      const kind = requiredKind(request.kind);
      if (kind === ResourceKind.OBJECTIVE)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "Objectives are listed with ObjectiveService.ListObjectives",
          [{ path: "kind", description: "not RESOURCE_KIND_OBJECTIVE" }],
        );
      if (request.manifest && kind === ResourceKind.WORKER_PROFILE)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "Worker Profiles are observed, so they have no manifest",
          [{ path: "manifest", description: "not for RESOURCE_KIND_WORKER_PROFILE" }],
        );
      const { page, nextPageToken } = pageOf(
        await queries.listResources({ kind, manifest: request.manifest }),
        request,
      );
      return { resources: [...page], nextPageToken };
    },

    diffManifests: (request) => queries.diffManifests(request),

    async applyManifests(request, context) {
      const target = documentTarget(request.documents);
      if (target !== undefined) noteAuditTarget(context, target);
      await assertAccepting(control);
      const applied = create(
        ApplyManifestsResponseSchema,
        await control.applyManifests(request, principalOf(context)),
      );
      noteAuditChanges(context, appliedChanges(applied));
      return applied;
    },

    async deleteResource(request, context) {
      const kind = requiredKind(request.kind);
      const name = requiredField(request.name, "name", "the resource's name");
      const target = AUDIT_KINDS[kind];
      if (target !== undefined) noteAuditTarget(context, target);
      if (request.dryRun) noteAuditPreview(context);
      await assertAccepting(control);
      const deleted = await control.deleteResource({ ...request, kind, name });
      if (target !== undefined) noteAuditTarget(context, `${target}/${name}`);
      return deleted;
    },
  };
}

/** Names and kinds an audit target may hold; anything else is left out rather than recorded. */
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const TARGET_KIND = /^[A-Z][A-Za-z]{0,62}$/u;

/**
 * The target of an apply that records no change of its own: `KIND/NAME` for one document, which a
 * refused call cuts back to its kind, and the service's kind for several.
 */
function documentTarget(documents: readonly ManifestDocument[]): string | undefined {
  const [only, ...rest] = documents;
  if (only === undefined || rest.length > 0) return undefined;
  const kind = only.manifest?.["kind"];
  const metadata = only.manifest?.["metadata"];
  const name =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? metadata["name"]
      : undefined;
  if (typeof kind !== "string" || !TARGET_KIND.test(kind)) return undefined;
  return typeof name === "string" && TARGET_NAME.test(name) ? `${kind}/${name}` : kind;
}

/** The Connect code a call refused for a document's failure reason would carry. */
const FAILURE_CODES: Readonly<Partial<Record<ErrorReason, Code>>> = {
  [ErrorReason.INVALID_ARGUMENT]: Code.InvalidArgument,
  [ErrorReason.NOT_FOUND]: Code.NotFound,
  [ErrorReason.CONFLICT]: Code.FailedPrecondition,
  [ErrorReason.PERMISSION_DENIED]: Code.PermissionDenied,
  [ErrorReason.RESOURCE_EXHAUSTED]: Code.ResourceExhausted,
  [ErrorReason.UNAVAILABLE]: Code.Unavailable,
};

/**
 * What an apply changed, one audit entry each: every document it applied or failed to apply, as
 * `resource.apply`, and every member pruning deleted or cancelled, as `resource.prune`.
 */
function appliedChanges(applied: ApplyManifestsResponse): readonly OperatorAuditChange[] {
  const changes: OperatorAuditChange[] = [];
  for (const result of applied.results) {
    if (result.outcome === ManifestOutcome.APPLIED)
      changes.push({ target: resourceTarget(result.kind, result.name) });
    else if (result.outcome === ManifestOutcome.FAILED)
      changes.push({
        target: resourceTarget(result.kind, result.name),
        failure: FAILURE_CODES[result.failure?.reason ?? ErrorReason.UNSPECIFIED] ?? Code.Internal,
      });
  }
  for (const item of applied.pruned)
    if (item.action === PruneAction.DELETE || item.action === PruneAction.CANCEL)
      changes.push({ action: "resource.prune", target: resourceTarget(item.kind, item.name) });
  return changes;
}

/** `KIND/NAME`, or only the kind when the name is not one an audit target may hold. */
function resourceTarget(kind: ResourceKind, name: string): string {
  const target = AUDIT_KINDS[kind] ?? "Resource";
  return TARGET_NAME.test(name) ? `${target}/${name}` : target;
}

function requiredKind(kind: ResourceKind): ResourceKind {
  if (kind === ResourceKind.UNSPECIFIED || ResourceKind[kind] === undefined)
    throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, "kind is required", [
      { path: "kind", description: "a resource kind" },
    ]);
  return kind;
}

function principalOf(context: HandlerContext) {
  const caller = context.values.get(operatorPrincipal);
  if (caller === undefined)
    throw operatorError(Code.Internal, ErrorReason.INTERNAL, "Control Plane internal error");
  return caller.principal;
}
