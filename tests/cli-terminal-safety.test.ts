import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runInboxCommand } from "../apps/cli/src/approvals.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { formatCliFailure } from "../apps/cli/src/index.ts";
import { renderListTable } from "../apps/cli/src/list-command.ts";
import { runObjectiveCommand } from "../apps/cli/src/objectives.ts";
import { formatOrganizationStatus } from "../apps/cli/src/organization-status.ts";
import { formatRows } from "../apps/cli/src/ps.ts";
import { describeTask, runResourceCommand } from "../apps/cli/src/resources.ts";
import { TagAdministration } from "../apps/cli/src/tag-administration.ts";
import {
  renderTagOperation,
  type TagOperationDependencies,
} from "../apps/cli/src/tag-command-adapter.ts";
import { AccountSelectionError } from "../apps/cli/src/tag-surface-target.ts";
import { terminalText } from "../apps/cli/src/terminal-text.ts";
import { fakeHostRpc, workerHostJson, workerHostResourceOf } from "./support/fake-host-rpc.ts";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";

const hostile = "visible\x1b[2J\x1b]0;hidden-title\x07\r\n\t\b\x00\x7f\u009b\u202e\u2028\u2029end";
const safe = (output: string) => {
  expect(output).toContain("visible");
  expect(output).toContain("end");
  expect(output).toContain("hidden-title");
  expect(output).toContain("[2J");
  expect(output.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  expect(output).not.toContain("\nend");
};
const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
  else Reflect.deleteProperty(process.stdout, "isTTY");
});

it("filters Worker Host observations in task descriptions without mutating them", () => {
  const resource = {
    apiVersion: "supertag/v1",
    kind: "Task",
    metadata: { id: "task" },
    spec: { sessionId: "session" },
    status: {
      phase: "running",
      attempt: { id: "attempt", phase: "running", workerId: hostile, workerHostId: hostile },
    },
  };
  safe(describeTask(resource));
  expect(resource.status.attempt.workerId).toBe(hostile);
});

it("filters all Worker Host description fields and preserves JSON values", async () => {
  const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
  const resource = {
    apiVersion: "supertag/v1",
    kind: "WorkerHost",
    metadata: { id: hostile },
    spec: {},
    status: {
      workletId: hostile,
      labels: [hostile],
      workers: [
        {
          id: hostile,
          type: hostile,
          profileCapabilities: [
            {
              profile: { id: hostile, revision: "1" },
              capabilities: [],
              contextTypes: [],
              harness: hostile,
              models: [hostile],
              efforts: ["high"],
            },
          ],
        },
      ],
    },
  };
  fakeHostRpc([{ ...resource, metadata: { id: "host" } }], {
    "HostService/GetWorkerHost": () => workerHostJson(resource),
  });
  safe(await runResourceCommand(client, "describe", ["worker-host", "host"]));
  expect(
    JSON.parse(
      await runResourceCommand(client, "describe", ["worker-host", "host", "--output", "json"]),
    ),
  ).toEqual(workerHostResourceOf(resource));
});

it("filters ps cells, host details, errors, and uncertain attempt recovery commands", () => {
  safe(
    formatRows([
      {
        service: hostile,
        type: "host",
        state: "running",
        configured: true,
        workerHostId: hostile,
        address: hostile,
        error: hostile,
        tags: [hostile],
        uncertainAttempts: [
          {
            taskId: "task",
            attemptId: "attempt",
            workerId: hostile,
            reason: hostile,
            since: "now",
          },
        ],
      },
    ]),
  );
});

it("filters list cells before measuring column widths", () => {
  safe(
    renderListTable("worker-host", {
      items: [{ metadata: { id: hostile }, status: { workers: [{ type: hostile }] } }],
    }),
  );
});

it("filters host ids and harness names in organization status", () => {
  safe(
    formatOrganizationStatus(
      {
        workerHosts: [
          {
            id: hostile,
            phase: "ready",
            running: 0,
            capacity: 1,
            harnesses: [{ harness: hostile, running: 0, capacity: 1 }],
          },
        ],
        tags: [],
        objectives: [],
        asOf: "now",
        inbox: { items: 0, truncated: false },
      },
      new Date(),
    ),
  );
});

it.each([
  ["before\x1b[31mred\x1b[0mafter", "before [31mred [0mafter"],
  [
    "before\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\after",
    "before ]8;;https://evil.test \\link ]8;; \\after",
  ],
  ["before\u009b2Jafter", "before 2Jafter"],
  ["before\x1bafter", "before after"],
  ["before\r\n\t\b\x00\x7f\u202e\u2028\u2029after", "before         after"],
])("filters terminal controls in %j", (input, expected) => {
  expect(terminalText(input)).toBe(expected);
});

it("filters inbox detail fields as well as recovery commands", async () => {
  fakeOperatorRpc({
    "InboxService/ListInboxItems": () => ({
      asOf: "2026-09-30T00:01:00Z",
      items: [
        {
          key: hostile,
          kind: "INBOX_ITEM_KIND_TASK_ATTENTION",
          objectiveId: hostile,
          operatorEligible: true,
          actionableSince: "2026-09-30T00:00:00Z",
          reason: hostile,
          commands: [hostile],
          notification: { status: "INBOX_NOTIFICATION_STATUS_FAILED", reason: hostile },
        },
      ],
    }),
  });
  safe(
    await runInboxCommand({ url: "http://127.0.0.1:1", token: "unused" }, "list", [
      "--output",
      "text",
    ]),
  );
});

