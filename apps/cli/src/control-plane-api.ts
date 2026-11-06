import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ControlPlane, CoordinationOperatorPrincipal } from "@supertag/control-plane";
import {
  ArtifactCatalog,
  AuthKeyRedemptionError,
  resolveOwnerObjectiveRuntimeActions,
  SessionPersistence,
  TagMailboxService,
  type TaskAttemptRunningCommand,
  taskAttemptRunningCommand,
} from "@supertag/control-plane";
import type {
  AddTagContextItemInput,
  AddTagPermissionInput,
  AnyArtifactTransferGrantClaims,
  AuthKey,
  ConnectedSurfaceProvider,
  ExecutionSettings,
  GatewayCredentialVault,
  ManagedResourceKind,
  Role,
  Store,
  SurfaceAccount,
  SurfaceProvider,
  Tag,
  TagContextItem,
  TagMessageType,
  TagMessagingGrant,
  TagPermission,
  TagPermissionSet,
  Task,
  TaskAssignment,
  VolumeSpec,
  WorkspaceSpec,
} from "@supertag/core";
import {
  type ApplyVolumeInput,
  type ApplyWorkspaceInput,
  ArtifactCatalogError,
  DEFAULT_WORKSPACE_DELIVERY,
  normalizeApprovers,
  OPERATOR_TOKEN_PREFIX,
  operatorTokenOperatorId,
  parseAuditQuery,
  parseAuthKeyName,
  parseCancelObjective,
  parseCreateObjective,
  parseExecutionSettings,
  parseMcpGrantAction,
  parseMcpGrantResource,
  parseOperatorTokenName,
  parseVolumeName,
  parseVolumeSpec,
  parseWorkerHostLabels,
  parseWorkerHostName,
  parseWorkspaceName,
  parseWorkspaceNames,
  parseWorkspaceSpec,
  TAG_MESSAGE_TYPES,
  TagMessagingError,
} from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import {
  type RemoteWorkletServer,
  RpcTelemetry,
  type RpcTelemetrySnapshot,
  startWorkletGrpcServer,
  type WorkletGrpcServerOptions,
} from "@supertag/worker-transport";
import { pruneApplySet } from "./apply-set-prune.js";
import { registerArtifactGrpcRoutes } from "./artifact-grpc.js";
import { handleArtifactRequest } from "./artifact-http.js";
import { handleOperatorArtifacts } from "./artifact-resources.js";
import {
  type AuditNote,
  AuditTrail,
  classifyManagementRequest,
  type ManagementAuditEvent,
  noteRequestBody,
} from "./audit-trail.js";
import {
  authKeyResource,
  CONTROL_PLANE_API_VERSION,
  canonicalMailboxGrants,
  canonicalTagLocations,
  contextSetResource,
  operatorTokenResource,
  permissionSetResource,
  resourceList,
  roleResource,
  sessionResource,
  surfaceAccountResource,
  type TagLocationSpec,
  type TagOrganization,
  tagLocationScopeFields,
  tagResource,
  taskResourceFromStore,
  volumeResource,
  workerHostCredentialIssuance,
  workerHostResource,
  workerHostResourcesFromStore,
  workerProfileResourcesFromHost,
  workspaceEnvironments,
  workspaceResource,
} from "./control-plane-resources.js";
import { registerCoordinationGrpcRoutes } from "./coordination-grpc.js";
import { handleCoordinationRequest } from "./coordination-http.js";
import { canonicalJson, locationKey, sameValue } from "./field-management.js";
import type { SurfaceController } from "./gateway-surfaces.js";
import { registerMailboxGrpcRoutes } from "./mailbox-grpc.js";
import { handleMailboxAdminRequest, handleMailboxRequest } from "./mailbox-http.js";
import {
  conflictMessage,
  type ManagedPlan,
  type ManagedWriteOptions,
  managedWriteOptions,
  planImperativeWrite,
  planManagedWrite,
  planReport,
  recordManagedWrite,
} from "./managed-apply.js";
import {
  applyObjectiveManifest,
  objectivePlanReport,
  objectiveRefusalMessage,
  objectiveResource,
  parseObjectiveManifest,
  planObjectiveManifest,
} from "./objective-manifest.js";
import { organizationStatus } from "./organization-status.js";
import {
  applyDeletion,
  DELETE_KIND_NAMES,
  deletionRefusal,
  findSurfaceAccountForDeletion,
  planDeletion,
} from "./resource-deletion.js";
import { registerSessionGrpcRoutes } from "./session-grpc.js";
import { handleSessionRequest } from "./session-http.js";
import {
  declaredConfiguration,
  parseSurfaceAccountManifest,
  type SurfaceAccountManifestSpec,
  sameCredential,
  manifestSpec as surfaceManifestSpec,
} from "./surface-account-manifest.js";
import { isTagCommand, renderTagOperation, type TagCommand } from "./tag-command-adapter.js";
import {
  AccountSelectionError,
  type SurfaceTarget,
  SurfaceTargetResolver,
  TargetValueError,
} from "./tag-surface-target.js";
import { SUPERTAG_VERSION, VERSION_HEADER } from "./version.js";

const MAX_API_BODY_BYTES = 1_000_000;

export interface ControlPlaneOperatorCredential {
  readonly token: string;
  readonly operatorId: string;
  readonly actions: readonly string[];
  readonly objectiveIds?: readonly string[];
  readonly teamIds?: readonly string[];
  /** Retains the credential definition while immediately refusing authentication. */
  readonly revoked?: boolean;
}

export interface ControlPlaneApiServerDependencies {
  /** Configured public URL; absent means local artifact endpoints are withheld. */
  readonly publicUrl?: string | undefined;
  readonly controlPlane: ControlPlane;
  readonly store: Store;
  readonly credentialVault: GatewayCredentialVault;
  readonly artifactTransfers?: {
    readonly publicKey: string;
    readonly sign: (claims: AnyArtifactTransferGrantClaims) => string;
  };
  readonly surfaceController: Pick<SurfaceController, "name" | "status">;
  readonly startedAt: string;
  readonly adminToken?: string;
  readonly coordinationOperatorCredentials: readonly ControlPlaneOperatorCredential[];
  readonly workletApi?: RemoteWorkletServer;
  readonly rpcTelemetry?: RpcTelemetry;
  /** Receives one event per authenticated management write, beside the database. */
  readonly audit?: (event: ManagementAuditEvent) => void;
  /** Shared with the Gateway; defaults to one that writes the store and `audit`. */
  readonly auditTrail?: AuditTrail;
}

export type { ManagementAuditEvent } from "./audit-trail.js";

interface ControlPlaneApiRequestContext extends ControlPlaneApiServerDependencies {
  readonly auditTrail: AuditTrail;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly rpcSnapshot: () => RpcTelemetrySnapshot;
  /** Aborted when the API Server drains, so long-lived responses such as reply streams end. */
  readonly draining: AbortSignal;
}

const CONTROL_PLANE_BREAK_GLASS_PRINCIPAL: CoordinationOperatorPrincipal = {
  operatorId: "control-plane-break-glass",
  scopes: { actions: ["*"] },
};

/** Internal API component for Control Plane resources, admission, and status. */
export class ControlPlaneApiServer {
  readonly #dependencies: ControlPlaneApiServerDependencies;
  readonly #activeRequests = new Set<Promise<void>>();
  readonly #rpcTelemetry: RpcTelemetry;
  readonly #auditTrail: AuditTrail;
  #workletGrpc: Promise<Awaited<ReturnType<typeof startWorkletGrpcServer>>> | undefined;
  #acceptingManagement = false;
  #acceptingInternal = false;
  #draining = new AbortController();

  constructor(dependencies: ControlPlaneApiServerDependencies) {
    this.#dependencies = dependencies;
    this.#rpcTelemetry = dependencies.rpcTelemetry ?? new RpcTelemetry();
    this.#auditTrail =
      dependencies.auditTrail ?? new AuditTrail(dependencies.store, dependencies.audit);
  }

