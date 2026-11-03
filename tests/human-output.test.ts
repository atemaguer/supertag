import { describe, expect, it } from "vitest";
import { takeOutputFlag } from "../apps/cli/src/output-flag.ts";
import { runTaskCommand } from "../apps/cli/src/tasks.ts";
import { runWorkerHostOperation } from "../apps/cli/src/worker-hosts.ts";

const client = (response: unknown) => ({
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
    const record = {
      kind: "TaskCancellation",
      metadata: { taskId: "t1" },
      status: { accepted: true, phase: "cancelled" },
    };
    expect(await runTaskCommand(client(record), "cancel", ["t1"])).toBe("task/t1 cancelled.\n");
    expect(
      await runTaskCommand(
        client({ ...record, status: { accepted: true, phase: "running" } }),
        "cancel",
        ["t1"],
      ),
    ).toBe("task/t1 cancellation requested; it is running until its Worker stops.\n");
    expect(
      await runTaskCommand(
        client({ ...record, status: { accepted: false, phase: "completed" } }),
        "cancel",
        ["t1"],
      ),
    ).toBe("task/t1 is already completed; nothing to cancel.\n");
    expect(
      JSON.parse(await runTaskCommand(client(record), "cancel", ["t1", "--output", "json"])),
    ).toEqual(record);
  });

  it("summarizes draining and resuming a Worker Host", async () => {
    const resource = { kind: "WorkerHost", metadata: { id: "host-a" } };
    expect(await runWorkerHostOperation(client(resource), "drain", ["host-a"])).toBe(
      "worker-host/host-a draining: it finishes accepted work and takes no new Tasks.\n",
    );
    expect(await runWorkerHostOperation(client(resource), "resume", ["host-a"])).toBe(
      "worker-host/host-a resumed: it takes new Tasks again.\n",
    );
    expect(
      JSON.parse(
        await runWorkerHostOperation(client(resource), "drain", ["host-a", "--output", "json"]),
      ),
    ).toEqual(resource);
  });
});
