import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DescMethod, getOption, type MessageInitShape } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel, timestampFromDate } from "@bufbuild/protobuf/wkt";
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
import type { ControlPlane } from "@supertag/control-plane";
import { TagMessagingError } from "@supertag/core";
import {
  action,
  allow_anonymous,
  audit_action,
  ControllerPhase,
  ControlPlanePhase,
  ErrorDetailSchema,
  ErrorReason,
  type FieldViolationSchema,
  OrganizationService,
  requires_admin_token,
} from "@supertag/operator-api";
import { type AuditTrail, auditTargetKind } from "./audit-trail.js";
import type { OperatorAuthentication } from "./control-plane-api.js";
import type { SurfaceController } from "./gateway-surfaces.js";

/** Every operator RPC is served under this path prefix: `/supertag.operator.v1.SERVICE/METHOD`. */
export const OPERATOR_RPC_PATH_PREFIX = "/supertag.operator.v1.";

const OPERATOR_RPC_MAX_BYTES = 1_000_000;

type Principal = Exclude<OperatorAuthentication, { readonly kind: "refused" }>;

/** The authenticated caller of an operator RPC; undefined for an anonymous call it allows. */
export const operatorPrincipal = createContextKey<Principal | undefined>(undefined, {
  description: "operator principal",
});

/**
 * What an audited RPC changed, as `Kind/NAME` or `Kind/ID`. It starts as the service's kind, such
 * as `Objective`, and the RPC sets it once it knows the target. A failed call records only the kind.
 */
export const operatorAuditTarget = createContextKey<{ target: string } | undefined>(undefined, {
  description: "operator audit target",
});

/** The credential the request gate authenticated, before the RPC's own access check. */
const authenticatedCaller = createContextKey<Principal | undefined>(undefined, {
  description: "authenticated operator caller",
});

export interface OperatorRpcDependencies {
  readonly controlPlane: Pick<ControlPlane, "isAccepting" | "controllerStatuses">;
  readonly surfaceController: Pick<SurfaceController, "name" | "status">;
  readonly startedAt: string;
  readonly auditTrail: Pick<AuditTrail, "record">;
  /** Resolves an `authorization` header value; undefined when it names no known credential. */
  readonly authenticate: (
    authorization: string | undefined,
  ) => Promise<OperatorAuthentication | undefined>;
  /** False once the API Server drains; new calls then fail with `Unavailable`. */
  readonly accepting: () => boolean;
}

/** A refusal carrying the `ErrorDetail` every operator RPC error has. */
export function operatorError(
  code: Code,
  reason: ErrorReason,
  message: string,
  fields: readonly MessageInitShape<typeof FieldViolationSchema>[] = [],
): ConnectError {
  return new ConnectError(message, code, undefined, [
    { desc: ErrorDetailSchema, value: { reason, fields: [...fields] } },
  ]);
}

/**
 * Serves the operator RPCs with the Connect and gRPC-Web protocols. gRPC itself needs HTTP/2,
 * which this HTTP/1.1 listener does not speak, so it is off. `routes` registers the services; it
 * defaults to every operator service. Throws when an RPC lacks the access or audit options it must
 * declare.
 */
export function createOperatorRpcHandler(
  dependencies: OperatorRpcDependencies,
  routes: (router: ConnectRouter) => void = (router) =>
    registerOperatorRoutes(router, dependencies),
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const adapter = connectNodeAdapter({
    connect: true,
    grpcWeb: true,
    grpc: false,
    readMaxBytes: OPERATOR_RPC_MAX_BYTES,
    requestGate: authentication(dependencies),
    interceptors: [auditing(dependencies.auditTrail), errorMapping(), authorization()],
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

function registerOperatorRoutes(router: ConnectRouter, dependencies: OperatorRpcDependencies) {
  router.service(OrganizationService, {
    getStatus() {
      const accepting = dependencies.controlPlane.isAccepting;
      const controllers = [
        ...dependencies.controlPlane.controllerStatuses,
        {
          name: dependencies.surfaceController.name,
          phase:
            dependencies.surfaceController.status().errors.length === 0 ? "running" : "degraded",
        },
      ];
      return {
        metadata: {
          id: "control-plane",
          name: "control-plane",
          resourceVersion: createHash("sha256")
            .update(JSON.stringify({ accepting, controllers }))
            .digest("hex"),
          createdAt: timestampFromDate(new Date(dependencies.startedAt)),
          updatedAt: timestampFromDate(new Date()),
        },
        phase: accepting ? ControlPlanePhase.ACCEPTING : ControlPlanePhase.DRAINING,
        controllers: controllers.map(({ name, phase }) => ({
          name,
          phase: CONTROLLER_PHASES[phase] ?? ControllerPhase.UNSPECIFIED,
        })),
      };
    },
  });
}

const CONTROLLER_PHASES: Readonly<Record<string, ControllerPhase>> = {
  running: ControllerPhase.RUNNING,
  degraded: ControllerPhase.DEGRADED,
  draining: ControllerPhase.DRAINING,
  stopped: ControllerPhase.STOPPED,
  disabled: ControllerPhase.DISABLED,
};

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
          caller.reason === "revoked"
            ? ErrorReason.CREDENTIAL_REVOKED
            : ErrorReason.CREDENTIAL_EXPIRED,
          caller.message,
        );
      context.values.set(authenticatedCaller, caller);
    } catch (error) {
      throw toOperatorError(error);
    }
  };
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
    // Scoped coordination credentials reach only the coordination API until it moves here.
    if (caller.kind === "coordination")
      throw operatorError(
        Code.PermissionDenied,
        ErrorReason.PERMISSION_DENIED,
        "This operator credential is limited to the coordination API",
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
      return await next(request);
    } catch (error) {
      throw toOperatorError(error);
    }
  };
}
