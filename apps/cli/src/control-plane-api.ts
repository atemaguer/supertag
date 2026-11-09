import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ControlPlane, CoordinationOperatorPrincipal } from "@supertag/control-plane";
import {
  ArtifactCatalog,
  AuthKeyRedemptionError,
  SessionPersistence,
} from "@supertag/control-plane";
import type { AnyArtifactTransferGrantClaims, GatewayCredentialVault, Store } from "@supertag/core";
import {
  OPERATOR_TOKEN_PREFIX,
  operatorTokenOperatorId,
  parseWorkerHostName,
  TagMessagingError,
} from "@supertag/core";
import {
  type RemoteWorkletServer,
  RpcTelemetry,
  type RpcTelemetrySnapshot,
  startWorkletGrpcServer,
  type WorkletGrpcServerOptions,
} from "@supertag/worker-transport";
import { registerArtifactGrpcRoutes } from "./artifact-grpc.js";
import { handleArtifactRequest } from "./artifact-http.js";
import { AuditTrail, type ManagementAuditEvent } from "./audit-trail.js";
import {
  CONTROL_PLANE_API_VERSION,
  workerHostCredentialIssuance,
  workerHostResource,
} from "./control-plane-resources.js";
import { registerCoordinationGrpcRoutes } from "./coordination-grpc.js";
import { handleCoordinationRequest } from "./coordination-http.js";
import type { SurfaceController } from "./gateway-surfaces.js";
import type { ManifestApplyContext, SurfaceVerifier } from "./manifest-apply.js";
import { MessageFollows } from "./message-follow.js";
import {
  controlPlaneControl,
  controlPlaneDataWrites,
  controlPlaneQueries,
} from "./operator-control-plane.js";
import {
  createOperatorRpcHandler,
  OPERATOR_RPC_PATH_PREFIX,
  registerOperatorRoutes,
} from "./operator-rpc.js";
import type { OperatorAuthentication } from "./operator-rpc-context.js";
import { registerSessionGrpcRoutes } from "./session-grpc.js";
import { handleSessionRequest } from "./session-http.js";
import { verifySurfaceAccount } from "./surface-account-manifest.js";
import { SUPERTAG_VERSION, VERSION_HEADER } from "./version.js";

const MAX_API_BODY_BYTES = 1_000_000;

export interface ControlPlaneOperatorCredential {
  readonly token: string;
  readonly operatorId: string;
  readonly actions: readonly string[];
  readonly objectiveIds?: readonly string[];
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
  /** Verifies applied Surface Account credentials; the provider's own check by default. */
  readonly verifySurface?: SurfaceVerifier;
}

export type { ManagementAuditEvent } from "./audit-trail.js";

interface ControlPlaneApiRequestContext extends ControlPlaneApiServerDependencies {
  readonly auditTrail: AuditTrail;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly rpcSnapshot: () => RpcTelemetrySnapshot;
}

const CONTROL_PLANE_BREAK_GLASS_PRINCIPAL: CoordinationOperatorPrincipal = {
  operatorId: "control-plane-break-glass",
  scopes: { actions: ["*"] },
};

/** Whether `ControlPlaneApiServer.handle` serves this path: the HTTP API or an operator RPC. */
export function isControlPlaneApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/internal/v1/") ||
    pathname.startsWith(OPERATOR_RPC_PATH_PREFIX)
  );
}

/** Internal API component for Control Plane resources, admission, and status. */
export class ControlPlaneApiServer {
  readonly #dependencies: ControlPlaneApiServerDependencies;
  readonly #activeRequests = new Set<Promise<void>>();
  readonly #rpcTelemetry: RpcTelemetry;
  readonly #auditTrail: AuditTrail;
  readonly #operatorRpc: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly #follows: MessageFollows;
  #workletGrpc: Promise<Awaited<ReturnType<typeof startWorkletGrpcServer>>> | undefined;
  #acceptingManagement = false;
  #acceptingInternal = false;
  #draining = new AbortController();

