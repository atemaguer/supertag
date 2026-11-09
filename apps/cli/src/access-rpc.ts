import { create } from "@bufbuild/protobuf";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { type OperatorToken as OperatorTokenRecord, parseOperatorTokenName } from "@supertag/core";
import { type AccessService, ErrorReason, OperatorTokenSchema } from "@supertag/operator-api";
import { operatorTokenResource } from "./control-plane-resources.js";
import { operatorTokenMessage } from "./host-protos.js";
import { invalidAsArgument } from "./host-rpc.js";
import { assertAccepting } from "./inbox-rpc.js";
import { pageOf } from "./operator-pages.js";
import { noteAuditTarget, operatorError, requiredField } from "./operator-rpc-context.js";
import type { OperatorControl, OperatorReadStore } from "./operator-seams.js";

export interface AccessServiceDependencies {
  readonly store: Pick<OperatorReadStore, "findOperatorTokenByName" | "listOperatorTokens">;
  /** Creates and revokes Operator Tokens. */
  readonly control: Pick<
    OperatorControl,
    "accepting" | "createOperatorToken" | "revokeOperatorToken"
  >;
}

/**
 * `AccessService`: the Operator Tokens of the Control Plane. Every RPC declares
 * `requires_admin_token`, so the request gate refuses any other credential before these run.
 */
export function accessService(
  dependencies: AccessServiceDependencies,
): ServiceImpl<typeof AccessService> {
  const { store, control } = dependencies;
  const message = (token: OperatorTokenRecord) =>
    create(OperatorTokenSchema, operatorTokenMessage(operatorTokenResource(token)));
  const tokenName = (name: string) => requiredField(name, "name", "an Operator Token's name");
  return {
    async createOperatorToken(request, context) {
      noteAuditTarget(context, "OperatorToken");
      const name = invalidAsArgument("name", () => parseOperatorTokenName(request.name));
      await assertAccepting(control);
      const issued = await control.createOperatorToken(name);
      noteAuditTarget(context, `OperatorToken/${issued.operatorToken.name}`);
      return { operatorToken: message(issued.operatorToken), secret: issued.secret };
    },

    async listOperatorTokens(request) {
      const { page, nextPageToken } = pageOf(await store.listOperatorTokens(), request);
      return { operatorTokens: page.map(message), nextPageToken };
    },

    async getOperatorToken(request) {
      const name = tokenName(request.name);
      const token = await store.findOperatorTokenByName(name);
      if (token === undefined) throw missingOperatorToken(name);
      return message(token);
    },

    async revokeOperatorToken(request, context) {
      noteAuditTarget(context, "OperatorToken");
      const name = tokenName(request.name);
      noteAuditTarget(context, `OperatorToken/${name}`);
      await assertAccepting(control);
      const token = await control.revokeOperatorToken(name);
      if (token === undefined) throw missingOperatorToken(name);
      return message(token);
    },
  };
}

function missingOperatorToken(name: string) {
  return operatorError(
    Code.NotFound,
    ErrorReason.NOT_FOUND,
    `Operator Token ${name} does not exist`,
    [{ path: "name", description: "an Operator Token's name" }],
  );
}
