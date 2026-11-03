import { describe, expect, it } from "vitest";
import {
  workerHostCredentialIssuance,
  workerHostResource,
  workerProfileResourcesFromHost,
} from "../apps/cli/src/control-plane-resources.ts";
import type { WorkerHost } from "../packages/core/src/index.ts";

const host: WorkerHost = {
  id: "host-a",
  credentialId: "control-plane/worker-host/secret-address",
  credentialRevision: 2,
  enrollmentStatus: "active",
  connectionGeneration: 4,
  connectionStatus: "connected",
  workletId: "worklet-a",
  protocolVersion: 13,
  durableProtocolVersion: 1,
  controlProtocolVersion: 1,
  workerSnapshot: {
    id: "host-a",
    workers: [
      {
        profileCapabilities: [
          { profile: { id: "general", revision: "1" }, capabilities: [], contextTypes: [] },
        ],
        id: "worker-a",
        type: "fixture",
        capabilities: [],
        contextTypes: [],
        profiles: [{ id: "general", revision: "1" }],
      },
    ],
  },
  capacity: 2,
  availableSlots: 1,
  activeAttempts: 1,
  ready: true,
  draining: false,
  lastSeenAt: "2026-09-14T00:01:00.000Z",
  connectedAt: "2026-09-14T00:00:30.000Z",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:01:00.000Z",
};

describe("Worker Host resources", () => {
  it("projects durable status without exposing credential storage", () => {
    const resource = workerHostResource(host);

    expect(resource).toMatchObject({
      kind: "WorkerHost",
      metadata: {
        id: "host-a",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:01:00.000Z",
      },
      spec: { draining: false },
      status: {
        phase: "ready",
        credentialRevision: 2,
        connectionGeneration: 4,
        connectionStatus: "connected",
        workletId: "worklet-a",
        protocolVersion: 13,
        capacity: 2,
        availableSlots: 1,
        activeAttempts: 1,
      },
    });
    expect(JSON.stringify(resource)).not.toContain("credentialId");
    expect(JSON.stringify(resource)).not.toContain("secret-address");
  });

  it("keeps disconnected and revoked hosts visible with explicit phases", () => {
    expect(
      workerHostResource({ ...host, connectionStatus: "disconnected", ready: false }).status.phase,
    ).toBe("unreachable");
    expect(
      workerHostResource({ ...host, enrollmentStatus: "revoked", ready: false }).status.phase,
    ).toBe("revoked");
  });

  it("derives Worker Profiles only from a valid durable descriptor snapshot", () => {
    expect(workerProfileResourcesFromHost(host, host.updatedAt)).toMatchObject([
      {
        kind: "WorkerProfile",
        metadata: { name: "general@1" },
        status: { workerHostId: "host-a", workletId: "worklet-a", workerId: "worker-a" },
      },
    ]);
    expect(
      workerProfileResourcesFromHost(
        { ...host, workerSnapshot: { id: "another-host", workers: [] } },
        host.updatedAt,
      ),
    ).toEqual([]);
  });

  it("projects only canonical descriptor fields from an untrusted Worklet snapshot", () => {
    const worker = (host.workerSnapshot["workers"] as unknown[])[0] as Record<string, unknown>;
    const resource = workerHostResource({
      ...host,
      workerSnapshot: {
        id: "host-a",
        enrollmentToken: "must-not-escape",
        workers: [{ ...worker, secret: "must-not-escape" }],
      },
    });

    expect(JSON.stringify(resource)).not.toContain("must-not-escape");
    expect(resource.status.workers).toHaveLength(1);
  });

  it("isolates the one-time credential in a dedicated issuance response", () => {
    const issuance = workerHostCredentialIssuance(
      "host-a",
      "one-time-token",
      "2026-09-14T00:02:00.000Z",
    );

    expect(issuance).toEqual({
      apiVersion: "supertag/v1",
      kind: "WorkerHostCredential",
      metadata: { workerHostId: "host-a", issuedAt: "2026-09-14T00:02:00.000Z" },
      credential: { token: "one-time-token" },
    });
  });
});
