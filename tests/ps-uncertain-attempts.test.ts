import { expect, it } from "vitest";
import { uncertainAttemptStatuses } from "../apps/cli/src/host-service.ts";
import { formatRows } from "../apps/cli/src/ps.ts";

const host = {
  service: "laptop",
  type: "host" as const,
  state: "running" as const,
  configured: true,
  pid: 42,
  workerHostId: "laptop-host",
  connected: true,
  attempts: 0,
};

it("lists a host's uncertain Task Attempts with the commands that recover them", () => {
  const uncertainAttempts = uncertainAttemptStatuses([
    {
      attemptId: "attempt-1",
      taskId: "task-1",
      workerId: "local-codex",
      uncertainty: {
        name: "ExecutionCleanupError",
        message: "Execution cleanup exceeded 5 seconds",
        at: "2026-10-04T20:35:56.000Z",
      },
    },
  ]);
  expect(uncertainAttempts).toEqual([
    {
      attemptId: "attempt-1",
      taskId: "task-1",
      workerId: "local-codex",
      reason: "ExecutionCleanupError: Execution cleanup exceeded 5 seconds",
      since: "2026-10-04T20:35:56.000Z",
    },
  ]);
  const text = formatRows([{ ...host, uncertainAttempts }]);
  // A running count of zero no longer hides held capacity.
  expect(text).toContain("Task Attempts running: 0; Task Attempts uncertain: 1");
  expect(text).toContain(
    "  Uncertain: Task task-1 Attempt attempt-1 may have executed and keeps a Worker slot (ExecutionCleanupError: Execution cleanup exceeded 5 seconds).\n",
  );
  expect(text).toContain("    Stop the host service first: supertag down laptop\n");
  expect(text).toContain(
    "    After confirming its execution stopped: supertag recover worklet --worker-id local-codex --task task-1 --attempt attempt-1 --confirm-stopped --reason TEXT\n",
  );
  expect(text).toContain("    Then start it again: supertag up laptop\n");
});

it("shows nothing extra for a host without uncertain Task Attempts", () => {
  expect(formatRows([host])).not.toContain("ncertain");
});
