import { expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { renderListTable, runListCommand } from "./src/list-command.js";

const target = { url: "http://control.invalid", token: "test" };

it("lists Tags as an operator table by default and preserves the collection in JSON and YAML", async () => {
  const collection = {
    items: [
      {
        metadata: { name: "builder", id: "tag-1" },
        spec: { roles: ["builder"], workerHosts: ["laptop"] },
        status: { phase: "active", execution: { harness: "codex", model: ["gpt-5"] } },
      },
    ],
  };
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue(collection);
  try {
    const table = await runListCommand(target, ["tag"]);
    expect(table).toContain("NAME");
    expect(table).toContain("WORKER HOSTS");
    expect(table).toContain("builder");
    expect(table).toContain("laptop");
    expect(JSON.parse(await runListCommand(target, ["tag", "--output", "json"]))).toEqual(
      collection,
    );
    expect(await runListCommand(target, ["tag", "--output=yaml"])).toContain("name: builder");
    expect(request).toHaveBeenCalledWith("/api/v1/tags");
  } finally {
    request.mockRestore();
  }
});

it("lists every Objective without --owner and filters by the owner's Tag ID with it", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockImplementation(async (path: string) =>
      path === "/api/v1/tags"
        ? { items: [{ metadata: { id: "tag-lead", name: "lead" } }] }
        : {
            items: [
              {
                id: "ship-sso",
                status: "working",
                ownerTagId: "tag-lead",
                spentMinor: 0,
                budgetLimitMinor: 3000,
                budgetCurrency: "USD",
                limitState: { reportedSpend: { amountMinor: 1380, currency: "USD" } },
              },
            ],
          },
    );
  const getTag = vi
    .spyOn(ControlPlaneClient.prototype, "getTag")
    .mockResolvedValue({ metadata: { name: "lead", id: "tag-lead" } } as never);
  try {
    const table = await runListCommand(target, ["objective"]);
    expect(table).toMatch(/ship-sso +working +lead +\$13\.80 \/ \$30\.00/);
    expect(request).toHaveBeenCalledWith("/api/v1/tag-messaging/objectives?");
    expect(
      JSON.parse(await runListCommand(target, ["objective", "--output", "json"])).items[0]
        .ownerTagId,
    ).toBe("tag-lead");
    await runListCommand(target, ["objective", "--owner", "lead", "--limit", "5"]);
    expect(getTag).toHaveBeenCalledWith("lead");
    expect(request).toHaveBeenCalledWith("/api/v1/tag-messaging/objectives?tagId=tag-lead&limit=5");
  } finally {
    request.mockRestore();
    getTag.mockRestore();
  }
});

it("keeps the detailed operator inbox view for text output", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 7,
    asOf: "now",
    items: [],
    tagNames: {},
    truncatedKinds: [],
  });
  try {
    const text = await runListCommand(target, ["inbox", "--objective", "ship-sso"]);
    expect(text).toContain("Operator inbox (0 items");
    expect(text).not.toContain("SUMMARY");
    expect(JSON.parse(await runListCommand(target, ["inbox", "--output", "json"])).items).toEqual(
      [],
    );
  } finally {
    request.mockRestore();
  }
});

it("rejects plural kinds before making a request", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request");
  try {
    await expect(runListCommand(target, ["tags"])).rejects.toThrow("did you mean `list tag`?");
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
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
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValueOnce({
      items: [
        {
          metadata: { id: "tag-1", name: "builder" },
          spec: { roles: [], workerHosts: ["host-1"] },
          status: {},
        },
      ],
    })
    .mockResolvedValueOnce({
      items: [
        {
          metadata: { id: "task-1" },
          spec: { tagId: "tag-1" },
          status: { attempt: { phase: "running" } },
        },
      ],
    })
    .mockResolvedValueOnce({
      items: [
        {
          metadata: { id: "host-1", name: "laptop" },
          status: {
            connectionStatus: "connected",
            workers: [{ id: "worker-1", type: "codex", maxConcurrency: 2 }],
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      items: [
        {
          metadata: { id: "task-1" },
          status: { attempt: { phase: "running", workerHostId: "host-1", workerId: "worker-1" } },
        },
      ],
    });
  try {
    expect(await runListCommand(target, ["tag"])).toContain("task-1");
    expect(await runListCommand(target, ["worker-host"])).toContain("codex 1/2");
  } finally {
    request.mockRestore();
  }
});

it("shows Objective spend against budget in major units", () => {
  const table = renderListTable("objective", {
    items: [
      {
        id: "launch",
        status: "working",
        ownerTagId: "lead",
        spentMinor: 1380,
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
      { id: "units", status: "working", ownerTagId: "lead", spentMinor: 5, budgetLimitMinor: 40 },
    ],
  });
  expect(table).toContain("5 units / 40 units");
  expect(table).not.toContain("$");
});