  start(): void {
    if (this.#acceptingManagement || this.#acceptingInternal) return;
    if (this.#draining.signal.aborted) this.#draining = new AbortController();
    this.#acceptingManagement = true;
    this.#acceptingInternal = true;
    try {
      this.#dependencies.workletApi?.start();
    } catch (error) {
      this.#acceptingManagement = false;
      this.#acceptingInternal = false;
      throw error;
    }
  }

  /** The API Server owns the optional execution listener alongside its HTTP APIs. */
  async startWorkletGrpc(
    options: Omit<WorkletGrpcServerOptions, "remote" | "telemetry">,
  ): Promise<string> {
    const remote = this.#dependencies.workletApi;
    if (!this.#acceptingInternal || !remote)
      throw new Error("A running remote Worklet API is required for gRPC");
    this.#workletGrpc ??= startWorkletGrpcServer({
      ...options,
      remote,
      telemetry: this.#rpcTelemetry,
      registerRoutes: (router) => {
        options.registerRoutes?.(router);
        const beginRequest = () => {
          if (!this.#acceptingInternal)
            throw new ConnectError("Control Plane is draining", Code.Unavailable);
          let release: (() => void) | undefined;
          const active = new Promise<void>((resolve) => {
            release = resolve;
          });
          this.#activeRequests.add(active);
          return () => {
            this.#activeRequests.delete(active);
            release?.();
          };
        };
        registerCoordinationGrpcRoutes(router, this.#dependencies.controlPlane.objectives, {
          beginRequest,
        });
        registerMailboxGrpcRoutes(
          router,
          new TagMailboxService(
            this.#dependencies.store,
            this.#dependencies.controlPlane.objectives.liveDelivery,
          ),
          {
            beginRequest,
          },
        );
        registerSessionGrpcRoutes(
          router,
          new SessionPersistence(
            this.#dependencies.store,
            this.#dependencies.controlPlane.objectives,
          ),
          { beginRequest },
        );
        const transfers = this.#dependencies.artifactTransfers;
        registerArtifactGrpcRoutes(
          router,
          new ArtifactCatalog(
            this.#dependencies.store,
            this.#dependencies.controlPlane.objectives,
            transfers === undefined ? undefined : { sign: transfers.sign },
          ),
          {
            beginRequest,
            ...(transfers === undefined
              ? {}
              : {
                  directTransfers: {
                    publicKey: transfers.publicKey,
                    authenticateWorkerHost: (id, token) =>
                      this.#dependencies.controlPlane.authenticateConnectedWorkerHost(id, token),
                  },
                }),
          },
        );
      },
    });
    const starting = this.#workletGrpc;
    try {
      return (await starting).url;
    } catch (error) {
      if (this.#workletGrpc === starting) this.#workletGrpc = undefined;
      throw error;
    }
  }

  /** Fence new HTTP work without disconnecting Worklets needed to drain accepted Tasks. */
  beginDrain(): void {
    this.#acceptingManagement = false;
    this.#draining.abort();
  }

  /** Fence execution APIs only after every accepted Task has stopped using them. */
  beginInternalDrain(): void {
    this.#acceptingInternal = false;
  }

  async drain(): Promise<void> {
    this.beginDrain();
    await Promise.allSettled([...this.#activeRequests]);
  }

  async stop(): Promise<void> {
    this.beginDrain();
    this.beginInternalDrain();
    await this.drain();
    await this.#auditTrail.settled();
    const starting = this.#workletGrpc;
    try {
      const grpc = await starting?.catch(() => undefined);
      await grpc?.close();
    } finally {
      if (this.#workletGrpc === starting) this.#workletGrpc = undefined;
    }
    await this.#dependencies.workletApi?.stop();
  }

  get workletStatus():
    | {
        readonly connected: boolean;
        readonly id?: string;
        readonly workerHostId?: string;
      }
    | undefined {
    const worklet = this.#dependencies.workletApi;
    if (worklet === undefined) return undefined;
    const registration = worklet.workletRegistration;
    return {
      connected: worklet.isConnected,
      ...(registration === undefined
        ? {}
        : { id: registration.id, workerHostId: registration.host.id }),
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/internal/v1/"))
      throw new Error("ControlPlaneApiServer only handles Control Plane API routes");
    // The Gateway sets this too; an embedded API Server may be served without one.
    response.setHeader(VERSION_HEADER, SUPERTAG_VERSION);
    const internal = url.pathname.startsWith("/internal/v1/");
    if ((internal && !this.#acceptingInternal) || (!internal && !this.#acceptingManagement)) {
      writeJson(response, 503, { error: "control_plane_draining" });
      return;
    }
    let releaseRequest: (() => void) | undefined;
    const activeRequest = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    this.#activeRequests.add(activeRequest);
    try {
      const context: ControlPlaneApiRequestContext = {
        ...this.#dependencies,
        auditTrail: this.#auditTrail,
        request,
        response,
        rpcSnapshot: () => this.#rpcTelemetry.snapshot(),
        draining: this.#draining.signal,
      };
      if (internal) {
        await handleInternalApiRequest(context, url);
        return;
      }
      await handleApiRequest(context, url);
    } finally {
      this.#activeRequests.delete(activeRequest);
      releaseRequest?.();
    }
  }
}

async function handleInternalApiRequest(
  context: ControlPlaneApiRequestContext,
  url: URL,
): Promise<void> {
  if (url.pathname.startsWith("/internal/v1/sessions/")) {
    await handleSessionRequest(
      context.request,
      context.response,
      url,
      new SessionPersistence(context.store, context.controlPlane.objectives),
    );
    return;
  }
  if (url.pathname.startsWith("/internal/v1/artifacts/")) {
    const catalog = new ArtifactCatalog(
      context.store,
      context.controlPlane.objectives,
      context.artifactTransfers === undefined
        ? undefined
        : { sign: context.artifactTransfers.sign },
    );
    await handleArtifactRequest(
      context.request,
      context.response,
      url,
      catalog,
      context.artifactTransfers === undefined
        ? undefined
        : {
            publicKey: context.artifactTransfers.publicKey,
            authenticateWorkerHost: (workerHostId, token) =>
              context.controlPlane.authenticateConnectedWorkerHost(workerHostId, token),
          },
    );
    return;
  }
  if (url.pathname.startsWith("/internal/v1/coordination/")) {
    await handleCoordinationRequest(
      context.request,
      context.response,
      url,
      context.controlPlane.objectives,
    );
    return;
  }
  if (url.pathname.startsWith("/internal/v1/mailbox/")) {
    await handleMailboxRequest(
      context.request,
      context.response,
      url,
      context.store,
      context.controlPlane.objectives.liveDelivery,
    );
    return;
  }
  writeJson(context.response, 404, { error: "not_found" });
}

async function handleApiRequest(context: ControlPlaneApiRequestContext, url: URL): Promise<void> {
  // Joining is authorized only by the Auth Key in the Authorization header.
  if (context.request.method === "POST" && url.pathname === "/api/v1/worker-host-joins") {
    await handleWorkerHostJoin(context);
    return;
  }
  const authentication = await authenticateOperator(context);
  if (authentication === undefined || authentication.kind === "refused") {
    if (authentication === undefined && (await handleWorkerHostSelfRevocation(context, url)))
      return;
    if (authentication === undefined && (await handleWorkerHostSelfDrain(context, url))) return;
    writeStatusError(
      context.response,
      401,
      "Unauthorized",
      authentication?.message ?? "A valid Control Plane admin token or Operator Token is required",
    );
    return;
  }
  const auditNote = auditManagementRequest(context, url, authentication.principal.operatorId);

  if (url.pathname.startsWith("/api/v1/coordination/")) {
    if (!context.controlPlane.isAccepting) {
      writeJson(context.response, 503, { error: "control_plane_draining" });
      return;
    }
    await handleCoordinationRequest(
      context.request,
      context.response,
      url,
      context.controlPlane.objectives,
      authentication.principal,
      auditNote,
    );
    return;
  }
  if (authentication.kind === "coordination") {
    writeStatusError(
      context.response,
      403,
      "Forbidden",
      "This operator credential is limited to the coordination API",
    );
    return;
  }
  // Artifact metadata and download locations are for administrators, not coordination credentials.
  if (url.pathname.startsWith("/api/v1/artifacts")) {
    const download = /^\/api\/v1\/artifacts\/([^/]+)\/download$/u.exec(url.pathname);
    if (download?.[1] && context.request.method === "POST") {
      await handleOperatorArtifactDownload(
        context,
        decodeURIComponent(download[1]),
        authentication.principal.operatorId,
      );
      return;
    }
    if (
      context.request.method === "GET" &&
      (await handleOperatorArtifacts(url, context.response, context.store))
    )
      return;
  }
  if (
    url.pathname === "/api/v1/operator-tokens" ||
    url.pathname.startsWith("/api/v1/operator-tokens/")
  ) {
    if (authentication.kind !== "break-glass") {
      writeStatusError(
        context.response,
        403,
        "Forbidden",
        "Only the admin token manages Operator Tokens",
      );
      return;
    }
    await handleOperatorTokenRequest(context, url);
    return;
  }
  if (url.pathname.startsWith("/api/v1/tag-messaging/")) {
    await handleMailboxAdminRequest(
      context.request,
      context.response,
      url,
      context.store,
      (objective) => context.controlPlane.objectives.objectiveRunnable(objective),
      async (objective) => {
        if (!context.controlPlane.isAccepting)
          throw new TagMessagingError(503, "The Control Plane is draining; start the owner later");
        return (await context.controlPlane.objectives.commandAsAdministrator(
          "start_objective",
          { objectiveId: objective.id },
          authentication.principal,
        )) as TaskAssignment;
      },
    );
    return;
  }
  if (
    (context.request.method === "POST" && url.pathname === "/api/v1/objectives") ||
    (context.request.method === "GET" && /^\/api\/v1\/objectives\/[^/]+$/u.test(url.pathname))
  ) {
    await handleObjectiveManifestRequest(context, url, authentication.principal);
    return;
  }
  const objectiveCancelMatch = /^\/api\/v1\/objectives\/([^/]+)\/cancel$/u.exec(url.pathname);
  if (context.request.method === "POST" && objectiveCancelMatch?.[1] !== undefined) {
    await handleObjectiveCancellation(
      context,
      decodeURIComponent(objectiveCancelMatch[1]),
      authentication.principal,
    );
    return;
  }

  const objectivePauseMatch = /^\/api\/v1\/objectives\/([^/]+)\/(pause|resume)$/u.exec(
    url.pathname,
  );
  if (
    context.request.method === "POST" &&
    objectivePauseMatch?.[1] !== undefined &&
    objectivePauseMatch[2] !== undefined
  ) {
    await handleObjectivePause(
      context,
      decodeURIComponent(objectivePauseMatch[1]),
      objectivePauseMatch[2] === "pause",
      authentication.principal,
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/audit") {
    await handleAuditRead(context, url);
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/status") {
    const now = new Date().toISOString();
    const status = {
      phase: context.controlPlane.isAccepting ? ("accepting" as const) : ("draining" as const),
      apiVersion: 1 as const,
      controllers: [
        ...context.controlPlane.controllerStatuses,
        {
          name: context.surfaceController.name,
          phase: context.surfaceController.status().errors.length === 0 ? "running" : "degraded",
        },
      ],
    };
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "ControlPlane",
      metadata: {
        id: "control-plane",
        name: "control-plane",
        resourceVersion: createHash("sha256").update(JSON.stringify(status)).digest("hex"),
        createdAt: context.startedAt,
        updatedAt: now,
      },
      spec: {},
      status,
    });
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/metrics") {
    const metrics = await context.store.readCoordinationMetrics();
    const { capturedAt, ...values } = metrics;
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "MetricSnapshot",
      metadata: { capturedAt },
      values: { ...values, rpc: context.rpcSnapshot() },
    });
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/organization") {
    const [hosts, tags, runningAttempts, objectives] = await Promise.all([
      context.controlPlane.listWorkerHosts(),
      context.store.listTags(),
      context.store.listRunningTaskAttempts(),
      context.store.listOpenObjectives(),
    ]);
    // Status shows spend only for open Objectives, so read only their Attempts.
    const spend = await context.store.readSpend({
      by: "objective",
      objectiveIds: objectives.map((objective) => objective.id),
    });
    const taskTagIds = new Map<string, string>();
    const runningCommands = new Map<string, TaskAttemptRunningCommand>();
    for (const taskId of new Set(runningAttempts.map((attempt) => attempt.taskId))) {
      const task = await context.store.findTaskById(taskId);
      if (task !== undefined) taskTagIds.set(taskId, task.tagId);
      const attempt = runningAttempts
        .filter((candidate) => candidate.taskId === taskId)
        .toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
      const running = taskAttemptRunningCommand(
        attempt,
        await context.store.listTaskEvents(taskId),
      );
      if (running !== null) runningCommands.set(taskId, running);
    }
    const objectiveTasks = new Map(
      await Promise.all(
        objectives.map(
          async (objective) =>
            [objective.id, await context.store.listTaskAssignments(objective.id)] as const,
        ),
      ),
    );
    writeJson(
      context.response,
      200,
      organizationStatus({
        asOf: new Date().toISOString(),
        workerHosts: hosts
          .filter((host) => !(host.ephemeral && host.enrollmentStatus === "revoked"))
          .map((host) => workerHostResource(host)),
        tags,
        runningAttempts,
        taskTagIds,
        runningCommands,
        objectives,
        objectiveTasks,
        objectiveSpend: new Map(spend.groups.map((group) => [group.key, group])),
      }),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/spend") {
    const by = url.searchParams.get("by") ?? "objective";
    const since = url.searchParams.get("since") ?? undefined;
    if (
      url.searchParams.size !==
        [...url.searchParams.keys()].filter((key) => key === "by" || key === "since").length ||
      !["tag", "objective", "day"].includes(by)
    ) {
      writeStatusError(
        context.response,
        400,
        "Invalid",
        "Spend supports by=tag|objective|day and since=ISO",
      );
      return;
    }
    try {
      writeJson(
        context.response,
        200,
        await context.store.readSpend({
          by: by as "tag" | "objective" | "day",
          ...(since === undefined ? {} : { since }),
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("since must")) {
        writeStatusError(context.response, 400, "Invalid", error.message);
        return;
      }
      throw error;
    }
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/tags") {
    const [tags, routes, assignments, roles, accounts, organization] = await Promise.all([
      context.store.listTags(),
      context.store.listTagRoutes(),
      context.store.listRoleAssignments(),
      context.store.listRoles(),
      context.store.listSurfaceAccounts(),
      tagOrganizationFromStore(context.store),
    ]);
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const bindings = new Map(
      await Promise.all(
        tags.map(
          async (tag) => [tag.id, await context.store.listTagWorkerHostBindings(tag.id)] as const,
        ),
      ),
    );
    const grantsByTag = new Map(
      await Promise.all(
        tags.map(async (tag) => [tag.id, await recipientGrants(context.store, tag)] as const),
      ),
    );
    writeJson(
      context.response,
      200,
      resourceList(
        tags.map((tag) =>
          tagResource(
            tag,
            routes.filter((route) => route.tagId === tag.id),
            assignments.filter((assignment) => assignment.tagId === tag.id),
            (bindings.get(tag.id) ?? []).map((binding) => binding.workerHostId),
            roleNames,
            accountsById,
            { ...organization, grants: grantsByTag.get(tag.id) ?? [] },
            new Map(roles.map((role) => [role.id, role])),
          ),
        ),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/surface-accounts") {
    writeJson(
      context.response,
      200,
      resourceList((await context.store.listSurfaceAccounts()).map(surfaceAccountResource)),
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/surface-accounts") {
    await applySurfaceAccountManifest(context, url);
    return;
  }

  const surfaceAccountMatch = /^\/api\/v1\/surface-accounts\/([^/]+)$/u.exec(url.pathname);
  if (context.request.method === "GET" && surfaceAccountMatch?.[1] !== undefined) {
    const name = decodeURIComponent(surfaceAccountMatch[1]);
    const account = await findSurfaceAccountForDeletion(context.store, name);
    if (account === undefined) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Surface Account ${name} does not exist`,
      });
      return;
    }
    writeJson(context.response, 200, surfaceAccountResource(account));
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/worker-hosts") {
    const desired = parseWorkerHostEnrollment(await readJsonBody(context.request));
    if ((await context.controlPlane.listWorkerHosts()).some((host) => host.id === desired.id)) {
      writeStatusError(context.response, 409, "AlreadyExists", "Worker Host is already enrolled");
      return;
    }
    let issued: Awaited<ReturnType<ControlPlane["enrollWorkerHost"]>>;
    try {
      issued = await context.controlPlane.enrollWorkerHost(desired);
    } catch (error) {
      if (error instanceof Error && /^Worker Host .+ is already enrolled$/u.test(error.message)) {
        writeStatusError(context.response, 409, "AlreadyExists", "Worker Host is already enrolled");
        return;
      }
      throw error;
    }
    writeOneTimeCredential(
      context.response,
      201,
      workerHostCredentialIssuance(issued.workerHost.id, issued.token, issued.workerHost.updatedAt),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/worker-hosts") {
    // Removed ephemeral hosts stay readable by ID but leave the default list.
    const workerHosts = (await context.controlPlane.listWorkerHosts()).filter(
      (host) => !(host.ephemeral && host.enrollmentStatus === "revoked"),
    );
    writeJson(
      context.response,
      200,
      resourceList(await workerHostResourcesFromStore(context.store, workerHosts)),
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/auth-keys") {
    let desired: ReturnType<typeof parseAuthKeyRequest>;
    try {
      desired = parseAuthKeyRequest(await readJsonBody(context.request));
    } catch (error) {
      writeStatusError(context.response, 400, "Invalid", errorText(error));
      return;
    }
    let issued: Awaited<ReturnType<ControlPlane["createAuthKey"]>>;
    try {
      issued = await context.controlPlane.createAuthKey(desired);
    } catch (error) {
      if (error instanceof TagMessagingError) {
        writeStatusError(
          context.response,
          error.statusCode,
          error.statusCode === 409 ? "AlreadyExists" : "Invalid",
          error.message,
        );
        return;
      }
      throw error;
    }
    writeOneTimeCredential(context.response, 201, {
      ...(await authKeyResourceFromStore(context.store, issued.authKey)),
      secret: issued.secret,
    });
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/auth-keys") {
    const keys = await context.controlPlane.listAuthKeys();
    const tagNames = await tagNamesById(context.store);
    writeJson(
      context.response,
      200,
      resourceList(keys.map((key) => authKeyResource(key, tagNames))),
    );
    return;
  }

  const authKeyMatch = /^\/api\/v1\/auth-keys\/([^/]+?)(\/revoke)?$/u.exec(url.pathname);
  if (
    authKeyMatch?.[1] !== undefined &&
    ((context.request.method === "GET" && authKeyMatch[2] === undefined) ||
      (context.request.method === "POST" && authKeyMatch[2] === "/revoke"))
  ) {
    const name = decodeURIComponent(authKeyMatch[1]);
    const key =
      context.request.method === "POST"
        ? await context.controlPlane.revokeAuthKey(name)
        : await context.controlPlane.findAuthKey(name);
    if (key === undefined) {
      writeStatusError(context.response, 404, "NotFound", `Auth Key ${name} does not exist`);
      return;
    }
    writeJson(context.response, 200, await authKeyResourceFromStore(context.store, key));
    return;
  }

  const workerHostCredentialMatch = /^\/api\/v1\/worker-hosts\/([^/]+)\/credential$/u.exec(
    url.pathname,
  );
  if (workerHostCredentialMatch?.[1] !== undefined) {
    const id = decodeURIComponent(workerHostCredentialMatch[1]);
    if (context.request.method === "POST") {
      const issued = await context.controlPlane.rotateWorkerHostCredential(id);
      if (issued === undefined) {
        const existing = (await context.controlPlane.listWorkerHosts()).find(
          (host) => host.id === id,
        );
        if (existing === undefined) {
          writeStatusError(context.response, 404, "NotFound", "Worker Host does not exist");
        } else {
          writeStatusError(
            context.response,
            409,
            "Revoked",
            "A revoked Worker Host must be enrolled under a new ID",
          );
        }
        return;
      }
      writeOneTimeCredential(
        context.response,
        200,
        workerHostCredentialIssuance(
          issued.workerHost.id,
          issued.token,
          issued.workerHost.updatedAt,
        ),
      );
      return;
    }
    if (context.request.method === "DELETE") {
      if ((await context.controlPlane.revokeWorkerHostCredential(id)) === undefined) {
        writeStatusError(context.response, 404, "NotFound", "Worker Host does not exist");
        return;
      }
      context.response.writeHead(204);
      context.response.end();
      return;
    }
  }

  const workerHostOperationMatch = /^\/api\/v1\/worker-hosts\/([^/]+)\/(drain|resume)$/u.exec(
    url.pathname,
  );
  if (
    context.request.method === "POST" &&
    workerHostOperationMatch?.[1] !== undefined &&
    workerHostOperationMatch[2] !== undefined
  ) {
    const id = decodeURIComponent(workerHostOperationMatch[1]);
    const draining = workerHostOperationMatch[2] === "drain";
    if (!(await context.controlPlane.setWorkerHostDraining(id, draining))) {
      writeStatusError(context.response, 404, "NotFound", "Worker Host does not exist");
      return;
    }
    const workerHost = (await context.controlPlane.listWorkerHosts()).find(
      (candidate) => candidate.id === id,
    );
    if (workerHost === undefined) {
      writeStatusError(context.response, 404, "NotFound", "Worker Host does not exist");
      return;
    }
    writeJson(context.response, 200, workerHostResource(workerHost));
    return;
  }

  const workerHostMatch = /^\/api\/v1\/worker-hosts\/([^/]+)$/u.exec(url.pathname);
  if (context.request.method === "GET" && workerHostMatch?.[1] !== undefined) {
    const id = decodeURIComponent(workerHostMatch[1]);
    const workerHost = (await context.controlPlane.listWorkerHosts()).find(
      (candidate) => candidate.id === id,
    );
    if (workerHost === undefined) {
      writeStatusError(context.response, 404, "NotFound", "Worker Host does not exist");
      return;
    }
    writeJson(
      context.response,
      200,
      (await workerHostResourcesFromStore(context.store, [workerHost]))[0],
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/worker-profiles") {
    const workerHosts = await context.controlPlane.listWorkerHosts();
    writeJson(
      context.response,
      200,
      resourceList(
        workerHosts.flatMap((host) => workerProfileResourcesFromHost(host, context.startedAt)),
      ),
    );
    return;
  }

  const workerProfileMatch = /^\/api\/v1\/worker-profiles\/([^/]+)$/u.exec(url.pathname);
  if (context.request.method === "GET" && workerProfileMatch?.[1] !== undefined) {
    const workerHosts = await context.controlPlane.listWorkerHosts();
    const name = decodeURIComponent(workerProfileMatch[1]);
    const profile = workerHosts
      .flatMap((host) => workerProfileResourcesFromHost(host, context.startedAt))
      .find((candidate) => candidate.metadata.name === name || candidate.metadata.id === name);
    if (profile === undefined) {
      writeStatusError(context.response, 404, "NotFound", "Worker Profile does not exist");
      return;
    }
    writeJson(context.response, 200, profile);
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/permission-sets") {
    const [sets, permissions, activations] = await Promise.all([
      context.store.listTagPermissionSets(),
      context.store.listTagPermissions(),
      context.store.listTagPermissionActivations(),
    ]);
    writeJson(
      context.response,
      200,
      resourceList(
        sets.map((set) =>
          permissionSetResource(
            set,
            permissions.filter((permission) => permission.permissionSetId === set.id),
            activations.filter((activation) => activation.permissionSetId === set.id),
          ),
        ),
      ),
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/permission-sets") {
    const options = managedWriteOptions(url);
    const body = await readJsonBody(context.request);
    const desired = parseDesiredPermissionSet(body);
    const existing = await context.store.findTagPermissionSetByName(desired.name);
    const plan = await planWrite(context.store, options, {
      kind: "PermissionSet",
      name: desired.name,
      currentSpec: existing
        ? permissionSetManifestSpec(
            existing,
            await context.store.listTagPermissions({ permissionSetId: existing.id }),
          )
        : undefined,
      desiredSpec: {
        ...(manifestSpec(body)["approvers"] === undefined ? {} : { approvers: desired.approvers }),
        permissions: desired.permissions,
      },
    });
    if (respondWithoutWriting(context, body, plan, options)) return;
    const merged = plan.spec as {
      readonly approvers: readonly string[];
      readonly permissions: readonly DesiredPermission[];
    };
    const created = await context.store.createTagPermissionSet({
      name: desired.name,
      approvers: merged.approvers,
    });
    const set =
      JSON.stringify(created.approvers ?? []) === JSON.stringify(merged.approvers)
        ? created
        : await context.store.setTagPermissionSetApprovers(created.id, merged.approvers);
    const current = await context.store.listTagPermissions({ permissionSetId: set.id });
    const desiredKeys = new Set(merged.permissions.map(permissionKey));
    await Promise.all(
      current
        .filter((permission) => !desiredKeys.has(permissionKey(permission)))
        .map((permission) => context.store.removeTagPermission(permission.id)),
    );
    for (const permission of merged.permissions) {
      const stored = await context.store.addTagPermission({
        permissionSetId: set.id,
        ...permission,
      });
      if (stored.approval !== permission.approval)
        await context.store.setTagPermissionApproval(stored.id, permission.approval);
    }
    const stored = (await context.store.findTagPermissionSetById(set.id)) ?? set;
    const permissions = await context.store.listTagPermissions({ permissionSetId: set.id });
    await recordWrite(context.store, plan, permissionSetManifestSpec(stored, permissions), options);
    writeJson(
      context.response,
      plan.exists ? 200 : 201,
      permissionSetResource(
        stored,
        permissions,
        await context.store.listTagPermissionActivations({ permissionSetId: set.id }),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname.startsWith("/api/v1/permission-sets/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/permission-sets/".length));
    const set = await context.store.findTagPermissionSetByName(name);
    if (set === undefined) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Permission Set ${name} does not exist`,
      });
      return;
    }
    writeJson(
      context.response,
      200,
      permissionSetResource(
        set,
        await context.store.listTagPermissions({ permissionSetId: set.id }),
        await context.store.listTagPermissionActivations({ permissionSetId: set.id }),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/context-sets") {
    const [sets, items, activations] = await Promise.all([
      context.store.listTagContextSets(),
      context.store.listTagContextItems(),
      context.store.listTagContextActivations(),
    ]);
    writeJson(
      context.response,
      200,
      resourceList(
        sets.map((set) =>
          contextSetResource(
            set,
            items.filter((item) => item.contextSetId === set.id),
            activations.filter((activation) => activation.contextSetId === set.id),
          ),
        ),
      ),
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/context-sets") {
    const options = managedWriteOptions(url);
    const body = await readJsonBody(context.request);
    const desired = parseDesiredContextSet(body);
    const existing = await context.store.findTagContextSetByName(desired.name);
    const plan = await planWrite(context.store, options, {
      kind: "ContextSet",
      name: desired.name,
      currentSpec: existing
        ? contextSetManifestSpec(
            await context.store.listTagContextItems({ contextSetId: existing.id }),
          )
        : undefined,
      desiredSpec: { items: desired.items },
    });
    if (respondWithoutWriting(context, body, plan, options)) return;
    const merged = plan.spec as { readonly items: readonly DesiredContextItem[] };
    const set = await context.store.createTagContextSet({ name: desired.name });
    const current = await context.store.listTagContextItems({ contextSetId: set.id });
    const desiredKeys = new Set(merged.items.map((item) => item.itemKey));
    await Promise.all(
      current
        .filter((item) => !desiredKeys.has(item.itemKey))
        .map((item) => context.store.removeTagContextItem(item.id)),
    );
    for (const item of merged.items) {
      const prior = current.find((candidate) => candidate.itemKey === item.itemKey);
      if (prior !== undefined && sameValue(contextItemValue(prior), item)) continue;
      if (prior !== undefined) await context.store.removeTagContextItem(prior.id);
      await context.store.addTagContextItem({ contextSetId: set.id, ...item });
    }
    const items = await context.store.listTagContextItems({ contextSetId: set.id });
    await recordWrite(context.store, plan, contextSetManifestSpec(items), options);
    writeJson(
      context.response,
      plan.exists ? 200 : 201,
      contextSetResource(
        set,
        items,
        await context.store.listTagContextActivations({ contextSetId: set.id }),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname.startsWith("/api/v1/context-sets/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/context-sets/".length));
    const set = await context.store.findTagContextSetByName(name);
    if (set === undefined) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Context Set ${name} does not exist`,
      });
      return;
    }
    writeJson(
      context.response,
      200,
      contextSetResource(
        set,
        await context.store.listTagContextItems({ contextSetId: set.id }),
        await context.store.listTagContextActivations({ contextSetId: set.id }),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/roles") {
    const roles = await context.store.listRoles();
    writeJson(
      context.response,
      200,
      resourceList(
        await Promise.all(roles.map((role) => roleResourceFromStore(context.store, role))),
      ),
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/roles") {
    const options = managedWriteOptions(url);
    const body = await readJsonBody(context.request);
    const desired = parseDesiredRole(body);
    const existing = await context.store.findRoleByName(desired.name);
    // A retired Role is gone from the organization; applying it again starts it fresh.
    const active = existing?.status === "active" ? existing : undefined;
    const plan = await planWrite(context.store, options, {
      kind: "Role",
      name: desired.name,
      currentSpec: active ? (await roleResourceFromStore(context.store, active)).spec : undefined,
      desiredSpec: {
        purpose: desired.purpose,
        instructions: desired.instructions,
        contextSets: desired.contextSets,
        permissionSets: desired.permissionSets,
        ...(desired.execution === undefined ? {} : { execution: desired.execution }),
      },
    });
    if (respondWithoutWriting(context, body, plan, options)) return;
    const merged = plan.spec as {
      readonly purpose?: string;
      readonly instructions?: string;
      readonly contextSets: readonly string[];
      readonly permissionSets: readonly string[];
      readonly execution?: ExecutionSettings;
    };
    const [contextSets, permissionSets] = await Promise.all([
      Promise.all(
        merged.contextSets.map(async (name) => {
          const set = await context.store.findTagContextSetByName(name);
          if (!set) throw new Error(`Context Set ${name} does not exist`);
          return set;
        }),
      ),
      Promise.all(
        merged.permissionSets.map(async (name) => {
          const set = await context.store.findTagPermissionSetByName(name);
          if (!set) throw new Error(`Permission Set ${name} does not exist`);
          return set;
        }),
      ),
    ]);
    const fields = {
      purpose: merged.purpose ?? desired.purpose,
      instructions: merged.instructions ?? "",
      contextSetIds: contextSets.map((set) => set.id),
      permissionSetIds: permissionSets.map((set) => set.id),
    };
    let role = existing
      ? await context.store.updateRole(existing.id, {
          expectedRevision: existing.revision,
          ...fields,
          execution: merged.execution ?? null,
          status: "active",
        })
      : await context.store.createRole({
          name: desired.name,
          ...fields,
          ...(merged.execution === undefined ? {} : { execution: merged.execution }),
        });
    role = (await context.store.findRoleById(role.id)) ?? role;
    const resource = await roleResourceFromStore(context.store, role);
    await recordWrite(context.store, plan, resource.spec, options);
    writeJson(context.response, existing === undefined ? 201 : 200, resource);
    return;
  }

  if (context.request.method === "GET" && url.pathname.startsWith("/api/v1/roles/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/roles/".length));
    const role = await context.store.findRoleByName(name);
    if (!role) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Role ${name} does not exist`,
      });
      return;
    }
    writeJson(context.response, 200, await roleResourceFromStore(context.store, role));
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/volumes") {
    const volumes = await context.store.listVolumes();
    writeJson(context.response, 200, resourceList(volumes.map(volumeResource)));
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/volumes") {
    const options = managedWriteOptions(url);
    const body = await readJsonBody(context.request);
    const desired = parseDesiredVolume(body);
    const existing = await context.store.findVolumeByName(desired.name);
    const { name: _name, ...desiredSpec } = desired;
    const plan = await planWrite(context.store, options, {
      kind: "Volume",
      name: desired.name,
      currentSpec: existing ? volumeResource(existing).spec : undefined,
      desiredSpec,
    });
    if (respondWithoutWriting(context, body, plan, options)) return;
    // The merged spec keeps fields other managers own; the store validates it again.
    let applied: Awaited<ReturnType<Store["applyVolume"]>>;
    try {
      applied = await context.store.applyVolume({
        ...(plan.spec as Partial<VolumeSpec>),
        name: desired.name,
      } as ApplyVolumeInput);
    } catch (error) {
      if (!(error instanceof TagMessagingError) || error.statusCode !== 409) throw error;
      writeStatusError(context.response, 409, "Conflict", error.message);
      return;
    }
    const { volume, created } = applied;
    await recordWrite(context.store, plan, volumeResource(volume).spec, options);
    writeJson(context.response, created ? 201 : 200, volumeResource(volume));
    return;
  }

  if (context.request.method === "GET" && url.pathname.startsWith("/api/v1/volumes/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/volumes/".length));
    const volume = await context.store.findVolumeByName(name);
    if (!volume) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Volume ${name} does not exist`,
      });
      return;
    }
    writeJson(context.response, 200, volumeResource(volume));
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/workspaces") {
    const [workspaces, hosts] = await Promise.all([
      context.store.listWorkspaces(),
      context.controlPlane.listWorkerHosts(),
    ]);
    writeJson(
      context.response,
      200,
      resourceList(workspaces.map((workspace) => workspaceResource(workspace, hosts))),
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/workspaces") {
    const options = managedWriteOptions(url);
    const body = await readJsonBody(context.request);
    const desired = parseDesiredWorkspace(body);
    const existing = await context.store.findWorkspaceByName(desired.name);
    const listed = manifestSpec(body);
    const plan = await planWrite(context.store, options, {
      kind: "Workspace",
      name: desired.name,
      currentSpec: existing ? workspaceResource(existing, []).spec : undefined,
      // Only the fields the manifest sets; the store fills defaults for the rest.
      desiredSpec: Object.fromEntries(
        Object.entries(withoutName(desired)).filter(([field]) => listed[field] !== undefined),
      ),
    });
    if (respondWithoutWriting(context, body, plan, options)) return;
    const merged = plan.spec as Partial<WorkspaceSpec>;
    const { workspace, created } = await context.store.applyWorkspace({
      name: desired.name,
      ...merged,
      delivery: merged.delivery ?? DEFAULT_WORKSPACE_DELIVERY,
    });
    await recordWrite(context.store, plan, workspaceResource(workspace, []).spec, options);
    writeJson(
      context.response,
      created ? 201 : 200,
      workspaceResource(workspace, await context.controlPlane.listWorkerHosts()),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname.startsWith("/api/v1/workspaces/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/workspaces/".length));
    const workspace = await context.store.findWorkspaceByName(name);
    if (!workspace) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Workspace ${name} does not exist`,
      });
      return;
    }
    const hosts = await context.controlPlane.listWorkerHosts();
    writeJson(
      context.response,
      200,
      workspaceResource(
        workspace,
        hosts,
        await workspaceEnvironments(context.store, workspace, hosts),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/tasks") {
    writeJson(
      context.response,
      200,
      resourceList(
        await Promise.all(
          (await context.store.listTasks()).map((task) =>
            taskResourceFromStore(context.store, task),
          ),
        ),
      ),
    );
    return;
  }

  if (context.request.method === "GET" && url.pathname === "/api/v1/sessions") {
    writeJson(
      context.response,
      200,
      resourceList((await context.store.listSessions()).map(sessionResource)),
    );
    return;
  }

  const taskEventsMatch = /^\/api\/v1\/tasks\/([^/]+)\/events$/u.exec(url.pathname);
  if (context.request.method === "GET" && taskEventsMatch?.[1] !== undefined) {
    const taskId = decodeURIComponent(taskEventsMatch[1]);
    if ((await context.store.findTaskById(taskId)) === undefined) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Task ${taskId} does not exist`,
      });
      return;
    }
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "TaskEventList",
      metadata: { taskId },
      items: await context.store.listTaskEvents(taskId),
    });
    return;
  }

  const taskExecutionMatch = /^\/api\/v1\/tasks\/([^/]+)\/execution$/u.exec(url.pathname);
  if (context.request.method === "GET" && taskExecutionMatch?.[1]) {
    const taskId = decodeURIComponent(taskExecutionMatch[1]);
    if (!(await context.store.findTaskById(taskId))) {
      writeJson(context.response, 404, { error: "not_found", message: "Task does not exist" });
      return;
    }
    writeJson(context.response, 200, await context.controlPlane.inspectTaskExecution(taskId));
    return;
  }

  const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/u.exec(url.pathname);
  if (context.request.method === "GET" && taskMatch?.[1] !== undefined) {
    const task = await context.store.findTaskById(decodeURIComponent(taskMatch[1]));
    if (task === undefined) {
      writeJson(context.response, 404, { error: "not_found", message: "Task does not exist" });
      return;
    }
    writeJson(
      context.response,
      200,
      await taskResourceFromStore(context.store, task, { storage: true }),
    );
    return;
  }

  const taskCancelMatch = /^\/api\/v1\/tasks\/([^/]+)\/cancel$/u.exec(url.pathname);
  if (context.request.method === "POST" && taskCancelMatch?.[1] !== undefined) {
    const result = await context.controlPlane.requestTaskCancellation(
      decodeURIComponent(taskCancelMatch[1]),
      authentication.principal,
    );
    writeJson(context.response, result.accepted ? 202 : 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "TaskCancellation",
      metadata: { taskId: result.task.id },
      status: { accepted: result.accepted, phase: result.task.status },
    });
    return;
  }

  const nativeSessionMatch = /^\/api\/v1\/sessions\/([^/]+)\/states(?:\/([^/]+))?$/u.exec(
    url.pathname,
  );
  if (context.request.method === "GET" && nativeSessionMatch?.[1]) {
    const sessionId = decodeURIComponent(nativeSessionMatch[1]);
    if (!(await context.store.findSessionById(sessionId))) {
      writeJson(context.response, 404, { error: "not_found" });
      return;
    }
    context.response.setHeader("cache-control", "no-store");
    if (nativeSessionMatch[2]) {
      const state = await context.store.findSessionState(decodeURIComponent(nativeSessionMatch[2]));
      if (!state || state.sessionId !== sessionId) {
        writeJson(context.response, 404, { error: "not_found" });
        return;
      }
      writeJson(context.response, 200, state);
      return;
    }
    const nativeId = url.searchParams.get("nativeId");
    const states = await context.store.listSessionStates({
      sessionId,
      limit: 100,
      ...(nativeId === null ? {} : { nativeId }),
    });
    writeJson(context.response, 200, { states });
    return;
  }
  const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/u.exec(url.pathname);
  if (context.request.method === "GET" && sessionMatch?.[1] !== undefined) {
    const session = await context.store.findSessionById(decodeURIComponent(sessionMatch[1]));
    if (session === undefined) {
      writeJson(context.response, 404, { error: "not_found", message: "Session does not exist" });
      return;
    }
    writeJson(context.response, 200, sessionResource(session));
    return;
  }

  const tagMessageMatch = /^\/api\/v1\/tags\/([^/]+)\/messages(?:\/([^/]+)(\/stream)?)?$/u.exec(
    url.pathname,
  );
  if (tagMessageMatch?.[1] !== undefined) {
    await handleTagMessage(
      context,
      decodeURIComponent(tagMessageMatch[1]),
      tagMessageMatch[2] === undefined ? undefined : decodeURIComponent(tagMessageMatch[2]),
      // The admin token is one operator; each Operator Token is another.
      authentication.kind === "break-glass" ? "admin" : authentication.principal.operatorId,
      tagMessageMatch[3] === undefined ? undefined : url,
    );
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/tags") {
    const options = managedWriteOptions(url);
    const body = await readJsonBody(context.request);
    const desired = parseDesiredTag(body);
    const [accounts, workerHosts] = await Promise.all([
      context.store.listSurfaceAccounts(),
      context.controlPlane.listWorkerHosts(),
    ]);
    const knownWorkerHostIds = new Set(workerHosts.map((host) => host.id));
    for (const workerHostId of desired.workerHosts ?? [])
      if (!knownWorkerHostIds.has(workerHostId))
        throw new Error(`Worker Host ${workerHostId} does not exist`);
    const locations =
      desired.locations === undefined
        ? undefined
        : await resolveTagLocations(context, desired.locations, accounts);
    const existing = await context.store.findTagByName(desired.name);
    const plan = await planWrite(context.store, options, {
      kind: "Tag",
      name: desired.name,
      currentSpec: existing
        ? (await tagResourceFromStore(context.store, existing)).spec
        : undefined,
      desiredSpec: desiredTagSpec(desired, locations),
    });
    // References are checked by the caller, against the whole input.
    if (respondWithoutWriting(context, body, plan, options)) return;
    const merged = plan.spec as {
      readonly roles: readonly string[];
      readonly workerHosts: readonly string[];
      readonly runsOn: readonly string[];
      readonly execution?: ExecutionSettings;
      readonly locations: readonly TagLocationSpec[];
      readonly acceptsMessagesFrom: readonly { tag: string; types: readonly TagMessageType[] }[];
    };
    // Kept locations come from stored routes; the manifest's own are already resolved.
    const resolved = new Map<string, ResolvedTagLocation>();
    for (const route of existing ? await context.store.listTagRoutes({ tagId: existing.id }) : []) {
      const account = accounts.find((candidate) => candidate.id === route.surfaceAccountId);
      if (!account) continue;
      const key = locationKey({
        provider: account.provider,
        ...tagLocationScopeFields(account.provider, route.scope),
      });
      resolved.set(key, {
        field: `spec.locations[${key}]`,
        provider: account.provider,
        account,
        scope: route.scope,
        displayName: route.scope,
        permissionSets: [],
        contextSets: [],
        workspaces: [],
      });
    }
    for (const location of locations ?? [])
      resolved.set(
        locationKey({
          provider: location.account.provider,
          ...tagLocationScopeFields(location.account.provider, location.scope),
        }),
        location,
      );
    const mergedLocations = merged.locations.map((location) => {
      const route = resolved.get(locationKey(location));
      if (!route) throw new Error(`Tag location ${locationKey(location)} cannot be resolved`);
      return {
        ...route,
        permissionSets: location.permissionSets ?? [],
        contextSets: location.contextSets ?? [],
        workspaces: location.workspaces ?? [],
      };
    });
    const { tag, created } = await applyDesiredTag(
      context,
      {
        name: desired.name,
        roles: merged.roles,
        workerHosts: merged.workerHosts,
        runsOn: merged.runsOn,
        execution: merged.execution ?? null,
        acceptsMessagesFrom: merged.acceptsMessagesFrom,
      },
      mergedLocations,
    );
    const resource = await tagResourceFromStore(context.store, tag);
    await recordWrite(context.store, plan, resource.spec, options);
    writeJson(context.response, created ? 201 : 200, resource);
    return;
  }

  const tagWorkerHostMatch = /^\/api\/v1\/tags\/([^/]+)\/worker-hosts\/([^/]+)$/u.exec(
    url.pathname,
  );
  if (
    (context.request.method === "PUT" || context.request.method === "DELETE") &&
    tagWorkerHostMatch?.[1] !== undefined &&
    tagWorkerHostMatch[2] !== undefined
  ) {
    const name = decodeURIComponent(tagWorkerHostMatch[1]);
    const workerHostId = decodeURIComponent(tagWorkerHostMatch[2]);
    const tag = await context.store.findTagByName(name);
    if (tag === undefined) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Tag ${JSON.stringify(name)} does not exist`,
      });
      return;
    }
    if (context.request.method === "PUT") {
      const workerHosts = await context.controlPlane.listWorkerHosts();
      if (!workerHosts.some((host) => host.id === workerHostId)) {
        writeJson(context.response, 404, {
          error: "not_found",
          message: `Worker Host ${workerHostId} does not exist`,
        });
        return;
      }
      await context.store.bindTagWorkerHost(tag.id, workerHostId);
    } else {
      await context.store.unbindTagWorkerHost(tag.id, workerHostId);
    }
    writeJson(context.response, 200, await tagResourceFromStore(context.store, tag));
    return;
  }

  if (context.request.method === "GET" && url.pathname.startsWith("/api/v1/tags/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/tags/".length));
    // A retired Tag stays readable by name until a new Tag takes the name.
    const tag = await context.store.findTagByName(name, { includeRetired: true });
    if (tag === undefined) {
      writeJson(context.response, 404, {
        error: "not_found",
        message: `Tag ${JSON.stringify(name)} does not exist`,
      });
      return;
    }
    writeJson(context.response, 200, await tagResourceFromStore(context.store, tag));
    return;
  }

  const deleteMatch =
    /^\/api\/v1\/(tags|roles|permission-sets|context-sets|volumes|workspaces|surface-accounts)\/([^/]+)$/u.exec(
      url.pathname,
    );
  if (
    context.request.method === "DELETE" &&
    deleteMatch?.[1] !== undefined &&
    deleteMatch[2] !== undefined
  ) {
    await handleResourceDeletion(
      context,
      DELETABLE_PATHS[deleteMatch[1] as keyof typeof DELETABLE_PATHS],
      decodeURIComponent(deleteMatch[2]),
      url.searchParams.get("dryRun") === "true",
    );
    return;
  }

  const pruneMatch = /^\/api\/v1\/apply-sets\/([^/]+)\/prune$/u.exec(url.pathname);
  if (context.request.method === "POST" && pruneMatch?.[1] !== undefined) {
    const applySet = decodeURIComponent(pruneMatch[1]);
    const body = await readJsonBody(context.request);
    const keep = isRecord(body) && Array.isArray(body["keep"]) ? body["keep"] : undefined;
    if (
      keep === undefined ||
      keep.some(
        (item) =>
          !isRecord(item) || typeof item["kind"] !== "string" || typeof item["name"] !== "string",
      )
    )
      throw new Error(
        "Prune requires keep, a list of the kind and name of every resource in the input",
      );
    const dryRun = url.searchParams.get("dryRun") === "true";
    const items = await pruneApplySet(context.store, {
      applySet,
      keep: keep as { kind: string; name: string }[],
      dryRun,
      credentialVault: context.credentialVault,
      workerHosts: () => context.controlPlane.listWorkerHosts(),
      cancelObjective: async (objectiveId, reason) => {
        await context.controlPlane.objectives.cancelObjective(
          { objectiveId, reason },
          authentication.principal,
        );
      },
    });
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "ApplySetPrune",
      metadata: { name: applySet },
      dryRun,
      items,
    });
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/surface-enrollments") {
    const enrollment = parseResourceRequest(
      await readJsonBody(context.request),
      "SurfaceEnrollment",
    );
    const verified = parseVerifiedSurfaceAccount(enrollment.spec);
    const account = await context.controlPlane.setupSurfaceAccount(verified);
    writeJson(context.response, 200, surfaceAccountResource(account));
    return;
  }

