import { create, toJson } from "@bufbuild/protobuf";
import type { Objective, Tag, TaskAttempt } from "@supertag/core";
import { OrganizationOverviewSchema } from "@supertag/operator-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeOperatorRpc } from "../../tests/support/fake-operator-rpc.js";
import type { WorkerHostResource } from "./src/control-plane-resources.js";
import { main } from "./src/index.js";
import { organizationOverviewMessage } from "./src/organization-protos.js";
import { formatOrganizationStatus, runStatusCommand } from "./src/organization-status.js";
import { type OrganizationStatus, organizationStatus } from "./src/organization-views.js";

const now = new Date("2026-10-03T03:00:00.000Z");

function host(id: string, phase: WorkerHostResource["status"]["phase"]): WorkerHostResource {
  return {
    apiVersion: "supertag/v1",
    kind: "WorkerHost",
    metadata: { id, resourceVersion: "1", createdAt: "", updatedAt: "" },
    spec: { draining: false },
    status: {
      phase,
      capacity: 3,
      activeAttempts: 2,
      availableSlots: 1,
      workers: [
        {
          id: "codex",
          type: "harness",
          capabilities: [],
          profiles: [],
          contextTypes: [],
          maxConcurrency: 2,
          profileCapabilities: [{ harness: "codex" }],
        },
        {
          id: "claude",
          type: "harness",
          capabilities: [],
          profiles: [],
          contextTypes: [],
          profileCapabilities: [{ harness: "claude-code" }],
        },
      ],
    } as unknown as WorkerHostResource["status"],
  };
}

function attempt(taskId: string, workerHostId: string, workerId: string): TaskAttempt {
  return { taskId, workerSnapshot: { workerHostId, workerId } } as unknown as TaskAttempt;
}

const tag = (id: string, name: string, status = "active") => ({ id, name, status }) as Tag;

function objective(id: string, fields: Partial<Objective>): Objective {
  return {
    id,
    status: "working",
    ownerTagId: "lead-id",
    createdAt: "2026-10-03T00:00:00.000Z",
    spentMinor: 0,
    ...fields,
  } as Objective;
}

const view: OrganizationStatus = organizationStatus({
  asOf: now.toISOString(),
  workerHosts: [host("laptop", "ready"), host("old", "revoked")],
  tags: [tag("lead-id", "lead"), tag("builder-id", "builder"), tag("gone", "gone", "retired")],
  runningAttempts: [
    attempt("build-a", "laptop", "codex"),
    attempt("build-b", "laptop", "laptop/codex"),
  ],
  taskTagIds: new Map([
    ["build-a", "builder-id"],
    ["build-b", "builder-id"],
  ]),
  objectives: [
    objective("older", {
      createdAt: "2026-10-01T00:00:00.000Z",
      status: "blocked",
      deadline: "2026-10-03T01:30:00.000Z",
    }),
    objective("newer", {
      createdAt: "2026-10-02T00:00:00.000Z",
      budgetLimitMinor: 3000,
      budgetCurrency: "USD",
      deadline: "2026-10-03T04:09:00.000Z",
      limitState: {
        reportedSpend: { amountMinor: 1380, currency: "USD", unknownAttemptIds: [] },
      } as unknown as Objective["limitState"],
    }),
    objective("done", { status: "completed" }),
  ],
});

