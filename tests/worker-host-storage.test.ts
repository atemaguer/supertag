import { describe, expect, it, vi } from "vitest";
import { workerHostResourcesFromStore } from "../apps/cli/src/control-plane-resources.ts";
import { workerHostStorage } from "../apps/cli/src/worker-host-storage.ts";
import type { Store, TaskAttempt, TaskEvent, WorkerHost } from "../packages/core/src/index.ts";

const attempt = (id: string, host = "cloud", taskId = "task-1") =>
  ({ id, taskId, status: "completed", workerSnapshot: { workerHostId: host } }) as TaskAttempt;
const event = (attemptId: string, provider: string, placement = "remote", sequence = 1) =>
  ({
    attemptId,
    sequence,
    type: "runtime-inputs.resolved",
    payload: {
      manifest: {
        harness: { id: "codex", version: "1" },
        executionEnvironment: { id: provider, provider, placement },
      },
    },
  }) as TaskEvent;

function records(attempts: TaskAttempt[], events: TaskEvent[], running: TaskAttempt[] = []) {
  return {
    listTasks: vi.fn(async () => [{ id: "task-1" }]),
    listTaskAttempts: vi.fn(async () => attempts),
    listRunningTaskAttempts: vi.fn(async () => running),
    listTaskEvents: vi.fn(async () => events),
  };
}

describe("Worker Host storage evidence", () => {
  it("retains sandbox history without advertisements and scopes events to the authenticated host", async () => {
    const store = records(
      [attempt("a"), attempt("b", "local"), attempt("c")],
      [
        event("a", "modal"),
        event("b", "local", "local"),
        event("c", "e2b"),
        event("unknown", "fake"),
      ],
    );
    const result = await workerHostStorage(store as never, [{ id: "cloud" }, { id: "local" }]);
    expect(result.get("cloud")).toEqual({ sandboxes: ["e2b", "modal"], placementUnknown: false });
    expect(result.get("local")).toEqual({ sandboxes: [], placementUnknown: false });
    expect(store.listTaskAttempts).toHaveBeenCalledExactlyOnceWith(["task-1"]);
    expect(store.listTaskEvents).toHaveBeenCalledExactlyOnceWith("task-1");
  });

  it("does not let a later manifest erase earlier remote execution on the same Attempt", async () => {
    const store = records([attempt("a")], [event("a", "modal"), event("a", "local", "local", 2)]);
    expect((await workerHostStorage(store as never, [{ id: "cloud" }])).get("cloud")).toEqual({
      sandboxes: ["modal"],
      placementUnknown: false,
    });
  });

  it("includes running Attempts outside the recent Task window", async () => {
    const store = records([], [event("old", "e2b")], [attempt("old", "cloud", "old-task")]);
    expect(
      (await workerHostStorage(store as never, [{ id: "cloud" }])).get("cloud")?.sandboxes,
    ).toEqual(["e2b"]);
    expect(store.listTasks).toHaveBeenCalledExactlyOnceWith({ limit: 200 });
    expect(store.listTaskEvents).toHaveBeenCalledExactlyOnceWith("old-task");
  });

  it("keeps unknown placement explicit, including missing, malformed, and managed records", async () => {
    const malformed = { ...event("bad", "modal"), payload: { manifest: {} } } as TaskEvent;
    const store = records(
      [attempt("missing", "missing"), attempt("bad", "bad"), attempt("managed", "managed")],
      [malformed, event("managed", "company", "managed")],
    );
    const hosts = ["unseen", "missing", "bad", "managed"].map((id) => ({ id }));
    const result = await workerHostStorage(store as never, hosts);
    for (const { id } of hosts)
      expect(result.get(id)).toEqual({ sandboxes: [], placementUnknown: true });
  });

  it("projects Control Plane evidence without trusting snapshot storage claims", async () => {
    const store = records([attempt("a")], [event("a", "modal")]);
    const hosts = [
      {
        id: "cloud",
        ephemeral: true,
        workerSnapshot: {
          workers: [],
          storage: { sandboxes: [], placementUnknown: false },
          ephemeral: false,
        },
      },
    ] as unknown as WorkerHost[];
    const [resource] = await workerHostResourcesFromStore(store as unknown as Store, hosts);
    expect(resource?.status).toMatchObject({
      ephemeral: true,
      storage: { sandboxes: ["modal"], placementUnknown: false },
    });
  });
});
