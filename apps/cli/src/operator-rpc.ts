import type { IncomingMessage, ServerResponse } from "node:http";
import { type DescMethod, getOption } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import {
  Code,
  ConnectError,
  type ConnectRouter,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import { codeToHttpStatus } from "@connectrpc/connect/protocol-connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ChangeFeed } from "@supertag/control-plane";
import { TagMessagingError } from "@supertag/core";
import {
  action,
  allow_anonymous,
  allow_scoped_credential,
  audit_action,
  ConversationService,
  ErrorDetailSchema,
  ErrorReason,
  EventService,
  InboxService,
  ObjectiveService,
  OrganizationService,
  requires_admin_token,
} from "@supertag/operator-api";
import { type AuditTrail, auditTargetKind } from "./audit-trail.js";
import { conversationService } from "./conversation-rpc.js";
import { eventService } from "./event-rpc.js";
import { inboxService } from "./inbox-rpc.js";
import type { MessageFollower } from "./message-follow.js";
import { objectiveService } from "./objective-rpc.js";
import {
  type OperatorAuthentication,
  type OperatorPrincipal,
  operatorAuditTarget,
  operatorError,
  operatorPrincipal,
  STREAM_HEARTBEAT_MS,
} from "./operator-rpc-context.js";
import {
  type OperatorControl,
  type OperatorQueries,
  type OperatorReadStore,
  operatorRpcClass,
} from "./operator-seams.js";
import { organizationService } from "./organization-rpc.js";

/** Every operator RPC is served under this path prefix: `/supertag.operator.v1.SERVICE/METHOD`. */
export const OPERATOR_RPC_PATH_PREFIX = "/supertag.operator.v1.";

const OPERATOR_RPC_MAX_BYTES = 1_000_000;

/** The credential the request gate authenticated, before the RPC's own access check. */
const authenticatedCaller = createContextKey<OperatorPrincipal | undefined>(undefined, {
  description: "authenticated operator caller",
});

/** What the request gate and the audit interceptor need, whatever services are registered. */
export interface OperatorRpcDependencies {
  readonly auditTrail: Pick<AuditTrail, "record">;
  /** Resolves an `authorization` header value; undefined when it names no known credential. */
  readonly authenticate: (
    authorization: string | undefined,
  ) => Promise<OperatorAuthentication | undefined>;
  /** False once the API Server drains; new calls then fail with `Unavailable`. */
  readonly accepting: () => boolean;
  /**
   * How often an open server stream rechecks its caller's credential; the stream heartbeat
   * interval unless a test shortens it.
   */
  readonly reauthenticateMs?: number;
}

/**
 * What the operator services read and act on. `read` and `data_write` RPCs use only the store
 * reads, the queries, the change feed and the follower; every `control` RPC changes state through
 * `control`.
 */
export interface OperatorServices {
  readonly store: OperatorReadStore;
  readonly queries: OperatorQueries;
  readonly control: OperatorControl;
  readonly changes: ChangeFeed;
  readonly follows: MessageFollower;
  /** Aborted once the API Server drains; open streams then end with `Unavailable`. */
  readonly draining: () => AbortSignal;
}

/**
 * Serves the operator RPCs with the Connect and gRPC-Web protocols. gRPC itself needs HTTP/2,
 * which this HTTP/1.1 listener does not speak, so it is off. `routes` registers the services, as
 * `registerOperatorRoutes` registers every operator service. Throws when an RPC lacks the access
 * or audit options it must declare.
 */
export function createOperatorRpcHandler(
  dependencies: OperatorRpcDependencies,
  routes: (router: ConnectRouter) => void,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const adapter = connectNodeAdapter({
    connect: true,
    grpcWeb: true,
    grpc: false,
    readMaxBytes: OPERATOR_RPC_MAX_BYTES,
    requestGate: authentication(dependencies),
    interceptors: [
      auditing(dependencies.auditTrail),
      errorMapping(),
      authorization(),
      reauthentication(dependencies),
    ],
    routes: (router) => {
      routes(router);
      for (const handler of router.handlers) assertMethodOptions(handler.method);
    },
  });
  return (request, response) =>
    new Promise<void>((resolve) => {
      response.once("close", resolve);
      adapter(request, response);
    });
}

/** Registers every operator service. Throws when an RPC has no class in `OPERATOR_RPC_CLASSES`. */
export function registerOperatorRoutes(router: ConnectRouter, dependencies: OperatorServices) {
  const { store, queries, control, changes, follows, draining } = dependencies;
  router.service(ConversationService, conversationService({ store, control, follows, draining }));
  router.service(InboxService, inboxService({ store, queries, control }));
  router.service(ObjectiveService, objectiveService({ store, queries, control }));
  router.service(EventService, eventService({ changes, store, draining }));
  router.service(OrganizationService, organizationService({ queries }));
  for (const handler of router.handlers) assertRpcClass(handler.method);
}

/** Every operator RPC has a class, and it is `read` exactly when the RPC has no side effects. */
function assertRpcClass(method: DescMethod): void {
  const name = `${method.parent.typeName}.${method.name}`;
  const rpcClass = operatorRpcClass(method);
  if (rpcClass === undefined) throw new Error(`${name} has no class in OPERATOR_RPC_CLASSES`);
  const readOnly = method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS;
  if (readOnly !== (rpcClass === "read"))
    throw new Error(
      readOnly
        ? `${name} sets idempotency_level = NO_SIDE_EFFECTS, so its class must be read`
        : `${name} can change state, so its class must not be read`,
    );
}

/** Every RPC names its operator action, and is either read-only or audited. */
function assertMethodOptions(method: DescMethod): void {
  const name = `${method.parent.typeName}.${method.name}`;
  if (!getOption(method, action))
    throw new Error(`${name} declares no (supertag.operator.v1.action)`);
  const readOnly = method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS;
  const audited = getOption(method, audit_action) !== "";
  if (readOnly && audited)
    throw new Error(
      `${name} sets idempotency_level = NO_SIDE_EFFECTS, so it must not declare (supertag.operator.v1.audit_action)`,
    );
  if (!readOnly && !audited)
    throw new Error(
      `${name} can change state, so it must declare (supertag.operator.v1.audit_action) or set idempotency_level = NO_SIDE_EFFECTS`,
    );
}

/**
 * Runs before the request body is read: refuses every call while draining, and every call without
 * a valid credential unless the RPC allows anonymous callers.
 */
function authentication(
  dependencies: OperatorRpcDependencies,
): (context: HandlerContext) => Promise<void> {
  return async (context) => {
    try {
      if (!dependencies.accepting())
        throw operatorError(Code.Unavailable, ErrorReason.DRAINING, "Control Plane is draining");
      const header = context.requestHeader.get("authorization") ?? undefined;
      if (header === undefined && getOption(context.method, allow_anonymous)) return;
      context.values.set(authenticatedCaller, await authenticated(dependencies, header));
    } catch (error) {
      throw toOperatorError(error);
    }
  };
}

/** The caller an `authorization` header names, or the `Unauthenticated` refusal. */
async function authenticated(
  dependencies: OperatorRpcDependencies,
  header: string | undefined,
): Promise<OperatorPrincipal> {
  const caller = await dependencies.authenticate(header);
  if (caller === undefined)
    throw operatorError(
      Code.Unauthenticated,
      ErrorReason.UNAUTHENTICATED,
      "A valid Control Plane admin token or Operator Token is required",
    );
  if (caller.kind === "refused")
    throw operatorError(
      Code.Unauthenticated,
      caller.reason === "revoked" ? ErrorReason.CREDENTIAL_REVOKED : ErrorReason.CREDENTIAL_EXPIRED,
      caller.message,
    );
  return caller;
}

/**
 * Rechecks an authenticated server stream's credential before an event, at most every
 * `reauthenticateMs`, so revoking or expiring an Operator Token also ends the streams it opened.
 * Open streams send a heartbeat at least that often, so an idle one is rechecked too.
 */
function reauthentication(dependencies: OperatorRpcDependencies): Interceptor {
  const everyMs = dependencies.reauthenticateMs ?? STREAM_HEARTBEAT_MS;
  return (next) => async (request) => {
    const response = await next(request);
    if (!response.stream || request.contextValues.get(authenticatedCaller) === undefined)
      return response;
    const header = request.header.get("authorization") ?? undefined;
    return {
      ...response,
      message: rechecking(response.message, everyMs, () => authenticated(dependencies, header)),
    };
  };
}

async function* rechecking<T>(
  messages: AsyncIterable<T>,
  everyMs: number,
  recheck: () => Promise<unknown>,
): AsyncIterable<T> {
  let checkedAt = Date.now();
  for await (const message of messages) {
    if (Date.now() - checkedAt >= everyMs) {
      await recheck();
      checkedAt = Date.now();
    }
    yield message;
  }
}

/** Checks that the authenticated caller may call this RPC, then attaches it as the principal. */
function authorization(): Interceptor {
  return (next) => async (request) => {
    const caller = request.contextValues.get(authenticatedCaller);
    if (caller === undefined) {
      if (!getOption(request.method, allow_anonymous))
        throw operatorError(Code.Internal, ErrorReason.INTERNAL, "Control Plane internal error");
      return next(request);
    }
    if (caller.kind === "coordination" && !getOption(request.method, allow_scoped_credential))
      throw operatorError(
        Code.PermissionDenied,
        ErrorReason.PERMISSION_DENIED,
        `A scoped coordination credential may not call ${request.method.name}`,
      );
    if (getOption(request.method, requires_admin_token) && caller.kind !== "break-glass")
      throw operatorError(
        Code.PermissionDenied,
        ErrorReason.PERMISSION_DENIED,
        `Only the admin token may call ${request.method.name}`,
      );
    const required = getOption(request.method, action);
    const actions = caller.principal.scopes.actions;
    if (!actions.includes("*") && !actions.includes(required))
      throw operatorError(
        Code.PermissionDenied,
        ErrorReason.PERMISSION_DENIED,
        `This credential does not carry the ${required} action`,
      );
    request.contextValues.set(operatorPrincipal, caller);
    return next(request);
  };
}

/**
 * Records one audit entry for each authenticated call to an RPC that declares `audit_action`, once
 * the RPC returns or fails. Refusals by the request gate are not recorded, as on the HTTP API.
 */
function auditing(auditTrail: Pick<AuditTrail, "record">): Interceptor {
  return (next) => async (request) => {
    const auditAction = getOption(request.method, audit_action);
    const caller = request.contextValues.get(authenticatedCaller);
    if (auditAction === "" || caller === undefined) return next(request);
    const note = { target: request.method.parent.name.replace(/Service$/u, "") };
    request.contextValues.set(operatorAuditTarget, note);
    let failure: Code | undefined;
    try {
      return await next(request);
    } catch (error) {
      failure = ConnectError.from(error).code;
      throw error;
    } finally {
      void auditTrail.record({
        at: new Date().toISOString(),
        actor: caller.principal.operatorId,
        action: auditAction,
        target: failure === undefined ? note.target : auditTargetKind(note.target),
        outcome: failure === undefined ? "succeeded" : "failed",
        status: failure === undefined ? 200 : codeToHttpStatus(failure),
        source: "api",
        method: request.requestMethod,
        path: `/${request.method.parent.typeName}/${request.method.name}`,
      });
    }
  };
}

const HTTP_STATUS_CODES: Readonly<Record<number, readonly [Code, ErrorReason]>> = {
  400: [Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT],
  401: [Code.Unauthenticated, ErrorReason.UNAUTHENTICATED],
  403: [Code.PermissionDenied, ErrorReason.PERMISSION_DENIED],
  404: [Code.NotFound, ErrorReason.NOT_FOUND],
  409: [Code.FailedPrecondition, ErrorReason.CONFLICT],
  413: [Code.ResourceExhausted, ErrorReason.RESOURCE_EXHAUSTED],
  429: [Code.ResourceExhausted, ErrorReason.RESOURCE_EXHAUSTED],
  503: [Code.Unavailable, ErrorReason.UNAVAILABLE],
};

const CODE_REASONS: Partial<Record<Code, ErrorReason>> = {
  [Code.InvalidArgument]: ErrorReason.INVALID_ARGUMENT,
  [Code.OutOfRange]: ErrorReason.INVALID_ARGUMENT,
  [Code.Unauthenticated]: ErrorReason.UNAUTHENTICATED,
  [Code.PermissionDenied]: ErrorReason.PERMISSION_DENIED,
  [Code.NotFound]: ErrorReason.NOT_FOUND,
  [Code.AlreadyExists]: ErrorReason.CONFLICT,
  [Code.FailedPrecondition]: ErrorReason.CONFLICT,
  [Code.Aborted]: ErrorReason.CONFLICT,
  [Code.Unavailable]: ErrorReason.UNAVAILABLE,
  [Code.ResourceExhausted]: ErrorReason.RESOURCE_EXHAUSTED,
};

const INTERNAL_CODES = new Set([Code.Internal, Code.Unknown, Code.DataLoss]);

/**
 * The refusal a caller sees: a Connect code and one `ErrorDetail`. Server failures, including any
 * TagMessagingError status this table does not know as a client error, name no internal detail.
 */
function toOperatorError(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    if (error.findDetails(ErrorDetailSchema).length > 0) return error;
    if (!INTERNAL_CODES.has(error.code))
      return operatorError(
        error.code,
        CODE_REASONS[error.code] ?? ErrorReason.UNSPECIFIED,
        error.rawMessage,
      );
  } else if (error instanceof TagMessagingError) {
    const mapped =
      HTTP_STATUS_CODES[error.statusCode] ??
      (error.statusCode >= 400 && error.statusCode < 500
        ? ([Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT] as const)
        : undefined);
    if (mapped !== undefined) return operatorError(mapped[0], mapped[1], error.message);
  }
  return operatorError(Code.Internal, ErrorReason.INTERNAL, "Control Plane internal error");
}

function errorMapping(): Interceptor {
  return (next) => async (request) => {
    try {
      const response = await next(request);
      return response.stream ? { ...response, message: mappingErrors(response.message) } : response;
    } catch (error) {
      throw toOperatorError(error);
    }
  };
}

/** A server stream's messages, failing as the operator API's errors do. */
async function* mappingErrors<T>(messages: AsyncIterable<T>): AsyncIterable<T> {
  try {
    yield* messages;
  } catch (error) {
    throw toOperatorError(error);
  }
}
