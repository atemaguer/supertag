import { expect, it, vi } from "vitest";
import { workerHostJson } from "../../tests/support/fake-host-rpc.js";
import { fakeOperatorRpc } from "../../tests/support/fake-operator-rpc.js";
import { fakeWorkRpc } from "../../tests/support/fake-work-rpc.js";
import { renderListTable, runListCommand } from "./src/list-command.js";

const target = { url: "http://control.invalid", token: "test" };

it("lists Tags as an operator table by default and preserves the collection in JSON and YAML", async () => {
  const rpc = fakeOperatorRpc({
    "ResourceService/ListResources": () => ({
      resources: [
        {
          tag: {
            metadata: {
              id: "tag-1",
              name: "builder",
              resourceVersion: "1",
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-01T00:00:00.000Z",
            },
            spec: { roles: ["builder"], workerHosts: ["laptop"] },
            status: {
              phase: "TAG_PHASE_ACTIVE",
              execution: { harness: "codex", model: ["gpt-5"] },
            },
          },
        },
      ],
    }),
    "WorkService/ListTasks": () => ({}),
  });
  try {
    const table = await runListCommand(target, ["tag"]);
    expect(table).toContain("NAME");
    expect(table).toContain("WORKER HOSTS");
    expect(table).toContain("builder");
    expect(table).toContain("laptop");
    expect(JSON.parse(await runListCommand(target, ["tag", "--output", "json"]))).toMatchObject({
      apiVersion: "supertag/v1",
      kind: "ResourceList",
      items: [
        {
          kind: "Tag",
          metadata: { name: "builder", id: "tag-1" },
          spec: { roles: ["builder"], workerHosts: ["laptop"], runsOn: [], locations: [] },
          status: { phase: "active", execution: { harness: "codex", model: ["gpt-5"] } },
        },
      ],
    });
    expect(await runListCommand(target, ["tag", "--output=yaml"])).toContain("name: builder");
    expect(rpc.called("ResourceService/ListResources")[0]?.body).toMatchObject({
      kind: "RESOURCE_KIND_TAG",
    });
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("shows Auth Key expiry from the operator API in the table", async () => {
  const rpc = fakeOperatorRpc({
    "HostService/ListAuthKeys": () => ({
      authKeys: [
        {
          metadata: { id: "key-ci", name: "ci" },
          phase: "AUTH_KEY_PHASE_ACTIVE",
          expiresAt: "2026-12-29T00:00:00Z",
        },
      ],
    }),
  });
  try {
    const table = await runListCommand(target, ["auth-key"]);
    expect(table).toContain("EXPIRES");
    expect(table).toMatch(/ci\s+active\s+2026-12-29T00:00:00\.000Z/u);
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("lists every Objective without --owner and filters by the owner's name with it", async () => {
  const rpc = fakeOperatorRpc({
    "ResourceService/ListResources": () => ({
      resources: [
        {
          tag: {
            metadata: { id: "tag-lead", name: "lead" },
            spec: {},
            status: { phase: "TAG_PHASE_ACTIVE" },
          },
        },
      ],
    }),
    "ObjectiveService/ListObjectives": () => ({
      objectives: [
        {
          id: "ship-sso",
          status: "OBJECTIVE_STATUS_WORKING",
          ownerTagId: "tag-lead",
          ownerTag: "lead",
          revision: "1",
          budget: { limitMinor: "3000", currency: "USD" },
          spend: { amountMinor: "1380", currency: "USD" },
        },
      ],
    }),
  });
  try {
    const table = await runListCommand(target, ["objective"]);
    expect(table).toMatch(/ship-sso +working +lead +\$13\.80 \/ \$30\.00/);
    expect(rpc.called("ResourceService/ListResources")).toHaveLength(1);
    expect(
      JSON.parse(await runListCommand(target, ["objective", "--output", "json"])).objectives[0]
        .ownerTagId,
    ).toBe("tag-lead");
    await runListCommand(target, ["objective", "--owner", "lead", "--limit", "5"]);
    expect(rpc.called("ObjectiveService/ListObjectives").map(({ body }) => body)).toEqual([
      {},
      {},
      { owner: "lead", pageSize: 5 },
    ]);
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("keeps the detailed operator inbox view for text output", async () => {
  const rpc = fakeOperatorRpc({
    "InboxService/ListInboxItems": () => ({ asOf: "2026-09-30T00:01:00Z" }),
  });
  try {
    const text = await runListCommand(target, ["inbox", "--objective", "ship-sso"]);
    expect(text).toContain("Operator inbox (0 items");
    expect(text).not.toContain("SUMMARY");
    expect(JSON.parse(await runListCommand(target, ["inbox", "--output", "json"]))).toEqual({
      asOf: "2026-09-30T00:01:00Z",
    });
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("rejects plural kinds before making a request", async () => {
  const rpc = fakeOperatorRpc({});
  try {
    await expect(runListCommand(target, ["tags"])).rejects.toThrow("did you mean `list tag`?");
    expect(rpc.fetch).not.toHaveBeenCalled();
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("shows each artifact's Task, file count, and copy locations", () => {
  const table = renderListTable("artifact", {
    items: [
      {
        kind: "Artifact",
        metadata: { id: "artifact-1", createdAt: "2026-10-06T04:00:00.000Z" },
        spec: { taskId: "task-1", entries: [{ path: "a" }, { path: "b" }] },
        status: {
          locations: [
            { kind: "worker-host", workerHostId: "laptop", ephemeral: false, removed: false },
            { kind: "volume", volume: "shared" },
          ],
          ephemeralOnly: false,
        },
      },
      {
        kind: "Artifact",
        metadata: { id: "artifact-2", createdAt: "2026-10-06T04:01:00.000Z" },
        spec: { taskId: "task-2", entries: [{ path: "c" }] },
        status: {
          locations: [
            { kind: "worker-host", workerHostId: "sandbox", ephemeral: true, removed: false },
          ],
          ephemeralOnly: true,
        },
      },
    ],
  });
  expect(table).toContain("LOCATIONS");
  expect(table).toMatch(
    /artifact-1\s+task-1\s+2026-10-06T04:00:00.000Z\s+2\s+laptop, Volume shared\n/u,
  );
  expect(table).toMatch(/artifact-2\s+task-2\s+\S+\s+1\s+sandbox \(ephemeral\); ephemeral only\n/u);
});

it("shows Worker Host connection and advertised harnesses", () => {
  const table = renderListTable("worker-host", {
    items: [
      {
        metadata: { name: "laptop" },
        status: {
          connectionStatus: "connected",
          workers: [{ type: "local-codex", profileCapabilities: [{ harness: "codex" }] }],
        },
      },
    ],
  });
  expect(table).toContain("CONNECTION");
  expect(table).toContain("connected");
  expect(table).toContain("codex");
});

it("shows busy Tags and running attempts against host capacity", async () => {
  const rpc = fakeWorkRpc(
    [
      {
        metadata: { id: "task-1" },
        spec: { tagId: "tag-1" },
        status: {
          phase: "running",
          attempt: { phase: "running", workerHostId: "host-1", workerId: "worker-1" },
        },
      },
    ],
    {
      "ResourceService/ListResources": () => ({
        resources: [
          {
            tag: {
              metadata: { id: "tag-1", name: "builder" },
              spec: { workerHosts: ["host-1"] },
              status: { phase: "TAG_PHASE_ACTIVE" },
            },
          },
        ],
      }),
      "HostService/ListWorkerHosts": () => ({
        workerHosts: [
          workerHostJson({
            metadata: { id: "host-1", name: "laptop" },
            status: {
              connectionStatus: "connected",
              workers: [{ id: "worker-1", type: "codex", maxConcurrency: 2 }],
            },
          }),
        ],
      }),
    },
  );
  try {
    expect(await runListCommand(target, ["tag"])).toContain("task-1");
    expect(await runListCommand(target, ["worker-host"])).toContain("codex 1/2");
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("lists Tasks and Sessions over WorkService, as tables and as the RPCs' messages", async () => {
  const rpc = fakeWorkRpc(
    [
      {
        metadata: { id: "task-1" },
        spec: { tagId: "tag-1", sessionId: "session-1", objectiveId: "ship" },
        status: { phase: "completed" },
      },
    ],
    {
      "WorkService/ListSessions": () => ({
        sessions: [
          {
            id: "session-1",
            tag: "builder",
            title: "Fix the build",
            parentSessionId: "session-0",
            latestTaskStatus: "TASK_STATUS_COMPLETED",
            lastInteractionAt: "2026-11-01T00:00:00Z",
          },
        ],
      }),
    },
  );
  try {
    expect(await runListCommand(target, ["task"])).toMatch(/task-1 +completed +tag-1 +ship/u);
    expect(await runListCommand(target, ["session"])).toMatch(
      /session-1 +builder +Fix the build +session-0 +completed +2026-11-01T00:00:00\.000Z/u,
    );
    expect(JSON.parse(await runListCommand(target, ["task", "--output", "json"]))).toMatchObject({
      tasks: [{ id: "task-1", status: "TASK_STATUS_COMPLETED" }],
    });
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("lists Teams, messages, grants and Workstream posts with the Tag names the RPCs return", async () => {
  const rpc = fakeOperatorRpc({
    "TeamService/ListTeams": () => ({
      teams: [
        { id: "crew", name: "Crew", members: [{ tagId: "a", tag: "alpha" }, { tagId: "b" }] },
      ],
    }),
    "MailboxService/ListTagMessages": () => ({
      messages: [
        {
          id: "m1",
          senderTagId: "a",
          recipientTagId: "b",
          status: "TAG_MESSAGE_STATUS_HANDLED",
          createdAt: "2026-11-01T00:00:00Z",
          text: "Ship it\nplease",
        },
      ],
      tagNames: { a: "alpha" },
    }),
    "MailboxService/ListMailboxGrants": () => ({
      grants: [{ senderTagId: "a", recipientTagId: "b" }],
      tagNames: { a: "alpha", b: "beta" },
    }),
    "MailboxService/ListWorkstreamPosts": () => ({
      posts: [
        {
          sequence: "3",
          authorTagId: "a",
          toTagIds: ["b"],
          createdAt: "2026-11-01T00:00:00Z",
          body: "Done",
        },
      ],
      tagNames: { a: "alpha", b: "beta" },
    }),
  });
  try {
    expect(await runListCommand(target, ["team"])).toMatch(/Crew +alpha, b +-/u);
    expect(await runListCommand(target, ["message", "--mailbox", "beta"])).toMatch(
      /m1 +alpha +b +handled +2026-11-01T00:00:00\.000Z +Ship it please$/mu,
    );
    expect(await runListCommand(target, ["mailbox-grant", "--mailbox", "beta"])).toMatch(
      /alpha +beta/u,
    );
    expect(await runListCommand(target, ["workstream-post", "--team", "crew"])).toMatch(
      /3 +alpha +beta +2026-11-01T00:00:00\.000Z +Done/u,
    );
  } finally {
    rpc.fetch.mockRestore();
  }
});

it("shows Objective spend against budget in major units", () => {
  const table = renderListTable("objective", {
    items: [
      {
        id: "launch",
        status: "working",
        ownerTagId: "lead",
        limitState: { reportedSpend: { amountMinor: 1380, currency: "USD" } },
        budgetLimitMinor: 3000,
        budgetCurrency: "USD",
        deadline: "2026-10-03T04:45:00.000Z",
      },
    ],
  });
  expect(table).toContain("SPEND / BUDGET");
  expect(table).toContain("$13.80 / $30.00");
  expect(table).not.toContain("1380");
});

it("no longer offers the supertag team command group", async () => {
  const { main } = await import("./src/index.js");
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await main(["--help"]);
    const help = write.mock.calls.map(([value]) => String(value)).join("");
    expect(help).not.toMatch(/supertag team (create|list|history|update|dissolve)/);
    expect(help).toContain("supertag list team");
  } finally {
    write.mockRestore();
  }
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(await main(["team", "list"])).toBe(1);
  } finally {
    stderr.mockRestore();
  }
});

it("keeps allocation-unit budgets out of money in the Objective table", () => {
  const table = renderListTable("objective", {
    items: [
      {
        id: "units",
        status: "working",
        ownerTagId: "lead",
        limitState: { reportedSpend: { amountMinor: 5, currency: null } },
        budgetLimitMinor: 40,
      },
    ],
  });
  expect(table).toContain("5 units / 40 units");
  expect(table).not.toContain("$");
});
