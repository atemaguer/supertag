import { expect, it } from "vitest";
import {
  observedDockerWorkerHarnesses,
  observedMcpHarnesses,
  takeUnseenTaskEvents,
} from "../scripts/shared-organization-evidence.mjs";

function evidence() {
  return {
    verification: {
      mcp: {
        nativeClients: [
          {
            harness: "claude-code",
            taskId: "owner",
            attemptId: "claude",
            readAfterProbe: true,
            transports: ["stdio", "http"],
          },
          {
            harness: "codex",
            taskId: "review",
            attemptId: "codex",
            readAfterProbe: true,
            transports: ["stdio", "http"],
          },
        ],
      },
    },
    attempts: [
      { id: "claude", taskId: "owner", status: "completed", executionCompleted: true },
      { id: "codex", taskId: "review", status: "completed", executionCompleted: true },
    ],
    placements: [
      { attemptId: "claude", harnessId: "claude-code", completed: true },
      { attemptId: "codex", harnessId: "codex", completed: true },
    ],
  };
}

it("requires both MCP transports to be observed by exact completed native executions", () => {
  expect(observedMcpHarnesses(evidence())).toEqual(new Set(["claude-code", "codex"]));
  for (const patch of [
    { taskId: "different-task" },
    { attemptId: "different-attempt" },
    { harness: "codex" },
    { harness: "probe" },
    { readAfterProbe: false },
    { transports: ["http"] },
  ]) {
    const input = evidence();
    Object.assign(input.verification.mcp.nativeClients[0], patch);
    expect(observedMcpHarnesses(input)).toEqual(new Set(["codex"]));
  }
});

it("does not let unrelated Harness completions or ambiguous identities substantiate ledger claims", () => {
  for (const mutate of [
    (value: ReturnType<typeof evidence>) => {
      value.attempts[0].status = "running";
    },
    (value: ReturnType<typeof evidence>) => {
      value.attempts[0].executionCompleted = false;
    },
    (value: ReturnType<typeof evidence>) => {
      value.attempts[0].taskId = "other-task";
    },
    (value: ReturnType<typeof evidence>) => {
      value.placements[0].harnessId = "codex";
    },
    (value: ReturnType<typeof evidence>) => {
      value.placements[0].completed = false;
    },
    (value: ReturnType<typeof evidence>) => {
      value.placements[0].attemptId = "unrelated";
    },
    (value: ReturnType<typeof evidence>) => {
      value.attempts.push({ ...value.attempts[0] });
    },
    (value: ReturnType<typeof evidence>) => {
      value.placements.push({ ...value.placements[0] });
    },
  ]) {
    const input = evidence();
    mutate(input);
    expect(observedMcpHarnesses(input)).toEqual(new Set(["codex"]));
  }
  expect(observedMcpHarnesses({ verification: {}, attempts: [], placements: [] })).toEqual(
    new Set(),
  );
});

it("retains a later failure once while polling repeated live snapshots", () => {
  const seen = new Set<string>();
  const started = { id: "start", type: "execution.started" };
  const failed = { id: "failure", type: "progress.updated" };
  expect(takeUnseenTaskEvents([{ taskId: "owner", events: [started] }], seen)).toEqual([
    { taskId: "owner", event: started },
  ]);
  expect(
    takeUnseenTaskEvents([{ taskId: "owner", events: [started, failed, failed] }], seen),
  ).toEqual([{ taskId: "owner", event: failed }]);
  expect(takeUnseenTaskEvents([{ taskId: "owner", events: [started, failed] }], seen)).toEqual([]);
  expect(takeUnseenTaskEvents([{ taskId: "review", events: [started] }], seen)).toEqual([
    { taskId: "review", event: started },
  ]);
  expect(
    takeUnseenTaskEvents([{ taskId: "owner", events: [{ type: "unidentified" }] }], seen),
  ).toEqual([]);
});

it("requires distinct owned Docker containers and matching completed Worker Host executions", () => {
  const input = {
    workerHosts: {
      mode: "docker",
      owner: "run",
      workers: [
        {
          manager: "claude",
          kind: "docker",
          containerId: "container-a",
          workerHostId: "host-a",
          ownerLabel: "run",
          runningObserved: true,
        },
        {
          manager: "codex",
          kind: "docker",
          containerId: "container-b",
          workerHostId: "host-b",
          ownerLabel: "run",
          runningObserved: true,
        },
      ],
    },
    attempts: evidence().attempts.map((a, i) => ({
      ...a,
      workerHostId: i === 0 ? "host-a" : "host-b",
    })),
    placements: evidence().placements,
    verification: evidence().verification,
  };
  expect(observedDockerWorkerHarnesses(input)).toEqual(new Set(["claude-code", "codex"]));
  for (const mutate of [
    (x: typeof input) => {
      x.workerHosts.workers[1].containerId = "container-a";
    },
    (x: typeof input) => {
      x.workerHosts.workers[1].workerHostId = "host-a";
    },
    (x: typeof input) => {
      x.workerHosts.mode = "local";
    },
  ]) {
    const x = structuredClone(input);
    mutate(x);
    expect(observedDockerWorkerHarnesses(x)).toEqual(new Set());
  }
  for (const mutate of [
    (x: typeof input) => {
      x.workerHosts.workers[0].runningObserved = false;
    },
    (x: typeof input) => {
      x.verification.mcp.nativeClients[0].attemptId = "other-attempt";
    },
    (x: typeof input) => {
      x.verification.mcp.nativeClients[0].transports = ["http"];
    },
    (x: typeof input) => {
      x.workerHosts.workers[0].ownerLabel = "another-run";
    },
    (x: typeof input) => {
      x.attempts[0].workerHostId = "another-host";
    },
    (x: typeof input) => {
      x.attempts[0].status = "running";
    },
    (x: typeof input) => {
      x.placements[0].harnessId = "codex";
    },
  ]) {
    const x = structuredClone(input);
    mutate(x);
    expect(observedDockerWorkerHarnesses(x)).toEqual(new Set(["codex"]));
  }
});
