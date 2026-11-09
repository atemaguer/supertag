import type { JsonObject, MessageInitShape } from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type {
  ConnectedSurfaceProvider,
  JsonRecord,
  SurfaceSecretReference as SecretReference,
} from "@supertag/core";
import {
  type AuthKey,
  AuthKeyPhase,
  type AuthKeySchema,
  type Metadata,
  type MetadataSchema,
  type OperatorToken,
  OperatorTokenPhase,
  type OperatorTokenSchema,
  type SurfaceAccount,
  SurfaceAccountPhase,
  type SurfaceAccountSchema,
  SurfaceProvider,
  type SurfaceSecretReference,
  type WorkerHost,
  WorkerHostConnection,
  type WorkerHostCredential,
  WorkerHostPhase,
  type WorkerHostSchema,
} from "@supertag/operator-api";
import {
  type AuthKeyResource,
  CONTROL_PLANE_API_VERSION,
  type OperatorTokenResource,
  type ResourceMetadata,
  type SurfaceAccountResource,
  type WorkerHostCredentialIssuance,
  type WorkerHostResource,
  workerDescriptor,
} from "./control-plane-resources.js";
import { isoOf, timestampOf } from "./objective-protos.js";

/**
 * Worker Hosts, Auth Keys, Operator Tokens and Surface Accounts in both directions: from the
 * resource views the Control Plane builds to the operator API's messages, and back to the same
 * views, so the CLI prints what it always printed.
 */

type WorkerHostStatus = WorkerHostResource["status"];

export const WORKER_HOST_PHASES = {
  connected: WorkerHostPhase.CONNECTED,
  draining: WorkerHostPhase.DRAINING,
  ready: WorkerHostPhase.READY,
  revoked: WorkerHostPhase.REVOKED,
  unreachable: WorkerHostPhase.UNREACHABLE,
} as const satisfies Record<WorkerHostStatus["phase"], WorkerHostPhase>;

export const SURFACE_PROVIDERS = {
  slack: SurfaceProvider.SLACK,
  github: SurfaceProvider.GITHUB,
  lark: SurfaceProvider.LARK,
  linear: SurfaceProvider.LINEAR,
  teams: SurfaceProvider.TEAMS,
} as const satisfies Record<ConnectedSurfaceProvider, SurfaceProvider>;

const AUTH_KEY_PHASES = {
  active: AuthKeyPhase.ACTIVE,
  used: AuthKeyPhase.USED,
  expired: AuthKeyPhase.EXPIRED,
  revoked: AuthKeyPhase.REVOKED,
} as const satisfies Record<AuthKeyResource["status"]["phase"], AuthKeyPhase>;

const OPERATOR_TOKEN_PHASES = {
  active: OperatorTokenPhase.ACTIVE,
  expired: OperatorTokenPhase.EXPIRED,
  revoked: OperatorTokenPhase.REVOKED,
} as const satisfies Record<OperatorTokenResource["status"]["phase"], OperatorTokenPhase>;

/** The name of an enum value in a table such as `WORKER_HOST_PHASES`; undefined when unknown. */
export function nameOf<Name extends string, Value>(
  table: Readonly<Record<Name, Value>>,
  value: Value,
): Name | undefined {
  return (Object.keys(table) as Name[]).find((name) => table[name] === value);
}

function known<Name extends string, Value>(
  table: Readonly<Record<Name, Value>>,
  value: Value,
  what: string,
): Name {
  const name = nameOf(table, value);
  if (name === undefined) throw new Error(`Control Plane returned an unknown ${what}`);
  return name;
}

export const optionalTimestamp = <K extends string>(key: K, iso: string | undefined) =>
  (iso === undefined ? {} : { [key]: timestampOf(iso) }) as Partial<Record<K, Timestamp>>;

export const optionalIso = <K extends string>(key: K, timestamp: Timestamp | undefined) =>
  (timestamp === undefined ? {} : { [key]: isoOf(timestamp) }) as Partial<Record<K, string>>;

export function metadataMessage(
  metadata: ResourceMetadata,
): MessageInitShape<typeof MetadataSchema> {
  return {
    id: metadata.id,
    name: metadata.name ?? "",
    resourceVersion: metadata.resourceVersion,
    ...optionalTimestamp("createdAt", metadata.createdAt),
    ...optionalTimestamp("updatedAt", metadata.updatedAt),
  };
}

export function metadataView(metadata: Metadata | undefined): ResourceMetadata {
  if (metadata === undefined) throw new Error("Control Plane returned a resource without metadata");
  return {
    id: metadata.id,
    name: metadata.name,
    resourceVersion: metadata.resourceVersion,
    createdAt: isoOf(metadata.createdAt) ?? "",
    updatedAt: isoOf(metadata.updatedAt) ?? "",
  };
}

// Worker Hosts.

