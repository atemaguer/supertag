import { parseArgs } from "node:util";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { operatorTokenView } from "./host-protos.js";
import { accessClient, refusedAsError } from "./operator-client.js";

export type OperatorTokenCommand = "create" | "revoke";

export function isOperatorTokenCommand(value: string | undefined): value is OperatorTokenCommand {
  return value === "create" || value === "revoke";
}

/**
 * Creates or revokes an Operator Token. `list operator-token` and `get operator-token` are
 * ordinary resource reads. The secret is printed once, on create, and never stored by the CLI.
 */
export async function runOperatorTokenCommand(
  client: Pick<ControlPlaneClient, "operator">,
  command: OperatorTokenCommand,
  args: readonly string[],
  controlPlaneUrl: string,
): Promise<string> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  const name = positionals[0]?.trim();
  if (positionals.length !== 1 || !name)
    throw new Error(`Usage: supertag ${command} operator-token NAME`);
  const access = accessClient(client.operator);
  if (command === "revoke") {
    const resource = operatorTokenView(await adminOnly(() => access.revokeOperatorToken({ name })));
    return `Revoked Operator Token ${resource.metadata.name ?? name}. Requests that present it are refused from now on.\n`;
  }
  const created = await adminOnly(() => access.createOperatorToken({ name }));
  if (created.operatorToken === undefined || !created.secret)
    throw new Error("Control Plane returned an invalid Operator Token");
  const issued = { ...operatorTokenView(created.operatorToken), secret: created.secret };
  return `Created Operator Token ${name}. Changes made with it are recorded as ${issued.status.operatorId}.
It expires at ${issued.status.expiresAt}.

Secret (shown only now; send it to its holder over a private channel):
  ${issued.secret}

On the machine that uses it, run this and paste the secret at the prompt:
  supertag connect control-plane ${controlPlaneUrl}
`;
}

/** Calls an `AccessService` RPC; a credential other than the admin token is refused. */
function adminOnly<T>(call: () => Promise<T>): Promise<T> {
  return refusedAsError(async () => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.PermissionDenied)
        throw new Error("Only the admin token manages Operator Tokens");
      throw error;
    }
  });
}

export function operatorTokenHelp(): string {
  return `Usage:
  supertag create operator-token NAME
  supertag list operator-token
  supertag get operator-token NAME
  supertag revoke operator-token NAME

An Operator Token lets one teammate or machine manage a shared Control Plane without the admin
token. SuperTag records the changes it makes, such as approvals, messages, cancellations, and
applies, as token:NAME. Only the admin token creates, lists, and revokes Operator Tokens; an
Operator Token can do everything else the admin token can.

A token expires 90 days after it is created. Revoking it refuses it immediately. Names are
never reused, so a record that names token:NAME always means the same token.

The secret is printed once, on create. list and get show the name, phase, expiry, last use, and
revocation, never the secret. The holder saves it with supertag connect control-plane URL, which
reads it from a masked prompt or SUPERTAG_OPERATOR_TOKEN.
`;
}
