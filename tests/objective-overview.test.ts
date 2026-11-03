import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { buildObjectiveOverview } from "../packages/control-plane/src/objective-overview.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Objective overview`, () => {
    const cleanups: Array<() => Promise<unknown>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture(budgetLimitMinor = 100) {
      const directory = await mkdtemp(join(tmpdir(), "supertag-overview-"));
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
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Deliver a reviewed result",
        budgetLimitMinor,
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Delivery",
        leadTagId: owner.id,
        memberTagIds: [],
        maxConcurrency: 1,
        scaling: { maxBreadth: 3, maxDepth: 2 },
      });
      const otherTeam = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Independent",
        leadTagId: owner.id,
        memberTagIds: [],
        maxConcurrency: 1,
      });
      const controller = new ObjectiveController(store, undefined);
      async function admit(
        id: string,
        options: {
          approval?: boolean;
          dependencies?: string[];
          teamId?: string;
          cost?: number;
          parentTaskId?: string;
        } = {},
      ) {
        const at = new Date().toISOString();
        return store.admitTaskAssignment({
          taskId: id,
          objectiveId: objective.id,
          teamId: options.teamId ?? team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: `Produce ${id}`,
          acceptanceCriteria: ["Reviewed"],
          requiresApproval: options.approval ?? false,
          dependencies: options.dependencies ?? [],
          ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
          maxCostMinor: options.cost ?? 0,
          execution: {},
          workspacePlan: { version: 1, status: "none" },
          contextPlan: emptyTagContextPlan(at),
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: owner.id, name: owner.name },
            origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
      }
      const overview = (input = {}) =>
        controller.readObjectiveOverview({ objectiveId: objective.id, ...input });
      return { store, url, owner, objective, team, otherTeam, controller, admit, overview };
    }

    it.each(["pagination", "Team filter"])(
      "reconciles Objective-wide spend with %s",
      async (scope) => {
        const f = await fixture();
        await f.admit("ordinary");
        await f.admit("reply", { teamId: f.otherTeam.id });
        const sql = `UPDATE "TaskAssignment" SET "activationKind" = 'team_reply' WHERE "taskId" = 'reply'`;
        if (dialect === "sqlite") {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(f.url.slice(5));
          try {
            db.exec(sql);
          } finally {
            db.close();
          }
        } else {
          const { Pool } = createRequire(
            new URL("../packages/store/package.json", import.meta.url),
          )("pg");
          const pool = new Pool({ connectionString: f.url });
          try {
            await pool.query(sql);
          } finally {
            await pool.end();
          }
        }
        for (const taskId of ["ordinary", "reply"]) {
          const attempt = await f.store.createTaskAttempt({
            taskId,
            attemptNumber: 1,
            workerProfile: { id: "default", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          await f.store.appendTaskEvent({
            taskId,
            attemptId: attempt.id,
            type: "usage.updated",
            payload: {
              usage: {
                inputTokens: 10,
                outputTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 10,
                complete: true,
                reportedCost: { amountMinor: taskId === "reply" ? 5 : 20, currency: "USD" },
              },
            },
          });
        }
        const spendRead = vi.spyOn(f.store, "readSpend");
        const view = await f.overview(
          scope === "pagination" ? { limit: 1 } : { teamId: f.team.id },
        );
        expect(view.tasks).toHaveLength(1);
        expect(JSON.parse(JSON.stringify(view)).postTriggeredSpend).toMatchObject({
          attempts: 1,
          reportedCostByCurrency: { USD: 5 },
        });
        expect(formatObjectiveOverview(view)).toContain(
          "Post-triggered activations (included in total) | 1 Attempt(s) | cost $0.05",
        );
        expect(formatObjectiveOverview(view)).toContain("$0.25 from recorded usage");
        const second = await f.overview({ limit: 1, offset: 1 });
        expect(formatObjectiveOverview(second)).toContain("$0.25 from recorded usage");
        const scoped = await f.overview({ teamId: f.team.id });
        expect(scoped.tasks.map((task) => task.taskId)).toEqual(["ordinary"]);
        expect(scoped.postTriggeredSpend.attempts).toBe(1);
        expect(formatObjectiveOverview(scoped)).toContain("$0.25 from recorded usage");
        expect(formatObjectiveOverview(scoped)).toContain("Spend scope: entire Objective");
        expect(spendRead).toHaveBeenCalledWith({ by: "objective", objectiveIds: [f.objective.id] });
      },
    );

    it("labels estimated provider cost in the objective budget", async () => {
      const f = await fixture();
      await f.admit("priced");
      const view = await f.overview();
      const task = view.tasks[0];
      if (!task) throw new Error("Missing test Task");
      const estimatedView: typeof view = {
        ...view,
        objectiveSpend: {
          ...view.objectiveSpend,
          estimatedCostAttempts: 1,
          reportedCostByCurrency: { USD: 5 },
        },
        tasks: [
          {
            ...task,
            budget: {
              ...task.budget,
              provider: {
                ...task.budget.provider,
                attempts: [
                  {
                    attemptId: "estimate",
                    attemptNumber: 1,
                    status: "completed",
                    limits: { observed: { usage: undefined } } as never,
                    requestedCost: null,
                    appliedCost: null,
                    observedCost: { amountMinor: 5, currency: "USD", estimated: true },
                    costCoverage: "complete",
                  },
                ],
              },
            },
          },
        ],
        objective: {
          ...view.objective,
          limitState: {
            reportedSpend: {
              amountMinor: 5,
              currency: "USD",
              unknownAttemptIds: [],
              estimatedCostAttempts: 1,
              observedAt: new Date().toISOString(),
            },
          },
        },
      };
      expect(formatObjectiveOverview(estimatedView)).toContain(
        "from recorded usage (includes estimated cost)",
      );
      expect(formatObjectiveOverview({ ...estimatedView, tasks: [] })).toContain(
        "from recorded usage (includes estimated cost)",
      );
    });

    it("never counts the owner's own submitted root activations as needing review", async () => {
      const f = await fixture();
      const startId = `${f.objective.id}:start`;
      const start = { ...(await f.admit(startId)), status: "submitted" as const };
      const delegated = {
        ...(await f.admit("delegated")),
        status: "submitted" as const,
        parentTaskId: startId,
      };
      // Work assigned straight to the owner outside its activations still awaits review.
      const direct = { ...(await f.admit("direct")), status: "submitted" as const };
      for (const status of ["working", "completed", "cancelled"] as const) {
        const view = await buildObjectiveOverview({
          store: f.store,
          objective: { ...f.objective, status, executionStartedAt: new Date().toISOString() },
          tasks: [start, delegated, direct],
          teams: [f.team],
          limit: 10,
          offset: 0,
          executionReadiness: "ready",
        });
        // The raw state count is unchanged; only the delegated and direct results await review.
        expect(view.performance.states.submitted).toBe(3);
        expect(view.performance.review.awaiting).toBe(2);
        expect(formatObjectiveOverview(view)).toContain("Needs review: 2\n");
      }
    });

    it("lists delegated work before the owner's own activations", async () => {
      const f = await fixture();
      const start = { ...(await f.admit("start")), status: "accepted" as const };
      const followup = {
        ...(await f.admit("start:assessment:followup")),
        status: "accepted" as const,
      };
      const delegated = {
        ...(await f.admit("delegated")),
        status: "submitted" as const,
        parentTaskId: "start",
      };
      const view = await buildObjectiveOverview({
        store: f.store,
        objective: f.objective,
        tasks: [start, followup, delegated],
        teams: [f.team],
        limit: 10,
        offset: 0,
        executionReadiness: "ready",
      });
      expect(view.tasks.map((task) => task.taskId)).toEqual([
        "delegated",
        "start",
        "start:assessment:followup",
      ]);
    });

    it("surfaces an active owner submission without scheduled follow-up, respecting visible scope", async () => {
      const f = await fixture();
      const assignment = await f.admit("manager");
      const task = { ...assignment, status: "submitted" as const };
      const objective = {
        ...f.objective,
        status: "working" as const,
        executionStartedAt: new Date().toISOString(),
      };
      const input = {
        store: f.store,
        objective,
        tasks: [task],
        teams: [f.team],
        limit: 1,
        offset: 0,
        executionReadiness: "ready",
      };
      const view = await buildObjectiveOverview(input);
      expect(view.attention).toContainEqual(
        expect.objectContaining({ kind: "no_scheduled_follow_up" }),
      );
      expect(formatObjectiveOverview(view)).toContain(
        "No work is scheduled to continue this Objective.",
      );
      expect(formatObjectiveOverview(view)).toContain(
        "Review the results, then send the owner your next instruction.",
      );
      expect(formatObjectiveOverview(view)).not.toContain("A prose request");
      expect(
        view.attention.find((item) => item.kind === "no_scheduled_follow_up")?.nextAction,
      ).toContain("A prose request");
      for (const status of ["queued", "running", "waiting"] as const) {
        const active = await buildObjectiveOverview({
          ...input,
          tasks: [task, { ...task, taskId: "follow-up", status }],
        });
        expect(active.attention.some((item) => item.kind === "no_scheduled_follow_up")).toBe(false);
      }
      const completed = await buildObjectiveOverview({
        ...input,
        objective: { ...objective, status: "completed" },
      });
      expect(completed.attention.some((item) => item.kind === "no_scheduled_follow_up")).toBe(
        false,
      );
      const scoped = await buildObjectiveOverview({ ...input, teamId: f.team.id, offset: 1 });
      expect(
        scoped.attention.find((item) => item.kind === "no_scheduled_follow_up")?.nextAction,
      ).toContain("Team-scoped");
    });

    it("surfaces durable observation delivery blockers in the operator view", async () => {
      const f = await fixture();
      const view = await buildObjectiveOverview({
        store: f.store,
        objective: {
          ...f.objective,
          observations: [{ workstreamId: "measurements" }],
          observationState: {
            cursors: { measurements: 2 },
            blocked: "Observation delivery awaits available Objective budget",
          },
        },
        tasks: [],
        teams: [f.team],
        limit: 50,
        offset: 0,
        executionReadiness: "ready",
      });
      expect(view.attention).toContainEqual(
        expect.objectContaining({
          kind: "observation_delivery_blocked",
          message: "Observation delivery awaits available Objective budget",
        }),
      );
      expect(formatObjectiveOverview(view)).toContain("Observation delivery awaits");
    });

    it("does not report unlimited scaling when an ancestor is outside the visible scope", async () => {
      const f = await fixture();
      const child = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Scoped child",
        leadTagId: f.team.leadTagId,
        memberTagIds: [],
        maxConcurrency: 1,
        parentTeamId: f.team.id,
      });
      const view = await buildObjectiveOverview({
        store: f.store,
        objective: f.objective,
        teams: [child],
        tasks: [],
        executionReadiness: "ready",
        limit: 50,
        offset: 0,
      });
      expect(view.teams[0]?.effectiveScaling).toBeNull();
    });

    it("explains approvals, acceptance dependencies, and visible Team capacity without changing work", async () => {
      const f = await fixture();
      await f.admit("source");
      await f.admit("consumer", { approval: true, dependencies: ["source"] });
      const running = await f.store.claimTaskAssignment({
        taskId: "source",
        leaseOwner: "test",
        leaseSeconds: 60,
      });
      expect(running?.status).toBe("running");
      const before = await f.store.listTaskAssignments(f.objective.id);
      const view = await f.overview();
      expect(view.teams.find((team) => team.id === f.team.id)?.scaling).toEqual({
        maxBreadth: 3,
        maxDepth: 2,
      });
      expect(view.teams.find((team) => team.id === f.team.id)?.effectiveScaling).toEqual({
        maxBreadth: 3,
        maxDepth: 2,
        maxBreadthTeamId: f.team.id,
        maxDepthTeamId: f.team.id,
      });
      expect(
        view.tasks
          .find((task) => task.taskId === "consumer")
          ?.explanations.map((reason) => reason.kind),
      ).toEqual(expect.arrayContaining(["approval", "dependency", "team_capacity", "controller"]));
      expect(view.performance.states).toMatchObject({ running: 1, queued: 1, accepted: 0 });
      expect(view.performance.review.acceptanceRate).toBeNull();
      expect(await f.store.listTaskAssignments(f.objective.id)).toEqual(before);
      expect(formatObjectiveOverview(view)).toContain("is not known to be accepted");
    });

    it("retains review, exact producing Attempt and artifact evidence across a database reopen", async () => {
      const f = await fixture();
      // Delegated work: the owner's own root activations close themselves without a review.
      await f.admit("start");
      await f.admit("implementation", { parentTaskId: "start" });
      const claim = await f.store.claimTaskAssignment({
        taskId: "implementation",
        leaseOwner: "test",
        leaseSeconds: 60,
      });
      expect(claim).toBeDefined();
      const attempt = await f.store.createTaskAttempt({
        taskId: "implementation",
        attemptNumber: 1,
        workerProfile: { id: "fixture", revision: "1" },
        workerSnapshot: {},
        startedAt: new Date().toISOString(),
      });
      const task = await f.store.findTaskById("implementation");
      if (!task) throw new Error("Missing Task");
      const digest = `sha256:${"a".repeat(64)}`;
      await f.store.recordArtifactUpload({
        taskId: task.id,
        attemptId: attempt.id,
        digest,
        sizeBytes: 42,
      });
      const artifact = await f.store.commitCapturedArtifact({
        operationId: "capture-result",
        taskId: task.id,
        attemptId: attempt.id,
        tagId: f.owner.id,
        sessionId: task.sessionId,
        objectiveId: f.objective.id,
        title: "Reviewed output",
        kind: "result",
        summary: "Result for independent review",
        entries: [
          {
            path: "workspace/result.txt",
            uri: `supertag-artifact:${digest}`,
            digest,
            sizeBytes: 42,
            mediaType: "text/plain",
          },
        ],
      });
      for (const totalTokens of [5, 10])
        await f.store.appendTaskEvent({
          taskId: task.id,
          attemptId: attempt.id,
          type: "execution.usage.updated",
          payload: {
            usage: {
              inputTokens: totalTokens,
              outputTokens: 0,
              cachedInputTokens: 0,
              totalTokens,
              complete: true,
            },
          },
        });
      await f.store.settleTaskAssignment({
        taskId: "implementation",
        leaseOwner: "test",
        attemptCount: 1,
        terminalAttempt: { id: attempt.id, status: "completed" },
        result: {
          taskResult: {
            artifacts: [{ artifactId: artifact.id, paths: ["workspace/result.txt"] }],
          },
        },
      });
      expect((await f.overview()).performance.states.submitted).toBe(1);
      await f.store.reviewTaskAssignment(
        "implementation",
        f.owner.id,
        true,
        "Checked the output independently.",
      );
      await f.store.disconnect();
      await f.store.connect();
      const view = await f.overview();
      expect(view.performance.review).toEqual({
        awaiting: 0,
        accepted: 1,
        rejected: 0,
        acceptanceRate: 1,
      });
      expect(view.tasks[0]).toMatchObject({
        status: "accepted",
        evidence: { producingAttemptId: attempt.id },
        review: { assessment: "Checked the output independently." },
        artifacts: [
          {
            artifactId: artifact.id,
            paths: ["workspace/result.txt"],
            reviewState: "accepted",
          },
        ],
      });
      expect(view.tasks[0]?.budget.provider.attempts[0]?.observedCost).toBeNull();
      expect(view.pageUsage.reportedTokens).toBe(10);
      expect(view.pageUsage.byTag).toEqual([
        expect.objectContaining({ tagId: f.owner.id, activationCount: 1, reportedTokens: 10 }),
      ]);
      expect(view.pageUsage.observationCoverage).toMatchObject({
        attempts: 1,
        reportingUsage: 1,
        reportingCost: 0,
        missingCostAttemptIds: [attempt.id],
      });
      // Attempt evidence stays in the JSON record; the text view reports usage in plain words.
      expect(formatObjectiveOverview(view)).toContain("Reported tokens: 10");
    });

    it("paginates execution detail and usage without shrinking the whole-view performance population", async () => {
      const f = await fixture();
      for (const id of ["one", "two", "three"]) await f.admit(id);
      const events = vi.spyOn(f.store, "listTaskEvents");
      const first = await f.overview({ limit: 1 });
      expect(first.performance.total).toBe(3);
      expect(first.tasks).toHaveLength(1);
      expect(first.nextOffset).toBe(1);
      expect(first.pageUsage.coversAllVisibleTasks).toBe(false);
      expect(first.pageUsage.byTag.reduce((sum, tag) => sum + tag.taskCount, 0)).toBe(
        first.tasks.length,
      );
      expect(events).toHaveBeenCalledTimes(1);
      const second = await f.overview({ limit: 1, offset: 1 });
      expect(second.tasks[0]?.taskId).not.toBe(first.tasks[0]?.taskId);
      expect((await f.overview({ offset: 3 })).tasks).toEqual([]);
      for (const input of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: 1.5 }])
        await expect(f.overview(input)).rejects.toMatchObject({ statusCode: 400 });
    });

    it("preserves action and Objective boundaries and does not promote a Team filter into authority", async () => {
      const f = await fixture();
      await f.admit("visible");
      await f.admit("filtered", { teamId: f.otherTeam.id });
      for (const scopes of [
        { actions: [] },
        { actions: ["read_objective"], objectiveIds: ["elsewhere"] },
        { actions: ["read_objective"], teamIds: [f.team.id] },
      ]) {
        await expect(
          f.controller.readObjectiveOverview(
            { objectiveId: f.objective.id, teamId: f.team.id },
            { operatorId: "limited", scopes },
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
      }
      const scoped = await f.controller.readObjectiveOverview(
        { objectiveId: f.objective.id, teamId: f.team.id },
        {
          operatorId: "objective-owner",
          scopes: { actions: ["read_objective"], objectiveIds: [f.objective.id] },
        },
      );
      expect(scoped.tasks.map((task) => task.taskId)).toEqual(["visible"]);
      expect(scoped.performance.total).toBe(1);
      expect(scoped.teams.map((team) => team.id)).toEqual([f.team.id]);
      await expect(f.overview({ teamId: "elsewhere" })).rejects.toMatchObject({ statusCode: 404 });
    });

    it("uses the latest stored scheduler diagnosis and does not return raw event payloads", async () => {
      const f = await fixture();
      await f.admit("queued");
      await f.store.appendTaskEvent({
        taskId: "queued",
        type: "task.scheduling-incompatible",
        payload: {
          unmetRequirements: ["execution.profile"],
          privateData: "SECRET_NOT_FOR_OVERVIEW",
        },
      });
      const view = await f.overview();
      expect(view.tasks[0]?.explanations).toContainEqual(
        expect.objectContaining({ kind: "worker_requirements", observedAt: expect.any(String) }),
      );
      expect(JSON.stringify(view)).not.toContain("SECRET_NOT_FOR_OVERVIEW");
      await f.store.appendTaskEvent({
        taskId: "queued",
        type: "task.scheduling-compatible",
        payload: {},
      });
      expect(
        (await f.overview()).tasks[0]?.explanations.some(
          (reason) => reason.kind === "worker_requirements",
        ),
      ).toBe(false);
    });

    it("explains a Task held for a lapsed MCP login with the login command", async () => {
      const f = await fixture();
      await f.admit("queued");
      await f.store.appendTaskEvent({
        taskId: "queued",
        type: "task.scheduling-incompatible",
        payload: {
          version: 1,
          status: "incompatible",
          unmetRequirements: ["labels:mcp:notion"],
          candidates: [],
          mcpLogins: ["notion"],
        },
      });
      expect((await f.overview()).tasks[0]?.explanations).toContainEqual(
        expect.objectContaining({
          kind: "worker_requirements",
          message:
            "Held until MCP server notion is logged in on its Worker Host; the login lapsed.",
          nextAction: "On that Worker Host, run supertag mcp login notion.",
        }),
      );
    });

    it("does not confuse exhausted unallocated budget with a blocker for reserved Tasks", async () => {
      const f = await fixture(10);
      await f.admit("reserved", { cost: 10 });
      const view = await f.overview();
      expect(view.allocation).toMatchObject({
        availableMinor: 0,
        reservedMinor: 10,
        chargedMinor: 0,
      });
      expect(view.attention).toContainEqual(
        expect.objectContaining({ kind: "allocation_exhausted" }),
      );
      expect(
        view.tasks[0]?.explanations.some((reason) => reason.kind === "allocation_exhausted"),
      ).toBe(false);
      expect(
        await f.store.claimTaskAssignment({ taskId: "reserved", leaseOwner: "test" }),
      ).toMatchObject({ status: "running" });
    });

    it.each(["working", "completed"] as const)(
      "separates budget exhaustion from %s delivery",
      async (status) => {
        const f = await fixture();
        const assignment = await f.admit("exhausted");
        const view = await buildObjectiveOverview({
          store: f.store,
          objective: { ...f.objective, status },
          teams: [f.team],
          tasks: [{ ...assignment, status: "failed", result: { failureKind: "budget-exhausted" } }],
          executionReadiness: "ready",
          limit: 50,
          offset: 0,
        });
        expect(view.tasks[0]?.explanations).toContainEqual(
          expect.objectContaining({
            kind: "budget_exhausted",
            nextAction: expect.stringContaining(
              status === "completed" ? "no renewal is required" : "explicit executionLimits",
            ),
          }),
        );
      },
    );

    it("labels a failed Task that delivered commits and offers acceptance", async () => {
      const f = await fixture();
      const assignment = await f.admit("timed-out");
      const view = await buildObjectiveOverview({
        store: f.store,
        objective: f.objective,
        teams: [f.team],
        tasks: [
          {
            ...assignment,
            status: "failed",
            result: {
              error: "Execution timed out",
              deliveredCommits: {
                attemptId: "attempt",
                branch: "supertag/o/timed-out",
                base: "a".repeat(40),
                head: "b".repeat(40),
                changedFiles: 2,
              },
            },
          },
        ],
        executionReadiness: "ready",
        limit: 50,
        offset: 0,
      });
      expect(view.tasks[0]?.explanations).toContainEqual(
        expect.objectContaining({
          kind: "failed_after_delivering_commits",
          message: expect.stringContaining("Failed after delivering commits"),
          nextAction: expect.stringContaining("status accepted"),
        }),
      );
      expect(formatObjectiveOverview(view)).toContain(
        "Failed after delivering commits: branch supertag/o/timed-out reached bbbbbbbbbbbb",
      );
    });

    it("flags expired running leases conservatively without claiming the execution stopped", async () => {
      const f = await fixture();
      const assignment = await f.admit("uncertain");
      const view = await buildObjectiveOverview({
        store: f.store,
        objective: f.objective,
        teams: [f.team],
        tasks: [{ ...assignment, status: "running", leaseExpiresAt: "2020-01-01T00:00:00.000Z" }],
        executionReadiness: "ready",
        limit: 50,
        offset: 0,
      });
      expect(view.tasks[0]?.explanations).toContainEqual(
        expect.objectContaining({
          kind: "recovery",
          message: expect.stringContaining("does not prove it stopped"),
        }),
      );
      expect((await f.store.getTaskAssignment("uncertain"))?.status).toBe("queued");
    });

    it("shows each Team's unresolved channel questions and blockers", async () => {
      const f = await fixture();
      const question = await f.store.postWorkstream({
        workstreamId: f.team.id,
        authorTagId: f.owner.id,
        type: "question",
        body: "Which interface should we use?",
        idempotencyKey: randomUUID(),
      });
      await f.store.postWorkstream({
        workstreamId: f.otherTeam.id,
        authorTagId: f.owner.id,
        type: "blocker",
        body: "Waiting on a credential",
        idempotencyKey: randomUUID(),
      });
      const reply = await f.store.postWorkstream({
        workstreamId: f.team.id,
        authorTagId: f.owner.id,
        type: "note",
        body: "Use the published interface",
        replyTo: question.id,
        idempotencyKey: randomUUID(),
      });
      const view = await f.overview();
      expect(view.coordination.posts).toHaveLength(3);
      const text = formatObjectiveOverview(view);
      expect(view.coordination.posts.some((post) => post.id === reply.id)).toBe(true);
      expect(text).not.toContain(`question post ${question.id} from`);
      expect(text).toContain("Waiting on a credential");
      expect(text).toContain("Delivery:");
      expect(text).toContain("Independent:");
    });

    it("shows addressed, sanitized posts and unanswered direct messages beyond recent history", async () => {
      const f = await fixture();
      const builder = await f.store.createTag({ name: "builder" });
      await f.store.updateTeam(f.team.id, {
        expectedRevision: f.team.revision,
        memberTagIds: [builder.id],
      });
      const post = await f.store.postWorkstream({
        workstreamId: f.team.id,
        authorTagId: f.owner.id,
        type: "blocker",
        to: [f.owner.id],
        body: `blocked\u001b[31m\n${"x".repeat(300)}`,
        idempotencyKey: randomUUID(),
      });
      const send = (type: "question" | "note", body: string, inReplyTo?: string) =>
        f.store.enqueueTagMessage({
          senderTagId: inReplyTo ? builder.id : f.owner.id,
          recipientTagId: inReplyTo ? f.owner.id : builder.id,
          objectiveId: f.objective.id,
          type,
          body: { message: body },
          idempotencyKey: randomUUID(),
          ...(inReplyTo ? { inReplyTo } : {}),
        });
      const open = await send("question", "Old unanswered direct question");
      const answered = await send("question", "Answered direct question");
      await send("note", "Answer", answered.message.id);
      // Processed messages still remain open until someone replies.
      for (let i = 0; i < 205; i++) {
        await send("note", `Noise ${i}`);
        await f.store.takeTeamDirectMessages({
          tagId: builder.id,
          objectiveId: f.objective.id,
          limit: 200,
        });
      }
      const view = await f.overview();
      const text = formatObjectiveOverview(view);
      expect(text).toContain(
        `blocker post ${post.id} from ${f.owner.name} to ${f.owner.name}: blocked [31m`,
      );
      expect(text).toContain(
        `question message ${open.message.id} from ${f.owner.name} to builder: Old unanswered direct question`,
      );
      expect(text).not.toContain("Answered direct question");
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("x".repeat(101));
      expect(
        view.teams.find((team) => team.id === f.otherTeam.id)?.openCoordination.directMessages,
      ).toEqual([]);
      expect(formatObjectiveOverview(await f.overview({ teamId: f.otherTeam.id }))).not.toContain(
        open.message.id,
      );
      const otherObjective = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Separate Objective",
      });
      await expect(f.store.listOpenTeamMessages(f.team.id, otherObjective.id)).rejects.toThrow();
      for (let i = 0; i < 22; i++) await send("question", `Open ${i}`);
      const bounded = await f.overview();
      expect(
        bounded.teams.find((team) => team.id === f.team.id)?.openCoordination.directMessages,
      ).toHaveLength(21);
      expect(formatObjectiveOverview(bounded)).toContain("More open questions or blockers");
    }, 30_000);

    it("keeps an old unanswered question visible beyond the recent post window", async () => {
      const f = await fixture();
      const question = await f.store.postWorkstream({
        workstreamId: f.team.id,
        authorTagId: f.owner.id,
        type: "question",
        body: "Old unanswered question",
        idempotencyKey: randomUUID(),
      });
      for (let index = 0; index < 101; index += 1)
        await f.store.postWorkstream({
          workstreamId: f.team.id,
          authorTagId: f.owner.id,
          body: `Later note ${index}`,
          idempotencyKey: randomUUID(),
        });
      const text = formatObjectiveOverview(await f.overview());
      expect(text).toContain(`question post ${question.id}`);
    });

    it("shows an actionable stall notice and retains its original record", async () => {
      const f = await fixture();
      const notice =
        "Needs you: owner stalled. SuperTag wrote this notice: the Objective is still working, but no owner activation is running, queued, or waiting, and SuperTag will not start another automatically because its limit was reached.";
      const view = {
        ...(await f.overview()),
        conversation: [
          {
            id: "notice",
            from: "owner" as const,
            tagId: f.owner.id,
            text: notice,
            status: "pending" as const,
            createdAt: "2026-10-06T00:00:00Z",
          },
        ],
      };
      const text = formatObjectiveOverview(view);
      expect(text).toContain("reply with your next instruction to restart the owner");
      expect(text).not.toContain("no owner activation");
      expect(JSON.stringify(view)).toContain(notice);
    });

    it("renders Teams by lead name and keeps effective scaling in the record", async () => {
      const f = await fixture();
      const view = await f.overview();
      const team = view.teams[0];
      expect(team?.effectiveScaling).not.toBeUndefined();
      const text = formatObjectiveOverview({
        ...view,
        tagNames: { ...view.tagNames, [team?.leadTagId ?? ""]: "lead-name" },
      });
      expect(text).toContain(
        `Team ${team?.name}: led by lead-name, 0 of ${team?.maxConcurrency} running`,
      );
      expect(text).not.toContain("effective breadth");
      const withoutNames = formatObjectiveOverview({ ...view, tagNames: {} });
      expect(withoutNames).toContain("Owner: unknown Tag");
      expect(withoutNames).not.toContain(view.objective.ownerTagId);
    });

    it("renders agent-authored text without terminal controls", async () => {
      const f = await fixture();
      const view = await f.overview();
      const text = formatObjectiveOverview({
        ...view,
        objective: { ...view.objective, outcome: "Hello\u001b[2J\u202e hidden" },
      });
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u202e");
    });

    it("explains registered wait conditions and measures current wait age without calling it a retry", async () => {
      const f = await fixture();
      await f.admit("waiting");
      await f.store.claimTaskAssignment({
        taskId: "waiting",
        leaseOwner: "test",
        leaseSeconds: 60,
      });
      const notBefore = new Date(Date.now() + 60_000).toISOString();
      await f.store.registerTaskAssignmentWait({
        taskId: "waiting",
        leaseOwner: "test",
        attemptCount: 1,
        notBefore,
      });
      // Registration does not mean the execution has stopped and released capacity.
      expect((await f.overview()).tasks[0]?.timing.currentWaitMs).toBeNull();
      await f.store.settleTaskAssignment({
        taskId: "waiting",
        leaseOwner: "test",
        attemptCount: 1,
        result: {},
      });
      const view = await f.overview();
      expect(view.tasks[0]?.timing.currentWaitMs).toBeGreaterThanOrEqual(0);
      expect(view.tasks[0]?.explanations).toContainEqual(
        expect.objectContaining({ kind: "wait", message: expect.stringContaining(notBefore) }),
      );
      expect(view.performance).toMatchObject({ states: { waiting: 1 }, additionalAttempts: 0 });
    });

    it("reconstructs historical dependency, wait, and ready-queue time from claimed activations", async () => {
      const f = await fixture();
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      await f.admit("source");
      await f.admit("consumer", { dependencies: ["source"] });
      const lease = { leaseOwner: "test", leaseSeconds: 60 };
      await f.store.claimTaskAssignment({ taskId: "source", ...lease });
      await sleep(20);
      await f.store.settleTaskAssignment({
        taskId: "source",
        leaseOwner: "test",
        attemptCount: 1,
        result: {},
      });
      await f.store.reviewTaskAssignment("source", f.owner.id, true, "Accepted");
      await sleep(20);
      await f.store.claimTaskAssignment({ taskId: "consumer", ...lease });
      const notBefore = new Date(Date.now() + 20).toISOString();
      await f.store.registerTaskAssignmentWait({
        taskId: "consumer",
        leaseOwner: "test",
        attemptCount: 1,
        notBefore,
      });
      await f.store.settleTaskAssignment({
        taskId: "consumer",
        leaseOwner: "test",
        attemptCount: 1,
        result: {},
      });
      await sleep(40);
      expect((await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId)).toEqual([
        "consumer",
      ]);
      await f.store.claimTaskAssignment({ taskId: "consumer", ...lease });
      const claims = (await f.store.listTaskEvents("consumer")).filter(
        (event) => event.type === "task.activation-claimed",
      );
      expect(claims.map((event) => event.payload)).toEqual([
        expect.objectContaining({ attemptNumber: 1, queuedFrom: "created", wait: null }),
        expect.objectContaining({
          attemptNumber: 2,
          queuedFrom: "wait",
          dependenciesReadyAt: expect.any(String),
          wait: expect.objectContaining({ reason: "time" }),
        }),
      ]);
      // A condition cannot be met before its wait is registered, which can be after notBefore
      // under load.
      const woken = claims[1];
      if (!woken) throw new Error("Missing woken activation");
      const { wait } = woken.payload as { wait: { conditionAt: string; registeredAt: string } };
      expect(wait.conditionAt).toBe(notBefore > wait.registeredAt ? notBefore : wait.registeredAt);
      const history = (await f.overview()).tasks.find((task) => task.taskId === "consumer")?.timing
        .history;
      expect(history).toMatchObject({ recordedActivations: 2, wakeDetectionUnknown: 0 });
      // The consumer waited on its dependency for at least the source's execution time.
      expect(history?.dependencyWaitMs).toBeGreaterThanOrEqual(20);
      expect(history?.waitMs).toBeGreaterThanOrEqual(20);
      expect(history?.waitMsByReason["time"]).toBe(history?.waitMs);
      expect(history?.queueMs).toBeGreaterThanOrEqual(
        (history?.dependencyWaitMs ?? 0) + (history?.readyQueueMs ?? 0) - 1,
      );
      const view = await f.overview();
      expect(view.pageUsage.byTag[0]?.history.recordedActivations).toBe(3);
      expect(view.pageUsage.byTag[0]?.history.unrecordedActivations).toBe(0);
    });

    it("dates a Workstream wake from the first qualifying post, not the latest", async () => {
      const f = await fixture();
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const stream = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Measurements",
        leadTagId: f.owner.id,
        memberTagIds: [f.owner.id],
      });
      const post = () =>
        f.store.postWorkstream({
          workstreamId: stream.id,
          authorTagId: f.owner.id,
          body: "A measurement",
          references: [],
          idempotencyKey: randomUUID(),
        });
      await f.admit("listener");
      const lease = { leaseOwner: "test", leaseSeconds: 60 };
      await f.store.claimTaskAssignment({ taskId: "listener", ...lease });
      await f.store.registerTaskAssignmentWait({
        taskId: "listener",
        leaseOwner: "test",
        attemptCount: 1,
        workstreamPosts: { workstreamId: stream.id, afterSequence: 0 },
      });
      await f.store.settleTaskAssignment({
        taskId: "listener",
        leaseOwner: "test",
        attemptCount: 1,
        result: {},
      });
      const first = await post();
      await sleep(30);
      await post();
      expect((await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId)).toEqual([
        "listener",
      ]);
      await f.store.claimTaskAssignment({ taskId: "listener", ...lease });
      const [, claim] = (await f.store.listTaskEvents("listener")).filter(
        (event) => event.type === "task.activation-claimed",
      );
      expect(claim?.payload).toMatchObject({
        wait: { reason: "workstream_posts", conditionAt: first.createdAt },
      });
      const history = (await f.overview()).tasks.find((task) => task.taskId === "listener")?.timing
        .history;
      // Detection spans at least the gap between the first and second posts.
      expect(history?.wakeDetectionMs).toBeGreaterThanOrEqual(30);
    });

    it("counts only a Team's own running member Attempts against its limit", async () => {
      const f = await fixture();
      const child = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Child",
        leadTagId: f.owner.id,
        memberTagIds: [],
        maxConcurrency: 1,
        parentTeamId: f.team.id,
      });
      await f.admit("child-work", { teamId: child.id });
      await f.admit("parent-work");
      expect(
        await f.store.claimTaskAssignment({
          taskId: "child-work",
          leaseOwner: "test",
          leaseSeconds: 60,
        }),
      ).toMatchObject({ status: "running" });
      // The child's running work does not occupy the parent's limit of 1.
      const view = await f.overview();
      expect(view.teams.find((team) => team.id === child.id)?.running).toBe(1);
      expect(view.teams.find((team) => team.id === f.team.id)?.running).toBe(0);
      expect(
        view.tasks.find((task) => task.taskId === "parent-work")?.explanations,
      ).not.toContainEqual(expect.objectContaining({ kind: "team_capacity" }));
      expect(view.capacityCoverage).toContain("descendant Teams and waiting Tasks do not count");
      // What the overview shows is what the scheduler enforces: the parent Team starts its work.
      expect(
        await f.store.claimTaskAssignment({
          taskId: "parent-work",
          leaseOwner: "test",
          leaseSeconds: 60,
        }),
      ).toMatchObject({ status: "running" });
      await f.admit("parent-blocked");
      const full = await f.overview();
      expect(full.teams.find((team) => team.id === f.team.id)?.running).toBe(1);
      expect(
        full.tasks.find((task) => task.taskId === "parent-blocked")?.explanations,
      ).toContainEqual(expect.objectContaining({ kind: "team_capacity" }));
      expect(
        await f.store.claimTaskAssignment({
          taskId: "parent-blocked",
          leaseOwner: "test",
          leaseSeconds: 60,
        }),
      ).toBeUndefined();
      const filtered = await f.overview({ teamId: f.team.id });
      expect(filtered.tasks[0]?.schedulingObservation).toContain("absence does not establish");
    });
  });
}