export function workerHostMessage(
  resource: WorkerHostResource,
): MessageInitShape<typeof WorkerHostSchema> {
  const { status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    draining: resource.spec.draining,
    phase: WORKER_HOST_PHASES[status.phase],
    ...(status.diskSpace === undefined
      ? {}
      : {
          diskSpace: {
            freeBytes: BigInt(status.diskSpace.freeBytes),
            totalBytes: BigInt(status.diskSpace.totalBytes),
          },
        }),
    ephemeral: status.ephemeral,
    ...(status.storage === undefined
      ? {}
      : {
          storage: {
            sandboxes: [...status.storage.sandboxes],
            placementUnknown: status.storage.placementUnknown,
          },
        }),
    authKey: status.authKey ?? "",
    credentialRevision: BigInt(status.credentialRevision),
    connectionGeneration: BigInt(status.connectionGeneration),
    connectionStatus:
      status.connectionStatus === "connected"
        ? WorkerHostConnection.CONNECTED
        : WorkerHostConnection.DISCONNECTED,
    workletId: status.workletId ?? "",
    ...(status.protocolVersion === undefined ? {} : { protocolVersion: status.protocolVersion }),
    ...(status.durableProtocolVersion === undefined
      ? {}
      : { durableProtocolVersion: status.durableProtocolVersion }),
    ...(status.controlProtocolVersion === undefined
      ? {}
      : { controlProtocolVersion: status.controlProtocolVersion }),
    workers: status.workers.map((worker) => JSON.parse(JSON.stringify(worker)) as JsonObject),
    workspaces: [...status.workspaces],
    labels: [...status.labels],
    grantedLabels: [...status.grantedLabels],
    ready: status.ready,
    ...optionalTimestamp("lastAuthenticatedAt", status.lastAuthenticatedAt),
    failedAuthenticationCount: status.failedAuthenticationCount,
    ...optionalTimestamp("lastAuthenticationFailureAt", status.lastAuthenticationFailureAt),
    ...optionalTimestamp("lastSeenAt", status.lastSeenAt),
    ...optionalTimestamp("connectedAt", status.connectedAt),
    ...optionalTimestamp("disconnectedAt", status.disconnectedAt),
    ...optionalTimestamp("revokedAt", status.revokedAt),
    revocationReason: status.revocationReason ?? "",
    activeAttempts: status.activeAttempts,
    capacity: status.capacity,
    availableSlots: status.availableSlots,
  };
}

/** A Worker Host as the `WorkerHost` resource the CLI prints. */
export function workerHostView(host: WorkerHost): WorkerHostResource {
  const metadata = metadataView(host.metadata);
  const workers = host.workers.map((worker) => {
    const descriptor = workerDescriptor(worker);
    if (descriptor === undefined)
      throw new Error("Control Plane returned an invalid Worker descriptor");
    return descriptor;
  });
  const status: WorkerHostStatus = {
    phase: known(WORKER_HOST_PHASES, host.phase, "Worker Host phase"),
    ...(host.diskSpace === undefined
      ? {}
      : {
          diskSpace: {
            freeBytes: Number(host.diskSpace.freeBytes),
            totalBytes: Number(host.diskSpace.totalBytes),
          },
        }),
    ephemeral: host.ephemeral,
    ...(host.storage === undefined
      ? {}
      : {
          storage: {
            sandboxes: [...host.storage.sandboxes],
            placementUnknown: host.storage.placementUnknown,
          },
        }),
    ...(host.authKey === "" ? {} : { authKey: host.authKey }),
    credentialRevision: Number(host.credentialRevision),
    connectionGeneration: Number(host.connectionGeneration),
    connectionStatus:
      host.connectionStatus === WorkerHostConnection.CONNECTED ? "connected" : "disconnected",
    ...(host.workletId === "" ? {} : { workletId: host.workletId }),
    ...(host.protocolVersion === undefined ? {} : { protocolVersion: host.protocolVersion }),
    ...(host.durableProtocolVersion === undefined
      ? {}
      : { durableProtocolVersion: host.durableProtocolVersion }),
    ...(host.controlProtocolVersion === undefined
      ? {}
      : { controlProtocolVersion: host.controlProtocolVersion }),
    workers,
    workspaces: [...host.workspaces],
    labels: [...host.labels],
    grantedLabels: [...host.grantedLabels],
    ready: host.ready,
    ...optionalIso("lastAuthenticatedAt", host.lastAuthenticatedAt),
    failedAuthenticationCount: host.failedAuthenticationCount,
    ...optionalIso("lastAuthenticationFailureAt", host.lastAuthenticationFailureAt),
    ...optionalIso("lastSeenAt", host.lastSeenAt),
    ...optionalIso("connectedAt", host.connectedAt),
    ...optionalIso("disconnectedAt", host.disconnectedAt),
    ...optionalIso("revokedAt", host.revokedAt),
    ...(host.revocationReason === "" ? {} : { revocationReason: host.revocationReason }),
    activeAttempts: host.activeAttempts,
    capacity: host.capacity,
    availableSlots: host.availableSlots,
  };
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "WorkerHost",
    metadata,
    spec: { draining: host.draining },
    status,
  };
}

/** A Worker Host credential as `enroll worker-host` and `rotate worker-host-credential` read it. */
export function workerHostCredentialView(
  credential: WorkerHostCredential,
): WorkerHostCredentialIssuance {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "WorkerHostCredential",
    metadata: {
      workerHostId: credential.workerHostId,
      issuedAt: isoOf(credential.issuedAt) ?? "",
    },
    credential: { token: credential.token },
  };
}

