import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  type AuthKeyResource,
  type OperatorTokenResource,
  type SurfaceAccountResource,
  type WorkerHostResource,
  workerHostResource,
} from "../apps/cli/src/control-plane-resources.ts";
import {
  authKeyMessage,
  authKeyView,
  operatorTokenMessage,
  operatorTokenView,
  surfaceAccountMessage,
  surfaceAccountView,
  workerHostMessage,
  workerHostView,
} from "../apps/cli/src/host-protos.ts";
import type { WorkerHost } from "../packages/core/src/index.ts";
import {
  AuthKeySchema,
  OperatorTokenSchema,
  SurfaceAccountSchema,
  WorkerHostSchema,
} from "../packages/operator-api/src/index.ts";

/** Sends a message over the wire as Connect JSON and reads it back. */
function overTheWire<T>(schema: Parameters<typeof create>[0], init: unknown): T {
  return fromJson(schema, toJson(schema, create(schema, init as never))) as T;
}

describe("Worker Host, Auth Key, Operator Token and Surface Account messages", () => {
  it("carry a Worker Host view to the same JSON the CLI always printed", () => {
    const at = "2026-11-09T01:02:03.456Z";
    const host: WorkerHost = {
      id: "studio",
      credentialId: "credential/studio",
      credentialRevision: 3,
      enrollmentStatus: "active",
      ephemeral: true,
      authKey: "pool",
      connectionGeneration: 7,
      connectionStatus: "connected",
      workletId: "worklet-1",
      protocolVersion: 2,
      durableProtocolVersion: 1,
      controlProtocolVersion: 1,
      workerSnapshot: {
        id: "studio",
        diskSpace: { freeBytes: 10_000_000_000, totalBytes: 50_000_000_000 },
        workers: [
          {
            id: "codex",
            type: "harness",
            capabilities: [{ id: "supertag.execution.local-process", version: 1 }],
            profiles: [{ id: "default", revision: "1" }],
            contextTypes: [{ type: "skill", versions: [1, 2] }],
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: [],
                contextTypes: [],
                harness: "codex",
                models: ["gpt-6"],
                efforts: ["low", "high"],
              },
            ],
            maxConcurrency: 2,
          },
        ],
      },
      labels: ["gpu", "rack:b"],
      grantedLabels: ["gpu"],
      ready: true,
      draining: false,
      lastSeenAt: at,
      connectedAt: at,
      disconnectedAt: at,
      lastAuthenticatedAt: at,
      lastAuthenticationFailureAt: at,
      failedAuthenticationCount: 1,
      activeAttempts: 1,
      capacity: 2,
      availableSlots: 1,
      createdAt: at,
      updatedAt: at,
    } as WorkerHost;
    for (const resource of [
      workerHostResource(host, { sandboxes: ["e2b"], placementUnknown: true }),
      workerHostResource({
        ...host,
        enrollmentStatus: "revoked",
        revokedAt: at,
        revocationReason: "OperatorRevoked",
        workletId: undefined,
        protocolVersion: undefined,
        authKey: undefined,
        workerSnapshot: {},
      } as WorkerHost),
    ] satisfies WorkerHostResource[]) {
      const read = workerHostView(overTheWire(WorkerHostSchema, workerHostMessage(resource)));
      expect(JSON.stringify(read)).toBe(JSON.stringify(resource));
    }
  });

  it("carry Auth Keys, Operator Tokens and Surface Accounts the same way", () => {
    const metadata = {
      id: "id-1",
      name: "name-1",
      resourceVersion: "abc",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    };
    const key: AuthKeyResource = {
      apiVersion: "supertag/v1",
      kind: "AuthKey",
      metadata,
      spec: { tags: ["builder"], labels: ["gpu"], reusable: true, ephemeral: false },
      status: {
        phase: "revoked",
        expiresAt: "2027-01-30T00:00:00.000Z",
        usedAt: "2026-11-03T00:00:00.000Z",
        redemptionCount: 2,
        revokedAt: "2026-11-04T00:00:00.000Z",
      },
    };
    expect(JSON.stringify(authKeyView(overTheWire(AuthKeySchema, authKeyMessage(key))))).toBe(
      JSON.stringify(key),
    );
    const token: OperatorTokenResource = {
      apiVersion: "supertag/v1",
      kind: "OperatorToken",
      metadata,
      spec: {},
      status: {
        phase: "active",
        operatorId: "token:name-1",
        expiresAt: "2027-01-30T00:00:00.000Z",
        lastUsedAt: "2026-11-03T00:00:00.000Z",
      },
    };
    expect(
      JSON.stringify(
        operatorTokenView(overTheWire(OperatorTokenSchema, operatorTokenMessage(token))),
      ),
    ).toBe(JSON.stringify(token));
    for (const secrets of [
      undefined,
      {},
      { botToken: { env: "BOT" }, appToken: { file: "app.txt" }, signing: { secretRef: "s" } },
    ]) {
      const account: SurfaceAccountResource = {
        apiVersion: "supertag/v1",
        kind: "SurfaceAccount",
        metadata: { ...metadata, resourceVersion: metadata.updatedAt },
        spec: {
          provider: "slack",
          externalAccountId: "T1",
          displayName: "Slack",
          authMethod: "slack-http",
          configuration: { transport: "http", retries: 3, nested: { on: true } },
          ...(secrets === undefined ? {} : { secrets }),
        },
        status: { phase: "retired", lastVerifiedAt: "2026-11-02T00:00:00.000Z" },
      };
      expect(
        JSON.stringify(
          surfaceAccountView(overTheWire(SurfaceAccountSchema, surfaceAccountMessage(account))),
        ),
      ).toBe(JSON.stringify(account));
    }
  });
});