  if (context.request.method === "POST" && url.pathname === "/api/v1/tag-operations") {
    const request = parseResourceRequest(await readJsonBody(context.request), "TagOperation");
    const command = parseTagCommandRequest(request.spec);
    const output = await renderTagOperation(command.command, command.args, {
      store: context.store,
      credentialVault: context.credentialVault,
    });
    const now = new Date().toISOString();
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "TagOperation",
      metadata: {
        id: request.id,
        resourceVersion: "1",
        createdAt: now,
        updatedAt: now,
      },
      spec: command,
      status: { phase: "completed", output },
    });
    return;
  }

  writeStatusError(context.response, 404, "NotFound", "Admin route not found");
}

function parseResourceRequest(
  value: unknown,
  expectedKind: "SurfaceEnrollment" | "TagOperation",
): { readonly id: string; readonly spec: Record<string, unknown> } {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== expectedKind ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  ) {
    throw new Error(`${expectedKind} resource is invalid`);
  }
  return {
    id: requiredString(value["metadata"]["id"], `${expectedKind} metadata.id`),
    spec: value["spec"],
  };
}

interface DesiredTagLocation {
  readonly field: string;
  readonly target: SurfaceTarget;
  readonly permissionSets: readonly string[];
  readonly contextSets: readonly string[];
  readonly workspaces: readonly string[];
}