describe("supertag status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a remote Worker Host's reported low disk warning", () => {
    const gib = 1024 ** 3;
    const status = organizationStatus({
      asOf: now.toISOString(),
      workerHosts: [
        {
          ...host("low", "ready"),
          status: {
            ...host("low", "ready").status,
            diskSpace: { freeBytes: 4 * gib, totalBytes: 100 * gib },
          },
        },
      ],
      tags: [],
      runningAttempts: [],
      taskTagIds: new Map(),
      objectives: [],
    });
    expect(status.workerHosts[0]?.diskWarning).toContain("below 5 GiB");
    expect(
      formatOrganizationStatus({ ...status, inbox: { items: 0, truncated: false } }, now),
    ).toContain("Warning: Worker Host free disk");
  });

  it("shows open high findings under their Objective", () => {
    const text = formatOrganizationStatus(
      {
        ...view,
        objectives: view.objectives.map((objective) => ({
          ...objective,
          needsOperator: 0,
          highFindings:
            objective.id === "newer"
              ? [{ taskId: "review-a", id: "F1", summary: "Missing guard", location: "src/a.ts:3" }]
              : [],
        })),
        inbox: { items: 0, truncated: false },
      },
      now,
    );
    expect(text).toContain("High finding: review-a F1: Missing guard (src/a.ts:3)");
  });

  it("counts running Task Attempts per harness and busy Tags", () => {
    expect(view.workerHosts).toEqual([
      {
        id: "laptop",
        phase: "ready",
        running: 2,
        capacity: 3,
        coordinationCapacity: 0,
        harnesses: [
          { harness: "claude-code", running: 0, capacity: 1, coordinationCapacity: 0 },
          { harness: "codex", running: 2, capacity: 2, coordinationCapacity: 0 },
        ],
      },
    ]);
    expect(view.tags).toEqual([
      {
        id: "builder-id",
        name: "builder",
        runningTaskIds: ["build-a", "build-b"],
        runningCommands: [],
      },
      { id: "lead-id", name: "lead", runningTaskIds: [], runningCommands: [] },
    ]);
    expect(view.objectives.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(view.objectives[0]).toMatchObject({ ownerName: "lead", spentMinor: 1380 });
  });

  it("includes the owner coordination slot in displayed capacity", () => {
    const machine = host("laptop", "ready");
    const claude = {
      ...machine.status.workers[1],
      maxConcurrency: 4,
      profileCapabilities: [
        {
          harness: "claude-code",
          capabilities: [{ id: "supertag.coordination", version: 1 }],
        },
      ],
    };
    const status = organizationStatus({
      asOf: now.toISOString(),
      workerHosts: [
        {
          ...machine,
          status: { ...machine.status, workers: [claude], capacity: 4, activeAttempts: 5 },
        },
      ],
      tags: [],
      runningAttempts: Array.from({ length: 5 }, (_, index) =>
        attempt(`task-${index}`, "laptop", "claude"),
      ),
      taskTagIds: new Map(),
      objectives: [],
    });
    expect(status.workerHosts[0]).toMatchObject({
      running: 5,
      capacity: 5,
      coordinationCapacity: 1,
      harnesses: [{ harness: "claude-code", running: 5, capacity: 5, coordinationCapacity: 1 }],
    });
    expect(
      formatOrganizationStatus({ ...status, inbox: { items: 0, truncated: false } }, now),
    ).toContain("claude-code 5/5 (1 owner-only slot)");
  });

  it("prints one screen with money in major units", () => {
    const text = formatOrganizationStatus(
      {
        ...view,
        objectives: view.objectives.map((item) => ({
          ...item,
          needsOperator: item.id === "newer" ? 2 : 0,
        })),
        inbox: { items: 3, truncated: false },
      },
      now,
    );
    expect(text).toContain("laptop  ready  2/3 Task Attempts running (claude-code 0/1, codex 2/2)");
    expect(text).toContain("builder  busy: build-a, build-b");
    expect(text).toContain("lead  idle");
    expect(text).toContain(
      "newer  working; owner lead; $13.80 of $30.00; deadline in 1h 9m; 2 need you",
    );
    expect(text).toContain("older  blocked; owner lead; no budget; deadline passed 1h 30m ago");
    expect(text).not.toContain("done");
    expect(text).toContain("Operator inbox: 3 items; see supertag list inbox");
  });

  it("labels unpriced Objective usage and warns once per Objective", () => {
    const status = organizationStatus({
      asOf: now.toISOString(),
      workerHosts: [],
      tags: [],
      runningAttempts: [],
      taskTagIds: new Map(),
      objectives: [objective("unpriced", { budgetLimitMinor: 1000, budgetCurrency: "USD" })],
      objectiveSpend: new Map([
        [
          "unpriced",
          {
            attempts: 2,
            reportedCostByCurrency: null,
            unknownCostAttempts: 2,
            unpricedModels: { "gpt-6-sol": 2 },
            unpricedTokens: 125,
            reportedTokens: 125,
            unknownTokenAttempts: 0,
          },
        ],
      ]),
    });
    const text = formatOrganizationStatus(
      {
        ...status,
        objectives: status.objectives.map((entry) => ({ ...entry, needsOperator: 0 })),
        inbox: { items: 0, truncated: false },
      },
      now,
    );
    expect(text).toContain("unpriced; 2 Task Attempts; 125 tokens");
    expect(text).not.toContain("$0.00 of $10.00");
    expect(text.match(/budget cannot be enforced/g)).toHaveLength(1);
  });

  it("shows each busy Task's running command as plain text with its elapsed time", () => {
    const status = organizationStatus({
      asOf: now.toISOString(),
      workerHosts: [],
      tags: [tag("builder-id", "builder")],
      runningAttempts: [
        attempt("build-a", "laptop", "codex"),
        attempt("build-b", "laptop", "codex"),
      ],
      taskTagIds: new Map([
        ["build-a", "builder-id"],
        ["build-b", "builder-id"],
        ["other", "lead-id"],
      ]),
      runningCommands: new Map([
        ["build-a", { command: "pnpm test:verify", startedAt: "2026-10-03T02:36:00.000Z" }],
        [
          "build-b",
          {
            command: `\x1b]0;pwned\x07\x1b[2Jecho ${"x".repeat(120)}`,
            startedAt: "2026-10-03T02:59:15.000Z",
          },
        ],
        ["other", { command: "not busy", startedAt: "2026-10-03T02:00:00.000Z" }],
      ]),
      objectives: [],
    });
    expect(status.tags[0]?.runningCommands.map((item) => item.taskId)).toEqual([
      "build-a",
      "build-b",
    ]);
    const text = formatOrganizationStatus(
      { ...status, objectives: [], inbox: { items: 0, truncated: false } },
      now,
    );
    expect(text).toContain("    build-a  running `pnpm test:verify` for 24m");
    const line = text.split("\n").find((candidate) => candidate.includes("build-b  running"));
    // Cut to 80 characters, ellipsis included.
    expect(line).toBe(`    build-b  running \`echo ${"x".repeat(74)}…\` for 45s`);
    expect(text.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(text).not.toContain("pwned");
    expect(text).not.toContain("not busy");
  });

  it("points to all pending decisions when the operator inbox is empty", () => {
    const text = formatOrganizationStatus({ ...view, inbox: { items: 0, truncated: false } }, now);
    expect(text).toContain(
      "Operator inbox: empty; see supertag list inbox --all for Tag decisions",
    );
  });

  it("reads the organization and the operator inbox, and prints JSON", async () => {
    const rpc = fakeOperatorRpc({
      "OrganizationService/GetOrganization": () =>
        toJson(
          OrganizationOverviewSchema,
          create(OrganizationOverviewSchema, organizationOverviewMessage(view)),
        ),
      "InboxService/ListInboxItems": (body) =>
        body["pageToken"] === "page-2"
          ? {
              items: [
                { objectiveId: "older", kind: "INBOX_ITEM_KIND_APPROVAL", operatorEligible: true },
              ],
            }
          : {
              items: [
                { objectiveId: "newer", kind: "INBOX_ITEM_KIND_APPROVAL", operatorEligible: true },
                { objectiveId: "newer", kind: "INBOX_ITEM_KIND_QUESTION", operatorEligible: true },
                {
                  objectiveId: "newer",
                  kind: "INBOX_ITEM_KIND_TASK_ATTENTION",
                  nextActorTagIds: ["x"],
                },
              ],
              nextPageToken: "page-2",
            },
    });
    const output = JSON.parse(
      await runStatusCommand({ url: "http://localhost", token: "t" }, ["--output", "json"]),
    );
    expect(rpc.called("OrganizationService/GetOrganization")).toHaveLength(1);
    // The overview prints exactly as the Control Plane built it, field order included.
    const { inbox: _inbox, objectives, ...rest } = output;
    expect(
      JSON.stringify({
        ...rest,
        objectives: objectives.map(
          ({ needsOperator: _needs, ...objective }: { needsOperator: number }) => objective,
        ),
      }),
    ).toBe(JSON.stringify(view));
    expect(rpc.called("InboxService/ListInboxItems").map(({ body }) => body)).toEqual([
      { pageSize: 100 },
      { pageToken: "page-2", pageSize: 100 },
    ]);
    // Every operator-eligible item counts, whether or not a Tag could also act on it.
    expect(output.inbox).toEqual({ items: 3, truncated: false });
    expect(
      output.objectives.map((item: { id: string; needsOperator: number }) => [
        item.id,
        item.needsOperator,
      ]),
    ).toEqual([
      ["newer", 2],
      ["older", 1],
    ]);
  });

  it("keeps allocation budgets apart from reported money and marks a truncated inbox", () => {
    const text = formatOrganizationStatus(
      {
        ...view,
        objectives: [
          {
            ...view.objectives[0],
            currency: null,
            spendCurrency: "USD",
            budgetLimitMinor: 3000,
            needsOperator: 0,
          } as never,
        ],
        inbox: { items: 1000, truncated: true },
      },
      now,
    );
    expect(text).toContain("$13.80 of 3000 budget units");
    expect(text).toContain("Operator inbox: at least 1000 items; see supertag list inbox");
  });

  it("takes no arguments and is listed in help", async () => {
    await expect(
      runStatusCommand({ url: "http://localhost", token: "t" }, ["tags"]),
    ).rejects.toThrow("supertag status takes no arguments");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await expect(main(["--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("supertag status [--output text|json]");
  });
});
