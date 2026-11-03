import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coordinationTools } from "../apps/cli/src/coordination-http.js";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.js";
import {
  ObjectiveController,
  STATEMENT_ITEMS_GUIDANCE,
} from "../packages/control-plane/src/objective-controller.js";
import { buildObjectiveOverview } from "../packages/control-plane/src/objective-overview.js";
import {
  normalizeTaskItems,
  objectiveItemProgress,
  parseObjectiveStatementItems,
  type TaskAssignment,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const STATEMENT = `Make progress easy to read.

1. Statement items mapped to Tasks. When a statement lists items, record them.
2) Owner reports versus questions.
   3. Describe task shows waits! More text.
4. A very long item title that keeps going well past the display limit without any sentence end at all
Verification: 5 checks.
1. A duplicate number is ignored.`;

describe("statement items", () => {
  it("parses numbered items with their first sentence", () => {
    expect(parseObjectiveStatementItems(STATEMENT)).toEqual([
      { item: "1", title: "Statement items mapped to Tasks." },
      { item: "2", title: "Owner reports versus questions." },
      { item: "3", title: "Describe task shows waits!" },
      { item: "4", title: expect.stringMatching(/^A very long item title.{50,}…$/u) },
    ]);
    expect(parseObjectiveStatementItems("Ship it. No list here.")).toEqual([]);
  });

  it("normalizes Task items to unique numbers in numeric order", () => {
    expect(normalizeTaskItems(undefined)).toEqual([]);
    expect(normalizeTaskItems(["10", "3", "1", "3"])).toEqual(["1", "3", "10"]);
    for (const invalid of ["1", [1], ["0"], ["01"], ["1a"], [" 1"], Array(51).fill("1")])
      expect(() => normalizeTaskItems(invalid)).toThrow(/items/);
  });

  it("derives each item's state from the Tasks that serve it", () => {
    const progress = objectiveItemProgress(STATEMENT, [
      { taskId: "build", status: "accepted", items: ["1", "3"] },
      { taskId: "review", status: "submitted", items: ["2"] },
      { taskId: "fix", status: "running", items: ["2"] },
      { taskId: "failed", status: "failed", items: ["4"] },
      { taskId: "stale", status: "queued", items: ["7"] },
      { taskId: "owner", status: "running" },
    ]);
    expect(progress.map(({ item, state, title }) => [item, state, title])).toEqual([
      ["1", "done", "Statement items mapped to Tasks."],
      ["2", "in progress", "Owner reports versus questions."],
      ["3", "done", "Describe task shows waits!"],
      ["4", "not started", expect.any(String)],
      ["7", "in progress", null],
    ]);
    expect(progress[1]?.tasks).toEqual([
      { taskId: "review", status: "submitted" },
      { taskId: "fix", status: "running" },
    ]);
    expect(
      objectiveItemProgress(STATEMENT, [{ taskId: "r", status: "submitted", items: ["2"] }])[1]
        ?.state,
    ).toBe("in review");
  });

  it("offers items on assign_task and tells owners to record them", () => {
    const tool = coordinationTools.find((candidate) => candidate.name === "assign_task");
    expect(tool?.inputSchema.properties).toHaveProperty("items");
    expect(STATEMENT_ITEMS_GUIDANCE).toMatch(/every assign_task/u);
    expect(STATEMENT_ITEMS_GUIDANCE).toMatch(/Before you wait/u);
  });
});

describe("items on assigned Tasks", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture(outcome = STATEMENT) {
    const directory = await mkdtemp(join(tmpdir(), "supertag-items-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    await store.bindTagWorkerHost(owner.id, "fixture");
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome,
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Delivery",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 5,
    });
    const controller = new ObjectiveController(store, undefined);
    const assign = (taskId: string, extra: Record<string, unknown> = {}) =>
      controller.command("assign_task", {
        objectiveId: objective.id,
        taskId,
        teamId: team.id,
        assignedTagId: owner.id,
        instruction: `Build ${taskId}`,
        acceptanceCriteria: ["Built"],
        ...extra,
      }) as Promise<TaskAssignment>;
    return { store, objective, team, assign };
  }

  it("persists items and rejects items the statement does not list", async () => {
    const f = await fixture();
    const task = await f.assign("build", { items: ["3", "1", "3"] });
    expect(task.items).toEqual(["1", "3"]);
    expect((await f.store.getTaskAssignment("build"))?.items).toEqual(["1", "3"]);
    // A retry with the same definition returns the same Task; changed items do not.
    expect((await f.assign("build", { items: ["1", "3"] })).taskId).toBe("build");
    await expect(f.assign("build", { items: ["1"] })).rejects.toThrow();
    expect((await f.assign("plain")).items).toEqual([]);
    await expect(f.assign("stale", { items: ["9"] })).rejects.toThrow(
      "items 9 not in the Objective statement, which lists items 1, 2, 3, 4",
    );
    await expect(f.assign("typed", { items: [1] })).rejects.toThrow(/statement item numbers/u);
  });

  it("refuses items when the statement lists none", async () => {
    const f = await fixture("Ship the release.");
    await expect(f.assign("build", { items: ["1"] })).rejects.toThrow(
      /requires an Objective statement with numbered items/u,
    );
  });

  it("shows each item with its Tasks and state in describe objective", async () => {
    const f = await fixture();
    const build = {
      ...(await f.assign("build", { items: ["1", "3"] })),
      status: "accepted" as const,
    };
    const review = {
      ...(await f.assign("review", { items: ["2"] })),
      status: "submitted" as const,
    };
    const view = await buildObjectiveOverview({
      store: f.store,
      objective: f.objective,
      tasks: [build, review],
      teams: [f.team],
      // Item progress covers every visible Task, not only the selected page.
      limit: 1,
      offset: 0,
      executionReadiness: "ready",
    });
    expect(view.items.map((entry) => [entry.item, entry.state])).toEqual([
      ["1", "done"],
      ["2", "in review"],
      ["3", "done"],
      ["4", "not started"],
    ]);
    const text = formatObjectiveOverview(view);
    expect(text).toContain(
      [
        "Items:",
        "  1  done         Statement items mapped to Tasks.",
        "     build accepted, also item 3",
        "  2  in review    Owner reports versus questions.",
        "     review submitted",
        "  3  done         Describe task shows waits!",
        "     build accepted, also item 1",
      ].join("\n"),
    );
    expect(text).toMatch(/ {2}4 {2}not started {2}A very long item title.*\n {5}No Task\.\n/u);
    expect(text.indexOf("Items:")).toBeGreaterThan(text.indexOf("Needs you:"));
    expect(text.indexOf("Items:")).toBeLessThan(text.indexOf("Tasks:"));
  });

  it("says so in one line when no Task records items", async () => {
    const f = await fixture();
    const build = { ...(await f.assign("build")), status: "accepted" as const };
    const view = await buildObjectiveOverview({
      store: f.store,
      objective: f.objective,
      tasks: [build],
      teams: [f.team],
      limit: 10,
      offset: 0,
      executionReadiness: "ready",
    });
    const text = formatObjectiveOverview(view);
    expect(text).toContain("\nItems: Tasks in this Objective don't record statement items.\n");
    expect(text).not.toContain("not started");
    expect(text).not.toContain("No Task.");
  });

  it("names every other item a Task serves, in item order", async () => {
    const f = await fixture();
    const build = {
      ...(await f.assign("build", { items: ["1", "3", "4"] })),
      status: "running" as const,
    };
    const fix = { ...(await f.assign("fix", { items: ["3"] })), status: "queued" as const };
    const view = await buildObjectiveOverview({
      store: f.store,
      objective: f.objective,
      tasks: [build, fix],
      teams: [f.team],
      limit: 10,
      offset: 0,
      executionReadiness: "ready",
    });
    const text = formatObjectiveOverview(view);
    expect(text).toContain("     build running, also items 3, 4\n");
    expect(text).toContain("     build running, also items 1, 4\n     fix queued\n");
    expect(text).toContain("     build running, also items 1, 3\n");
  });

  it("omits the Items section when the statement lists no items", async () => {
    const f = await fixture("Ship the release.");
    const task = await f.assign("build");
    const view = await buildObjectiveOverview({
      store: f.store,
      objective: f.objective,
      tasks: [task],
      teams: [f.team],
      limit: 10,
      offset: 0,
      executionReadiness: "ready",
    });
    expect(view.items).toEqual([]);
    expect(formatObjectiveOverview(view)).not.toContain("Items:");
  });
});