  constructor(dependencies: ControlPlaneApiServerDependencies) {
    this.#dependencies = dependencies;
    this.#rpcTelemetry = dependencies.rpcTelemetry ?? new RpcTelemetry();
    this.#auditTrail =
      dependencies.auditTrail ?? new AuditTrail(dependencies.store, dependencies.audit);
    this.#follows = new MessageFollows({
      store: dependencies.store,
      replies: dependencies.controlPlane,
      changes: dependencies.controlPlane.changes,
    });
    const resources: ManifestApplyContext = {
      store: dependencies.store,
      credentialVault: dependencies.credentialVault,
      controlPlane: dependencies.controlPlane,
      startedAt: dependencies.startedAt,
      verifySurface: dependencies.verifySurface ?? verifySurfaceAccount,
    };
    this.#operatorRpc = createOperatorRpcHandler(
      {
        auditTrail: this.#auditTrail,
        authenticate: (authorization) => authenticateOperator(dependencies, authorization),
        accepting: () => this.#acceptingManagement,
      },
      (router) =>
        registerOperatorRoutes(router, {
          store: dependencies.store,
          queries: controlPlaneQueries(dependencies, resources),
          writes: controlPlaneDataWrites(dependencies),
          control: controlPlaneControl(dependencies, resources),
          changes: dependencies.controlPlane.changes,
          follows: this.#follows,
          rpcTelemetry: () => this.#rpcTelemetry.snapshot(),
          draining: () => this.#draining.signal,
        }),
    );
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
    this.#follows.close();
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
    if (!isControlPlaneApiPath(url.pathname))
      throw new Error("ControlPlaneApiServer only handles Control Plane API routes");
    // The Gateway sets this too; an embedded API Server may be served without one.
    response.setHeader(VERSION_HEADER, SUPERTAG_VERSION);
    const operatorRpc = url.pathname.startsWith(OPERATOR_RPC_PATH_PREFIX);
    const internal = url.pathname.startsWith("/internal/v1/");
    // Operator RPCs refuse in their own protocol once draining.
    if (
      !operatorRpc &&
      ((internal && !this.#acceptingInternal) || (!internal && !this.#acceptingManagement))
    ) {
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
      };
      if (operatorRpc) {
        await this.#operatorRpc(request, response);
        return;
      }
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
  writeJson(context.response, 404, { error: "not_found" });
}

async function handleApiRequest(context: ControlPlaneApiRequestContext, url: URL): Promise<void> {
  // Joining is authorized only by the Auth Key in the Authorization header.
  if (context.request.method === "POST" && url.pathname === "/api/v1/worker-host-joins") {
    await handleWorkerHostJoin(context);
    return;
  }
  const authentication = await authenticateOperator(
    context,
    header(context.request, "authorization"),
  );
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
  if (authentication.kind === "coordination") {
    writeStatusError(
      context.response,
      403,
      "Forbidden",
      "A scoped coordination credential may call only the operator RPCs that accept one",
    );
    return;
  }
  writeStatusError(context.response, 404, "NotFound", "Admin route not found");
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

async function tagNamesById(store: Store): Promise<ReadonlyMap<string, string>> {
  return new Map((await store.listTags({ includeRetired: true })).map((tag) => [tag.id, tag.name]));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

function hasBearerToken(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const actualDigest = createHash("sha256").update(authorization.slice("Bearer ".length)).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

/** Authenticates an `authorization` header value; undefined when it holds no known credential. */
async function authenticateOperator(
  context: Pick<
    ControlPlaneApiServerDependencies,
    "adminToken" | "coordinationOperatorCredentials" | "controlPlane"
  >,
  authorization: string | undefined,
): Promise<OperatorAuthentication | undefined> {
  if (context.adminToken !== undefined && hasBearerToken(authorization, context.adminToken))
    return { kind: "break-glass", principal: CONTROL_PLANE_BREAK_GLASS_PRINCIPAL };
  const bearer = bearerToken(authorization);
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
        reason: "revoked",
        message: "This Operator Token was revoked; ask an admin for a new one",
      };
    if (result.status === "expired")
      return {
        kind: "refused",
        reason: "expired",
        message: "This Operator Token has expired; ask an admin for a new one",
      };
    // An unknown stop_ value may still be a static coordination credential.
  }
  for (const credential of context.coordinationOperatorCredentials) {
    if (!hasBearerToken(authorization, credential.token)) continue;
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
    const objectives = credential.objectiveIds;
    if (objectives?.some((value) => !value.trim() || value.length > 200))
      throw new Error("Coordination operator Objective scope contains an invalid ID");
    if (objectives && new Set(objectives).size !== objectives.length)
      throw new Error("Coordination operator Objective scope contains duplicate IDs");
    const digest = tokenDigest(credential.token);
    if (tokens.has(digest)) throw new Error("Coordination operator tokens must be unique");
    tokens.add(digest);
    return {
      ...credential,
      actions: [...new Set(credential.actions)],
      ...(credential.objectiveIds === undefined
        ? {}
        : { objectiveIds: [...credential.objectiveIds] }),
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
  const allowed = new Set(["token", "operatorId", "actions", "objectiveIds", "revoked"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(
      `Coordination operator credential ${index} has unknown fields: ${unknown.join(", ")}`,
    );
  if (typeof record["token"] !== "string" || typeof record["operatorId"] !== "string")
    throw new Error(`Coordination operator credential ${index} requires token and operatorId`);
  const strings = (name: "actions" | "objectiveIds", optional = false) => {
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
  return {
    token: record["token"],
    operatorId: record["operatorId"],
    actions,
    ...(objectiveIds === undefined ? {} : { objectiveIds }),
    ...(record["revoked"] === undefined ? {} : { revoked: record["revoked"] }),
  };
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const rawBody = await readBody(request);
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
