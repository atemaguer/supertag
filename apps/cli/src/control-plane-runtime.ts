import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import {
  ControlPlane,
  configuredOperatorChannel,
  controlPlaneEventLoopLag,
  type OperatorNotificationSender,
  type OutboundReplyHandler,
  parseNotificationDestination,
} from "@supertag/control-plane";
import { type GatewayCredentialVault, isLoopbackAddress } from "@supertag/core";
import { deploymentPlatform, resolveDeploymentEnvironment } from "@supertag/deployment";
import { assertDatabaseSchemaReady, DrizzleStore } from "@supertag/store";
import {
  LocalWorklet,
  StaticWorker,
  signArtifactTransferGrant,
  type Worklet,
} from "@supertag/worker-sdk";
import {
  RemoteWorkletServer,
  RpcTelemetry,
  type WorkletGrpcServerOptions,
} from "@supertag/worker-transport";
import { loadArtifactTransferSigningIdentity } from "./artifact-transfer-key.js";
import { AuditTrail } from "./audit-trail.js";
import { SUPERTAG_BUILD_IDENTITY } from "./build-identity.js";
import {
  ControlPlaneApiServer,
  type ControlPlaneOperatorCredential,
  environmentCoordinationOperatorCredentials,
  isControlPlaneApiPath,
  type ManagementAuditEvent,
  validateCoordinationOperatorCredentials,
} from "./control-plane-api.js";
import { ensureLocalAdminToken } from "./control-plane-client.js";
import { loadControlPlaneCoordinationKey } from "./coordination-key.js";
import { createCredentialVaultFromEnvironment } from "./credential-vault.js";
import { Gateway } from "./gateway.js";
import { handleGatewayHttpRequest } from "./gateway-http.js";
import {
  createOperatorNotificationSender,
  createProviderReply,
  createWorkspacePullRequestHandler,
  SurfaceController,
} from "./gateway-surfaces.js";
import { createNotificationDeliverySender } from "./operator-notification-delivery.js";
import { SUPERTAG_VERSION } from "./version.js";

export type { GatewayController, SurfaceControllerStatus } from "./gateway-surfaces.js";

export interface ControlPlaneRuntimeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly databaseUrl?: string;
  readonly githubMention?: string;
  readonly linearMention?: string;
  readonly surfaceRefreshIntervalMs?: number;
  readonly workletTransport?: "embedded" | "remote";
  readonly worklet?: Worklet;
  /** Optional outbound Worklet gRPC endpoint, owned by the API Server. */
  readonly workletGrpc?: Omit<WorkletGrpcServerOptions, "remote" | "telemetry">;
  /** Public base URL reachable from remote execution environments. */
  readonly coordinationUrl?: string;
  /** Optional process-local RPC counters and lifecycle event sink. */
  readonly rpcTelemetry?: RpcTelemetry;
  readonly adminToken?: string;
  /** Verified surface Task used as the deployment operator notification destination. */
  readonly operatorNotificationTaskId?: string;
  /** Operator channel for new inbox items, as in SUPERTAG_OPERATOR_CHANNEL. */
  readonly operatorChannel?: string | readonly string[];
  readonly operatorNotificationSecrets?: Readonly<Record<string, string>>;
  readonly operatorNotificationSender?: OperatorNotificationSender;
  /** Server-side coordination credentials. Tokens never define their own identity or scope. */
  readonly coordinationOperatorCredentials?: readonly ControlPlaneOperatorCredential[];
  /**
   * Receives each audit entry, naming the operator, in addition to the database. Use it for a
   * log stream or file; a failing sink never fails the request.
   */
  readonly audit?: (event: ManagementAuditEvent) => void;
  readonly enableLocalAdmin?: boolean;
  /** Override the local file vault with an external Gateway credential provider. */
  readonly credentialVault?: GatewayCredentialVault;
  readonly reply?: OutboundReplyHandler;
  /** Directory for the default file credential vault; defaults to SUPERTAG_STATE_DIR. */
  readonly stateDirectory?: string;
}

export type { ControlPlaneOperatorCredential } from "./control-plane-api.js";

export interface ControlPlaneRuntimeHandle {
  readonly url: string;
  readonly workletGrpcUrl?: string;
  close(): Promise<void>;
}