const target = { url: "http://127.0.0.1:1", token: "unused" };

it.each(["\u3164", "\u2800", "\u115f", "\u1160", "\uffa0"])(
  "replaces invisible filler %j",
  (filler) => {
    expect(terminalText(`before${filler}after`)).toBe("before after");
  },
);

it("bounds stacked combining marks while preserving ordinary accents", () => {
  expect(terminalText(`x${"\u0301".repeat(30)}end`)).not.toMatch(/\p{M}{3}/u);
  expect(terminalText("café")).toBe("café");
});

it("sanitizes failure messages, including non-Error failures", () => {
  safe(formatCliFailure(new Error(hostile)));
  safe(formatCliFailure(hostile));
});

it.each(["create", "status"])(
  "sanitizes objective %s warnings and refusal reasons",
  async (command) => {
    const objective = { id: "objective", revision: "1" };
    fakeOperatorRpc({
      "ObjectiveService/CreateObjective": () => ({
        objective,
        warnings: [hostile],
        notStarted: hostile,
      }),
      "ObjectiveService/UpdateObjective": () => ({ objective, warnings: [hostile] }),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runObjectiveCommand(
      target,
      command === "create"
        ? ["create", "objective", "--owner", "owner", "--outcome", "outcome"]
        : ["status", "objective", "working", "--revision", "1"],
    );
    for (const [line] of stderr.mock.calls) safe(String(line));
    expect(stderr).toHaveBeenCalled();
  },
);

it("sanitizes apply warnings and refusal reasons", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-apply-"));
  try {
    const file = join(directory, "objective.yaml");
    await writeFile(
      file,
      "apiVersion: supertag/v1\nkind: Objective\nmetadata: { name: objective }\nspec: { owner: owner, outcome: outcome }\n",
    );
    const client = new ControlPlaneClient(target);
    vi.spyOn(client, "request").mockResolvedValue({
      plan: { action: "create", conflicts: [] },
      warnings: [hostile],
      notStarted: hostile,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runResourceCommand(client, "apply", ["-f", file]);
    expect(stderr).toHaveBeenCalledTimes(2);
    for (const [line] of stderr.mock.calls) safe(String(line));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["describe", "get", "watch"] as const)(
  "sanitizes %s fallback only for human terminal output",
  async (command) => {
    const client = new ControlPlaneClient(target);
    const resource = { kind: "PermissionSet", metadata: { name: "before\u009b2J\u202eafter" } };
    vi.spyOn(client, "request").mockResolvedValue(resource);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const args = ["permission-set", "name", ...(command === "watch" ? ["--once"] : [])];
    const text = await runResourceCommand(client, command, args);
    expect(text).not.toMatch(/[\u009b\u202e]/u);
    expect(text).toContain("\n  ");
    expect(await runResourceCommand(client, command, [...args, "--output", "json"])).toBe(
      `${JSON.stringify(resource, null, 2)}\n`,
    );
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    if (command !== "describe")
      expect(await runResourceCommand(client, command, args)).toBe(
        `${JSON.stringify(resource, null, 2)}\n`,
      );
  },
);

it("sanitizes account ids and display names in ambiguous account errors", async () => {
  vi.spyOn(TagAdministration.prototype, "addRoute").mockRejectedValue(
    new AccountSelectionError({
      provider: "slack",
      selector: undefined,
      matches: [
        { externalAccountId: hostile, displayName: hostile },
      ] as unknown as AccountSelectionError["selection"]["matches"],
    }),
  );
  const error = await renderTagOperation(
    "add",
    ["tag", "slack", "--channel-id", "channel"],
    {} as TagOperationDependencies,
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  safe((error as Error).message.replaceAll("\t", " "));
});

it.each([false, true])("filters subsequent watch frames (explicit JSON: %s)", async (json) => {
  vi.useFakeTimers();
  const existing = process.listeners("SIGINT");
  let watching: Promise<string> | undefined;
  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const client = new ControlPlaneClient(target);
    const first = { metadata: { name: "first\u009b\u202e", resourceVersion: "1" } };
    const next = { metadata: { name: "next\u009b\u202e", resourceVersion: "2" } };
    vi.spyOn(client, "request").mockResolvedValueOnce(first).mockResolvedValue(next);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    watching = runResourceCommand(client, "watch", [
      "permission-set",
      "name",
      ...(json ? ["--output", "json"] : []),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stdout).toHaveBeenCalledTimes(2);
    for (const [index, resource] of [first, next].entries()) {
      const text = String(stdout.mock.calls[index]?.[0]);
      if (json) expect(text).toBe(`${JSON.stringify(resource, null, 2)}\n`);
      else expect(text).not.toMatch(/[\u009b\u202e]/u);
    }
  } finally {
    for (const listener of process.listeners("SIGINT")) {
      if (!existing.includes(listener)) listener("SIGINT");
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await watching;
    vi.useRealTimers();
  }
  expect(process.listeners("SIGINT")).toEqual(existing);
});