interface DesiredTag {
  readonly name: string;
  readonly roles?: readonly string[];
  readonly workerHosts?: readonly string[];
  /** Absent leaves placement labels unmanaged; present replaces them. */
  readonly runsOn?: readonly string[];
  /** Absent leaves execution settings unmanaged; null clears them. */
  readonly execution?: ExecutionSettings | null;
  /** Absent leaves routes and their activations unmanaged; present is authoritative. */
  readonly locations?: readonly DesiredTagLocation[];
  /** Absent leaves Mailbox grants unmanaged; present is authoritative. */
  readonly acceptsMessagesFrom?: readonly {
    readonly tag: string;
    readonly types: readonly TagMessageType[];
  }[];
}

interface ResolvedTagLocation {
  readonly field: string;
  readonly provider: SurfaceProvider;
  readonly account: SurfaceAccount;
  readonly scope: string;
  readonly displayName: string;
  readonly permissionSets: readonly string[];
  readonly contextSets: readonly string[];
  /** Workspaces an Objective created from this location names. */
  readonly workspaces: readonly string[];
}

/** Scope fields per provider, spelled as the camelCase `--add-location` flags. */
const LOCATION_SCOPES: Readonly<Record<ConnectedSurfaceProvider, readonly (readonly string[])[]>> =
  {
    slack: [["channelId"]],
    lark: [["chatId"]],
    teams: [["teamId", "channelId"]],
    github: [["repo"], ["repoId"]],
    linear: [["team"], ["teamId"]],
  };

function parseDesiredTag(value: unknown): DesiredTag {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== "Tag" ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  )
    throw new Error("Tag resource is invalid");
  const spec = value["spec"];
  const allowed = new Set([
    "roles",
    "workerHosts",
    "runsOn",
    "execution",
    "locations",
    "acceptsMessagesFrom",
  ]);
  const unknown = Object.keys(spec).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`Tag spec contains unknown fields: ${unknown.join(", ")}`);
  const roles = optionalNameList(spec["roles"], "Tag spec.roles");
  const workerHosts = optionalNameList(spec["workerHosts"], "Tag spec.workerHosts");
  const runsOn =
    spec["runsOn"] === undefined
      ? undefined
      : parseWorkerHostLabels(spec["runsOn"], "Tag spec.runsOn");
  const execution = parseExecutionSettings(spec["execution"], "Tag spec.execution");
  const locations = spec["locations"];
  if (locations !== undefined && !Array.isArray(locations))
    throw new Error("Tag spec.locations must be an array");
  const accepts = spec["acceptsMessagesFrom"];
  if (accepts !== undefined && !Array.isArray(accepts))
    throw new Error("Tag spec.acceptsMessagesFrom must be an array");
  const grants = accepts?.map((grant: unknown, index: number) => {
    const field = `Tag spec.acceptsMessagesFrom[${index}]`;
    if (!isRecord(grant)) throw new Error(`${field} must be an object`);
    const extra = Object.keys(grant).filter((key) => key !== "tag" && key !== "types");
    if (extra.length > 0) throw new Error(`${field} contains unknown fields: ${extra.join(", ")}`);
    const types: unknown = grant["types"];
    if (
      !Array.isArray(types) ||
      types.length === 0 ||
      types.some((type) => typeof type !== "string")
    )
      throw new Error(`${field}.types must list at least one message type`);
    const unsupported = types.filter(
      (type) => !(TAG_MESSAGE_TYPES as readonly string[]).includes(type),
    );
    if (unsupported.length > 0)
      throw new Error(
        `${field}.types contains unknown message types: ${unsupported.join(", ")}. Supported types: ${TAG_MESSAGE_TYPES.join(", ")}`,
      );
    return {
      tag: requiredField(grant["tag"], `${field}.tag`),
      types: [...new Set(types as TagMessageType[])].toSorted(),
    };
  });
  if (grants && new Set(grants.map((grant) => grant.tag)).size !== grants.length)
    throw new Error("Tag spec.acceptsMessagesFrom must list each sender Tag once");
  return {
    name: requiredString(value["metadata"]["name"], "Tag metadata.name"),
    ...(roles === undefined ? {} : { roles }),
    ...(workerHosts === undefined ? {} : { workerHosts }),
    ...(runsOn === undefined ? {} : { runsOn }),
    ...(execution === undefined ? {} : { execution }),
    ...(locations === undefined
      ? {}
      : {
          locations: locations.map((location: unknown, index: number) =>
            parseTagLocation(location, index),
          ),
        }),
    ...(grants === undefined ? {} : { acceptsMessagesFrom: grants }),
  };
}