// Auth Keys.

export function authKeyMessage(resource: AuthKeyResource): MessageInitShape<typeof AuthKeySchema> {
  const { spec, status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    tags: [...spec.tags],
    labels: [...spec.labels],
    reusable: spec.reusable,
    ephemeral: spec.ephemeral,
    phase: AUTH_KEY_PHASES[status.phase],
    ...optionalTimestamp("expiresAt", status.expiresAt),
    ...optionalTimestamp("usedAt", status.usedAt),
    redemptionCount: status.redemptionCount,
    ...optionalTimestamp("revokedAt", status.revokedAt),
  };
}

export function authKeyView(key: AuthKey): AuthKeyResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "AuthKey",
    metadata: metadataView(key.metadata),
    spec: {
      tags: [...key.tags],
      labels: [...key.labels],
      reusable: key.reusable,
      ephemeral: key.ephemeral,
    },
    status: {
      phase: known(AUTH_KEY_PHASES, key.phase, "Auth Key phase"),
      expiresAt: isoOf(key.expiresAt) ?? "",
      ...optionalIso("usedAt", key.usedAt),
      redemptionCount: key.redemptionCount,
      ...optionalIso("revokedAt", key.revokedAt),
    },
  };
}

// Operator Tokens.

export function operatorTokenMessage(
  resource: OperatorTokenResource,
): MessageInitShape<typeof OperatorTokenSchema> {
  const { status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    phase: OPERATOR_TOKEN_PHASES[status.phase],
    operatorId: status.operatorId,
    ...optionalTimestamp("expiresAt", status.expiresAt),
    ...optionalTimestamp("lastUsedAt", status.lastUsedAt),
    ...optionalTimestamp("revokedAt", status.revokedAt),
  };
}

export function operatorTokenView(token: OperatorToken): OperatorTokenResource {
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "OperatorToken",
    metadata: metadataView(token.metadata),
    spec: {},
    status: {
      phase: known(OPERATOR_TOKEN_PHASES, token.phase, "Operator Token phase"),
      operatorId: token.operatorId,
      expiresAt: isoOf(token.expiresAt) ?? "",
      ...optionalIso("lastUsedAt", token.lastUsedAt),
      ...optionalIso("revokedAt", token.revokedAt),
    },
  };
}

// Surface Accounts.

export function surfaceAccountMessage(
  resource: SurfaceAccountResource,
): MessageInitShape<typeof SurfaceAccountSchema> {
  const { spec, status } = resource;
  return {
    metadata: metadataMessage(resource.metadata),
    provider:
      spec.provider === "cli" ? SurfaceProvider.UNSPECIFIED : SURFACE_PROVIDERS[spec.provider],
    externalAccountId: spec.externalAccountId,
    displayName: spec.displayName,
    authMethod: spec.authMethod,
    configuration: JSON.parse(JSON.stringify(spec.configuration)) as JsonObject,
    ...(spec.secrets === undefined
      ? {}
      : {
          secrets: {
            references: Object.fromEntries(
              Object.entries(spec.secrets).map(([name, reference]) => [
                name,
                { source: secretSource(reference) },
              ]),
            ),
          },
        }),
    phase:
      status.phase === "connected" ? SurfaceAccountPhase.CONNECTED : SurfaceAccountPhase.RETIRED,
    ...optionalTimestamp("lastVerifiedAt", status.lastVerifiedAt),
  };
}

function secretSource(reference: SecretReference) {
  if ("secretRef" in reference) return { case: "secretRef" as const, value: reference.secretRef };
  if ("env" in reference) return { case: "env" as const, value: reference.env };
  return { case: "file" as const, value: reference.file };
}

export function surfaceAccountView(account: SurfaceAccount): SurfaceAccountResource {
  const secrets =
    account.secrets === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(account.secrets.references).map(([name, reference]) => [
            name,
            secretReferenceView(reference),
          ]),
        );
  return {
    apiVersion: CONTROL_PLANE_API_VERSION,
    kind: "SurfaceAccount",
    metadata: metadataView(account.metadata),
    spec: {
      provider: known(SURFACE_PROVIDERS, account.provider, "collaboration surface"),
      externalAccountId: account.externalAccountId,
      displayName: account.displayName,
      authMethod: account.authMethod,
      configuration: (account.configuration ?? {}) as JsonRecord,
      ...(secrets === undefined ? {} : { secrets }),
    },
    status: {
      phase: account.phase === SurfaceAccountPhase.RETIRED ? "retired" : "connected",
      lastVerifiedAt: isoOf(account.lastVerifiedAt) ?? "",
    },
  };
}

function secretReferenceView(reference: SurfaceSecretReference): SecretReference {
  const { source } = reference;
  if (source.case === "secretRef") return { secretRef: source.value };
  if (source.case === "env") return { env: source.value };
  if (source.case === "file") return { file: source.value };
  throw new Error("Control Plane returned a secret reference without a source");
}
