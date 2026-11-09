import { create, toJson } from "@bufbuild/protobuf";
import type { WorkerHostResource } from "../../apps/cli/src/control-plane-resources.ts";
import { workerHostMessage } from "../../apps/cli/src/host-protos.ts";
import {
  ListWorkerHostsResponseSchema,
  WorkerHostSchema,
} from "../../packages/operator-api/src/index.ts";
import { type FakeRpcHandler, fakeOperatorRpc } from "./fake-operator-rpc.ts";

/**
 * A Worker Host view as `HostService` serves it, from a partial `WorkerHost` resource with the
 * rest defaulted, encoded as the RPC's proto JSON.
 */
export function workerHostJson(view: Record<string, unknown>) {
  return toJson(
    WorkerHostSchema,
    create(WorkerHostSchema, workerHostMessage(workerHostResourceOf(view))),
  );
}

/**
 * Serves Worker Host views over `HostService.ListWorkerHosts` and `GetWorkerHost`, and any
 * further handlers, as `fakeOperatorRpc` does.
 */
export function fakeHostRpc(
  hosts: readonly Record<string, unknown>[],
  handlers: Readonly<Record<string, FakeRpcHandler>> = {},
) {
  const byId = new Map(
    hosts.map((view) => [String((view["metadata"] as { id: string }).id), view] as const),
  );
  return fakeOperatorRpc({
    "HostService/ListWorkerHosts": () =>
      toJson(
        ListWorkerHostsResponseSchema,
        create(ListWorkerHostsResponseSchema, {
          workerHosts: hosts.map((view) =>
            create(WorkerHostSchema, workerHostMessage(workerHostResourceOf(view))),
          ),
        }),
      ),
    "HostService/GetWorkerHost": (body) => {
      const view = byId.get(String(body["id"]));
      if (view === undefined) throw new Error(`unexpected Worker Host ${String(body["id"])}`);
      return workerHostJson(view);
    },
    ...handlers,
  });
}

/** A partial `WorkerHost` resource with the rest defaulted, as the CLI reads it back. */
export function workerHostResourceOf(view: Record<string, unknown>): WorkerHostResource {
  const metadata = view["metadata"] as { id: string } & Record<string, unknown>;
  const status = (view["status"] ?? {}) as Record<string, unknown>;
  const workers = (status["workers"] ?? []) as Record<string, unknown>[];
  return {
    apiVersion: "supertag/v1",
    kind: "WorkerHost",
    metadata: { name: metadata.id, resourceVersion: "", createdAt: "", updatedAt: "", ...metadata },
    spec: { draining: false, ...(view["spec"] as object | undefined) },
    status: {
      phase: "connected",
      ephemeral: false,
      credentialRevision: 1,
      connectionGeneration: 1,
      connectionStatus: "connected",
      workspaces: [],
      labels: [],
      grantedLabels: [],
      ready: false,
      failedAuthenticationCount: 0,
      activeAttempts: 0,
      capacity: 0,
      availableSlots: 0,
      ...status,
      workers: workers.map((worker) => ({
        capabilities: [],
        profiles: [],
        contextTypes: [],
        profileCapabilities: [],
        ...worker,
      })),
    } as WorkerHostResource["status"],
  };
}