export async function runControlPlaneCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(controlPlaneHelp());
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: environmentGatewayPort() },
      "github-mention": { type: "string", default: "@supertag" },
      "linear-mention": { type: "string", default: "@supertag" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer from 0 through 65535");
  }
  const runtime = await startControlPlaneRuntime({
    host: values.host,
    port,
    enableLocalAdmin: true,
    audit: writeAuditEvent,
    githubMention: values["github-mention"],
    linearMention: values["linear-mention"],
  });
  process.stdout.write(`SuperTag Control Plane listening at ${runtime.url}\n`);
  if (runtime.workletGrpcUrl)
    process.stdout.write(`Worklet gRPC listening at ${runtime.workletGrpcUrl}\n`);

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await runtime.close();
}

export async function startControlPlaneRuntime(
  options: ControlPlaneRuntimeOptions = {},
): Promise<ControlPlaneRuntimeHandle> {
  const platform = process.env["SUPERTAG_DEPLOYMENT_PLATFORM"];
  const environment =
    platform === undefined
      ? process.env
      : resolveDeploymentEnvironment(deploymentPlatform(platform), process.env);
  const host = options.host ?? "127.0.0.1";
  const workletTransport = options.workletTransport ?? environmentWorkletTransport(environment);
  const workletGrpc = options.workletGrpc ?? (await environmentWorkletGrpc(host));
  if (workletGrpc && (workletTransport !== "remote" || options.worklet))
    throw new Error("Worklet gRPC requires the remote Worklet API");
  const operatorChannelSetting =
    options.operatorChannel ?? process.env["SUPERTAG_OPERATOR_CHANNEL"];
  const operatorChannel =
    operatorChannelSetting === undefined
      ? undefined
      : (typeof operatorChannelSetting === "string"
          ? [operatorChannelSetting]
          : operatorChannelSetting
        ).map(parseNotificationDestination);
  await assertDatabaseSchemaReady(
    options.databaseUrl === undefined ? {} : { url: options.databaseUrl },
  );
  const server = createServer();
  const startedAt = new Date().toISOString();
  const store = new DrizzleStore(
    options.databaseUrl === undefined ? {} : { url: options.databaseUrl },
  );
  const credentialVault =
    options.credentialVault ??
    createCredentialVaultFromEnvironment(
      options.stateDirectory === undefined
        ? environment
        : { ...environment, SUPERTAG_STATE_DIR: options.stateDirectory },
    );
  const signingKey = await loadControlPlaneCoordinationKey(credentialVault);
  const artifactTransferIdentity = await loadArtifactTransferSigningIdentity(credentialVault);
  const adminToken =
    options.adminToken ??
    process.env["SUPERTAG_ADMIN_TOKEN"]?.trim() ??
    (options.enableLocalAdmin === true && isLoopbackHost(host)
      ? await ensureLocalAdminToken()
      : undefined);
  const coordinationOperatorCredentials = validateCoordinationOperatorCredentials(
    options.coordinationOperatorCredentials ?? (await environmentCoordinationOperatorCredentials()),
    adminToken,
  );
  // The Worklet API is also the Control Plane's remote Worklet proxy, so the composition root
  // constructs it before both owners and gives lifecycle control to the API Server below.
  let workletApi: RemoteWorkletServer | undefined;
  let worklet: Worklet;
  let controlPlane: ControlPlane | undefined;
  if (options.worklet !== undefined) {
    worklet = options.worklet;
  } else if (workletTransport === "remote") {
    workletApi = new RemoteWorkletServer({
      server,
      authenticateWorklet: (request) => {
        if (controlPlane === undefined) throw new Error("Control Plane is not initialized");
        return controlPlane.authenticateWorkerHost(request);
      },
      onWorkletObserved: (observation) => {
        if (controlPlane === undefined) throw new Error("Control Plane is not initialized");
        return controlPlane.observeWorkerHostConnection(observation);
      },
      onError: (error) => {
        process.stderr.write(`Remote Worklet transport failed: ${errorMessage(error)}\n`);
      },
      onWorkletConnected: (registration) => {
        process.stdout.write(
          `Remote Worklet ${registration.id} connected for Worker Host ${registration.host.id}\n`,
        );
      },
      onWorkletDisconnected: (registration) => {
        process.stderr.write(
          `Remote Worklet ${registration.id} disconnected from Worker Host ${registration.host.id}\n`,
        );
      },
    });
    worklet = workletApi;
  } else {
    worklet = new LocalWorklet("control-plane-static-worklet", "control-plane-static-host", [
      new StaticWorker({
        id: "control-plane-static-worker",
        profile: { id: "default", revision: "1" },
      }),
    ]);
  }
  const providerReply = createProviderReply(credentialVault);
  const operatorNotificationTaskId =
    options.operatorNotificationTaskId ??
    process.env["SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID"]?.trim();
  // One trail for API requests and Gateway commands: the database, then the configured sink.
  const auditTrail = new AuditTrail(store, options.audit);
  controlPlane = new ControlPlane({
    store,
    credentialVault,
    audit: (entry) => auditTrail.record(entry),
    worklet,
    reply: options.reply ?? providerReply,
    pullRequests: createWorkspacePullRequestHandler(store, credentialVault),
    ...(operatorNotificationTaskId ? { operatorNotificationTaskId } : {}),
    ...(operatorChannel
      ? {
          operatorNotifications: {
            resolver: configuredOperatorChannel(operatorChannel),
            destinationFromKey: (key: string) => {
              const destination = operatorChannel.find((entry) => entry.key === key);
              if (!destination) throw new Error("Notification destination is no longer configured");
              return destination;
            },
            redact: (value: string) => {
              let redacted = value;
              for (const secret of Object.values(options.operatorNotificationSecrets ?? {}))
                if (secret) redacted = redacted.replaceAll(secret, "<redacted>");
              return redacted;
            },
            send:
              options.operatorNotificationSender ??
              createNotificationDeliverySender(
                createOperatorNotificationSender(store, credentialVault),
                options.operatorNotificationSecrets,
              ),
          },
        }
      : {}),
    dispatch: {
      onDispatchError: (error) => {
        process.stderr.write(`Control Plane dispatch failed: ${errorMessage(error)}\n`);
      },
    },
  });
  const surfaceController = new SurfaceController({
    store,
    credentialVault,
    controlPlane,
    refreshIntervalMs: options.surfaceRefreshIntervalMs ?? 10_000,
  });
  let publicUrl = options.coordinationUrl ?? process.env["SUPERTAG_COORDINATION_URL"];
  const apiServer = new ControlPlaneApiServer({
    get publicUrl() {
      // A synthesized loopback URL is a connection convenience, not a local listener.
      return host === "localhost" || isLoopbackAddress(host) ? publicUrl : undefined;
    },
    controlPlane,
    store,
    credentialVault,
    artifactTransfers: {
      publicKey: artifactTransferIdentity.publicKeyBase64,
      sign: (claims) => signArtifactTransferGrant(claims, artifactTransferIdentity.privateKey),
    },
    surfaceController,
    rpcTelemetry:
      options.rpcTelemetry ??
      new RpcTelemetry(
        process.env["SUPERTAG_RPC_TRACE"] === "1"
          ? {
              onEvent: (event) => {
                if (process.stderr.writableNeedDrain) throw new Error("RPC trace sink busy");
                process.stderr.write(`${JSON.stringify({ type: "supertag.rpc", ...event })}\n`);
              },
            }
          : {},
      ),
    startedAt,
    ...(adminToken === undefined ? {} : { adminToken }),
    coordinationOperatorCredentials,
    auditTrail,
    ...(workletApi === undefined ? {} : { workletApi }),
  });
  const requestContext: Omit<HttpRequestContext, "request" | "response"> = {
    apiServer,
    controlPlane,
    store,
    credentialVault,
    surfaceController,
    githubMention: options.githubMention ?? "@supertag",
    linearMention: options.linearMention ?? "@supertag",
  };
  const gateway = new Gateway({
    server,
    host,
    port: options.port ?? 3434,
    surfaceController,
    handleRequest: (request, response) =>
      controlPlaneEventLoopLag.run(
        `http: ${request.method ?? "UNKNOWN"} ${new URL(request.url ?? "/", "http://localhost").pathname}`,
        () => handleHttpRequest({ ...requestContext, request, response }),
      ),
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      apiServer.beginDrain();
      controlPlane.beginDrain();
      gateway.beginDrain();
      await Promise.all([apiServer.drain(), gateway.drain()]);
      await controlPlane.drain();
      apiServer.beginInternalDrain();
      await Promise.all([apiServer.drain(), gateway.drain()]);
      await apiServer.stop();
      await controlPlane.stop();
      await gateway.stop();
      controlPlaneEventLoopLag.stop();
    })();
    return shutdownPromise;
  };
  controlPlaneEventLoopLag.start();
  try {
    await controlPlane.start();
    apiServer.start();
    const workletGrpcUrl = workletGrpc ? await apiServer.startWorkletGrpc(workletGrpc) : undefined;
    const url = await gateway.start();

    publicUrl ??= url;
    controlPlane.objectives.activateCoordination({
      url: publicUrl,
      signingKey,
    });
    return {
      url,
      ...(workletGrpcUrl === undefined ? {} : { workletGrpcUrl }),
      close: shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

interface HttpRequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly apiServer: ControlPlaneApiServer;
  readonly controlPlane: ControlPlane;
  readonly store: DrizzleStore;
  readonly credentialVault: GatewayCredentialVault;
  readonly surfaceController: SurfaceController;
  readonly githubMention: string;
  readonly linearMention: string;
}

async function handleHttpRequest(context: HttpRequestContext): Promise<void> {
  const url = new URL(context.request.url ?? "/", "http://localhost");
  if (
    context.request.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/healthz")
  ) {
    // Only the version: the endpoint is unauthenticated.
    writeJson(context.response, 200, {
      ok: true,
      version: SUPERTAG_VERSION,
      buildIdentity: SUPERTAG_BUILD_IDENTITY,
    });
    return;
  }
  if (context.request.method === "GET" && url.pathname === "/readyz") {
    const surfaces = context.surfaceController.status();
    const worklet = context.apiServer.workletStatus;
    const workletReady = worklet?.connected ?? true;
    const objectives = context.controlPlane.objectives.executionReadiness;
    const ready =
      context.controlPlane.isAccepting &&
      surfaces.errors.length === 0 &&
      workletReady &&
      objectives === "ready";
    writeJson(context.response, ready ? 200 : 503, {
      ok: ready,
      controlPlane: context.controlPlane.isAccepting ? "accepting" : "draining",
      objectives,
      surfaces,
      ...(worklet === undefined
        ? {}
        : {
            worklet: {
              status: worklet.connected ? "connected" : "disconnected",
              id: worklet.id,
              workerHostId: worklet.workerHostId,
            },
          }),
    });
    return;
  }
  if (isControlPlaneApiPath(url.pathname)) {
    await context.apiServer.handle(context.request, context.response, url);
    return;
  }
  const handled = await handleGatewayHttpRequest({
    request: context.request,
    response: context.response,
    pathname: url.pathname,
    controlPlane: context.controlPlane,
    store: context.store,
    credentialVault: context.credentialVault,
    surfaceController: context.surfaceController,
    githubMention: context.githubMention,
    linearMention: context.linearMention,
  });
  if (!handled) writeJson(context.response, 404, { error: "not_found" });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

/** Writes a management audit event as one JSON line on stderr, beside the process log. */
export function writeAuditEvent(event: ManagementAuditEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function environmentWorkletTransport(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): "embedded" | "remote" {
  const value = environment["SUPERTAG_WORKLET_TRANSPORT"]?.trim() ?? "embedded";
  if (value === "embedded" || value === "remote") {
    return value;
  }
  throw new Error("SUPERTAG_WORKLET_TRANSPORT must be embedded or remote");
}

async function environmentWorkletGrpc(
  host: string,
): Promise<Omit<WorkletGrpcServerOptions, "remote" | "telemetry"> | undefined> {
  const configuredPort = process.env["SUPERTAG_WORKLET_GRPC_PORT"];
  if (configuredPort === undefined) return undefined;
  const port = Number(configuredPort);
  if (!configuredPort.trim() || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("SUPERTAG_WORKLET_GRPC_PORT must be an integer from 0 through 65535");
  const certPath = process.env["SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE"];
  const keyPath = process.env["SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE"];
  if (Boolean(certPath) !== Boolean(keyPath))
    throw new Error("Worklet gRPC requires both TLS certificate and key files");
  return {
    host,
    port,
    ...(certPath && keyPath
      ? { tls: { cert: await readFile(certPath), key: await readFile(keyPath) } }
      : {}),
  };
}

function environmentGatewayPort(): string {
  return process.env["PORT"]?.trim() || "3434";
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function controlPlaneHelp(): string {
  return `Usage: supertag start control-plane [--host HOST] [--port PORT] [--github-mention @NAME] [--linear-mention @NAME]

Starts the persistent Control Plane, including its Gateway surface supervision, and authenticated Slack/GitHub/Lark/Linear/Teams ingress.
Events are admitted durably; Worker execution and reply delivery continue asynchronously.

Environment:
  SUPERTAG_DEPLOYMENT_PLATFORM=railway|render|cloudflare
                            Validates hosted database, credentials, storage, and public URL at startup
  PORT                      Platform-provided default for --port (default: 3434)
  SUPERTAG_STATE_DIR        Local credentials, artifacts, and default SQLite directory (default: ~/.supertag)
  SUPERTAG_DATABASE_URL     file:, postgresql:, or postgres: database URL
  SUPERTAG_ADMIN_TOKEN      Enables authenticated remote Control Plane management. Its holder
                            issues Operator Tokens (supertag create operator-token) to teammates
  SUPERTAG_CREDENTIAL_VAULT=file|vault (default: file)
  VAULT_ADDR / VAULT_TOKEN  Required for the HashiCorp Vault KV v2 credential provider
  SUPERTAG_VAULT_MOUNT / SUPERTAG_VAULT_PATH_PREFIX / VAULT_NAMESPACE
                            Optional Vault mount, path prefix, and Enterprise namespace
  SUPERTAG_COORDINATION_OPERATORS_FILE
                            JSON file containing scoped coordination operator credentials
  SUPERTAG_WORKLET_TRANSPORT=embedded|remote
  SUPERTAG_RPC_TRACE=1       Emit bounded, payload-free RPC lifecycle events to stderr
  SUPERTAG_WORKLET_GRPC_PORT Optional API Server gRPC listener for remote Worklets
  SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE / SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE
                            TLS files required for a non-loopback gRPC listener

Remote Worker Hosts join with an Auth Key (supertag create auth-key) before connecting.

Endpoints:
  POST /supertag.operator.v1.OrganizationService/GetStatus   (Connect and gRPC-Web)
  GET  /api/v1/metrics
  GET  /api/v1/tags
  POST /api/v1/tags
  PUT  /api/v1/tags/:name/worker-hosts/:workerHostId
  DELETE /api/v1/tags/:name/worker-hosts/:workerHostId
  GET  /api/v1/permission-sets
  POST /api/v1/permission-sets
  GET  /api/v1/context-sets
  POST /api/v1/context-sets
  GET  /api/v1/roles
  POST /api/v1/roles
  GET  /api/v1/worker-hosts
  POST /api/v1/worker-hosts
  GET  /api/v1/worker-hosts/:id
  POST /api/v1/worker-hosts/:id/credential
  DELETE /api/v1/worker-hosts/:id/credential
  POST /api/v1/worker-hosts/:id/drain
  POST /api/v1/worker-hosts/:id/resume
  GET  /api/v1/auth-keys
  POST /api/v1/auth-keys
  GET  /api/v1/auth-keys/:name
  POST /api/v1/auth-keys/:name/revoke
  POST /api/v1/worker-host-joins        (authorized by an Auth Key)
  GET  /api/v1/operator-tokens          (admin token only, like every operator-tokens route)
  POST /api/v1/operator-tokens
  GET  /api/v1/operator-tokens/:name
  POST /api/v1/operator-tokens/:name/revoke
  GET  /api/v1/worker-profiles
  GET  /api/v1/tasks
  GET  /api/v1/sessions
  POST /api/v1/surface-enrollments
  POST /api/v1/tag-operations
  POST /webhooks/slack/:externalAccountId
  POST /webhooks/github/:externalAccountId
  POST /webhooks/linear
  POST /webhooks/teams/:externalAccountId
  GET  /health
  GET  /healthz
  GET  /readyz
`;
}