function parseTagLocation(value: unknown, index: number): DesiredTagLocation {
  const field = `Tag spec.locations[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const provider = value["provider"];
  if (typeof provider !== "string" || !Object.hasOwn(LOCATION_SCOPES, provider))
    throw new Error(`${field}.provider must be slack, github, lark, linear, or teams`);
  const alternatives = LOCATION_SCOPES[provider as ConnectedSurfaceProvider];
  const scopeFields = new Set(alternatives.flat());
  const allowed = new Set([
    "provider",
    "account",
    "permissionSets",
    "contextSets",
    "workspaces",
    ...scopeFields,
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`${field} contains fields not used by ${provider}: ${unknown.join(", ")}`);
  const present = Object.keys(value).filter((key) => scopeFields.has(key));
  const chosen = alternatives.find(
    (fields) => fields.length === present.length && fields.every((name) => present.includes(name)),
  );
  if (chosen === undefined)
    throw new Error(
      `${field} for ${provider} requires ${alternatives.map((fields) => fields.join(" and ")).join(" or ")}`,
    );
  const scope: Record<string, string> = Object.fromEntries(
    chosen.map((name) => [name, requiredField(value[name], `${field}.${name}`)]),
  );
  const account =
    value["account"] === undefined
      ? undefined
      : requiredField(value["account"], `${field}.account`);
  const common = account === undefined ? {} : { accountSelector: account };
  const text = (name: string) => scope[name] ?? "";
  let target: SurfaceTarget;
  if (provider === "slack") target = { ...common, provider, channelId: text("channelId") };
  else if (provider === "lark") target = { ...common, provider, chatId: text("chatId") };
  else if (provider === "teams")
    target = { ...common, provider, teamId: text("teamId"), channelId: text("channelId") };
  else if (provider === "github")
    target =
      scope["repoId"] === undefined
        ? { ...common, provider, repositoryName: text("repo") }
        : { ...common, provider, repositoryId: text("repoId") };
  else
    target =
      scope["teamId"] === undefined
        ? { ...common, provider: "linear", teamName: text("team") }
        : { ...common, provider: "linear", teamId: text("teamId") };
  return {
    field,
    target,
    permissionSets: optionalNameList(value["permissionSets"], `${field}.permissionSets`) ?? [],
    contextSets: optionalNameList(value["contextSets"], `${field}.contextSets`) ?? [],
    workspaces: parseWorkspaceNames(value["workspaces"], `${field}.workspaces`),
  };
}

/** Resolves locations with the surface resolver that `--add-location` uses. */
async function resolveTagLocations(
  context: Pick<ControlPlaneApiRequestContext, "store" | "credentialVault">,
  locations: readonly DesiredTagLocation[],
  accounts: readonly SurfaceAccount[],
): Promise<readonly ResolvedTagLocation[]> {
  const resolver = new SurfaceTargetResolver(context.store, context.credentialVault);
  const resolved: ResolvedTagLocation[] = [];
  for (const location of locations) {
    try {
      const target = await resolver.resolve(location.target, accounts);
      resolved.push({
        field: location.field,
        provider: location.target.provider,
        permissionSets: location.permissionSets,
        contextSets: location.contextSets,
        workspaces: location.workspaces,
        account: target.account,
        scope: target.scope,
        displayName: target.displayName,
      });
    } catch (error) {
      throw new Error(`${location.field}: ${locationErrorMessage(error)}`, { cause: error });
    }
  }
  const keys = new Set<string>();
  for (const location of resolved) {
    const key = JSON.stringify([location.account.id, location.scope]);
    if (keys.has(key))
      throw new Error(
        `${location.field} repeats ${location.provider} ${location.displayName}; list each location once`,
      );
    keys.add(key);
  }
  return resolved;
}

function locationErrorMessage(error: unknown): string {
  if (error instanceof AccountSelectionError) {
    const { provider, selector, matches } = error.selection;
    if (matches.length === 0)
      return selector === undefined
        ? `No connected ${provider} account exists. Run supertag setup surface ${provider}.`
        : `No connected ${provider} account matches account ${JSON.stringify(selector)}`;
    return `Multiple connected ${provider} accounts exist; set account to one of: ${matches.map((account) => account.externalAccountId).join(", ")}`;
  }
  if (error instanceof TargetValueError) return `${error.field} is required`;
  return error instanceof Error ? error.message : String(error);
}

/** The resolved form of the fields a manifest manages; absent fields stay absent. */
function desiredTagSpec(
  desired: DesiredTag,
  locations: readonly ResolvedTagLocation[] | undefined,
): Record<string, unknown> {
  return {
    ...(desired.roles === undefined
      ? {}
      : { roles: desired.roles.toSorted((left, right) => left.localeCompare(right)) }),
    ...(desired.workerHosts === undefined ? {} : { workerHosts: desired.workerHosts.toSorted() }),
    ...(desired.runsOn === undefined ? {} : { runsOn: desired.runsOn }),
    ...(desired.execution === undefined || desired.execution === null
      ? {}
      : { execution: desired.execution }),
    ...(locations === undefined
      ? {}
      : {
          locations: canonicalTagLocations(
            locations.map(
              (location): TagLocationSpec => ({
                provider: location.account.provider,
                account: location.account.externalAccountId,
                ...tagLocationScopeFields(location.account.provider, location.scope),
                permissionSets: location.permissionSets,
                contextSets: location.contextSets,
                workspaces: location.workspaces,
              }),
            ),
          ),
        }),
    ...(desired.acceptsMessagesFrom === undefined
      ? {}
      : { acceptsMessagesFrom: canonicalMailboxGrants(desired.acceptsMessagesFrom) }),
  };
}

/**
 * Reconciles one Tag. Every reference is checked before the first write, so a manifest that
 * names a missing Role, set, sender, or occupied location leaves the Tag untouched.
 */
async function applyDesiredTag(
  context: ControlPlaneApiRequestContext,
  desired: DesiredTag,
  locations: readonly ResolvedTagLocation[] | undefined,
): Promise<{ readonly tag: Tag; readonly created: boolean }> {
  const store = context.store;
  const existing = await store.findTagByName(desired.name);
  const roles = await Promise.all(
    (desired.roles ?? []).map(async (name) => {
      const role = await store.findRoleByName(name);
      if (role?.status !== "active") throw new Error(`Role ${name} does not exist`);
      return role;
    }),
  );
  const permissionSetIds = new Map<string, string>();
  const contextSetIds = new Map<string, string>();
  for (const location of locations ?? []) {
    for (const name of location.permissionSets) {
      const set = await store.findTagPermissionSetByName(name);
      if (!set) throw new Error(`Permission Set ${name} does not exist`);
      permissionSetIds.set(name, set.id);
    }
    for (const name of location.contextSets) {
      const set = await store.findTagContextSetByName(name);
      if (!set) throw new Error(`Context Set ${name} does not exist`);
      contextSetIds.set(name, set.id);
    }
    for (const name of location.workspaces)
      if (!(await store.findWorkspaceByName(name)))
        throw new Error(
          `${location.field}.workspaces: Workspace ${name} does not exist; apply a Workspace manifest before naming it`,
        );
    const holder = (await store.listTagRoutes({ surfaceAccountId: location.account.id })).find(
      (route) => route.scope === location.scope && route.tagId !== existing?.id,
    );
    if (holder) {
      const other = await store.findTagById(holder.tagId);
      throw new Error(
        `${location.field}: ${location.provider} ${location.displayName} already routes to Tag ${other?.name ?? holder.tagId}`,
      );
    }
  }
  const senders = new Map<string, Tag>();
  for (const grant of desired.acceptsMessagesFrom ?? []) {
    if (grant.tag === desired.name) continue;
    const sender = await store.findTagByName(grant.tag);
    if (sender?.status !== "active") throw new Error(`Tag ${grant.tag} does not exist`);
    senders.set(grant.tag, sender);
  }

  let tag = existing ?? (await store.createTag({ name: desired.name }));
  if (desired.roles !== undefined) {
    const currentAssignments = await store.listRoleAssignments({ tagId: tag.id, status: "active" });
    const desiredRoleIds = new Set(roles.map((role) => role.id));
    for (const assignment of currentAssignments)
      if (!desiredRoleIds.has(assignment.roleId))
        await store.deactivateRoleAssignment(assignment.id, assignment.revision);
    for (const role of roles) await store.assignRole({ roleId: role.id, tagId: tag.id });
  }
  // Placement labels only; they never widen which bound hosts may run the Tag's Tasks.
  if (
    desired.runsOn !== undefined &&
    JSON.stringify(parseWorkerHostLabels(desired.runsOn, "Tag spec.runsOn")) !==
      JSON.stringify(tag.runsOn)
  )
    tag = await store.setTagRunsOn(tag.id, desired.runsOn);
  if (
    desired.execution !== undefined &&
    canonicalJson(desired.execution ?? undefined) !== canonicalJson(tag.execution)
  )
    tag = await store.setTagExecution(tag.id, desired.execution ?? undefined);
  if (desired.workerHosts !== undefined) {
    const current = await store.listTagWorkerHostBindings(tag.id);
    const desiredIds = new Set(desired.workerHosts);
    for (const binding of current)
      if (!desiredIds.has(binding.workerHostId))
        await store.unbindTagWorkerHost(tag.id, binding.workerHostId);
    for (const workerHostId of desired.workerHosts)
      await store.bindTagWorkerHost(tag.id, workerHostId);
  }
  if (locations !== undefined) {
    const routeKey = (surfaceAccountId: string, scope: string) =>
      JSON.stringify([surfaceAccountId, scope]);
    const current = await store.listTagRoutes({ tagId: tag.id });
    const wanted = new Set(
      locations.map((location) => routeKey(location.account.id, location.scope)),
    );
    // Same store call as `--remove-location`: the route and its activations are deleted.
    for (const route of current)
      if (!wanted.has(routeKey(route.surfaceAccountId, route.scope)))
        await store.removeTagRoute(route.id);
    for (const location of locations) {
      const route =
        current.find(
          (candidate) =>
            routeKey(candidate.surfaceAccountId, candidate.scope) ===
            routeKey(location.account.id, location.scope),
        ) ??
        (await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: location.account.id,
          scope: location.scope,
        }));
      if (JSON.stringify(route.workspaces) !== JSON.stringify(location.workspaces))
        await store.setTagRouteWorkspaces(route.id, location.workspaces);
      const wantedPermissionSets = new Set(
        location.permissionSets.map((name) => permissionSetIds.get(name) ?? name),
      );
      const permissionActivations = await store.listTagPermissionActivations({
        tagRouteId: route.id,
      });
      for (const activation of permissionActivations)
        if (!wantedPermissionSets.has(activation.permissionSetId))
          await store.deactivateTagPermissionSet(activation.permissionSetId, route.id);
      for (const permissionSetId of wantedPermissionSets)
        if (!permissionActivations.some((item) => item.permissionSetId === permissionSetId))
          await store.activateTagPermissionSet({ permissionSetId, tagRouteId: route.id });
      const wantedContextSets = new Set(
        location.contextSets.map((name) => contextSetIds.get(name) ?? name),
      );
      const contextActivations = await store.listTagContextActivations({ tagRouteId: route.id });
      for (const activation of contextActivations)
        if (!wantedContextSets.has(activation.contextSetId))
          await store.deactivateTagContextSet(activation.contextSetId, route.id);
      for (const contextSetId of wantedContextSets)
        if (!contextActivations.some((item) => item.contextSetId === contextSetId))
          await store.activateTagContextSet({ contextSetId, tagRouteId: route.id });
    }
  }
  if (desired.acceptsMessagesFrom !== undefined) {
    // Same service call as `supertag grant mailbox`; revoking stores an empty type list.
    const mailbox = new TagMailboxService(store);
    const current = await recipientGrants(store, tag);
    const wanted = new Map(
      desired.acceptsMessagesFrom.map((grant) => [(senders.get(grant.tag) ?? tag).id, grant.types]),
    );
    for (const grant of current)
      if (!wanted.has(grant.senderTagId))
        await mailbox.setGrant({
          senderTagId: grant.senderTagId,
          recipientTagId: tag.id,
          messageTypes: [],
        });
    for (const [senderTagId, types] of wanted) {
      const prior = current.find((grant) => grant.senderTagId === senderTagId);
      if (JSON.stringify(prior?.messageTypes.toSorted() ?? []) !== JSON.stringify(types))
        await mailbox.setGrant({ senderTagId, recipientTagId: tag.id, messageTypes: types });
    }
  }
  return { tag, created: existing === undefined };
}

/** Active Mailbox grants where the Tag is the recipient. */
async function recipientGrants(
  store: Pick<Store, "listTagMessagingGrants">,
  tag: Tag,
): Promise<readonly TagMessagingGrant[]> {
  if (tag.status !== "active") return [];
  return (await store.listTagMessagingGrants(tag.id)).filter(
    (grant) => grant.recipientTagId === tag.id && grant.messageTypes.length > 0,
  );
}

async function tagOrganizationFromStore(store: Store): Promise<Omit<TagOrganization, "grants">> {
  const [permissionActivations, contextActivations, permissionSets, contextSets, tags] =
    await Promise.all([
      store.listTagPermissionActivations(),
      store.listTagContextActivations(),
      store.listTagPermissionSets(),
      store.listTagContextSets(),
      store.listTags(),
    ]);
  return {
    permissionActivations,
    contextActivations,
    permissionSetNames: new Map(permissionSets.map((set) => [set.id, set.name])),
    contextSetNames: new Map(contextSets.map((set) => [set.id, set.name])),
    tagNames: new Map(tags.map((tag) => [tag.id, tag.name])),
  };
}

function optionalNameList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error(`${field} must be a string array`);
  const names = value.map((item: string) => item.trim());
  if (new Set(names).size !== names.length) throw new Error(`${field} must not contain duplicates`);
  return names;
}

function requiredField(value: unknown, field: string): string {
  const result = stringValue(value)?.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function planWrite(
  store: Store,
  options: ManagedWriteOptions,
  input: Omit<Parameters<typeof planManagedWrite>[1], "options">,
): Promise<ManagedPlan> {
  return options.imperative
    ? Promise.resolve(planImperativeWrite(input))
    : planManagedWrite(store, { ...input, options });
}

/** Imperative writes are attributed to `cli` when the next managed write compares values. */
async function recordWrite(
  store: Store,
  plan: ManagedPlan,
  storedSpec: unknown,
  options: ManagedWriteOptions,
): Promise<void> {
  if (!options.imperative) await recordManagedWrite(store, plan, storedSpec, options);
}

/**
 * Answers a dry run with the merged spec and its plan, or refuses a conflicting write. Returns
 * true when the response is complete.
 */
function respondWithoutWriting(
  context: ControlPlaneApiRequestContext,
  body: unknown,
  plan: ManagedPlan,
  options: ManagedWriteOptions,
): boolean {
  if (options.dryRun) {
    writeJson(context.response, 200, {
      ...dryRunResource(body),
      spec: plan.spec,
      plan: planReport(plan),
    });
    return true;
  }
  if (plan.merge.conflicts.length === 0) return false;
  writeStatusError(context.response, 409, "Conflict", conflictMessage(plan), {
    conflicts: plan.merge.conflicts,
  });
  return true;
}

function manifestSpec(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord(body["spec"]) ? body["spec"] : {};
}

function permissionSetManifestSpec(
  set: TagPermissionSet,
  permissions: readonly TagPermission[],
): Record<string, unknown> {
  return {
    ...(set.approvers?.length ? { approvers: [...set.approvers] } : {}),
    permissions: permissions.map(
      (permission): DesiredPermission =>
        permission.target === "runtime"
          ? {
              target: "runtime",
              action: permission.action,
              ...(permission.approval ? { approval: permission.approval } : {}),
            }
          : permission.target === "mcp"
            ? {
                target: "mcp",
                action: permission.action,
                ...(permission.resource ? { resource: permission.resource } : {}),
                ...(permission.approval ? { approval: permission.approval } : {}),
              }
            : {
                target: "surface",
                surfaceAccountId: permission.surfaceAccountId,
                scope: permission.scope,
                action: permission.action,
                ...(permission.reference ? { reference: permission.reference } : {}),
                ...(permission.approval ? { approval: permission.approval } : {}),
              },
    ),
  };
}

function contextSetManifestSpec(items: readonly TagContextItem[]): Record<string, unknown> {
  return { items: items.map(contextItemValue) };
}

/** A validated manifest echoed without writes, for `supertag diff` and pre-apply validation. */
function dryRunResource(value: unknown): {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: { readonly name: string };
  readonly spec: unknown;
} {
  const resource = isRecord(value) ? value : {};
  const metadata = isRecord(resource["metadata"]) ? resource["metadata"] : {};
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: String(resource["kind"]),
    metadata: { name: requiredField(metadata["name"], "metadata.name") },
    spec: resource["spec"],
  };
}

type DesiredPermission = AddTagPermissionInput extends infer Permission
  ? Permission extends AddTagPermissionInput
    ? Omit<Permission, "permissionSetId">
    : never
  : never;
type DesiredContextItem = Omit<AddTagContextItemInput, "contextSetId" | "createdBy">;

function parseDesiredPermissionSet(value: unknown): {
  readonly name: string;
  readonly approvers: readonly string[];
  readonly permissions: readonly DesiredPermission[];
} {
  const resource = parseNamedDesiredResource(value, "PermissionSet");
  const permissions = resource.spec["permissions"];
  if (!Array.isArray(permissions))
    throw new Error("PermissionSet spec.permissions must be an array");
  let approvers: string[];
  try {
    approvers = normalizeApprovers(resource.spec["approvers"]);
  } catch (error) {
    throw new Error(`PermissionSet spec.${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    name: resource.name,
    approvers,
    permissions: permissions.map((permission) => {
      if (!isRecord(permission)) throw new Error("PermissionSet permission must be an object");
      const target = requiredString(permission["target"], "target");
      const action = requiredString(permission["action"], "action");
      const approvalValue = permission["approval"];
      if (approvalValue !== undefined && approvalValue !== "required")
        throw new Error("PermissionSet permission approval must be required when present");
      const approval = approvalValue === "required" ? { approval: "required" as const } : {};
      if (target === "runtime") return { target, action, ...approval };
      if (target === "mcp") {
        const unknown = Object.keys(permission).filter(
          (key) => !["target", "action", "resource", "approval"].includes(key),
        );
        if (unknown.length > 0)
          throw new Error(
            `PermissionSet mcp permission ${action} does not take ${unknown.join(", ")}; use target, action, resource, and approval`,
          );
        parseMcpGrantAction(action);
        const rawResource = permission["resource"];
        if (rawResource !== undefined && typeof rawResource !== "string")
          throw new Error(`PermissionSet mcp permission ${action} resource must be a string`);
        const resource = rawResource?.trim();
        if (resource) parseMcpGrantResource(resource);
        return { target, action, ...(resource ? { resource } : {}), ...approval };
      }
      if (target !== "surface") {
        throw new Error("PermissionSet permission target must be surface, runtime, or mcp");
      }
      const reference = stringValue(permission["reference"])?.trim();
      return {
        target,
        surfaceAccountId: requiredString(permission["surfaceAccountId"], "surfaceAccountId"),
        scope: requiredString(permission["scope"], "scope"),
        action,
        ...(reference ? { reference } : {}),
        ...approval,
      };
    }),
  };
}

function parseDesiredContextSet(value: unknown): {
  readonly name: string;
  readonly items: readonly DesiredContextItem[];
} {
  const resource = parseNamedDesiredResource(value, "ContextSet");
  const items = resource.spec["items"];
  if (!Array.isArray(items)) throw new Error("ContextSet spec.items must be an array");
  return {
    name: resource.name,
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("ContextSet item must be an object");
      const version = item["version"];
      const required = item["required"];
      const config = item["config"];
      if (!Number.isInteger(version) || Number(version) < 1)
        throw new Error("ContextSet item version must be a positive integer");
      if (typeof required !== "boolean")
        throw new Error("ContextSet item required must be boolean");
      if (!isRecord(config)) throw new Error("ContextSet item config must be an object");
      return {
        itemKey: requiredString(item["itemKey"], "itemKey"),
        type: requiredString(item["type"], "type"),
        version: Number(version),
        required,
        config,
      };
    }),
  };
}

interface DesiredRole {
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  readonly contextSets: readonly string[];
  readonly permissionSets: readonly string[];
  /** Absent leaves execution settings to whichever manager set them. */
  readonly execution?: ExecutionSettings;
}

function parseWorkerHostEnrollment(value: unknown): {
  readonly id: string;
} {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== "WorkerHostEnrollment" ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  ) {
    throw new Error("WorkerHostEnrollment resource is invalid");
  }
  const unknownTopLevel = Object.keys(value).filter(
    (key) => !["apiVersion", "kind", "metadata", "spec"].includes(key),
  );
  if (unknownTopLevel.length > 0) {
    throw new Error(`WorkerHostEnrollment contains unknown fields: ${unknownTopLevel.join(", ")}`);
  }
  const unknownMetadata = Object.keys(value["metadata"]).filter((key) => key !== "id");
  if (unknownMetadata.length > 0) {
    throw new Error(
      `WorkerHostEnrollment metadata contains unknown fields: ${unknownMetadata.join(", ")}`,
    );
  }
  if (Object.keys(value["spec"]).length > 0) {
    throw new Error("WorkerHostEnrollment spec must be empty");
  }
  const id = requiredString(value["metadata"]["id"], "WorkerHostEnrollment metadata.id");
  return { id };
}

