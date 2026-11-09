import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createContextKey, type HandlerContext } from "@connectrpc/connect";
import type { CoordinationOperatorPrincipal } from "@supertag/control-plane";
import { ErrorDetailSchema, ErrorReason, type FieldViolationSchema } from "@supertag/operator-api";

/** A stream sends a heartbeat after this long without another event. */
export const STREAM_HEARTBEAT_MS = 15_000;

/**
 * Who sent an operator request. `break-glass` holds the admin token and may do anything.
 * `operator-token` holds an Operator Token: everything except managing Operator Tokens, attributed
 * to `token:NAME`. `coordination` holds a static scoped credential limited to the coordination API.
 */
export type OperatorAuthentication =
  | { readonly kind: "break-glass"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "operator-token"; readonly principal: CoordinationOperatorPrincipal }
  | { readonly kind: "coordination"; readonly principal: CoordinationOperatorPrincipal }
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
 * What an audited RPC changed, as `Kind/NAME` or `Kind/ID`. It starts as the service's kind, such
 * as `Objective`, and the RPC sets it once it knows the target. A failed call records only the kind.
 */
export const operatorAuditTarget = createContextKey<{ target: string } | undefined>(undefined, {
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
