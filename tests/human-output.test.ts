import { describe, expect, it, vi } from "vitest";
import { takeOutputFlag } from "../apps/cli/src/output-flag.ts";
import { runTaskCommand } from "../apps/cli/src/tasks.ts";
import { runWorkerHostOperation } from "../apps/cli/src/worker-hosts.ts";
import { workerHostJson, workerHostResourceOf } from "./support/fake-host-rpc.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

const _client = (response: unknown) => ({
  calls: [] as string[],
  async request<T>(path: string): Promise<T> {
    this.calls.push(path);
    return response as T;
  },
});

describe("one-line summaries for commands that change something", () => {
  it("reads --output text|json and leaves other flags alone", () => {
    expect(takeOutputFlag(["a", "--output", "json", "--output-file", "outputs/x"])).toEqual({
      json: true,
      args: ["a", "--output-file", "outputs/x"],
    });
    expect(takeOutputFlag(["--output=text"])).toEqual({ json: false, args: [] });
    expect(() => takeOutputFlag(["--output", "yaml"])).toThrow("--output must be text or json");
  });

  it("summarizes Task cancellation, with the record under --output json", async () => {
    const operator = { operator: { url: "http://127.0.0.1:1", token: "t" } };
    const cancelled = (record: Record<string, unknown>) =>
      fakeOperatorRpc({ "WorkService/CancelTask": () => record });
    const record = { taskId: "t1", accepted: true, status: "TASK_STATUS_CANCELLED" };
    cancelled(record);
    expect(await runTaskCommand(operator, "cancel", ["t1"])).toBe("task/t1 cancelled.\n");
    vi.restoreAllMocks();
    cancelled({ ...record, status: "TASK_STATUS_RUNNING" });
    expect(await runTaskCommand(operator, "cancel", ["t1"])).toBe(
      "task/t1 cancellation requested; it is running until its Worker stops.\n",
    );
    vi.restoreAllMocks();
    cancelled({ taskId: "t1", status: "TASK_STATUS_COMPLETED" });
    expect(await runTaskCommand(operator, "cancel", ["t1"])).toBe(
      "task/t1 is already completed; nothing to cancel.\n",
    );
    vi.restoreAllMocks();
    cancelled(record);
    expect(
      JSON.parse(await runTaskCommand(operator, "cancel", ["t1", "--output", "json"])),
    ).toEqual(record);
    vi.restoreAllMocks();
  });

  it("summarizes draining and resuming a Worker Host", async () => {
    const resource = { kind: "WorkerHost", metadata: { id: "host-a" } };
    const hosts = fakeOperatorRpc({
      "HostService/DrainWorkerHost": () => workerHostJson(resource),
      "HostService/ResumeWorkerHost": () => workerHostJson(resource),
    });
    const operator = { operator: { url: "http://127.0.0.1:1", token: "t" } };
    expect(await runWorkerHostOperation(operator, "drain", ["host-a"])).toBe(
      "worker-host/host-a draining: it finishes accepted work and takes no new Tasks.\n",
    );
    expect(await runWorkerHostOperation(operator, "resume", ["host-a"])).toBe(
      "worker-host/host-a resumed: it takes new Tasks again.\n",
    );
    expect(
      JSON.parse(await runWorkerHostOperation(operator, "drain", ["host-a", "--output", "json"])),
    ).toEqual(workerHostResourceOf(resource));
    expect(hosts.calls.map((call) => call.body)).toEqual([
      { id: "host-a" },
      { id: "host-a" },
      { id: "host-a" },
    ]);
    vi.restoreAllMocks();
  });
});
