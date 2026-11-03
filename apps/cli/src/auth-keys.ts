import { parseArgs } from "node:util";
import { parseWorkerHostLabels } from "@supertag/core";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { type AuthKeyResource, CONTROL_PLANE_API_VERSION } from "./control-plane-resources.js";

export type AuthKeyCommand = "create" | "revoke";

const CREATE_USAGE =
  "supertag create auth-key NAME --tag TAG [--tag TAG ...] [--label LABEL ...] [--reusable] [--ephemeral]";

export function isAuthKeyCommand(value: string | undefined): value is AuthKeyCommand {
  return value === "create" || value === "revoke";
}

/**
 * Creates or revokes an Auth Key. `list auth-key` and `get auth-key` are ordinary resource reads.
 * The secret is printed once, on create, and never stored by the CLI.
 */
export async function runAuthKeyCommand(
  client: Pick<ControlPlaneClient, "request">,
  command: AuthKeyCommand,
  args: readonly string[],
  controlPlaneUrl: string,
): Promise<string> {
  if (command === "revoke") {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
    const name = positionals[0]?.trim();
    if (positionals.length !== 1 || !name) throw new Error("Usage: supertag revoke auth-key NAME");
    const resource = await client.request<AuthKeyResource>(
      `/api/v1/auth-keys/${encodeURIComponent(name)}/revoke`,
      { method: "POST" },
    );
    return `Revoked Auth Key ${resource.metadata.name ?? name}. It cannot join new Worker Hosts; hosts that already joined keep their enrollment.\n`;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tag: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      reusable: { type: "boolean", default: false },
      ephemeral: { type: "boolean", default: false },
    },
    strict: true,
  });
  const name = positionals[0]?.trim();
  const tags = (values.tag ?? []).map((tag) => tag.trim()).filter(Boolean);
  if (positionals.length !== 1 || !name || tags.length === 0)
    throw new Error(`Usage: ${CREATE_USAGE}`);
  const labels = parseWorkerHostLabels(values.label ?? [], "--label");
  const issued = await client.request<AuthKeyResource & { readonly secret?: unknown }>(
    "/api/v1/auth-keys",
    {
      method: "POST",
      body: JSON.stringify({
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind: "AuthKey",
        metadata: { name },
        spec: { tags, labels, reusable: values.reusable, ephemeral: values.ephemeral },
      }),
    },
  );
  if (issued?.kind !== "AuthKey" || typeof issued.secret !== "string" || !issued.secret)
    throw new Error("Control Plane returned an invalid Auth Key");
  const kind = [
    issued.spec.reusable ? "reusable" : "one-off",
    ...(issued.spec.ephemeral ? ["ephemeral"] : []),
  ].join(", ");
  const granted = issued.spec.labels ?? [];
  return `Created Auth Key ${name} (${kind}) for Tags ${issued.spec.tags.join(", ")}.
${granted.length === 0 ? "" : `Hosts that join with it get labels ${granted.join(", ")}.\n`}It expires at ${issued.status.expiresAt}.

Secret (shown only now; store it in a secret manager):
  ${issued.secret}

On the machine to join, run:
  SUPERTAG_AUTH_KEY=<secret> supertag connect worklet --control-plane ${controlPlaneUrl} --harness codex
`;
}

export function authKeyHelp(): string {
  return `Usage:
  ${CREATE_USAGE}
  supertag list auth-key
  supertag get auth-key NAME
  supertag revoke auth-key NAME

An Auth Key lets a machine join as a Worker Host with one command. Hosts that redeem it are bound
to its Tags. A one-off key joins one host and expires after one hour; a reusable key expires after
90 days. Hosts joined with an ephemeral key are removed after they disconnect.

--label adds a placement label, such as gpu, to every host that joins with the key. A Tag whose
runsOn lists labels runs only on bound hosts that carry all of them. Labels choose among hosts a
Tag may already use; they never grant access.

The secret is printed once, on create. list and get never show it. To change a key's Tags, revoke
it and create a new key; revoking never removes hosts that already joined.
`;
}