/**
 * Redeems the Auth Key in the Authorization header: enrolls a new Worker Host, binds the key's
 * Tags, and returns the host's credential once.
 */
async function handleWorkerHostJoin(context: ControlPlaneApiRequestContext): Promise<void> {
  const authorization = header(context.request, "authorization");
  const secret = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!secret) {
    writeStatusError(context.response, 401, "Unauthorized", "An Auth Key is required to join");
    return;
  }
  let name: string;
  try {
    name = parseWorkerHostJoin(await readJsonBody(context.request));
  } catch (error) {
    writeStatusError(context.response, 400, "Invalid", errorText(error));
    return;
  }
  try {
    const joined = await context.controlPlane.redeemAuthKey(secret, name);
    const tagNames = await tagNamesById(context.store);
    writeOneTimeCredential(context.response, 201, {
      ...workerHostCredentialIssuance(
        joined.workerHost.id,
        joined.token,
        joined.workerHost.updatedAt,
      ),
      status: {
        authKey: joined.authKey.name,
        tags: joined.authKey.tagIds.map((id) => tagNames.get(id) ?? id),
        ephemeral: joined.workerHost.ephemeral,
      },
    });
  } catch (error) {
    if (error instanceof AuthKeyRedemptionError || error instanceof TagMessagingError) {
      writeStatusError(
        context.response,
        error.statusCode,
        error instanceof AuthKeyRedemptionError ? authKeyFailureReason(error.reason) : "Invalid",
        error.message,
      );
      return;
    }
    throw error;
  }
}

function authKeyFailureReason(reason: AuthKeyRedemptionError["reason"]): string {
  if (reason === "invalid") return "Unauthorized";
  if (reason === "tag-missing") return "Conflict";
  return "Forbidden";
}

/** A Worker Host may revoke its own credential with that credential. */
async function handleWorkerHostSelfRevocation(
  context: ControlPlaneApiRequestContext,
  url: URL,
): Promise<boolean> {
  if (context.request.method !== "DELETE") return false;
  const match = /^\/api\/v1\/worker-hosts\/([^/]+)\/credential$/u.exec(url.pathname);
  const authorization = header(context.request, "authorization");
  if (match?.[1] === undefined || !authorization?.startsWith("Bearer ")) return false;
  const id = decodeURIComponent(match[1]);
  const host = await context.controlPlane.authenticateWorkerHostCredential(
    id,
    authorization.slice("Bearer ".length),
  );
  if (host === undefined) return false;
  await context.controlPlane.revokeWorkerHostCredential(host.id, "SelfRevoked");
  context.response.writeHead(204);
  context.response.end();
  return true;
}

/**
 * A Worker Host may drain or resume itself with its own credential, as `supertag up` and
 * `supertag down` do before restarting or stopping a host service.
 */
async function handleWorkerHostSelfDrain(
  context: ControlPlaneApiRequestContext,
  url: URL,
): Promise<boolean> {
  if (context.request.method !== "POST") return false;
  const match = /^\/api\/v1\/worker-hosts\/([^/]+)\/(drain|resume)$/u.exec(url.pathname);
  const authorization = header(context.request, "authorization");
  if (match?.[1] === undefined || !authorization?.startsWith("Bearer ")) return false;
  const host = await context.controlPlane.authenticateWorkerHostCredential(
    decodeURIComponent(match[1]),
    authorization.slice("Bearer ".length),
  );
  if (host === undefined) return false;
  await context.controlPlane.setWorkerHostDraining(host.id, match[2] === "drain");
  const workerHost = (await context.controlPlane.listWorkerHosts()).find(
    (candidate) => candidate.id === host.id,
  );
  if (workerHost === undefined) {
    writeStatusError(context.response, 404, "NotFound", "Worker Host does not exist");
    return true;
  }
  writeJson(context.response, 200, workerHostResource(workerHost));
  return true;
}

function parseWorkerHostJoin(value: unknown): string {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== "WorkerHostJoin" ||
    !isRecord(value["metadata"]) ||
    (value["spec"] !== undefined && !isRecord(value["spec"]))
  )
    throw new Error("WorkerHostJoin resource is invalid");
  if (Object.keys(value["metadata"]).some((key) => key !== "name"))
    throw new Error("WorkerHostJoin metadata accepts only name");
  if (isRecord(value["spec"]) && Object.keys(value["spec"]).length > 0)
    throw new Error("WorkerHostJoin spec must be empty; the Auth Key decides Tags");
  return parseWorkerHostName(value["metadata"]["name"]);
}

function parseAuthKeyRequest(value: unknown): {
  readonly name: string;
  readonly tags: readonly string[];
  readonly labels: readonly string[];
  readonly reusable: boolean;
  readonly ephemeral: boolean;
} {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== "AuthKey" ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  )
    throw new Error("AuthKey resource is invalid");
  const unknown = Object.keys(value["spec"]).filter(
    (key) => !["tags", "labels", "reusable", "ephemeral"].includes(key),
  );
  if (unknown.length > 0)
    throw new Error(`AuthKey spec contains unknown fields: ${unknown.join(", ")}`);
  const tags = value["spec"]["tags"];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
    throw new Error("AuthKey spec.tags must be an array of Tag names");
  for (const flag of ["reusable", "ephemeral"])
    if (value["spec"][flag] !== undefined && typeof value["spec"][flag] !== "boolean")
      throw new Error(`AuthKey spec.${flag} must be a boolean`);
  return {
    name: parseAuthKeyName(value["metadata"]["name"]),
    tags,
    labels: parseWorkerHostLabels(value["spec"]["labels"] ?? [], "AuthKey spec.labels"),
    reusable: value["spec"]["reusable"] === true,
    ephemeral: value["spec"]["ephemeral"] === true,
  };
}

async function tagNamesById(store: Store): Promise<ReadonlyMap<string, string>> {
  return new Map((await store.listTags({ includeRetired: true })).map((tag) => [tag.id, tag.name]));
}

async function authKeyResourceFromStore(store: Store, key: AuthKey) {
  return authKeyResource(key, await tagNamesById(store));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDesiredRole(value: unknown): DesiredRole {
  const resource = parseNamedDesiredResource(value, "Role");
  const allowed = new Set([
    "purpose",
    "instructions",
    "contextSets",
    "permissionSets",
    "execution",
  ]);
  const unknown = Object.keys(resource.spec).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`Role spec contains unknown fields: ${unknown.join(", ")}`);
  const execution = parseExecutionSettings(resource.spec["execution"], "Role spec.execution");
  const strings = (key: "contextSets" | "permissionSets"): readonly string[] => {
    const values = resource.spec[key] ?? [];
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim()))
      throw new Error(`Role spec.${key} must be a string array`);
    if (new Set(values).size !== values.length)
      throw new Error(`Role spec.${key} must not contain duplicates`);
    return values.map((item) => item.trim());
  };
  const purpose = requiredString(resource.spec["purpose"], "Role spec.purpose");
  const instructions = stringValue(resource.spec["instructions"] ?? "");
  if (instructions === undefined) throw new Error("Role spec.instructions must be text");
  const contextSets = strings("contextSets");
  const permissionSets = strings("permissionSets");
  return {
    name: resource.name,
    purpose,
    instructions,
    contextSets,
    permissionSets,
    ...(execution === undefined ? {} : { execution }),
  };
}

