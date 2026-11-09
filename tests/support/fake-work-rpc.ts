import { create, toJson } from "@bufbuild/protobuf";
import { taskMessage } from "../../apps/cli/src/work-protos.ts";
import type { TaskResource } from "../../apps/cli/src/work-views.ts";
import { ListTasksResponseSchema, TaskSchema } from "../../packages/operator-api/src/index.ts";
import { type FakeRpcHandler, fakeOperatorRpc } from "./fake-operator-rpc.ts";

/**
 * A Task view as `WorkService` serves it: the Control Plane's view, encoded as the RPC's proto
 * JSON, so a CLI test reads it back through the same conversion as a real Task.
 */
export function taskJson(view: Record<string, unknown>, tag?: string) {
  return toJson(TaskSchema, create(TaskSchema, taskInit(view, tag)));
}

/**
 * Serves Task views over `WorkService.GetTask` and `ListTasks`, and any further handlers, as
 * `fakeOperatorRpc` does.
 */
export function fakeWorkRpc(
  tasks: readonly Record<string, unknown>[],
  handlers: Readonly<Record<string, FakeRpcHandler>> = {},
) {
  const byId = new Map(
    tasks.map((view) => [String((view["metadata"] as { id: string }).id), view] as const),
  );
  return fakeOperatorRpc({
    "WorkService/GetTask": (body) => {
      const view = byId.get(String(body["id"]));
      if (view === undefined) throw new Error(`unexpected Task ${String(body["id"])}`);
      return taskJson(view);
    },
    "WorkService/ListTasks": () =>
      toJson(
        ListTasksResponseSchema,
        create(ListTasksResponseSchema, {
          tasks: tasks.map((view) => create(TaskSchema, taskInit(view))),
        }),
      ),
    ...handlers,
  });
}

function taskInit(view: Record<string, unknown>, tag?: string) {
  const resource = view as unknown as TaskResource;
  return taskMessage(
    {
      ...resource,
      metadata: { resourceVersion: "", createdAt: "", updatedAt: "", ...resource.metadata },
      spec: { execution: {}, trigger: {}, ...resource.spec },
      status: { ...resource.status },
    },
    tag,
    undefined,
  );
}
