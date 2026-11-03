import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  emptyTagContextPlan,
  type TaskClaimDecline,
  teamRunningCount,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const lease = { leaseOwner: "test", leaseSeconds: 60 };

describe("teamRunningCount", () => {
  it("counts only running assignments of the Team held by its members", () => {
    const team = { id: "delivery", memberTagIds: ["a", "b"] };
    expect(
      teamRunningCount(team, [
        { teamId: "delivery", assignedTagId: "a", status: "running" },
        { teamId: "delivery", assignedTagId: "b", status: "waiting" },
        { teamId: "delivery", assignedTagId: "b", status: "queued" },
        { teamId: "delivery:child", assignedTagId: "a", status: "running" },
        { teamId: "delivery", assignedTagId: "former-member", status: "running" },
      ]),
    ).toBe(1);
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Team concurrency`, () => {
    const cleanups: Array<() => Promise<unknown>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-team-concurrency-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      if (isolated) cleanups.push(isolated.cleanup);
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const builders = await Promise.all(
        Array.from({ length: 5 }, (_, n) =>
          store.createTag({ name: `builder-${n}-${randomUUID()}` }),
        ),
      );
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Deliver independent items at once",
      });
      const controller = new ObjectiveController(store, undefined);
      async function admit(
        id: string,
        teamId: string,
        assignedTagId: string,
        objectiveId = objective.id,
      ) {
        const at = new Date().toISOString();
        return store.admitTaskAssignment({
          taskId: id,
          objectiveId,
          teamId,
          requestedByTagId: owner.id,
          assignedTagId,
          instruction: `Produce ${id}`,
          acceptanceCriteria: ["Reviewed"],
          requiresApproval: false,
          dependencies: [],
          maxCostMinor: 0,
          execution: {},
          workspacePlan: { version: 1, status: "none" },
          contextPlan: emptyTagContextPlan(at),
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: assignedTagId, name: assignedTagId },
            origin: { kind: "internal", objectiveId, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
      }
      const claim = (taskId: string) => store.claimTaskAssignment({ taskId, ...lease });
      const overview = () => controller.readObjectiveOverview({ objectiveId: objective.id });
      return { store, owner, builders, objective, admit, claim, overview };
    }

    it("starts every independent delegated Task together when the Team sets no limit", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Delivery",
        leadTagId: f.owner.id,
        memberTagIds: f.builders.map((tag) => tag.id),
      });
      expect(team.maxConcurrency).toBeNull();
      for (const [n, builder] of f.builders.entries())
        await f.admit(`item-${n}`, team.id, builder.id);
      const claimed = await Promise.all(f.builders.map((_, n) => f.claim(`item-${n}`)));
      expect(claimed.map((task) => task?.status)).toEqual(f.builders.map(() => "running"));
      const view = await f.overview();
      expect(view.teams[0]?.running).toBe(f.builders.length);
      expect(formatObjectiveOverview(view)).toContain(
        `${f.builders.length} running, limited only by Worker Host capacity`,
      );
    });

    it("frees a Team slot while its Task waits", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Throttled",
        leadTagId: f.owner.id,
        memberTagIds: [f.builders[0]?.id as string],
        maxConcurrency: 1,
      });
      await f.admit("lead-coordination", team.id, f.owner.id);
      await f.admit("build", team.id, f.builders[0]?.id as string);
      const lead = await f.claim("lead-coordination");
      expect(lead?.status).toBe("running");
      expect(await f.claim("build")).toBeUndefined();
      expect(formatObjectiveOverview(await f.overview())).toContain("1 of 1 running");
      // The lead now only waits for results; waiting holds no slot.
      await f.store.registerTaskAssignmentWait({
        taskId: "lead-coordination",
        leaseOwner: lease.leaseOwner,
        attemptCount: lead?.attemptCount ?? 0,
        submittedTaskIds: ["build"],
      });
      // Until its Attempt ends, the lead is still running and keeps its slot.
      expect(await f.claim("build")).toBeUndefined();
      await f.store.settleTaskAssignment({
        taskId: "lead-coordination",
        leaseOwner: lease.leaseOwner,
        attemptCount: lead?.attemptCount ?? 0,
        result: { text: "Waiting for the build" },
      });
      expect((await f.store.getTaskAssignment("lead-coordination"))?.status).toBe("waiting");
      const view = await f.overview();
      expect(view.teams[0]?.running).toBe(0);
      expect(view.tasks.find((task) => task.taskId === "build")?.explanations).not.toContainEqual(
        expect.objectContaining({ kind: "team_capacity" }),
      );
      expect((await f.claim("build"))?.status).toBe("running");
    });

    it("does not count descendant Teams' running work against an ancestor", async () => {
      const f = await fixture();
      const [first, second] = f.builders.map((tag) => tag.id) as [string, string];
      const parent = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Leadership",
        leadTagId: f.owner.id,
        memberTagIds: [first, second],
        maxConcurrency: 1,
      });
      const child = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Delivery",
        leadTagId: f.owner.id,
        memberTagIds: [first, second],
        parentTeamId: parent.id,
      });
      await f.admit("child-a", child.id, first);
      await f.admit("child-b", child.id, second);
      await f.admit("parent-review", parent.id, f.owner.id);
      expect((await f.claim("child-a"))?.status).toBe("running");
      expect((await f.claim("child-b"))?.status).toBe("running");
      expect((await f.claim("parent-review"))?.status).toBe("running");
      const view = await f.overview();
      expect(view.teams.find((team) => team.id === parent.id)?.running).toBe(1);
      expect(view.teams.find((team) => team.id === child.id)?.running).toBe(2);
    });

    it("shows a shared Team's running work from every Objective, as the scheduler counts it", async () => {
      const f = await fixture();
      const [first, second] = f.builders.map((tag) => tag.id) as [string, string];
      const other = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Share the Delivery Team",
      });
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Shared",
        leadTagId: f.owner.id,
        memberTagIds: [first, second],
        maxConcurrency: 1,
      });
      await f.store.updateTeam(team.id, { expectedRevision: 1, objectiveIds: [other.id] });
      await f.admit("elsewhere", team.id, first, other.id);
      await f.admit("here", team.id, second);
      expect((await f.claim("elsewhere"))?.status).toBe("running");
      // The other Objective's Attempt fills the shared Team, so this one cannot start ...
      expect(await f.claim("here")).toBeUndefined();
      // ... and describe objective shows the same count the scheduler enforced.
      const view = await f.overview();
      expect(view.teams[0]?.running).toBe(1);
      expect(view.tasks.find((task) => task.taskId === "here")?.explanations).toContainEqual(
        expect.objectContaining({ kind: "team_capacity" }),
      );
      expect(formatObjectiveOverview(view)).toContain("1 of 1 running");
    });

    it("explains a declined claim in describe objective with the store's reason, not a missing Worker", async () => {
      const f = await fixture();
      const [first, second] = f.builders.map((tag) => tag.id) as [string, string];
      const other = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Share the Delivery Team",
      });
      const team = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Shared",
        leadTagId: f.owner.id,
        memberTagIds: [first, second],
        maxConcurrency: 1,
      });
      await f.store.updateTeam(team.id, { expectedRevision: 1, objectiveIds: [other.id] });
      await f.admit("elsewhere", team.id, first, other.id);
      await f.admit("here", team.id, second);
      expect((await f.claim("elsewhere"))?.status).toBe("running");
      let decline: TaskClaimDecline | undefined;
      expect(
        await f.store.claimTaskAssignment({
          taskId: "here",
          ...lease,
          onDecline: (reason) => {
            decline = reason;
          },
        }),
      ).toBeUndefined();
      // Record the wait as the scheduler does for a declined claim.
      await f.store.appendTaskEvent({
        taskId: "here",
        type: "task.scheduling-waiting",
        payload: { version: 1, status: "waiting", reason: "claim", claim: decline },
      });
      const view = await f.overview();
      const explanations = view.tasks.find((task) => task.taskId === "here")?.explanations ?? [];
      expect(explanations).toContainEqual(
        expect.objectContaining({
          kind: "claim_declined",
          message: `Team ${team.id} runs at most 1 Task at once (maxConcurrency); running now: 1 Task in other Objectives.`,
          nextAction: expect.stringContaining("the Task starts when this clears."),
        }),
      );
      expect(explanations.map((explanation) => explanation.kind)).not.toContain("worker_capacity");
      const text = formatObjectiveOverview(view);
      expect(text).not.toContain("No eligible Worker Host has a matching Worker connected.");
      expect(text).not.toContain("elsewhere");
    });
  });
}