/** Validates a Volume manifest; its spec must name a source. */
function parseDesiredVolume(value: unknown): ApplyVolumeInput {
  const resource = parseNamedDesiredResource(value, "Volume");
  try {
    return {
      name: parseVolumeName(resource.name, "Volume metadata.name"),
      ...parseVolumeSpec(resource.spec),
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

/** Validates a Workspace manifest; an omitted spec takes every default. */
function parseDesiredWorkspace(value: unknown): ApplyWorkspaceInput {
  const resource = parseNamedDesiredResource(
    isRecord(value) && value["spec"] === undefined ? { ...value, spec: {} } : value,
    "Workspace",
  );
  try {
    return {
      name: parseWorkspaceName(resource.name, "Workspace metadata.name"),
      ...parseWorkspaceSpec(resource.spec),
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function withoutName({ name: _name, ...spec }: ApplyWorkspaceInput) {
  return spec;
}

function parseNamedDesiredResource(
  value: unknown,
  kind: "ContextSet" | "PermissionSet" | "Role" | "Volume" | "Workspace",
): { readonly name: string; readonly spec: Record<string, unknown> } {
  if (
    !isRecord(value) ||
    value["apiVersion"] !== CONTROL_PLANE_API_VERSION ||
    value["kind"] !== kind ||
    !isRecord(value["metadata"]) ||
    !isRecord(value["spec"])
  ) {
    throw new Error(`${kind} resource is invalid`);
  }
  return {
    name: requiredString(value["metadata"]["name"], `${kind} metadata.name`),
    spec: value["spec"],
  };
}

async function roleResourceFromStore(store: Store, role: Role) {
  const [assignments, contextSets, permissionSets, tags] = await Promise.all([
    store.listRoleAssignments({ roleId: role.id }),
    store.listTagContextSets(),
    store.listTagPermissionSets(),
    store.listTags(),
  ]);
  return roleResource(role, assignments, {
    contextSets: new Map(contextSets.map((set) => [set.id, set.name])),
    permissionSets: new Map(permissionSets.map((set) => [set.id, set.name])),
    tags: new Map(tags.map((tag) => [tag.id, tag.name])),
  });
}

async function tagResourceFromStore(store: Store, tag: Tag) {
  const [routes, assignments, bindings, roles, accounts, organization, grants] = await Promise.all([
    store.listTagRoutes({ tagId: tag.id }),
    store.listRoleAssignments({ tagId: tag.id }),
    store.listTagWorkerHostBindings(tag.id),
    store.listRoles(),
    store.listSurfaceAccounts(),
    tagOrganizationFromStore(store),
    recipientGrants(store, tag),
  ]);
  return tagResource(
    tag,
    routes,
    assignments,
    bindings.map((binding) => binding.workerHostId),
    new Map(roles.map((role) => [role.id, role.name])),
    new Map(accounts.map((account) => [account.id, account])),
    { ...organization, grants },
    new Map(roles.map((role) => [role.id, role])),
  );
}

function permissionKey(permission: DesiredPermission | TagPermission): string {
  if (permission.target === "runtime")
    return JSON.stringify([permission.target, permission.action]);
  if (permission.target === "mcp")
    return JSON.stringify([permission.target, permission.action, permission.resource ?? null]);
  return JSON.stringify([
    permission.target,
    permission.surfaceAccountId,
    permission.scope,
    permission.reference ?? null,
    permission.action,
  ]);
}

function contextItemValue(item: TagContextItem): DesiredContextItem {
  return {
    itemKey: item.itemKey,
    type: item.type,
    version: item.version,
    required: item.required,
    config: item.config,
  };
}

async function handleOperatorTokenRequest(
  context: ControlPlaneApiRequestContext,
  url: URL,
): Promise<void> {
  if (context.request.method === "POST" && url.pathname === "/api/v1/operator-tokens") {
    let name: string;
    try {
      name = parseOperatorTokenRequest(await readJsonBody(context.request));
    } catch (error) {
      writeStatusError(context.response, 400, "Invalid", errorText(error));
      return;
    }
    let issued: Awaited<ReturnType<ControlPlane["createOperatorToken"]>>;
    try {
      issued = await context.controlPlane.createOperatorToken({ name });
    } catch (error) {
      if (error instanceof TagMessagingError) {
        writeStatusError(
          context.response,
          error.statusCode,
          error.statusCode === 409 ? "AlreadyExists" : "Invalid",
          error.message,
        );
        return;
      }
      throw error;
    }
    writeOneTimeCredential(context.response, 201, {
      ...operatorTokenResource(issued.operatorToken),
      secret: issued.secret,
    });
    return;
  }
  if (context.request.method === "GET" && url.pathname === "/api/v1/operator-tokens") {
    const tokens = await context.controlPlane.listOperatorTokens();
    writeJson(context.response, 200, resourceList(tokens.map(operatorTokenResource)));
    return;
  }
  const match = /^\/api\/v1\/operator-tokens\/([^/]+?)(\/revoke)?$/u.exec(url.pathname);
  if (
    match?.[1] !== undefined &&
    ((context.request.method === "GET" && match[2] === undefined) ||
      (context.request.method === "POST" && match[2] === "/revoke"))
  ) {
    const name = decodeURIComponent(match[1]);
    const token =
      context.request.method === "POST"
        ? await context.controlPlane.revokeOperatorToken(name)
        : await context.controlPlane.findOperatorToken(name);
    if (token === undefined) {
      writeStatusError(context.response, 404, "NotFound", `Operator Token ${name} does not exist`);
      return;
    }
    writeJson(context.response, 200, operatorTokenResource(token));
    return;
  }
  writeJson(context.response, 404, { error: "not_found" });
}

function parseOperatorTokenRequest(value: unknown): string {
  if (!isRecord(value) || value["kind"] !== "OperatorToken")
    throw new Error("Expected an OperatorToken resource");
  const metadata = value["metadata"];
  if (!isRecord(metadata)) throw new Error("OperatorToken metadata.name is required");
  return parseOperatorTokenName(metadata["name"]);
}

/** Each write request's audit note, so body parsing can name its target. */
const auditNotes = new WeakMap<IncomingMessage, AuditNote>();

/**
 * Records who changed what. Every authenticated management write, such as an apply, a delete, an
 * Auth Key, an approval decision, or an Objective message, becomes one audit entry in the database
 * and in the configured sink once its response ends. Reads are not recorded.
 */
function auditManagementRequest(
  context: ControlPlaneApiRequestContext,
  url: URL,
  actor: string,
): AuditNote | undefined {
  const method = context.request.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return undefined;
  const note = classifyManagementRequest(method, url);
  auditNotes.set(context.request, note);
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    // Recording never fails the request it describes, and never throws out of this listener.
    try {
      const status = context.response.statusCode;
      const succeeded = context.response.writableFinished && status < 400;
      // A name the caller supplied is kept only once a real change succeeded, so it names a real
      // resource. A failed request or a dry run keeps only the kind, since its name might hold a
      // credential.
      const confirmed = succeeded && !note.action.endsWith(".dry-run");
      void context.auditTrail.record({
        at: new Date().toISOString(),
        actor,
        action: note.action,
        target: confirmed ? note.target : auditTargetKind(note.target),
        outcome: succeeded ? "succeeded" : "failed",
        status,
        source: "api",
        method,
        // The route template, never the request's own path, which the caller chose.
        ...(note.route === undefined ? {} : { path: note.route }),
      });
    } catch {
      // The trail reports its own failures; there is nothing more to do here.
    }
  };
  context.response.once("finish", record);
  context.response.once("close", record);
  return note;
}

/** The kind part of an audit target, such as `Tag` from `Tag/reviewer`. */
function auditTargetKind(target: string): string {
  const slash = target.indexOf("/");
  return slash === -1 ? target : target.slice(0, slash);
}

/** `GET /api/v1/audit`: recorded changes, newest first. */
async function handleAuditRead(context: ControlPlaneApiRequestContext, url: URL): Promise<void> {
  const allowed = new Set(["since", "actor", "limit"]);
  let query: ReturnType<typeof parseAuditQuery>;
  try {
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key)) throw new RangeError(`Unknown audit query parameter: ${key}`);
      if (url.searchParams.getAll(key).length !== 1)
        throw new RangeError(`Give the ${key} query parameter once`);
    }
    const value = (key: string) => url.searchParams.get(key) ?? undefined;
    query = parseAuditQuery({
      since: value("since"),
      actor: value("actor"),
      limit: value("limit"),
    });
  } catch (error) {
    writeStatusError(context.response, 400, "Invalid", errorText(error));
    return;
  }
  // Changes this Control Plane already answered are visible to the next read.
  await context.auditTrail.settled();
  writeJson(context.response, 200, {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "AuditEntryList",
    metadata: { limit: query.limit },
    items: await context.store.listAuditEntries(query),
  });
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = header(request, "authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

function hasBearerToken(request: IncomingMessage, expected: string): boolean {
  const authorization = header(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const actualDigest = createHash("sha256").update(authorization.slice("Bearer ".length)).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * Who sent an operator request. `break-glass` holds the admin token and may do anything.
 * `operator-token` holds an Operator Token: everything except managing Operator Tokens, attributed
 * to `token:NAME`. `coordination` holds a static scoped credential limited to the coordination API.
 */
type OperatorAuthentication =
  | { readonly kind: "break-glass"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "operator-token"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "coordination"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "refused"; readonly message: string };

async function authenticateOperator(
  context: Pick<
    ControlPlaneApiRequestContext,
    "request" | "adminToken" | "coordinationOperatorCredentials" | "controlPlane"
  >,
): Promise<OperatorAuthentication | undefined> {
  if (context.adminToken !== undefined && hasBearerToken(context.request, context.adminToken))
    return { kind: "break-glass", principal: CONTROL_PLANE_BREAK_GLASS_PRINCIPAL };
  const bearer = bearerToken(context.request);
  if (bearer?.startsWith(OPERATOR_TOKEN_PREFIX)) {
    const result = await context.controlPlane.authenticateOperatorToken(bearer);
    if (result.status === "authenticated")
      return {
        kind: "operator-token",
        principal: {
          operatorId: operatorTokenOperatorId(result.operatorToken.name),
          scopes: { actions: ["*"] },
        },
      };
    // Only a holder of the full secret learns that it was revoked or expired.
    if (result.status === "revoked")
      return {
        kind: "refused",
        message: "This Operator Token was revoked; ask an admin for a new one",
      };
    if (result.status === "expired")
      return {
        kind: "refused",
        message: "This Operator Token has expired; ask an admin for a new one",
      };
    // An unknown stop_ value may still be a static coordination credential.
  }
  for (const credential of context.coordinationOperatorCredentials) {
    if (!hasBearerToken(context.request, credential.token)) continue;
    if (credential.revoked === true) return undefined;
    return {
      kind: "coordination",
      principal: {
        operatorId: credential.operatorId,
        scopes: {
          actions: credential.actions,
          ...(credential.objectiveIds === undefined
            ? {}
            : { objectiveIds: credential.objectiveIds }),
          ...(credential.teamIds === undefined ? {} : { teamIds: credential.teamIds }),
        },
      },
    };
  }
  return undefined;
}

export function validateCoordinationOperatorCredentials(
  credentials: readonly ControlPlaneOperatorCredential[],
  adminToken: string | undefined,
): readonly ControlPlaneOperatorCredential[] {
  const tokens = new Set(adminToken === undefined ? [] : [tokenDigest(adminToken)]);
  return credentials.map((credential) => {
    if (!credential.token.trim()) throw new Error("Coordination operator token must not be empty");
    if (!/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,199}$/u.test(credential.operatorId))
      throw new Error("Coordination operator ID contains unsupported characters");
    if (
      credential.actions.length === 0 ||
      credential.actions.some((action) => action !== "*" && !/^[a-z][a-z0-9_]{0,99}$/u.test(action))
    )
      throw new Error("Coordination operator actions must be non-empty command names");
    for (const [name, values] of [
      ["Objective", credential.objectiveIds],
      ["Team", credential.teamIds],
    ] as const) {
      if (values?.some((value) => !value.trim() || value.length > 200))
        throw new Error(`Coordination operator ${name} scope contains an invalid ID`);
      if (values && new Set(values).size !== values.length)
        throw new Error(`Coordination operator ${name} scope contains duplicate IDs`);
    }
    const digest = tokenDigest(credential.token);
    if (tokens.has(digest)) throw new Error("Coordination operator tokens must be unique");
    tokens.add(digest);
    return {
      ...credential,
      actions: [...new Set(credential.actions)],
      ...(credential.objectiveIds === undefined
        ? {}
        : { objectiveIds: [...credential.objectiveIds] }),
      ...(credential.teamIds === undefined ? {} : { teamIds: [...credential.teamIds] }),
    };
  });
}

export async function environmentCoordinationOperatorCredentials(
  path = process.env["SUPERTAG_COORDINATION_OPERATORS_FILE"]?.trim(),
): Promise<readonly ControlPlaneOperatorCredential[]> {
  if (!path) return [];
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read coordination operator credentials from ${path}`, {
      cause: error,
    });
  }
  if (!Array.isArray(value))
    throw new Error("Coordination operator credentials file must contain a JSON array");
  return value.map((item, index) => parseCoordinationOperatorCredential(item, index));
}

function parseCoordinationOperatorCredential(
  value: unknown,
  index: number,
): ControlPlaneOperatorCredential {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Coordination operator credential ${index} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(["token", "operatorId", "actions", "objectiveIds", "teamIds", "revoked"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(
      `Coordination operator credential ${index} has unknown fields: ${unknown.join(", ")}`,
    );
  if (typeof record["token"] !== "string" || typeof record["operatorId"] !== "string")
    throw new Error(`Coordination operator credential ${index} requires token and operatorId`);
  const strings = (name: "actions" | "objectiveIds" | "teamIds", optional = false) => {
    const current = record[name];
    if (current === undefined && optional) return undefined;
    if (!Array.isArray(current) || current.some((item) => typeof item !== "string"))
      throw new Error(`Coordination operator credential ${index} ${name} must be a string array`);
    return current as string[];
  };
  if (record["revoked"] !== undefined && typeof record["revoked"] !== "boolean")
    throw new Error(`Coordination operator credential ${index} revoked must be a boolean`);
  const actions = strings("actions") ?? [];
  const objectiveIds = strings("objectiveIds", true);
  const teamIds = strings("teamIds", true);
  return {
    token: record["token"],
    operatorId: record["operatorId"],
    actions,
    ...(objectiveIds === undefined ? {} : { objectiveIds }),
    ...(teamIds === undefined ? {} : { teamIds }),
    ...(record["revoked"] === undefined ? {} : { revoked: record["revoked"] }),
  };
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const DELETABLE_PATHS = {
  "surface-accounts": "SurfaceAccount",
  tags: "Tag",
  roles: "Role",
  "permission-sets": "PermissionSet",
  "context-sets": "ContextSet",
  volumes: "Volume",
  workspaces: "Workspace",
} as const satisfies Record<string, ManagedResourceKind>;

const DELETABLE_LABELS: Readonly<Record<ManagedResourceKind, string>> = {
  SurfaceAccount: "Surface Account",
  Tag: "Tag",
  Role: "Role",
  PermissionSet: "Permission Set",
  ContextSet: "Context Set",
  Volume: "Volume",
  Workspace: "Workspace",
  Objective: "Objective",
};

/**
 * Declarative Surface Accounts. The body is a SurfaceAccount manifest whose secrets are
 * references. A dry run plans the non-secret fields; when it also carries `credentials`, the
 * resolved values, it reports whether they match what the credential vault holds, without
 * storing or returning them. A write carries `verified`, the account the CLI verified with the
 * provider, and stores it exactly as `supertag setup surface` does. A write without `verified`
 * only records field ownership and set membership, and is refused if anything would change.
 */
async function applySurfaceAccountManifest(
  context: ControlPlaneApiRequestContext,
  url: URL,
): Promise<void> {
  const options = managedWriteOptions(url);
  const body = await readJsonBody(context.request);
  const manifest = parseSurfaceAccountManifest(body);
  const extra = isRecord(body)
    ? Object.keys(body).filter(
        (key) =>
          !["apiVersion", "kind", "metadata", "spec", "credentials", "verified"].includes(key),
      )
    : [];
  if (extra.length > 0) throw new Error(`SurfaceAccount request has unknown fields: ${extra}`);
  const existing = await context.store.findSurfaceAccountByName(manifest.name);
  const plan = await planWrite(context.store, options, {
    kind: "SurfaceAccount",
    name: manifest.name,
    currentSpec: existing ? storedSurfaceAccountSpec(existing) : undefined,
    desiredSpec: surfaceManifestSpec(manifest),
  });
  const refusals =
    existing !== undefined && existing.provider !== manifest.provider
      ? [
          {
            path: "spec.provider",
            reason: `${manifest.name} is a ${existing.provider} account. Delete it, then apply the ${manifest.provider} account under a new name`,
          },
        ]
      : [];
  if (options.dryRun) {
    const credentials = isRecord(body) ? body["credentials"] : undefined;
    let secrets: "changed" | "unchanged" | undefined;
    if (credentials !== undefined) {
      if (!isStringRecord(credentials))
        throw new Error("SurfaceAccount credentials must map secret names to text");
      secrets =
        existing !== undefined &&
        sameCredential(await context.credentialVault.resolve(existing.credentialId), credentials)
          ? "unchanged"
          : "changed";
    }
    writeJson(context.response, 200, {
      ...dryRunResource(body),
      spec: plan.spec,
      plan: {
        ...planReport(plan),
        refusals,
        ...(secrets === undefined ? {} : { secrets }),
      },
      ...(existing === undefined
        ? {}
        : {
            current: {
              provider: existing.provider,
              externalAccountId: existing.externalAccountId,
            },
          }),
    });
    return;
  }
  if (refusals.length > 0) {
    writeStatusError(
      context.response,
      409,
      "Conflict",
      `SurfaceAccount ${manifest.name}: ${refusals.map((refusal) => refusal.reason).join("; ")}`,
    );
    return;
  }
  if (respondWithoutWriting(context, body, plan, options)) return;
  const verifiedValue = isRecord(body) ? body["verified"] : undefined;
  if (verifiedValue === undefined) {
    if (existing === undefined || plan.merge.changes.length > 0)
      throw new Error(
        `SurfaceAccount ${manifest.name} changes require credentials verified with the provider; apply it with supertag apply`,
      );
    await recordWrite(context.store, plan, storedSurfaceAccountSpec(existing), options);
    writeJson(context.response, 200, surfaceAccountResource(existing));
    return;
  }
  const verified = parseVerifiedSurfaceAccount(verifiedValue);
  if (verified.provider !== manifest.provider)
    throw new Error(
      `SurfaceAccount ${manifest.name} declares ${manifest.provider}, but its credentials are for ${verified.provider}`,
    );
  const expectedKeys = Object.keys(manifest.secrets).toSorted().join(",");
  if (Object.keys(verified.secrets).toSorted().join(",") !== expectedKeys)
    throw new Error(
      `SurfaceAccount ${manifest.name} credentials must hold exactly ${expectedKeys.replaceAll(",", ", ")}`,
    );
  if (existing !== undefined && existing.externalAccountId !== verified.externalAccountId) {
    writeStatusError(
      context.response,
      409,
      "Conflict",
      `SurfaceAccount ${manifest.name} is ${existing.provider} account ${existing.externalAccountId}, but its credentials belong to ${verified.externalAccountId}. Delete it, then apply the other account under a new name`,
    );
    return;
  }
  const holder = await context.store.findSurfaceAccount(
    verified.provider,
    verified.externalAccountId,
  );
  if (holder?.name !== undefined && holder.name !== manifest.name) {
    writeStatusError(
      context.response,
      409,
      "Conflict",
      `${verified.provider} account ${verified.externalAccountId} is already declared as SurfaceAccount ${holder.name}`,
    );
    return;
  }
  const merged = plan.spec as Partial<SurfaceAccountManifestSpec>;
  const account = await context.controlPlane.setupSurfaceAccount(
    {
      ...verified,
      displayName:
        typeof merged.displayName === "string" ? merged.displayName : verified.displayName,
    },
    { name: manifest.name, secretReferences: merged.secrets ?? manifest.secrets },
  );
  await recordWrite(context.store, plan, storedSurfaceAccountSpec(account), options);
  writeJson(context.response, existing === undefined ? 201 : 200, surfaceAccountResource(account));
}

/** One message in an operator's CLI conversation with a Tag, and the Tag's reply once recorded. */
interface TagMessageRecord {
  readonly apiVersion: typeof CONTROL_PLANE_API_VERSION;
  readonly kind: "TagMessage";
  readonly tag: string;
  readonly session: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** The running Task this message was delivered into, when it joined one instead of starting. */
  readonly joinedTaskId?: string;
  readonly status: "waiting" | "replied";
  /** The Tag's final reply: its result, or the error that ended the Task. */
  readonly reply?: { readonly presentation: string; readonly text: string };
}

const TAG_CONVERSATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * `POST /api/v1/tags/NAME/messages` sends one message in the operator's CLI conversation;
 * `GET /api/v1/tags/NAME/messages/TASK_ID` reads it back with the reply once there is one, and
 * `GET /api/v1/tags/NAME/messages/TASK_ID/stream` follows the reply as it is written.
 * A conversation is private: only the operator who sent the message reads it here.
 */
async function handleTagMessage(
  context: ControlPlaneApiRequestContext,
  tagName: string,
  taskId: string | undefined,
  operatorId: string,
  streamUrl?: URL,
): Promise<void> {
  const method = taskId === undefined ? "POST" : "GET";
  if (context.request.method !== method) {
    writeStatusError(context.response, 405, "MethodNotAllowed", `Use ${method} for this path`);
    return;
  }
  const tag = await context.store.findTagByName(tagName);
  if (tag === undefined) {
    writeStatusError(context.response, 404, "NotFound", `Tag ${tagName} does not exist`);
    return;
  }
  const prefix = `cli:${operatorId}:`;
  if (taskId === undefined) {
    const body = await readJsonBody(context.request);
    const text = isRecord(body) && typeof body["text"] === "string" ? body["text"].trim() : "";
    const session = isRecord(body) && body["session"] !== undefined ? body["session"] : "default";
    if (!text) {
      writeStatusError(context.response, 400, "BadRequest", "The message is empty");
      return;
    }
    if (typeof session !== "string" || !TAG_CONVERSATION_NAME.test(session)) {
      writeStatusError(
        context.response,
        400,
        "BadRequest",
        "A session name is 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
      );
      return;
    }
    if (!context.controlPlane.isAccepting) {
      writeJson(context.response, 503, { error: "control_plane_draining" });
      return;
    }
    const result = await context.controlPlane.messageTag({
      tagName: tag.name,
      operatorId,
      session,
      text,
    });
    if (result.taskId === undefined) {
      writeStatusError(
        context.response,
        409,
        "Conflict",
        result.reason ?? `Tag ${tag.name} did not accept the message`,
      );
      return;
    }
    taskId = result.taskId;
  }
  const task = await context.store.findTaskById(taskId);
  const origin = isRecord(task?.trigger["origin"]) ? task.trigger["origin"] : undefined;
  const sessionKey = typeof origin?.["sessionKey"] === "string" ? origin["sessionKey"] : "";
  if (task === undefined || task.tagId !== tag.id || !sessionKey.startsWith(prefix)) {
    writeStatusError(
      context.response,
      404,
      "NotFound",
      `Task ${taskId} is not a message in your conversations with Tag ${tag.name}`,
    );
    return;
  }
  if (streamUrl !== undefined) {
    await streamTagMessage(context, task, streamResumePoint(context, streamUrl));
    return;
  }
  const { reply, joinedTaskId } = await tagMessageReply(context.store, task);
  const record: TagMessageRecord = {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "TagMessage",
    tag: tag.name,
    session: sessionKey.slice(prefix.length),
    sessionId: task.sessionId,
    taskId: task.id,
    ...(joinedTaskId === undefined ? {} : { joinedTaskId }),
    status: reply === undefined ? "waiting" : "replied",
    ...(reply === undefined
      ? {}
      : { reply: { presentation: reply.presentation, text: reply.text } }),
  };
  writeJson(context.response, method === "POST" ? 201 : 200, record);
}

/** How often a reply stream rechecks a message that has neither a running stream nor a reply. */
const TAG_MESSAGE_STREAM_WAIT_MS = 250;
/** A comment line this often keeps idle proxies from closing a quiet reply stream. */
const TAG_MESSAGE_STREAM_KEEPALIVE_MS = 15_000;

/** The last part a resuming reader saw, from `resumeAt` or the `Last-Event-ID` header. */
function streamResumePoint(context: ControlPlaneApiRequestContext, url: URL): number {
  const header = context.request.headers["last-event-id"];
  const value = url.searchParams.get("resumeAt") ?? (typeof header === "string" ? header : "0");
  const after = Number(value);
  return Number.isSafeInteger(after) && after > 0 ? after : 0;
}

/**
 * Serves one CLI message's reply as an AI SDK UI message stream over Server-Sent Events. A
 * running Task's live stream resumes after part `after`; a message that joined a running Task
 * follows that Task. A finished Task, or one without a live stream, sends its stored reply as one
 * complete message. Until either exists, the response waits.
 */
async function streamTagMessage(
  context: ControlPlaneApiRequestContext,
  task: Task,
  after: number,
): Promise<void> {
  const { response } = context;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-vercel-ai-ui-message-stream": "v1",
  });
  const closed = new AbortController();
  const close = () => closed.abort();
  response.once("close", close);
  context.draining.addEventListener("abort", close, { once: true });
  const keepalive = setInterval(
    () => response.write(": keepalive\n\n"),
    TAG_MESSAGE_STREAM_KEEPALIVE_MS,
  );
  keepalive.unref();
  try {
    while (!closed.signal.aborted) {
      const current = (await context.store.findTaskById(task.id)) ?? task;
      const { reply, joinedTaskId } = await tagMessageReply(context.store, current);
      if (reply !== undefined) {
        response.write(completeReplyStream(current.id, reply));
        return;
      }
      // A joined message follows its Task from now on; earlier parts answered earlier messages.
      const live = await context.controlPlane.streamTaskReply(
        joinedTaskId ?? current.id,
        joinedTaskId !== undefined && after === 0 ? "now" : after,
      );
      if (live !== undefined) {
        await pipeReplyStream(live, response, closed.signal);
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, TAG_MESSAGE_STREAM_WAIT_MS);
        closed.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          { once: true },
        );
      });
    }
  } finally {
    clearInterval(keepalive);
    response.off("close", close);
    context.draining.removeEventListener("abort", close);
    response.end();
  }
}

/** Copies a live reply stream to the response until it ends or the reader goes away. */
async function pipeReplyStream(
  live: ReadableStream<string>,
  response: ServerResponse,
  closed: AbortSignal,
): Promise<void> {
  const reader = live.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  closed.addEventListener("abort", cancel, { once: true });
  try {
    while (!closed.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) response.write(value);
    }
  } finally {
    closed.removeEventListener("abort", cancel);
    cancel();
  }
}

/** A stored reply as one complete UI message stream: its text, then its finish or error. */
function completeReplyStream(
  messageId: string,
  reply: { readonly presentation: string; readonly text: string },
): string {
  const parts: Record<string, unknown>[] = [{ type: "start", messageId }];
  if (reply.presentation === "error") parts.push({ type: "error", errorText: reply.text });
  else
    parts.push(
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: reply.text },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        messageMetadata: { reply: { presentation: reply.presentation, text: reply.text } },
      },
    );
  return `${parts.map((part, index) => `id: ${index + 1}\ndata: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * The reply that answers one CLI message. A message sent while an earlier Task in the Session
 * still runs is delivered into that Task, so the answer is that Task's final reply; a delivery
 * whose outcome is unknown is answered by the error notice recorded for it.
 */
async function tagMessageReply(
  store: ControlPlaneApiRequestContext["store"],
  task: Task,
): Promise<{
  readonly reply?: { readonly presentation: string; readonly text: string };
  readonly joinedTaskId?: string;
}> {
  if (task.inboundEventId === null) return {};
  const own = await store.findOutboundReply(task.inboundEventId, "final");
  if (own !== undefined) return { reply: own };
  const unresolved = await store.findOutboundReply(task.inboundEventId, "session-input-unresolved");
  if (unresolved !== undefined) return { reply: unresolved };
  const reason = task.outcome?.["reason"];
  const targetTaskId = task.outcome?.["targetTaskId"];
  if (reason !== "input-accepted" || typeof targetTaskId !== "string") return {};
  const target = await store.findTaskById(targetTaskId);
  const reply =
    target?.inboundEventId === null || target === undefined
      ? undefined
      : await store.findOutboundReply(target.inboundEventId, "final");
  return { joinedTaskId: targetTaskId, ...(reply === undefined ? {} : { reply }) };
}

/** A stored account in manifest form, as field management compares it. */
function storedSurfaceAccountSpec(account: SurfaceAccount): SurfaceAccountManifestSpec {
  if (account.provider === "cli") throw new Error("The CLI conversation account is built in");
  return {
    provider: account.provider,
    displayName: account.displayName,
    configuration: declaredConfiguration({ ...account, provider: account.provider }),
    secrets: account.secretReferences ?? {},
  };
}

/**
 * Operator deletion of one configuration resource. A resource something still uses is refused
 * with every reference; `dryRun` answers the same way without changing anything.
 */
async function handleResourceDeletion(
  context: ControlPlaneApiRequestContext,
  kind: ManagedResourceKind,
  name: string,
  dryRun: boolean,
): Promise<void> {
  const plan = await planDeletion(context.store, kind, name, () =>
    context.controlPlane.listWorkerHosts(),
  );
  if (plan === undefined) {
    writeStatusError(
      context.response,
      404,
      "NotFound",
      `${DELETABLE_LABELS[kind]} ${name} does not exist`,
    );
    return;
  }
  const refusal = deletionRefusal(plan);
  if (refusal !== undefined) {
    writeStatusError(
      context.response,
      409,
      "Conflict",
      `${DELETE_KIND_NAMES[kind]} ${name} ${refusal}.`,
      { references: plan.references },
    );
    return;
  }
  if (!dryRun) {
    try {
      await applyDeletion(context.store, plan, context.credentialVault);
    } catch (error) {
      if (!(error instanceof TagMessagingError) || error.statusCode !== 409) throw error;
      writeStatusError(context.response, 409, "Conflict", error.message);
      return;
    }
  }
  writeJson(context.response, 200, {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "ResourceDeletion",
    metadata: { kind, name },
    dryRun,
    action: plan.action,
    removed: plan.removed,
    notes: plan.notes,
  });
}

/**
 * Declarative Objectives: `POST /api/v1/objectives` applies one Objective manifest under field
 * ownership, and `GET /api/v1/objectives/ID` returns an Objective in manifest form.
 */
async function handleObjectiveManifestRequest(
  context: ControlPlaneApiRequestContext,
  url: URL,
  principal: CoordinationOperatorPrincipal,
): Promise<void> {
  try {
    if (context.request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/v1/objectives/".length));
      const objective = await context.store.getObjective(id).catch((error: unknown) => {
        if (error instanceof TagMessagingError && error.statusCode === 404)
          throw new TagMessagingError(404, `Objective ${id} does not exist`);
        throw error;
      });
      writeJson(context.response, 200, await objectiveResource(context.store, objective));
      return;
    }
    const options = managedWriteOptions(url);
    if (options.imperative)
      throw new TagMessagingError(
        400,
        "Change an Objective imperatively with supertag update objective; apply takes manifests",
      );
    const body = await readJsonBody(context.request);
    const { name, spec } = parseObjectiveManifest(body);
    const plan = await planObjectiveManifest(context.store, { name, spec, options });
    if (options.dryRun) {
      writeJson(context.response, 200, {
        ...dryRunResource(body),
        spec: plan.managed.spec,
        plan: objectivePlanReport(plan),
      });
      return;
    }
    if (plan.refusals.length > 0) throw new TagMessagingError(409, objectiveRefusalMessage(plan));
    if (plan.held !== undefined && plan.objective !== undefined) {
      writeJson(context.response, 200, {
        ...(await objectiveResource(context.store, plan.objective)),
        warnings: [plan.held],
      });
      return;
    }
    if (plan.managed.merge.conflicts.length > 0) {
      writeStatusError(context.response, 409, "Conflict", conflictMessage(plan.managed), {
        conflicts: plan.managed.merge.conflicts,
      });
      return;
    }
    const objectives = context.controlPlane.objectives;
    const result = await applyObjectiveManifest(
      {
        store: context.store,
        create: async (definition, ownerTagId) => {
          const parsed = parseCreateObjective(definition);
          const runtime = await resolveOwnerObjectiveRuntimeActions(context.store, {
            objectiveId: parsed.id,
            ownerTagId,
            ...(definition["runtimeActions"] === undefined
              ? {}
              : { requested: parsed.runtimeActions ?? [] }),
          });
          return {
            objective: await context.store.createObjective({
              ...parsed,
              runtimeActions: runtime.runtimeActions,
              ownerTagId,
            }),
            warnings: runtime.warnings,
          };
        },
        update: async (objective, change) => {
          const runtime =
            change.runtimeActions === undefined
              ? undefined
              : await resolveOwnerObjectiveRuntimeActions(context.store, {
                  objectiveId: objective.id,
                  ownerTagId: objective.ownerTagId,
                  requested: change.runtimeActions,
                });
          return {
            objective: await context.store.updateObjectiveStatus(
              objective.id,
              {
                ...change,
                ...(runtime === undefined ? {} : { runtimeActions: runtime.runtimeActions }),
                expectedRevision: objective.revision,
              },
              undefined,
              undefined,
              { operatorId: principal.operatorId },
            ),
            warnings: runtime?.warnings ?? [],
          };
        },
        start: async (objective) => {
          if (!context.controlPlane.isAccepting)
            throw new TagMessagingError(
              503,
              "The Control Plane is draining; apply again later to start the owner",
            );
          const task = (await objectives.commandAsAdministrator(
            "start_objective",
            { objectiveId: objective.id },
            principal,
          )) as TaskAssignment;
          return { taskId: task.taskId, teamId: task.teamId };
        },
        runnable: (objective) => objectives.objectiveRunnable(objective),
        createTeam: (input) => objectives.commandAsAdministrator("create_team", input, principal),
        updateTeam: (input) => objectives.commandAsAdministrator("update_team", input, principal),
      },
      plan,
    );
    await recordManagedWrite(
      context.store,
      plan.managed,
      (await objectiveResource(context.store, await context.store.getObjective(name))).spec,
      options,
    );
    writeJson(context.response, result.created ? 201 : 200, {
      ...(await objectiveResource(context.store, await context.store.getObjective(name))),
      warnings: result.warnings,
      ...(result.started === undefined ? {} : { started: result.started }),
      ...(result.notStarted === undefined ? {} : { notStarted: result.notStarted }),
    });
  } catch (error) {
    if (!(error instanceof TagMessagingError)) throw error;
    const reasons: Record<number, string> = {
      400: "Invalid",
      403: "Forbidden",
      404: "NotFound",
      409: "Conflict",
    };
    writeStatusError(
      context.response,
      error.statusCode,
      reasons[error.statusCode] ?? "Invalid",
      error.message,
    );
  }
}

/** Operator pause or resume of an Objective; repeating either is harmless. */
async function handleObjectivePause(
  context: ControlPlaneApiRequestContext,
  objectiveId: string,
  pause: boolean,
  principal: CoordinationOperatorPrincipal,
): Promise<void> {
  try {
    const result = pause
      ? {
          ...(await context.controlPlane.objectives.pauseObjective({ objectiveId }, principal)),
          summary: null,
        }
      : await context.controlPlane.objectives.resumeObjective({ objectiveId }, principal);
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: pause ? "ObjectivePause" : "ObjectiveResume",
      metadata: { objectiveId: result.objective.id },
      status: {
        changed: result.changed,
        phase: result.objective.status,
        pausedAt: result.objective.pausedAt ?? null,
        ...(pause ? {} : { summary: result.summary }),
      },
    });
  } catch (error) {
    if (!(error instanceof TagMessagingError)) throw error;
    const reasons: Record<number, string> = {
      400: "Invalid",
      401: "Unauthorized",
      403: "Forbidden",
      404: "NotFound",
      409: "Conflict",
    };
    writeStatusError(
      context.response,
      error.statusCode,
      reasons[error.statusCode] ?? "Invalid",
      error.message,
    );
  }
}

/** Operator cancellation of an Objective and its open Tasks; repeating it is harmless. */
async function handleObjectiveCancellation(
  context: ControlPlaneApiRequestContext,
  objectiveId: string,
  principal: CoordinationOperatorPrincipal,
): Promise<void> {
  const raw = await readBody(context.request);
  let body: unknown = {};
  try {
    if (raw.trim()) body = JSON.parse(raw);
    const { reason } = parseCancelObjective(body);
    const result = await context.controlPlane.objectives.cancelObjective(
      { objectiveId, reason: reason ?? null },
      principal,
    );
    writeJson(context.response, 200, {
      apiVersion: CONTROL_PLANE_API_VERSION,
      kind: "ObjectiveCancellation",
      metadata: { objectiveId: result.objective.id },
      status: {
        changed: result.changed,
        phase: result.objective.status,
        cancelledAt: result.objective.cancelledAt ?? null,
        reason: result.objective.cancellationReason ?? null,
        cancelledTaskIds: result.cancelledTaskIds,
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeStatusError(context.response, 400, "Invalid", "Request body must be valid JSON");
      return;
    }
    if (!(error instanceof TagMessagingError)) throw error;
    const reasons: Record<number, string> = {
      400: "Invalid",
      403: "Forbidden",
      404: "NotFound",
      409: "Conflict",
    };
    writeStatusError(
      context.response,
      error.statusCode,
      reasons[error.statusCode] ?? "Invalid",
      error.message,
    );
  }
}

/**
 * Where an administrator's `supertag download artifact` can read one file: the producing host's
 * transfer endpoint with a short-lived grant bound to the file and operator, and the Volume copies
 * the operator's own machine may map. Metadata only; the Control Plane holds no bytes to serve.
 */
async function handleOperatorArtifactDownload(
  context: ControlPlaneApiRequestContext,
  artifactId: string,
  operatorId: string,
): Promise<void> {
  const catalog = new ArtifactCatalog(
    context.store,
    context.controlPlane.objectives,
    context.artifactTransfers === undefined ? undefined : { sign: context.artifactTransfers.sign },
  );
  try {
    const resolved = await catalog.resolveOperatorDownload(
      operatorId,
      artifactId,
      await readJsonBody(context.request),
      {
        publicUrl: context.publicUrl,
        operatorAddress: context.request.socket.remoteAddress,
        hostConnectionIsLoopback: (workerHostId, generation) =>
          context.workletApi?.isHostConnectionLoopback(workerHostId, generation) === true,
      },
    );
    context.response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    context.response.end(JSON.stringify(resolved));
  } catch (error) {
    if (error instanceof TagMessagingError || error instanceof ArtifactCatalogError) {
      writeStatusError(
        context.response,
        error.statusCode,
        error.statusCode === 404 ? "NotFound" : "Invalid",
        error.message,
      );
      return;
    }
    if (error instanceof Error && error.message === "Request body must be valid JSON") {
      writeStatusError(context.response, 400, "Invalid", error.message);
      return;
    }
    throw error;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const rawBody = await readBody(request);
  try {
    const body: unknown = JSON.parse(rawBody);
    noteRequestBody(auditNotes.get(request), body);
    return body;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function parseTagCommandRequest(value: unknown): {
  readonly command: TagCommand;
  readonly args: readonly string[];
} {
  if (!isRecord(value)) {
    throw new Error("Tag command is invalid");
  }
  const command = stringValue(value["command"]);
  if (!isTagCommand(command)) throw new Error("Tag command is invalid");
  if (command === "create") {
    throw new Error("Create Tags with POST /api/v1/tags");
  }
  const args = value["args"];
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) {
    throw new Error("Tag command arguments must be strings");
  }
  return { command, args };
}

function parseVerifiedSurfaceAccount(value: unknown): VerifiedSurfaceAccount {
  if (!isRecord(value)) throw new Error("Surface account is invalid");
  const provider = stringValue(value["provider"]);
  if (
    provider !== "github" &&
    provider !== "lark" &&
    provider !== "linear" &&
    provider !== "slack" &&
    provider !== "teams"
  ) {
    throw new Error("Surface provider is invalid");
  }
  const configuration = value["configuration"];
  const secrets = value["secrets"];
  if (!isRecord(configuration) || !isStringRecord(secrets)) {
    throw new Error("Surface configuration or secrets are invalid");
  }
  return {
    provider,
    externalAccountId: requiredString(value["externalAccountId"], "externalAccountId"),
    displayName: requiredString(value["displayName"], "displayName"),
    authMethod: requiredString(value["authMethod"], "authMethod"),
    configuration,
    secrets,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value)?.trim();
  if (!result) throw new Error(`Surface ${name} is required`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_API_BODY_BYTES) {
      throw new Error("Request body exceeds the one-megabyte limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeOneTimeCredential(response: ServerResponse, status: number, body: unknown): void {
  response.setHeader("cache-control", "no-store");
  writeJson(response, status, body);
}

function writeStatusError(
  response: ServerResponse,
  status: number,
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  writeJson(response, status, {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "Status",
    status: "Failure",
    reason,
    code: status,
    message,
    details,
  });
}
