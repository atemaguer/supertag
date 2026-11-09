import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createContextKey, type HandlerContext } from "@connectrpc/connect";
import type { CoordinationOperatorPrincipal } from "@supertag/control-plane";
import { ErrorDetailSchema, ErrorReason, type FieldViolationSchema } from "@supertag/operator-api";

/** A stream sends a heartbeat after this long without another event. */
export const STREAM_HEARTBEAT_MS = 15_000;

/** An idempotency key is 1 to 200 characters without whitespace or control characters. */
export const IDEMPOTENCY_KEY = /^[^\s\p{Cc}]{1,200}$/u;

/**
 * Who sent an operator request. `break-glass` holds the admin token and may do anything.
 * `operator-token` holds an Operator Token: everything except managing Operator Tokens, attributed
 * to `token:NAME`. `coordination` holds a static scoped credential limited to the coordination API.
 * `worker-host` holds a Worker Host's own credential, attributed to `worker-host:ID`, and reaches
 * only the RPCs that act on that host.
 */
export type OperatorAuthentication =
  | { readonly kind: "break-glass"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "operator-token"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "coordination"; readonly principal: CoordinationOperatorPrincipal }
  | {
      readonly kind: "worker-host";
      readonly workerHostId: string;
      readonly principal: CoordinationOperatorPrincipal;
    }
  | {
      readonly kind: "refused";
      readonly reason: "revoked" | "expired";
      readonly message: string;
    };

export type OperatorPrincipal = Exclude<OperatorAuthentication, { readonly kind: "refused" }>;

/** The authenticated caller of an operator RPC; undefined for an anonymous call it allows. */
export const operatorPrincipal = createContextKey<OperatorPrincipal | undefined>(undefined, {
  description: "operator principal",
});

/**
 * The bearer token of a call to an RPC that sets `requires_auth_key`, an Auth Key the Control
 * Plane knows, which the RPC redeems.
 */
export const presentedAuthKey = createContextKey<string | undefined>(undefined, {
  description: "presented Auth Key",
});

/** The header that names the Worker Host whose own credential is the bearer token. */
export const WORKER_HOST_ID_HEADER = "x-supertag-worker-host-id";

/** The caller's address as the API listener's socket reports it; never read from a header. */
export const operatorPeerAddress = createContextKey<string | undefined>(undefined, {
  description: "operator peer address",
});

/** One change an audited RPC made, when one call makes several. */
export interface OperatorAuditChange {
  /** The change's action; the RPC's `audit_action` when unset. */
  readonly action?: string;
  /** `Kind/NAME` or `Kind/ID`; a failed change records only the kind. */
  readonly target: string;
  /** Set when this change failed although the call succeeded. */
  readonly failure?: Code;
}

export interface OperatorAuditNote {
  target: string;
  /** Who the entry names when the call carried no authenticated credential, such as an Auth Key. */
  actor?: string;
  preview?: boolean;
  changes?: readonly OperatorAuditChange[];
}

/**
 * What an audited RPC changed, as `Kind/NAME` or `Kind/ID`. It starts as the service's kind, such
 * as `Objective`, and the RPC sets it once it knows the target. A failed call records only the kind.
 * A call that only previews a change, such as a dry run, sets `preview` and is not recorded. A call
 * that succeeds after making several changes lists them in `changes`, one entry each.
 */
export const operatorAuditTarget = createContextKey<OperatorAuditNote | undefined>(undefined, {
  description: "operator audit target",
});

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

/** The operator who holds a conversation: the admin token is `admin`, an Operator Token its own. */
export function conversationOperator(context: HandlerContext): string {
  const caller = context.values.get(operatorPrincipal);
  if (caller === undefined)
    throw operatorError(Code.Internal, ErrorReason.INTERNAL, "Control Plane internal error");
  return caller.kind === "break-glass" ? "admin" : caller.principal.operatorId;
}

export function drainingError() {
  return operatorError(Code.Unavailable, ErrorReason.DRAINING, "Control Plane is draining");
}

/** Names what an audited RPC changes, as `Kind/NAME` or `Kind/ID`, or only its kind. */
export function noteAuditTarget(context: HandlerContext, target: string): void {
  const note = context.values.get(operatorAuditTarget);
  if (note !== undefined) note.target = target;
}

/** Names who an audited call without an authenticated credential acted as, such as `auth-key:NAME`. */
export function noteAuditActor(context: HandlerContext, actor: string): void {
  const note = context.values.get(operatorAuditTarget);
  if (note !== undefined) note.actor = actor;
}

/** Lists what a successful audited call changed, recorded as one entry each instead of one for the call. */
export function noteAuditChanges(
  context: HandlerContext,
  changes: readonly OperatorAuditChange[],
): void {
  const note = context.values.get(operatorAuditTarget);
  if (note !== undefined) note.changes = changes;
}

/** Marks an audited RPC's call as a preview that changes nothing, which the audit trail skips. */
export function noteAuditPreview(context: HandlerContext): void {
  const note = context.values.get(operatorAuditTarget);
  if (note !== undefined) note.preview = true;
}

/** A request field that must not be empty, trimmed; `InvalidArgument` naming it otherwise. */
export function requiredField(value: string, path: string, description: string): string {
  const trimmed = value.trim();
  if (trimmed === "")
    throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, `${path} is required`, [
      { path, description },
    ]);
  return trimmed;
}
