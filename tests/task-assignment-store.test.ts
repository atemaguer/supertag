import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AdmitTaskAssignmentInput,
  ownerDeliveries,
  taskFollowupId,
  taskWorkspaceBranch,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { captureTestArtifact } from "./support/captured-artifact.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const Pool = createRequire(new URL("../packages/store/package.json", import.meta.url))("pg")
  .Pool as new (options: {
  connectionString: string;
}) => {
  query(text: string, values?: readonly string[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} internal Task persistence`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        vi.useRealTimers();
        const errors: unknown[] = [];
        for (const cleanup of cleanups.splice(0).reverse()) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, "Task fixture cleanup failed");
      });
      async function fixture(options: { budgetCurrency?: string } = {}) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-task-assignment-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const other = new DrizzleStore({ url });
        await other.connect();
        cleanups.push(() => other.disconnect());
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const worker = await store.createTag({ name: `worker-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Validate the product",
          budgetLimitMinor: 100,
          ...(options.budgetCurrency ? { budgetCurrency: options.budgetCurrency } : {}),
        });
        const team = await store.createTeam(
          {
            id: randomUUID(),
            objectiveId: objective.id,
            name: "Engineering",
            leadTagId: owner.id,
            memberTagIds: [worker.id],
            maxConcurrency: 1,
          },
          owner.id,
        );
        const make = (extra: Partial<AdmitTaskAssignmentInput> = {}): AdmitTaskAssignmentInput => ({
          taskId: randomUUID(),
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: worker.id,
          instruction: "Build a prototype",
          acceptanceCriteria: ["Tests pass"],
          execution: {},
          authorizationSnapshot: {
            version: 4,
            capturedAt: new Date().toISOString(),
            tag: { id: worker.id, name: worker.name },
            origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
          workspacePlan: { version: 1, status: "none" },
          ...extra,
        });
        return { store, other, owner, worker, objective, team, make, url };
      }
      it("reserves branches across concurrent admissions from different Objectives", async () => {
        const f = await fixture();
        await f.store.applyWorkspace({ name: "app", delivery: "branch" });
        const prefix = "objective-name-".padEnd(40, "x");
        const inputs = [];
        for (const ending of ["one", "two", "three"]) {
          const objective = await f.store.createObjective({
            id: `${prefix}-${ending}`,
            ownerTagId: f.owner.id,
            outcome: "Test branch collisions",
            workspaces: ["app"],
          });
          const team = await f.store.createTeam({
            id: `team-${ending}`,
            objectiveId: objective.id,
            name: "Engineering",
            leadTagId: f.owner.id,
            memberTagIds: [f.worker.id],
          });
          const taskId = `${objective.id}:fix-readme`;
          inputs.push(
            f.make({
              objectiveId: objective.id,
              teamId: team.id,
              taskId,
              workspacePlan: {
                version: 1,
                status: "workspace",
                workspace: "app",
                branch: taskWorkspaceBranch(objective.id, taskId),
                delivery: "branch",
              },
            }),
          );
        }
        await Promise.all(
          inputs.map((input, index) => (index % 2 ? f.other : f.store).admitTaskAssignment(input)),
        );
        const plans = await Promise.all(
          inputs.map(async ({ taskId }) => (await f.store.findTaskById(taskId))?.workspacePlan),
        );
        const branches = plans.map((plan) => plan?.status === "workspace" && plan.branch);
        expect(new Set(branches).size).toBe(3);
        expect(branches).toContain(`supertag/${prefix}/fix-readme`);
        // Cancelled and completed work still reserves its branch. Readmission is idempotent.
        for (const [index, input] of inputs.entries()) {
          await f.store.cancelTaskAssignment(input.taskId, f.owner.id);
          await f.other.admitTaskAssignment(input);
          expect((await f.store.findTaskById(input.taskId))?.workspacePlan).toEqual(plans[index]);
        }
        const first = inputs[0];
        if (!first) throw new Error("Missing branch fixture");
        const next = { ...first, taskId: `${first.objectiveId}:Fix-Readme` };
        await f.store.admitTaskAssignment(next);
        const nextPlan = (await f.store.findTaskById(next.taskId))?.workspacePlan;
        expect(branches).not.toContain(nextPlan?.status === "workspace" && nextPlan.branch);
      });

      it.each([undefined, "https://github.com/acme/app.git"])(
        "reserves message branches across workspace aliases with source %s",
        async (source) => {
          const f = await fixture();
          const inputs = [];
          for (const name of ["app", "alias"]) {
            await f.store.applyWorkspace({
              name,
              delivery: "branch",
              ...(source ? { source } : {}),
            });
            const taskId = `message:${randomUUID()}`;
            inputs.push(
              f.make({
                taskId,
                workspacePlan: {
                  version: 1,
                  status: "workspace",
                  workspace: name,
                  ...(source ? { source } : {}),
                  branch: taskWorkspaceBranch(f.objective.id, taskId),
                  delivery: "branch",
                },
              }),
            );
          }
          await Promise.all(
            inputs.map((input, i) => (i ? f.other : f.store).admitTaskAssignment(input)),
          );
          const plans = await Promise.all(
            inputs.map(async ({ taskId }) => (await f.store.findTaskById(taskId))?.workspacePlan),
          );
          const branches = plans.map((plan) => plan?.status === "workspace" && plan.branch);
          expect(new Set(branches).size).toBe(2);
          expect(
            branches.filter((branch) => typeof branch === "string" && branch.endsWith("/message")),
          ).toHaveLength(1);
        },
      );

      it("reserves aliases of a non-GitHub source with .git and trailing slashes", async () => {
        const f = await fixture();
        const sources = [
          "https://git.example.test/acme/app.git",
          "https://git.example.test/acme/app/",
        ];
        const branches = [];
        for (const [index, source] of sources.entries()) {
          const name = `alias-${index}`;
          await f.store.applyWorkspace({ name, source, delivery: "branch" });
          const taskId = `message:${randomUUID()}`;
          await f.store.admitTaskAssignment(
            f.make({
              taskId,
              workspacePlan: {
                version: 1,
                status: "workspace",
                workspace: name,
                source,
                branch: taskWorkspaceBranch(f.objective.id, taskId),
                delivery: "branch",
              },
            }),
          );
          const plan = (await f.store.findTaskById(taskId))?.workspacePlan;
          branches.push(plan?.status === "workspace" ? plan.branch : undefined);
        }
        expect(new Set(branches).size).toBe(2);
      });

      it("keeps the unsuffixed name available in a different source repository", async () => {
        const f = await fixture();
        const branches = [];
        for (const name of ["app", "other"]) {
          const source = `https://github.com/acme/${name}.git`;
          await f.store.applyWorkspace({ name, source, delivery: "branch" });
          const taskId = `message:${randomUUID()}`;
          await f.store.admitTaskAssignment(
            f.make({
              taskId,
              workspacePlan: {
                version: 1,
                status: "workspace",
                workspace: name,
                source,
                branch: taskWorkspaceBranch(f.objective.id, taskId),
                delivery: "branch",
              },
            }),
          );
          const plan = (await f.store.findTaskById(taskId))?.workspacePlan;
          branches.push(plan?.status === "workspace" && plan.branch);
        }
        expect(branches[0]).toBe(branches[1]);
        expect(String(branches[0])).toMatch(/\/message$/u);
      });

      it("reserves a host's collision suffix for later admissions through a workspace alias", async () => {
        const f = await fixture();
        for (const name of ["app", "alias"])
          await f.store.applyWorkspace({
            name,
            source: "https://github.com/acme/app.git",
            delivery: "branch",
          });
        const taskId = `message:${randomUUID()}`;
        const branch = taskWorkspaceBranch(f.objective.id, taskId);
        const workspacePlan = {
          version: 1 as const,
          status: "workspace" as const,
          workspace: "app",
          source: "https://github.com/acme/app.git",
          branch,
          delivery: "branch" as const,
        };
        await f.store.admitTaskAssignment(f.make({ taskId, workspacePlan }));
        const allocated = `${branch}-deadbeef`;
        await f.store.appendTaskEvent({
          taskId,
          type: "runtime-inputs.resolved",
          payload: {
            manifest: {
              inputs: [
                {
                  kind: "workspace",
                  resource: {
                    provenance: {
                      provider: "supertag-workspace",
                      workspace: "app",
                      branch: allocated,
                    },
                  },
                },
              ],
            },
          },
        });
        const nextId = `${f.objective.id}:message-deadbeef`;
        await f.other.admitTaskAssignment(
          f.make({ taskId: nextId, workspacePlan: { ...workspacePlan, workspace: "alias" } }),
        );
        const next = (await f.store.findTaskById(nextId))?.workspacePlan;
        expect(next?.status === "workspace" && next.branch).not.toBe(allocated);
      });

      it("preserves a historical branch on readmission and reserves it for its original Task", async () => {
        const f = await fixture();
        await f.store.applyWorkspace({ name: "app", delivery: "branch" });
        const input = f.make({
          taskId: `${f.objective.id}:original`,
          workspacePlan: {
            version: 1,
            status: "workspace",
            workspace: "app",
            branch: taskWorkspaceBranch(f.objective.id, "original"),
            delivery: "branch",
          },
        });
        await f.store.admitTaskAssignment(input);
        const oldPlan = {
          ...input.workspacePlan,
          branch: taskWorkspaceBranch(f.objective.id, "fix"),
        };
        // Simulate a plan saved by an earlier release, before the naming rule changed.
        if (dialect === "sqlite") {
          const connection = new Database(f.url.slice(5));
          try {
            connection
              .prepare('UPDATE "Task" SET "workspacePlan" = ? WHERE "id" = ?')
              .run(JSON.stringify(oldPlan), input.taskId);
          } finally {
            connection.close();
          }
        } else {
          const pool = new Pool({ connectionString: f.url });
          try {
            await pool.query('UPDATE "Task" SET "workspacePlan" = $1 WHERE "id" = $2', [
              JSON.stringify(oldPlan),
              input.taskId,
            ]);
          } finally {
            await pool.end();
          }
        }
        await f.other.admitTaskAssignment(input);
        expect((await f.store.findTaskById(input.taskId))?.workspacePlan).toEqual(oldPlan);
        const next = { ...input, taskId: `${f.objective.id}:fix` };
        await f.store.admitTaskAssignment(next);
        const nextPlan = (await f.store.findTaskById(next.taskId))?.workspacePlan;
        expect(nextPlan?.status === "workspace" && nextPlan.branch).not.toBe(oldPlan.branch);
      });

      it.each([false, true])(
        "pins a review artifact to Worker-recorded delivery (renamed branch: %s)",
        async (renamed) => {
          const f = await fixture();
          await f.store.applyWorkspace({ name: "app", delivery: "patch" });
          const taskId = `${f.objective.id}:source`;
          const requested = taskWorkspaceBranch(f.objective.id, taskId);
          const branch = renamed ? `${requested}-deadbeef` : requested;
          const reported = "a".repeat(40);
          const delivered = "b".repeat(40);
          const plan = {
            version: 1 as const,
            status: "workspace" as const,
            workspace: "app",
            branch: requested,
            delivery: "patch" as const,
          };
          const source = await f.store.admitTaskAssignment(f.make({ taskId, workspacePlan: plan }));
          await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "source" });
          const artifact = await captureTestArtifact(f.store, source.taskId);
          const path = artifact.entries[0]?.path;
          if (!path) throw new Error("Missing artifact entry");
          const progress = (head: string) => ({
            type: "progress.updated",
            progress: {
              summary: `Committed workspace app changes to ${branch}`,
              items: [
                { id: "workspace-branch", text: `Branch: ${branch}`, status: "completed" },
                { id: "workspace-base", text: `Base: ${"c".repeat(40)}`, status: "completed" },
                { id: "workspace-head", text: `Head: ${head}`, status: "completed" },
                { id: "workspace-changed-files", text: "Changed files: 1", status: "completed" },
              ],
            },
          });
          // A delivery record on another Attempt of the Task does not pin this artifact.
          await f.store.appendTaskEvent({
            taskId: source.taskId,
            type: "progress.updated",
            payload: progress(reported),
          });
          // The Task's own result names a commit first; only the Worker's record is trusted.
          await f.store.settleTaskAssignment({
            taskId: source.taskId,
            leaseOwner: "source",
            attemptCount: 1,
            result: {
              taskResult: {
                artifacts: [{ artifactId: artifact.id, paths: [path] }],
                changes: [{ reference: `git:${branch}@${reported}` }],
              },
            },
          });
          const reviewInput = async () => {
            const review = await f.store.admitTaskAssignment(
              f.make({
                workspacePlan: { ...plan, branch: `supertag/objective/review-${randomUUID()}` },
                inputArtifacts: [{ artifactId: artifact.id, paths: [path] }],
              }),
            );
            return (await f.store.findTaskById(review.taskId))?.trigger["inputArtifacts"] as {
              provenance: Record<string, unknown>;
            }[];
          };
          const unpinned = await reviewInput();
          expect(unpinned[0]?.provenance).not.toHaveProperty("workspaceGitReference");

          if (renamed)
            await f.store.appendTaskEvent({
              taskId: source.taskId,
              attemptId: artifact.attemptId,
              type: "runtime-inputs.resolved",
              payload: {
                manifest: {
                  inputs: [
                    {
                      kind: "workspace",
                      resource: {
                        provenance: {
                          provider: "supertag-workspace",
                          workspace: "app",
                          branch,
                        },
                      },
                    },
                  ],
                },
              },
            });
          await f.store.appendTaskEvent({
            taskId: source.taskId,
            attemptId: artifact.attemptId,
            type: "progress.updated",
            payload: progress(delivered),
          });
          expect(await reviewInput()).toMatchObject([
            { provenance: { workspaceGitReference: `git:${branch}@${delivered}` } },
          ]);
        },
      );
      it("retains only ordered accounting for the exact cancelled durable Attempt", async () => {
        const f = await fixture();
        const task = await f.store.admitTaskAssignment(f.make());
        const claimed = await f.store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "old-owner",
        });
        if (!claimed) throw new Error("Task not claimed");
        const attempt = await f.store.createTaskAttempt({
          taskId: task.taskId,
          attemptNumber: claimed.attemptCount,
          workerProfile: { id: "worker", revision: "1" },
          workerSnapshot: { durableExecution: true },
          startedAt: new Date().toISOString(),
        });
        await f.store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });
        await f.store.updateTaskAssignment(
          task.taskId,
          { expectedStatus: "running", status: "cancelled" },
          f.owner.id,
          { administrator: true },
        );
        const input = {
          taskId: task.taskId,
          attemptId: attempt.id,
          leaseOwner: "reconciler",
          attemptCount: claimed.attemptCount,
          sequence: 3,
          type: "usage.updated",
          payload: {
            type: "usage.updated",
            taskId: task.taskId,
            attemptId: attempt.id,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 0,
              totalTokens: 15,
              complete: true,
            },
          },
        };
        for (const invalid of [
          { ...input, type: "result" },
          { ...input, payload: { ...input.payload, attemptId: "another-attempt" } },
          { ...input, attemptCount: claimed.attemptCount + 1 },
        ])
          await expect(f.store.appendTaskAssignmentJournalEvent(invalid)).rejects.toThrow(
            "lease lost",
          );
        const saved = await f.store.appendTaskAssignmentJournalEvent(input);
        expect((await f.other.appendTaskAssignmentJournalEvent(input)).id).toBe(saved.id);
        await expect(
          f.store.appendTaskAssignmentJournalEvent({ ...input, sequence: 2 }),
        ).rejects.toThrow("sequence gap");
        expect((await f.store.getTaskAssignment(task.taskId))?.status).toBe("cancelled");
        await f.store.closeTaskAttempt({
          attemptId: attempt.id,
          status: "cancelled",
          endedAt: new Date().toISOString(),
        });
        await expect(
          f.store.appendTaskAssignmentJournalEvent({ ...input, sequence: 4 }),
        ).rejects.toThrow("lease lost");
      });
      it("atomically records only the authorized completing Attempt", async () => {
        const f = await fixture();
        const input = f.make({ assignedTagId: f.owner.id, execution: {} });
        const task = await f.store.admitTaskAssignment(input);
        await f.store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "completion-owner",
        });
        const attempt = await f.store.createTaskAttempt({
          workerProfile: { id: "default", revision: "1" },
          taskId: task.taskId,
          attemptNumber: 1,
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await f.store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });
        const update = {
          status: "completed" as const,
          expectedRevision: f.objective.revision,
          completionSummary: "Criteria satisfied",
        };
        await expect(
          f.other.updateObjectiveStatus(f.objective.id, update, f.owner.id, {
            taskId: task.taskId,
            attemptCount: 1,
            leaseOwner: "stale-owner",
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await f.store.getObjective(f.objective.id)).status).toBe("working");
        expect(
          (await f.store.listTaskEvents(task.taskId)).filter(
            (e) => e.type === "objective.completed",
          ),
        ).toHaveLength(0);
        const completed = await f.store.updateObjectiveStatus(f.objective.id, update, f.owner.id, {
          taskId: task.taskId,
          attemptCount: 1,
          leaseOwner: "completion-owner",
        });
        expect(
          (await f.other.listTaskEvents(task.taskId)).filter(
            (e) => e.type === "objective.completed",
          ),
        ).toEqual([
          expect.objectContaining({
            attemptId: attempt.id,
            payload: {
              objectiveId: f.objective.id,
              objectiveRevision: completed.revision,
              attemptCount: 1,
            },
          }),
        ]);
        await expect(
          f.store.updateObjectiveStatus(f.objective.id, update, f.owner.id, {
            taskId: task.taskId,
            attemptCount: 1,
            leaseOwner: "completion-owner",
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (await f.store.listTaskEvents(task.taskId)).filter(
            (e) => e.type === "objective.completed",
          ),
        ).toHaveLength(1);
      });
      it("releases a durably rejected pre-admission Attempt for a fresh claim", async () => {
        const f = await fixture();
        const task = await f.store.admitTaskAssignment(f.make());
        const claimed = await f.store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "rejected-admission",
        });
        if (!claimed) throw new Error("Task was not claimed");
        const attempt = await f.store.createTaskAttempt({
          workerProfile: { id: "manager", revision: "1" },
          taskId: task.taskId,
          attemptNumber: claimed.attemptCount,
          workerSnapshot: { durableExecution: true },
          startedAt: new Date().toISOString(),
        });
        await f.store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });

        const rejectedAt = Date.now();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(rejectedAt);
        try {
          await expect(
            f.store.releaseUnacceptedTaskAssignment({
              taskId: task.taskId,
              attemptId: attempt.id,
              leaseOwner: "rejected-admission",
              attemptCount: claimed.attemptCount,
              reason: "Worker capacity changed before durable admission",
              retryAfterMs: 100,
            }),
          ).resolves.toMatchObject({
            status: "queued",
            leaseOwner: null,
            availableAt: expect.any(String),
          });
          const released = await f.store.getTaskAssignment(task.taskId);
          expect(Date.parse(released?.availableAt ?? "")).toBe(rejectedAt + 100);
          expect((await f.store.listTaskAttempts(task.taskId))[0]).toMatchObject({
            id: attempt.id,
            status: "failed",
          });
          await expect(
            f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "retry" }),
          ).resolves.toBeUndefined();
          vi.setSystemTime(rejectedAt + 99);
          await expect(
            f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "retry" }),
          ).resolves.toBeUndefined();
          vi.setSystemTime(rejectedAt + 100);
          await expect(
            f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "retry" }),
          ).resolves.toMatchObject({ status: "running", attemptCount: 2 });
        } finally {
          vi.useRealTimers();
        }
      });
      it("refuses Objective completion until delegated Tasks assigned to other Tags are settled", async () => {
        const f = await fixture();
        const caller = await f.store.admitTaskAssignment(f.make({ assignedTagId: f.owner.id }));
        const outstanding = await f.store.admitTaskAssignment(f.make());
        const claimed = await f.store.claimTaskAssignment({
          taskId: caller.taskId,
          leaseOwner: "completion-owner",
        });
        if (!claimed?.leaseOwner) throw new Error("Missing completion lease");
        await f.store.createTaskAttempt({
          workerProfile: { id: "default", revision: "1" },
          taskId: caller.taskId,
          attemptNumber: claimed.attemptCount,
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await f.store.startTask({ taskId: caller.taskId, startedAt: new Date().toISOString() });
        const completion = {
          status: "completed" as const,
          expectedRevision: f.objective.revision,
          completionSummary: "All evidence reviewed",
        };

        await expect(
          f.store.updateObjectiveStatus(f.objective.id, completion, f.owner.id, {
            taskId: caller.taskId,
            attemptCount: claimed.attemptCount,
            leaseOwner: claimed.leaseOwner,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining(`${outstanding.taskId} (queued)`),
        });
        expect((await f.store.getObjective(f.objective.id)).status).toBe("working");
        await f.store.cancelTaskAssignment(outstanding.taskId, f.owner.id);
        await expect(
          f.store.updateObjectiveStatus(f.objective.id, completion, f.owner.id, {
            taskId: caller.taskId,
            attemptCount: claimed.attemptCount,
            leaseOwner: claimed.leaseOwner,
          }),
        ).resolves.toMatchObject({ status: "completed" });
      });
      it.each([true, false])(
        "freezes artifact references across review (accepted=%s) and keeps admission idempotent",
        async (accepted) => {
          const f = await fixture();
          const source = await f.store.admitTaskAssignment(f.make());
          await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "source" });
          const artifact = await captureTestArtifact(f.store, source.taskId, {
            mediaType: "application/octet-stream",
          });
          const entry = artifact.entries[0];
          if (!entry) throw new Error("Missing captured entry");
          const { uri, digest, path } = entry;
          const selection = { artifactId: artifact.id, paths: [path] };
          await f.store.settleTaskAssignment({
            taskId: source.taskId,
            leaseOwner: "source",
            attemptCount: 1,
            result: {
              reviewedByTagId: "untrusted-worker-reviewer",
              taskResult: {
                artifacts: [
                  {
                    ...selection,
                    ignored: "Not forwarded",
                  },
                ],
              },
            },
          });
          const input = f.make({
            inputArtifacts: [selection],
            maxCostMinor: 25,
          });
          const admitted = await f.store.admitTaskAssignment(input);
          const frozen = (await f.store.findTaskById(admitted.taskId))?.trigger;
          expect(frozen).toMatchObject({
            inputArtifacts: [
              {
                artifactId: artifact.id,
                path,
                uri,
                digest,
                mediaType: "application/octet-stream",
                provenance: {
                  taskId: source.taskId,
                  attemptCount: 1,
                  statusAtAdmission: "submitted",
                },
              },
            ],
          });
          expect(JSON.stringify(frozen)).not.toContain("Not forwarded");
          expect(JSON.stringify(frozen)).not.toContain("untrusted-worker-reviewer");
          const acceptedInput = f.make({
            inputArtifacts: [{ ...selection, requireAccepted: true }],
          });
          await expect(f.store.admitTaskAssignment(acceptedInput)).rejects.toMatchObject({
            statusCode: 409,
          });
          await f.store.reviewTaskAssignment(source.taskId, f.owner.id, accepted, "Reviewed");
          expect(await f.other.admitTaskAssignment(input)).toEqual(admitted);
          expect((await f.other.findTaskById(admitted.taskId))?.trigger).toEqual(frozen);
          const repair = await f.store.admitTaskAssignment(f.make({ inputArtifacts: [selection] }));
          expect((await f.store.findTaskById(repair.taskId))?.trigger["inputArtifacts"]).toEqual([
            {
              artifactId: artifact.id,
              path,
              sizeBytes: artifact.entries[0]?.sizeBytes,
              uri,
              digest,
              mediaType: "application/octet-stream",
              provenance: {
                taskId: source.taskId,
                attemptId: artifact.attemptId,
                attemptCount: 1,
                statusAtAdmission: accepted ? "accepted" : "rejected",
                reviewedByTagId: f.owner.id,
              },
            },
          ]);
          if (accepted) {
            const consumer = await f.store.admitTaskAssignment(acceptedInput);
            expect(await f.other.admitTaskAssignment(acceptedInput)).toEqual(consumer);
            await expect(
              f.store.admitTaskAssignment({
                ...acceptedInput,
                inputArtifacts: [selection],
              }),
            ).rejects.toMatchObject({ statusCode: 409 });
          } else {
            await expect(f.store.admitTaskAssignment(acceptedInput)).rejects.toMatchObject({
              statusCode: 409,
            });
          }
          expect((await f.store.getTaskAssignment(source.taskId))?.status).toBe(
            accepted ? "accepted" : "rejected",
          );
          await expect(
            f.store.admitTaskAssignment({ ...input, inputArtifacts: [] }),
          ).rejects.toMatchObject({ statusCode: 409 });
          expect(await f.store.getObjective(f.objective.id)).toMatchObject({
            reservedMinor: 25,
            spentMinor: 0,
          });
        },
      );
      it("rejects missing, unfinished, foreign, and invalid artifact selections without charging budget", async () => {
        const f = await fixture();
        const source = await f.store.admitTaskAssignment(f.make());
        const use = (artifactId: string, paths = ["output.json"]) =>
          f.make({ maxCostMinor: 50, inputArtifacts: [{ artifactId, paths }] });
        await expect(f.store.admitTaskAssignment(use(randomUUID()))).rejects.toMatchObject({
          statusCode: 404,
        });
        await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "source" });
        const artifact = await captureTestArtifact(f.store, source.taskId);
        await expect(f.store.admitTaskAssignment(use(artifact.id))).rejects.toMatchObject({
          statusCode: 409,
        });
        await expect(
          f.store.settleTaskAssignment({
            taskId: source.taskId,
            leaseOwner: "source",
            attemptCount: 1,
            result: {
              taskResult: { artifacts: [{ artifactId: artifact.id, paths: ["missing.json"] }] },
            },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await f.store.settleTaskAssignment({
          taskId: source.taskId,
          leaseOwner: "source",
          attemptCount: 1,
          result: {
            taskResult: { artifacts: [{ artifactId: artifact.id, paths: ["output.json"] }] },
          },
        });
        await f.store.reviewTaskAssignment(source.taskId, f.owner.id, false, "Repair required");
        await expect(
          f.store.admitTaskAssignment(use(artifact.id, ["missing.json"])),
        ).rejects.toMatchObject({ statusCode: 400 });
        const lead = await f.store.createTag({ name: randomUUID() });
        const isolatedTeam = await f.store.createTeam(
          {
            id: randomUUID(),
            objectiveId: f.objective.id,
            name: "Isolated",
            leadTagId: lead.id,
            memberTagIds: [f.worker.id],
            maxConcurrency: 1,
          },
          f.owner.id,
        );
        await expect(
          f.store.admitTaskAssignment({
            ...use(artifact.id),
            requestedByTagId: lead.id,
            teamId: isolatedTeam.id,
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const foreign = await fixture();
        const foreignSource = await foreign.store.admitTaskAssignment(foreign.make());
        await foreign.store.claimTaskAssignment({
          taskId: foreignSource.taskId,
          leaseOwner: "foreign",
        });
        const foreignArtifact = await captureTestArtifact(foreign.store, foreignSource.taskId);
        await expect(f.store.admitTaskAssignment(use(foreignArtifact.id))).rejects.toMatchObject({
          statusCode: 404,
        });
        expect(await f.store.getObjective(f.objective.id)).toMatchObject({
          reservedMinor: 0,
          spentMinor: 0,
        });
        expect(await f.store.listTaskAssignments(f.objective.id)).toHaveLength(1);
      });
      it("binds acceptance to the submitted catalog selection and excludes another capture from the same Attempt", async () => {
        const f = await fixture();
        const source = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "source" });
        const reviewed = await captureTestArtifact(f.store, source.taskId, { content: "reviewed" });
        const attempt = (await f.store.listTaskAttempts(source.taskId))[0];
        if (!attempt) throw new Error("Missing producer Attempt");
        const replacement = await captureTestArtifact(f.store, source.taskId, {
          attempt,
          content: "replacement",
        });
        const selection = { artifactId: reviewed.id, paths: ["output.json"] };
        await f.store.settleTaskAssignment({
          taskId: source.taskId,
          leaseOwner: "source",
          attemptCount: 1,
          result: { taskResult: { artifacts: [selection] } },
        });
        await f.store.reviewTaskAssignment(
          source.taskId,
          f.owner.id,
          true,
          "Inspected submitted output",
        );
        expect((await f.store.getTaskAssignment(source.taskId))?.result).toMatchObject({
          reviewedAttemptId: attempt.id,
          reviewedArtifacts: [selection],
        });
        const consumer = await f.store.admitTaskAssignment(
          f.make({ inputArtifacts: [{ ...selection, requireAccepted: true }] }),
        );
        expect((await f.store.findTaskById(consumer.taskId))?.trigger["inputArtifacts"]).toEqual([
          expect.objectContaining({
            artifactId: reviewed.id,
            digest: reviewed.entries[0]?.digest,
            provenance: expect.objectContaining({
              attemptId: attempt.id,
              reviewedByTagId: f.owner.id,
            }),
          }),
        ]);
        await expect(
          f.store.admitTaskAssignment(
            f.make({
              inputArtifacts: [
                { artifactId: replacement.id, paths: ["output.json"], requireAccepted: true },
              ],
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });
      });
      it("rejects submission of another Task's catalog output even when its bytes are identical", async () => {
        const f = await fixture();
        const first = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: first.taskId, leaseOwner: "first" });
        const artifact = await captureTestArtifact(f.store, first.taskId);
        await f.store.settleTaskAssignment({
          taskId: first.taskId,
          leaseOwner: "first",
          attemptCount: 1,
          result: {
            taskResult: { artifacts: [{ artifactId: artifact.id, paths: ["output.json"] }] },
          },
        });
        const second = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: second.taskId, leaseOwner: "second" });
        await captureTestArtifact(f.store, second.taskId);
        await expect(
          f.store.settleTaskAssignment({
            taskId: second.taskId,
            leaseOwner: "second",
            attemptCount: 1,
            result: {
              taskResult: { artifacts: [{ artifactId: artifact.id, paths: ["output.json"] }] },
            },
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await f.store.getTaskAssignment(second.taskId))?.status).toBe("running");
      });
      it("coalesces shared posts into one cursor wake and observes posts committed before registration", async () => {
        const f = await fixture();
        // The Team's channel: its lead posts and its member waits.
        const stream = await f.store.getWorkstream(f.team.id);
        const task = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "posts" });
        await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            f.store.postWorkstream({
              workstreamId: stream.id,
              authorTagId: f.owner.id,
              body: `Finding ${i}`,
              idempotencyKey: randomUUID(),
            }),
          ),
        );
        const registration = {
          taskId: task.taskId,
          leaseOwner: "posts",
          attemptCount: 1,
          workstreamPosts: { workstreamId: stream.id, afterSequence: 0 },
          // An event wake is an alternative to the timer, not gated by it.
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        };
        await f.store.registerTaskAssignmentWait(registration);
        await f.other.registerTaskAssignmentWait(registration);
        await expect(
          f.other.registerTaskAssignmentWait({
            ...registration,
            workstreamPosts: { workstreamId: stream.id, afterSequence: 1 },
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "posts",
          attemptCount: 1,
          result: {},
        });
        const wakes = (
          await Promise.all([
            f.store.wakeWaitingTaskAssignments(),
            f.other.wakeWaitingTaskAssignments(),
          ])
        )
          .flat()
          .filter((row) => row.taskId === task.taskId);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "workstream_posts",
          workstreamId: stream.id,
          throughSequence: 50,
        });
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "next" });
        await f.store.registerTaskAssignmentWait({
          ...registration,
          leaseOwner: "next",
          attemptCount: 2,
          workstreamPosts: { workstreamId: stream.id, afterSequence: 50 },
        });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "next",
          attemptCount: 2,
          result: {},
        });
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some((row) => row.taskId === task.taskId),
        ).toBe(false);
        await f.store.postWorkstream({
          workstreamId: stream.id,
          authorTagId: f.owner.id,
          body: "Next",
          idempotencyKey: randomUUID(),
        });
        expect(
          (await f.other.wakeWaitingTaskAssignments()).find((row) => row.taskId === task.taskId)
            ?.waitState?.wake?.throughSequence,
        ).toBe(51);
        expect(await f.store.listTaskAssignments(f.objective.id)).toHaveLength(1);
        expect(await f.store.listTagMessages(f.worker.id)).toEqual([]);
      });
      it("rejects invalid post cursors and no longer wakes after membership removal", async () => {
        const f = await fixture();
        // A second Team the worker belongs to without Tasks in it, so it can leave.
        const board = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: f.objective.id,
          name: "Board",
          leadTagId: f.owner.id,
          memberTagIds: [f.worker.id],
        });
        const stream = await f.store.getWorkstream(board.id);
        const task = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "posts" });
        const registration = {
          taskId: task.taskId,
          leaseOwner: "posts",
          attemptCount: 1,
          workstreamPosts: { workstreamId: stream.id, afterSequence: 0 },
        };
        for (const afterSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null])
          await expect(
            f.store.registerTaskAssignmentWait({
              ...registration,
              workstreamPosts: { workstreamId: stream.id, afterSequence: afterSequence as number },
            }),
          ).rejects.toMatchObject({ statusCode: 400 });
        const foreignObjective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Other",
        });
        const foreign = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: foreignObjective.id,
          name: "Other",
          leadTagId: f.owner.id,
          memberTagIds: [f.worker.id],
        });
        await expect(
          f.store.registerTaskAssignmentWait({
            ...registration,
            workstreamPosts: { workstreamId: foreign.id, afterSequence: 0 },
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await f.store.registerTaskAssignmentWait(registration);
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "posts",
          attemptCount: 1,
          result: {},
        });
        await f.store.updateTeam(board.id, { expectedRevision: board.revision, memberTagIds: [] });
        await f.store.postWorkstream({
          workstreamId: stream.id,
          authorTagId: f.owner.id,
          body: "Private",
          idempotencyKey: randomUUID(),
        });
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some((row) => row.taskId === task.taskId),
        ).toBe(false);
      });
      it("refuses a post wait on a dissolved Team channel", async () => {
        const f = await fixture();
        const board = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: f.objective.id,
          name: "Board",
          leadTagId: f.owner.id,
          memberTagIds: [f.worker.id],
        });
        const task = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "posts" });
        await f.store.updateTeam(board.id, {
          expectedRevision: board.revision,
          status: "dissolved",
        });
        await expect(
          f.store.registerTaskAssignmentWait({
            taskId: task.taskId,
            leaseOwner: "posts",
            attemptCount: 1,
            workstreamPosts: { workstreamId: board.id, afterSequence: 0 },
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringMatching(/Workstream.*dissolved/),
        });
        expect((await f.store.getTaskAssignment(task.taskId))?.waitState).toBeNull();
      });
      it("wakes an already due timer without waiting for another event", async () => {
        const f = await fixture();
        const task = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "timer" });
        await f.store.registerTaskAssignmentWait({
          taskId: task.taskId,
          leaseOwner: "timer",
          attemptCount: 1,
          notBefore: new Date(Date.now() - 1000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "timer",
          attemptCount: 1,
          result: {},
        });
        expect(await f.other.wakeWaitingTaskAssignments()).toContainEqual(
          expect.objectContaining({
            taskId: task.taskId,
            waitState: expect.objectContaining({
              wake: expect.objectContaining({ reason: "time" }),
            }),
          }),
        );
        expect(
          (await f.store.wakeWaitingTaskAssignments()).some((row) => row.taskId === task.taskId),
        ).toBe(false);
      });
      it("never retries an expired durable execution with an unknown outcome", async () => {
        const f = await fixture();
        const task = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "durable",
          leaseSeconds: 5,
        });
        await f.store.createTaskAttempt({
          workerProfile: { id: "default", revision: "1" },
          taskId: task.taskId,
          attemptNumber: 1,
          workerSnapshot: { durableExecution: true },
          startedAt: new Date().toISOString(),
        });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 6000);
        expect(
          await f.other.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "replacement" }),
        ).toBeUndefined();
        expect(await f.store.getTaskAssignment(task.taskId)).toMatchObject({
          status: "running",
          attemptCount: 1,
          result: null,
        });
      });
      it("persists waits, releases capacity, wakes once on failed children, and avoids double charging", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make({ maxCostMinor: 50 }));
        const child = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        const registration = {
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          submittedTaskIds: [child.taskId],
        };
        await f.store.registerTaskAssignmentWait(registration);
        expect(
          (await f.other.registerTaskAssignmentWait(registration)).waitState?.submittedTaskIds,
        ).toEqual([child.taskId]);
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: { progress: "delegated" },
        });
        expect((await f.other.getTaskAssignment(parent.taskId))?.status).toBe("waiting");
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
        expect(
          await f.other.claimTaskAssignment({ taskId: child.taskId, leaseOwner: "child" }),
        ).toBeDefined();
        await f.other.settleTaskAssignment({
          taskId: child.taskId,
          leaseOwner: "child",
          attemptCount: 1,
          failed: true,
          result: { error: "blocked" },
        });
        expect(
          (await f.store.listTaskAssignmentFollowups()).some((t) => t.taskId === child.taskId),
        ).toBe(false);
        const wakes = (
          await Promise.all([
            f.store.wakeWaitingTaskAssignments(),
            f.other.wakeWaitingTaskAssignments(),
          ])
        )
          .flat()
          .filter((t) => t.taskId === parent.taskId);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "submitted_tasks",
          taskIds: [child.taskId],
        });
        expect(
          await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "resume" }),
        ).toMatchObject({ attemptCount: 2 });
        expect(await f.store.getObjective(f.objective.id)).toMatchObject({
          spentMinor: 50,
          reservedMinor: 0,
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "resume",
          attemptCount: 2,
          result: { final: true },
        });
        expect((await f.store.getTaskAssignment(parent.taskId))?.status).toBe("submitted");
      });
      it("wakes a requester waiting on one Task when another delegated Task submits for its review", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make({ assignedTagId: f.owner.id }));
        const a = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        const b = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          submittedTaskIds: [a.taskId],
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: { progress: "delegated" },
        });
        expect(
          (await f.store.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
        await f.store.claimTaskAssignment({ taskId: b.taskId, leaseOwner: "b" });
        await f.store.settleTaskAssignment({
          taskId: b.taskId,
          leaseOwner: "b",
          attemptCount: 1,
          result: { taskResult: { summary: "Ready for review" } },
        });
        expect((await f.store.getTaskAssignment(b.taskId))?.status).toBe("submitted");
        const wakes = (await f.store.wakeWaitingTaskAssignments()).filter(
          (t) => t.taskId === parent.taskId,
        );
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "submitted_tasks",
          taskIds: [b.taskId],
        });
      });
      it("wakes a requester waiting on several listed Tasks when one fails, as a submission does", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make({ assignedTagId: f.owner.id }));
        const a = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        const b = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          submittedTaskIds: [a.taskId, b.taskId],
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: { progress: "delegated" },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await f.store.claimTaskAssignment({ taskId: a.taskId, leaseOwner: "a" });
        await f.store.settleTaskAssignment({
          taskId: a.taskId,
          leaseOwner: "a",
          attemptCount: 1,
          failed: true,
          result: { error: "Harness exited before any event" },
        });
        expect((await f.store.getTaskAssignment(a.taskId))?.status).toBe("failed");
        const wakes = (await f.store.wakeWaitingTaskAssignments()).filter(
          (t) => t.taskId === parent.taskId,
        );
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "submitted_tasks",
          taskIds: [a.taskId],
        });
      });
      it("reports why it declines to claim a queued Task", async () => {
        const f = await fixture();
        const running = await f.store.admitTaskAssignment(f.make());
        const queued = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: running.taskId, leaseOwner: "a" });
        const declines: unknown[] = [];
        await expect(
          f.store.claimTaskAssignment({
            taskId: queued.taskId,
            leaseOwner: "b",
            onDecline: (decline) => declines.push(decline),
          }),
        ).resolves.toBeUndefined();
        expect(declines).toEqual([
          {
            code: "team_concurrency",
            message: `Team ${f.team.id} runs at most 1 Task at once (maxConcurrency); running now: ${running.taskId}.`,
            teamId: f.team.id,
            taskIds: [running.taskId],
          },
        ]);
        // A claim that succeeds reports nothing.
        await f.store.cancelTaskAssignment(running.taskId, f.owner.id);
        declines.length = 0;
        await expect(
          f.store.claimTaskAssignment({
            taskId: queued.taskId,
            leaseOwner: "b",
            onDecline: (decline) => declines.push(decline),
          }),
        ).resolves.toMatchObject({ status: "running" });
        expect(declines).toEqual([]);
      });
      it("names no Task from another Objective when a shared Team's maxConcurrency declines a claim", async () => {
        const f = await fixture();
        const other = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Share the Team",
        });
        await f.store.updateTeam(f.team.id, { expectedRevision: 1, objectiveIds: [other.id] });
        const elsewhere = await f.store.admitTaskAssignment(f.make({ objectiveId: other.id }));
        const queued = await f.store.admitTaskAssignment(f.make());
        await expect(
          f.store.claimTaskAssignment({ taskId: elsewhere.taskId, leaseOwner: "a" }),
        ).resolves.toMatchObject({ status: "running" });
        const declines: unknown[] = [];
        await expect(
          f.store.claimTaskAssignment({
            taskId: queued.taskId,
            leaseOwner: "b",
            onDecline: (decline) => declines.push(decline),
          }),
        ).resolves.toBeUndefined();
        expect(declines).toEqual([
          {
            code: "team_concurrency",
            message: `Team ${f.team.id} runs at most 1 Task at once (maxConcurrency); running now: 1 Task in other Objectives.`,
            teamId: f.team.id,
            taskIds: [],
          },
        ]);
        expect(JSON.stringify(declines)).not.toContain(elsewhere.taskId);
      });
      it("wakes a waiter that names a Task another Tag requested when that Task fails", async () => {
        const f = await fixture();
        // The waiter is the worker's Task; the owner requested the Tasks it names.
        const parent = await f.store.admitTaskAssignment(f.make());
        const a = await f.store.admitTaskAssignment(f.make());
        const b = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          acceptedTaskIds: [a.taskId, b.taskId],
          notBefore: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: { progress: "waiting" },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(
          (await f.store.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
        await f.store.claimTaskAssignment({ taskId: b.taskId, leaseOwner: "b" });
        await f.store.settleTaskAssignment({
          taskId: b.taskId,
          leaseOwner: "b",
          attemptCount: 1,
          failed: true,
          result: { error: "Harness exited before any event" },
        });
        const wakes = (await f.store.wakeWaitingTaskAssignments()).filter(
          (t) => t.taskId === parent.taskId,
        );
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "submitted_tasks",
          taskIds: [b.taskId],
        });
      });
      it("wakes a requester waiting on several listed Tasks when the first submits, ignoring earlier results", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make({ assignedTagId: f.owner.id }));
        const early = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        const a = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        const b = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        const c = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        const submit = async (taskId: string) => {
          await f.store.claimTaskAssignment({ taskId, leaseOwner: taskId });
          await f.store.settleTaskAssignment({
            taskId,
            leaseOwner: taskId,
            attemptCount: 1,
            result: { taskResult: { summary: "Ready for review" } },
          });
          expect((await f.store.getTaskAssignment(taskId))?.status).toBe("submitted");
        };
        // Submitted before the wait began: it must not wake the requester.
        await submit(early.taskId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          submittedTaskIds: [a.taskId, b.taskId, c.taskId],
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: { progress: "delegated" },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(
          (await f.store.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
        await submit(b.taskId);
        const wakes = (await f.store.wakeWaitingTaskAssignments()).filter(
          (t) => t.taskId === parent.taskId,
        );
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "submitted_tasks",
          taskIds: [b.taskId],
        });
        // The same result does not wake it again.
        expect(
          (await f.store.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
      });
      it("rejects a Task-only wait when its target cannot run until the caller reviews a dependency", async () => {
        const f = await fixture();
        const source = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "source" });
        await f.store.settleTaskAssignment({
          taskId: source.taskId,
          leaseOwner: "source",
          attemptCount: 1,
          result: { taskResult: { summary: "Ready for review" } },
        });
        const dependent = await f.store.admitTaskAssignment(
          f.make({ dependencies: [source.taskId] }),
        );
        const parent = await f.store.admitTaskAssignment(f.make({ assignedTagId: f.owner.id }));
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });

        await expect(
          f.store.registerTaskAssignmentWait({
            taskId: parent.taskId,
            leaseOwner: "parent",
            attemptCount: 1,
            submittedTaskIds: [dependent.taskId],
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining(`requires dependency ${source.taskId} to be accepted`),
        });
        expect(await f.store.getTaskAssignment(parent.taskId)).toMatchObject({
          status: "running",
          waitState: null,
        });
        await expect(
          f.store.registerTaskAssignmentWait({
            taskId: parent.taskId,
            leaseOwner: "parent",
            attemptCount: 1,
            acceptedTaskIds: [source.taskId],
          }),
        ).resolves.toMatchObject({
          waitState: expect.objectContaining({ acceptedTaskIds: [source.taskId] }),
        });
      });
      it("wakes a persisted Task-only wait once its target becomes blocked on manager review", async () => {
        const f = await fixture();
        await f.store.updateTeam(f.team.id, { expectedRevision: 1, maxConcurrency: 2 }, f.owner.id);
        const source = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: source.taskId, leaseOwner: "source" });
        const dependent = await f.store.admitTaskAssignment(
          f.make({ dependencies: [source.taskId] }),
        );
        const parent = await f.store.admitTaskAssignment(f.make({ assignedTagId: f.owner.id }));
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          submittedTaskIds: [dependent.taskId],
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: { progress: "Waiting for dependent work" },
        });
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some(
            (task) => task.taskId === parent.taskId,
          ),
        ).toBe(false);

        await f.store.settleTaskAssignment({
          taskId: source.taskId,
          leaseOwner: "source",
          attemptCount: 1,
          result: { taskResult: { summary: "Ready for review" } },
        });
        const wakes = (
          await Promise.all([
            f.store.wakeWaitingTaskAssignments(),
            f.other.wakeWaitingTaskAssignments(),
          ])
        )
          .flat()
          .filter((task) => task.taskId === parent.taskId);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.waitState?.wake).toMatchObject({
          reason: "blocked_tasks",
          taskIds: [dependent.taskId],
        });
        expect(
          await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "resume" }),
        ).toMatchObject({ attemptCount: 2 });
      });
      it("wakes already accepted dependencies only after settlement and keeps cancellation final", async () => {
        const f = await fixture();
        const child = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: child.taskId, leaseOwner: "child" });
        await f.store.settleTaskAssignment({
          taskId: child.taskId,
          leaseOwner: "child",
          attemptCount: 1,
          result: {},
        });
        await f.store.reviewTaskAssignment(child.taskId, f.owner.id, true, "Done");
        const parent = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "parent" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          acceptedTaskIds: [child.taskId],
        });
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "parent",
          attemptCount: 1,
          result: {},
        });
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(true);
        await f.store.claimTaskAssignment({ taskId: parent.taskId, leaseOwner: "second" });
        await f.store.registerTaskAssignmentWait({
          taskId: parent.taskId,
          leaseOwner: "second",
          attemptCount: 2,
          notBefore: new Date(Date.now() - 1000).toISOString(),
        });
        await f.store.settleTaskAssignment({
          taskId: parent.taskId,
          leaseOwner: "second",
          attemptCount: 2,
          result: {},
        });
        await f.store.cancelTaskAssignment(parent.taskId, f.owner.id);
        expect(
          (await f.other.wakeWaitingTaskAssignments()).some((t) => t.taskId === parent.taskId),
        ).toBe(false);
      });
      describe("a child whose waiting parent was cancelled", () => {
        // The parent waited on the child, then was cancelled; a takeover Task (in production a
        // Mailbox Task for the same owner) registers the same wait.
        async function cancelledParent(takeoverEnds: boolean) {
          const f = await fixture();
          const parent = await f.store.admitTaskAssignment(f.make());
          const child = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
          const takeover = await f.store.admitTaskAssignment(f.make());
          const wait = async (taskId: string, settle: { failed?: true; result: object }) => {
            await f.store.claimTaskAssignment({ taskId, leaseOwner: taskId });
            await f.store.registerTaskAssignmentWait({
              taskId,
              leaseOwner: taskId,
              attemptCount: 1,
              submittedTaskIds: [child.taskId],
            });
            await f.store.settleTaskAssignment({
              taskId,
              leaseOwner: taskId,
              attemptCount: 1,
              ...settle,
            });
          };
          await wait(parent.taskId, { result: {} });
          await f.store.cancelTaskAssignment(parent.taskId, f.owner.id);
          await wait(
            takeover.taskId,
            takeoverEnds
              ? { failed: true, result: { error: "Task outcome remains unknown" } }
              : { result: {} },
          );
          await f.store.claimTaskAssignment({ taskId: child.taskId, leaseOwner: "child" });
          await new Promise((resolve) => setTimeout(resolve, 5));
          await f.store.settleTaskAssignment({
            taskId: child.taskId,
            leaseOwner: "child",
            attemptCount: 1,
            result: { text: "done" },
          });
          const followups = (await f.other.listTaskAssignmentFollowups()).map(
            (task) => task.taskId,
          );
          return { f, parent, child, takeover, followups };
        }

        it("is left to a takeover that still waits on it", async () => {
          const { f, child, takeover, followups } = await cancelledParent(false);
          expect((await f.store.getTaskAssignment(takeover.taskId))?.status).toBe("waiting");
          expect(followups).not.toContain(child.taskId);
        });

        it("gets a follow-up when nothing that waited on it is still active", async () => {
          const { f, parent, child, followups } = await cancelledParent(true);
          expect(followups).toContain(child.taskId);
          // The ended parent's retained wait no longer blocks admitting that follow-up.
          await expect(
            f.store.admitTaskAssignment(
              f.make({
                taskId: `${child.taskId}:followup`,
                assignedTagId: f.worker.id,
                followupSources: { parentTaskId: parent.taskId, taskIds: [child.taskId] },
              }),
            ),
          ).resolves.toMatchObject({ status: "queued" });
        });
      });
      it("tags an assignment only with a channel that includes its assignee and requester", async () => {
        const f = await fixture();
        const outsider = await f.store.createTag({ name: `outsider-${randomUUID()}` });
        const elsewhere = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: f.objective.id,
          name: "Elsewhere",
          leadTagId: outsider.id,
          memberTagIds: [],
        });
        await expect(
          f.store.admitTaskAssignment(f.make({ workstreamId: elsewhere.id })),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.store.admitTaskAssignment(f.make({ workstreamId: randomUUID() })),
        ).rejects.toMatchObject({ statusCode: 403 });
        const task = await f.store.admitTaskAssignment(f.make({ workstreamId: f.team.id }));
        expect(task.workstreamId).toBe(f.team.id);
        // Leaving the Team, and so its channel, waits for the assignment to finish.
        await expect(
          f.store.updateTeam(f.team.id, { expectedRevision: f.team.revision, memberTagIds: [] }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it("reconciles cancelled assignments only while their current Attempt remains running", async () => {
        const f = await fixture();
        const task = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "cancel-current" });
        const attempt = await f.store.createTaskAttempt({
          taskId: task.taskId,
          attemptNumber: 1,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await f.store.cancelTaskAssignment(task.taskId, f.owner.id);
        expect(await f.other.listPendingTaskAssignments()).toContainEqual(
          expect.objectContaining({ taskId: task.taskId, status: "cancelled" }),
        );
        await f.store.closeTaskAttempt({
          attemptId: attempt.id,
          status: "cancelled",
          endedAt: new Date().toISOString(),
        });
        expect(
          (await f.other.listPendingTaskAssignments()).map((entry) => entry.taskId),
        ).not.toContain(task.taskId);

        const neverStarted = await f.store.admitTaskAssignment(f.make());
        await f.store.cancelTaskAssignment(neverStarted.taskId, f.owner.id);
        expect(
          (await f.other.listPendingTaskAssignments()).map((entry) => entry.taskId),
        ).not.toContain(neverStarted.taskId);

        const historical = await f.store.admitTaskAssignment(f.make());
        await f.store.claimTaskAssignment({
          taskId: historical.taskId,
          leaseOwner: "cancel-historical",
        });
        const oldAttempt = await f.store.createTaskAttempt({
          taskId: historical.taskId,
          attemptNumber: 1,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        await f.store.cancelTaskAssignment(historical.taskId, f.owner.id);
        // Simulate a stale historical observer after the assignment advanced. Its
        // running flag must not make the current cancelled identity recoverable.
        if (dialect === "sqlite") {
          const connection = new Database(f.url.slice(5));
          try {
            connection
              .prepare('UPDATE "TaskAssignment" SET "attemptCount" = 2 WHERE "taskId" = ?')
              .run(historical.taskId);
          } finally {
            connection.close();
          }
        } else {
          const connection = new Pool({ connectionString: f.url });
          try {
            await connection.query(
              'UPDATE "TaskAssignment" SET "attemptCount" = 2 WHERE "taskId" = $1',
              [historical.taskId],
            );
          } finally {
            await connection.end();
          }
        }
        expect(
          (await f.store.listTaskAttempts(historical.taskId)).find(
            (entry) => entry.id === oldAttempt.id,
          )?.status,
        ).toBe("running");
        expect(
          (await f.other.listPendingTaskAssignments()).map((entry) => entry.taskId),
        ).not.toContain(historical.taskId);
        const current = await f.store.createTaskAttempt({
          taskId: historical.taskId,
          attemptNumber: 2,
          workerProfile: { id: "default", revision: "1" },
          workerSnapshot: {},
          startedAt: new Date().toISOString(),
        });
        expect((await f.other.listPendingTaskAssignments()).map((entry) => entry.taskId)).toContain(
          historical.taskId,
        );
        await f.store.closeTaskAttempt({
          attemptId: current.id,
          status: "completed",
          endedAt: new Date().toISOString(),
        });
        expect(
          (await f.other.listPendingTaskAssignments()).map((entry) => entry.taskId),
        ).not.toContain(historical.taskId);
      });

      it("admits one canonical Task without an inbound event and rejects duplicate definition changes", async () => {
        const f = await fixture();
        const input = f.make();
        const task = await f.store.admitTaskAssignment(input);
        expect(await f.other.admitTaskAssignment(input)).toEqual(task);
        expect((await f.store.findTaskById(task.taskId))?.inboundEventId).toBeNull();
        await expect(
          f.store.admitTaskAssignment({ ...input, instruction: "Different" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
          f.store.admitTaskAssignment(f.make({ requestedByTagId: f.worker.id })),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(await f.other.listPendingTaskAssignments()).toContainEqual(task);
      });
      it("serializes budget reservations across stores and releases cancelled reservations", async () => {
        const f = await fixture();
        const results = await Promise.allSettled([
          f.store.admitTaskAssignment(f.make({ maxCostMinor: 70 })),
          f.other.admitTaskAssignment(f.make({ maxCostMinor: 70 })),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const task = results.find((r) => r.status === "fulfilled");
        if (task?.status !== "fulfilled") throw new Error("No admission");
        await f.store.cancelTaskAssignment(task.value.taskId, f.owner.id);
        expect(await f.store.listTaskEvents(task.value.taskId)).toContainEqual(
          expect.objectContaining({
            type: "task.cancelled",
            payload: expect.objectContaining({
              actorTagId: f.owner.id,
              previousStatus: "queued",
              attemptCount: 0,
            }),
          }),
        );
        const next = await f.other.admitTaskAssignment(f.make({ maxCostMinor: 100 }));
        expect(next.reservedMinor).toBe(100);
      });
      it("requires provider cost ceilings to fit an explicitly denominated Task reservation", async () => {
        const currencyless = await fixture();
        await expect(
          currencyless.store.admitTaskAssignment(
            currencyless.make({
              maxCostMinor: 25,
              execution: {
                limits: { maxReportedCost: { amountMinor: 25, currency: "USD" } },
              },
            }),
          ),
        ).rejects.toThrow("maxReportedCost requires an Objective with a monetary budgetCurrency");
        expect(await currencyless.store.getObjective(currencyless.objective.id)).toMatchObject({
          reservedMinor: 0,
        });

        const denominated = await fixture({ budgetCurrency: "USD" });
        await expect(
          denominated.store.admitTaskAssignment(
            denominated.make({
              maxCostMinor: 25,
              execution: {
                limits: { maxReportedCost: { amountMinor: 25, currency: "EUR" } },
              },
            }),
          ),
        ).rejects.toThrow("maxReportedCost currency must match the Objective budgetCurrency");
        await expect(
          denominated.store.admitTaskAssignment(
            denominated.make({
              maxCostMinor: 24,
              execution: {
                limits: { maxReportedCost: { amountMinor: 25, currency: "USD" } },
              },
            }),
          ),
        ).rejects.toThrow("maxReportedCost cannot exceed the Task maxCostMinor reservation");
        await expect(
          denominated.store.admitTaskAssignment(
            denominated.make({
              execution: {
                limits: { maxReportedCost: { amountMinor: 1, currency: "USD" } },
              },
            }),
          ),
        ).rejects.toThrow("maxReportedCost cannot exceed the Task maxCostMinor reservation");

        const zero = await denominated.store.admitTaskAssignment(
          denominated.make({
            execution: {
              limits: { maxReportedCost: { amountMinor: 0, currency: "USD" } },
            },
          }),
        );
        expect(zero.reservedMinor).toBe(0);
        const valid = await denominated.store.admitTaskAssignment(
          denominated.make({
            maxCostMinor: 25,
            execution: {
              limits: { maxReportedCost: { amountMinor: 20, currency: "USD" } },
            },
          }),
        );
        expect(valid.reservedMinor).toBe(25);
        expect(await denominated.store.getObjective(denominated.objective.id)).toMatchObject({
          budgetCurrency: "USD",
          reservedMinor: 25,
        });
      });
      it("freezes normalized output policy and rejects changed collection requirements", async () => {
        const f = await fixture();
        const input = f.make({ execution: { outputs: { required: ["outputs/report.md"] } } });
        await f.store.admitTaskAssignment(input);
        const task = await f.store.findTaskById(input.taskId);
        expect(task?.execution.outputs).toEqual({
          directory: "outputs",
          required: ["outputs/report.md"],
          include: ["outputs/**"],
          exclude: [],
          git: "reference",
          maxFiles: 100,
          maxBytes: 67_108_864,
        });
        await expect(
          f.store.admitTaskAssignment({ ...input, execution: task?.execution ?? {} }),
        ).resolves.toBeDefined();
        await expect(
          f.store.admitTaskAssignment({
            ...input,
            execution: { outputs: { required: ["outputs/other.md"] } },
          }),
        ).rejects.toThrow("different execution requirements");
        await expect(
          f.store.admitTaskAssignment(
            f.make({ execution: { outputs: { directory: "../outside" } } }),
          ),
        ).rejects.toThrow("safe relative POSIX");
      });

      it("keeps normalized execution requirements immutable across idempotent admission", async () => {
        const f = await fixture({ budgetCurrency: "USD" });
        const taskId = randomUUID();
        const input = f.make({
          taskId,
          maxCostMinor: 25,
          execution: {
            profile: { id: "bounded-worker", revision: "1" },
            limits: { maxReportedCost: { amountMinor: 20, currency: "USD" } },
          },
        });

        const admitted = await f.store.admitTaskAssignment(input);
        await expect(
          f.other.admitTaskAssignment({
            ...input,
            execution: {
              limits: { maxReportedCost: { currency: "USD", amountMinor: 20 } },
              profile: { revision: "1", id: "bounded-worker" },
            },
          }),
        ).resolves.toEqual(admitted);
        expect(await f.store.getObjective(f.objective.id)).toMatchObject({ reservedMinor: 25 });

        await expect(
          f.other.admitTaskAssignment({
            ...input,
            execution: {
              profile: { id: "bounded-worker", revision: "1" },
              limits: { maxReportedCost: { amountMinor: 21, currency: "USD" } },
            },
          }),
        ).rejects.toThrow("Task ID already has different execution requirements");
        await expect(
          f.other.admitTaskAssignment({
            ...input,
            execution: {
              profile: { id: "bounded-worker", revision: "2" },
              limits: { maxReportedCost: { amountMinor: 20, currency: "USD" } },
            },
          }),
        ).rejects.toThrow("Task ID already has different execution requirements");

        expect((await f.store.findTaskById(taskId))?.execution).toEqual(input.execution);
        expect(await f.store.getObjective(f.objective.id)).toMatchObject({ reservedMinor: 25 });
      });
      it("requires approval and accepted dependencies, and fences cancellation from late results", async () => {
        const f = await fixture();
        const first = await f.store.admitTaskAssignment(f.make({ requiresApproval: true }));
        expect(
          await f.store.claimTaskAssignment({ taskId: first.taskId, leaseOwner: "one" }),
        ).toBeUndefined();
        await f.store.approveTaskAssignment(first.taskId, f.owner.id);
        const second = await f.store.admitTaskAssignment(f.make({ dependencies: [first.taskId] }));
        expect(
          await f.store.claimTaskAssignment({ taskId: second.taskId, leaseOwner: "two" }),
        ).toBeUndefined();
        const claim = await f.store.claimTaskAssignment({
          taskId: first.taskId,
          leaseOwner: "one",
        });
        expect(claim?.attemptCount).toBe(1);
        await f.store.settleTaskAssignment({
          taskId: first.taskId,
          leaseOwner: "one",
          attemptCount: 1,
          result: { artifact: "prototype" },
        });
        expect((await f.store.findTaskById(first.taskId))?.status).toBe("completed");
        expect(
          await f.store.claimTaskAssignment({ taskId: second.taskId, leaseOwner: "two" }),
        ).toBeUndefined();
        await f.store.reviewTaskAssignment(
          first.taskId,
          f.owner.id,
          true,
          "Prototype passes the tests",
        );
        expect(
          await f.other.claimTaskAssignment({ taskId: second.taskId, leaseOwner: "two" }),
        ).toMatchObject({ status: "running" });
        await f.store.cancelTaskAssignment(second.taskId, f.owner.id);
        await expect(
          f.other.settleTaskAssignment({
            taskId: second.taskId,
            leaseOwner: "two",
            attemptCount: 1,
            result: { late: true },
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await f.store.findTaskById(second.taskId))?.status).toBe("cancelled");
      });
      it("follows up a child change that an owner activation ended without receiving", async () => {
        const f = await fixture();
        const leadership = await f.store.createTeam(
          {
            id: `${f.objective.id}:leadership`,
            objectiveId: f.objective.id,
            name: "Leadership",
            leadTagId: f.owner.id,
            memberTagIds: [f.owner.id],
          },
          f.owner.id,
        );
        const activation = await f.store.admitTaskAssignment(
          f.make({ teamId: leadership.id, assignedTagId: f.owner.id }),
        );
        const [seen, unseen] = await Promise.all(
          [0, 1].map(() =>
            f.store.admitTaskAssignment(f.make({ parentTaskId: activation.taskId })),
          ),
        );
        if (!seen || !unseen) throw new Error("Missing child Tasks");
        const run = async (taskId: string, leaseOwner: string) => {
          const claimed = await f.store.claimTaskAssignment({ taskId, leaseOwner });
          if (!claimed) throw new Error(`Task ${taskId} could not be claimed`);
          return claimed;
        };
        const settle = (claimed: { taskId: string; attemptCount: number }, leaseOwner: string) =>
          f.store.settleTaskAssignment({
            taskId: claimed.taskId,
            leaseOwner,
            attemptCount: claimed.attemptCount,
            result: { text: "Done" },
          });
        // The owner waits for one result, which wakes it into a second Attempt.
        const first = await run(activation.taskId, "owner");
        await f.store.registerTaskAssignmentWait({
          taskId: activation.taskId,
          leaseOwner: "owner",
          attemptCount: first.attemptCount,
          submittedTaskIds: [seen.taskId],
        });
        await settle(first, "owner");
        await settle(await run(seen.taskId, "worker"), "worker");
        expect((await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId)).toEqual([
          activation.taskId,
        ]);
        const second = await run(activation.taskId, "owner");
        // Another result lands during that Attempt, before a controller delivers it, and the
        // activation then ends. It never received the change, so the change needs a follow-up.
        await settle(await run(unseen.taskId, "worker"), "worker");
        await settle(second, "owner");
        expect(await f.store.getTaskAssignment(activation.taskId)).toMatchObject({
          status: "accepted",
          waitState: expect.objectContaining({ attemptCount: first.attemptCount }),
        });
        expect(await f.other.listTaskAssignmentFollowups()).toContainEqual(
          expect.objectContaining({ taskId: unseen.taskId, status: "submitted" }),
        );
      });
      /** An owner activation with delegated children, and the controller's delivery step. */
      async function ownerActivationFixture(children: number) {
        const f = await fixture();
        const leadership = await f.store.createTeam(
          {
            id: `${f.objective.id}:leadership`,
            objectiveId: f.objective.id,
            name: "Leadership",
            leadTagId: f.owner.id,
            memberTagIds: [f.owner.id],
          },
          f.owner.id,
        );
        const activation = await f.store.admitTaskAssignment(
          f.make({ teamId: leadership.id, assignedTagId: f.owner.id }),
        );
        const tasks = await Promise.all(
          Array.from({ length: children }, () =>
            f.store.admitTaskAssignment(f.make({ parentTaskId: activation.taskId })),
          ),
        );
        const run = async (taskId: string, leaseOwner: string) => {
          const claimed = await f.store.claimTaskAssignment({ taskId, leaseOwner });
          if (!claimed) throw new Error(`Task ${taskId} could not be claimed`);
          return claimed;
        };
        const settle = (claimed: { taskId: string; attemptCount: number }, leaseOwner: string) =>
          f.store.settleTaskAssignment({
            taskId: claimed.taskId,
            leaseOwner,
            attemptCount: claimed.attemptCount,
            result: { text: "Done" },
          });
        const submit = async (taskId: string) => settle(await run(taskId, "worker"), "worker");
        // What one controller tick delivers to the owner's open activation.
        const tick = async () => {
          const changed = (await f.other.listTaskAssignmentFollowups())
            .filter((task) => task.objectiveId === f.objective.id)
            .map((task) => task.taskId);
          if (changed.length) await f.other.deliverOwnerTaskChanges(f.objective.id, changed);
          return changed;
        };
        const deliveries = async () =>
          ownerDeliveries((await f.store.findTaskById(activation.taskId))?.trigger);
        const review = (taskId: string, status: "accepted" | "rejected" | "cancelled") =>
          f.store.updateTaskAssignment(
            taskId,
            {
              expectedStatus: status === "cancelled" ? "queued" : "submitted",
              status,
              ...(status === "cancelled" ? {} : { assessment: `Owner ${status} it` }),
            },
            f.owner.id,
            { byTaskId: activation.taskId },
          );
        return { f, activation, children: tasks, run, settle, submit, tick, deliveries, review };
      }
      it("never delivers the owner's own review or cancellation back to its activation", async () => {
        const { f, activation, children, run, settle, submit, tick, deliveries, review } =
          await ownerActivationFixture(5);
        const [accepted, rejected, cancelled, raced, operator] = children.map(
          (child) => child.taskId,
        ) as [string, string, string, string, string];
        const attempt = await run(activation.taskId, "owner");
        await submit(accepted);
        await submit(rejected);
        // A controller tick delivers the submitted results; the next Attempt would receive them.
        expect((await tick()).sort()).toEqual([accepted, rejected].sort());
        // The owner finds and reviews them in this Attempt anyway, and cancels a queued Task.
        await review(accepted, "accepted");
        await review(rejected, "rejected");
        await review(cancelled, "cancelled");
        // Discovery that read before the owner's review delivers nothing after it.
        await submit(raced);
        const stale = (await f.other.listTaskAssignmentFollowups()).map((task) => task.taskId);
        expect(stale).toEqual([raced]);
        await review(raced, "accepted");
        await f.other.deliverOwnerTaskChanges(f.objective.id, stale);
        expect(await tick()).toEqual([]);
        expect(await deliveries()).toEqual({
          pending: [],
          handledTaskIds: [accepted, rejected, cancelled, raced],
        });
        // The activation ends instead of waking again for its own changes.
        await settle(attempt, "owner");
        expect(await f.store.getTaskAssignment(activation.taskId)).toMatchObject({
          status: "accepted",
          waitState: null,
        });
        // A change somebody else makes is still a follow-up.
        await f.store.updateTaskAssignment(
          operator,
          { expectedStatus: "queued", status: "cancelled" },
          f.owner.id,
          { administrator: true },
        );
        expect((await f.other.listTaskAssignmentFollowups()).map((task) => task.taskId)).toEqual([
          operator,
        ]);
      });
      it("delivers a change reported at an Attempt's start to that Attempt only once", async () => {
        const { f, activation, children, run, settle, submit, tick, deliveries } =
          await ownerActivationFixture(3);
        const [awaited, other, later] = children.map((child) => child.taskId) as [
          string,
          string,
          string,
        ];
        const first = await run(activation.taskId, "owner");
        await f.store.registerTaskAssignmentWait({
          taskId: activation.taskId,
          leaseOwner: "owner",
          attemptCount: first.attemptCount,
          submittedTaskIds: [awaited],
        });
        await settle(first, "owner");
        // Both results land while the owner waits; the awaited one wakes it.
        await submit(other);
        await submit(awaited);
        await f.store.wakeWaitingTaskAssignments();
        expect((await f.store.getTaskAssignment(activation.taskId))?.waitState?.wake).toMatchObject(
          { reason: "submitted_tasks", taskIds: [awaited] },
        );
        // The next Attempt starts with both changes, which its wake and current work report.
        const second = await run(activation.taskId, "owner");
        expect((await deliveries()).pending).toHaveLength(2);
        expect((await deliveries()).pending).toEqual(
          expect.arrayContaining([
            { kind: "task", id: other, attempt: second.attemptCount },
            { kind: "task", id: awaited, attempt: second.attemptCount },
          ]),
        );
        expect(await tick()).toEqual([]);
        // A change it never received is delivered, and wakes it once more for that change.
        await submit(later);
        expect(await tick()).toEqual([later]);
        await settle(second, "owner");
        expect(await f.store.getTaskAssignment(activation.taskId)).toMatchObject({
          status: "waiting",
          waitState: expect.objectContaining({
            reason: "Owner triggers were delivered during this activation",
          }),
        });
        expect([...(await deliveries()).handledTaskIds].sort()).toEqual([other, awaited].sort());
        await f.store.wakeWaitingTaskAssignments();
        expect((await f.store.getTaskAssignment(activation.taskId))?.waitState?.wake).toMatchObject(
          { reason: "delivery", taskIds: [later] },
        );
        const third = await run(activation.taskId, "owner");
        expect((await deliveries()).pending).toEqual([
          { kind: "task", id: later, attempt: third.attemptCount },
        ]);
        expect(await tick()).toEqual([]);
        // Handled changes are not delivered again, so the activation ends.
        await settle(third, "owner");
        expect(await tick()).toEqual([]);
        expect(await f.store.getTaskAssignment(activation.taskId)).toMatchObject({
          status: "accepted",
        });
        const handled = await deliveries();
        expect(handled.pending).toEqual([]);
        expect([...handled.handledTaskIds].sort()).toEqual([other, awaited, later].sort());
      });
      it("finds terminal child work until its durable followup is admitted", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make());
        const child = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        await f.store.cancelTaskAssignment(child.taskId, f.owner.id);
        expect(await f.other.listTaskAssignmentFollowups()).toContainEqual(
          expect.objectContaining({ taskId: child.taskId }),
        );
        await f.store.admitTaskAssignment(f.make({ taskId: `${child.taskId}:followup` }));
        expect(
          (await f.other.listTaskAssignmentFollowups()).some((x) => x.taskId === child.taskId),
        ).toBe(false);
      });
      it("coalesces child-result receipts atomically across controllers", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make());
        const children = await Promise.all(
          [0, 1, 2].map(() => f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }))),
        );
        for (const child of children) await f.store.cancelTaskAssignment(child.taskId, f.owner.id);
        const taskIds = children.slice(0, 2).map((child) => child.taskId);
        const sources = { parentTaskId: parent.taskId, taskIds };
        const definition = f.make({
          taskId: await taskFollowupId(taskIds[0] as string),
          followupSources: sources,
        });
        await f.store.admitTaskAssignment(definition);
        expect((await f.other.listTaskAssignmentFollowups()).map((task) => task.taskId)).toEqual([
          children[2]?.taskId,
        ]);
        await expect(f.other.admitTaskAssignment(definition)).resolves.toMatchObject({
          taskId: definition.taskId,
        });
        await expect(
          f.other.admitTaskAssignment(
            f.make({
              followupSources: {
                parentTaskId: parent.taskId,
                taskIds: [taskIds[1] as string, children[2]?.taskId as string],
              },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await f.other.listTaskAssignmentFollowups()).map((task) => task.taskId)).toEqual([
          children[2]?.taskId,
        ]);
      });
      it("discovers accepted results even when review happens before controller polling", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make());
        const child = await f.store.admitTaskAssignment(f.make({ parentTaskId: parent.taskId }));
        await f.store.claimTaskAssignment({ taskId: child.taskId, leaseOwner: "review" });
        await f.store.settleTaskAssignment({
          taskId: child.taskId,
          leaseOwner: "review",
          attemptCount: 1,
          result: { text: "Done" },
        });
        await f.store.reviewTaskAssignment(child.taskId, f.owner.id, true, "Meets criteria");
        expect(await f.other.listTaskAssignmentFollowups()).toContainEqual(
          expect.objectContaining({ taskId: child.taskId, status: "accepted" }),
        );
      });
      it("does not claim assignments after requester or assignee revocation", async () => {
        for (const principal of ["requester", "assignee"] as const) {
          const f = await fixture();
          const task = await f.store.admitTaskAssignment(f.make());
          const tagId = principal === "requester" ? f.owner.id : f.worker.id;
          if (dialect === "sqlite") {
            const connection = new Database(f.url.slice(5));
            try {
              connection
                .prepare('UPDATE "Tag" SET "status" = ? WHERE "id" = ?')
                .run("inactive", tagId);
            } finally {
              connection.close();
            }
          } else {
            const connection = new Pool({ connectionString: f.url });
            try {
              await connection.query('UPDATE "Tag" SET "status" = $1 WHERE "id" = $2', [
                "inactive",
                tagId,
              ]);
            } finally {
              await connection.end();
            }
          }
          expect(
            await f.other.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "revoked" }),
          ).toBeUndefined();
          expect(await f.store.getTaskAssignment(task.taskId)).toMatchObject({
            status: "queued",
            attemptCount: 0,
          });
        }
      });
      it("stops discovering maximum-length task IDs after their bounded followup exists", async () => {
        const f = await fixture();
        const parent = await f.store.admitTaskAssignment(f.make());
        const taskId = `${randomUUID()}-${"x".repeat(163)}`;
        expect(taskId.length).toBe(200);
        const child = await f.store.admitTaskAssignment(
          f.make({ taskId, parentTaskId: parent.taskId }),
        );
        await f.store.cancelTaskAssignment(child.taskId, f.owner.id);
        expect(
          (await f.other.listTaskAssignmentFollowups()).some((task) => task.taskId === taskId),
        ).toBe(true);
        const followupId = await taskFollowupId(taskId);
        expect(followupId.length).toBeLessThanOrEqual(200);
        await f.store.admitTaskAssignment(f.make({ taskId: followupId }));
        expect(
          (await f.other.listTaskAssignmentFollowups()).some((task) => task.taskId === taskId),
        ).toBe(false);
        expect(
          (await f.store.listTaskAssignments(f.objective.id)).filter(
            (task) => task.taskId === followupId,
          ),
        ).toHaveLength(1);
      });
      it("does not count a child Team's running work against its parent's capacity", async () => {
        const f = await fixture();
        const child = await f.store.createTeam(
          {
            id: randomUUID(),
            objectiveId: f.objective.id,
            name: "Backend",
            leadTagId: f.owner.id,
            memberTagIds: [f.worker.id],
            parentTeamId: f.team.id,
            maxConcurrency: 1,
          },
          f.owner.id,
        );
        const a = await f.store.admitTaskAssignment(f.make());
        const b = await f.store.admitTaskAssignment(f.make({ teamId: child.id }));
        const claims = await Promise.all([
          f.store.claimTaskAssignment({ taskId: a.taskId, leaseOwner: "parent" }),
          f.other.claimTaskAssignment({ taskId: b.taskId, leaseOwner: "child" }),
        ]);
        // Each Team's limit counts only its own running member work; limits do not nest.
        expect(claims.filter(Boolean)).toHaveLength(2);
      });
      it("does not automatically repeat funded execution after its lease expires", async () => {
        const f = await fixture();
        const task = await f.store.admitTaskAssignment(f.make({ maxCostMinor: 70 }));
        await f.store.claimTaskAssignment({
          taskId: task.taskId,
          leaseOwner: "original",
          leaseSeconds: 5,
        });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 6000);
        expect(
          await f.other.claimTaskAssignment({ taskId: task.taskId, leaseOwner: "retry" }),
        ).toBeUndefined();
        expect(await f.store.getTaskAssignment(task.taskId)).toMatchObject({
          status: "failed",
          chargedMinor: 70,
          attemptCount: 1,
        });
        expect(await f.store.getObjective(f.objective.id)).toMatchObject({
          spentMinor: 70,
          reservedMinor: 0,
        });
        await expect(
          f.store.admitTaskAssignment(f.make({ maxCostMinor: 40 })),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it("enforces Team capacity atomically and recovers a crashed zero-cost execution with fencing", async () => {
        const f = await fixture();
        const a = await f.store.admitTaskAssignment(f.make());
        const b = await f.store.admitTaskAssignment(f.make());
        const claims = await Promise.all([
          f.store.claimTaskAssignment({ taskId: a.taskId, leaseOwner: "a", leaseSeconds: 5 }),
          f.other.claimTaskAssignment({ taskId: b.taskId, leaseOwner: "b", leaseSeconds: 5 }),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const claim = claims.find(Boolean);
        if (!claim?.leaseOwner) throw new Error("Missing execution claim");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 6000);
        const recovered = await f.other.claimTaskAssignment({
          taskId: claim.taskId,
          leaseOwner: "recovery",
          leaseSeconds: 5,
        });
        expect(recovered?.attemptCount).toBe(2);
        await expect(
          f.store.settleTaskAssignment({
            taskId: claim.taskId,
            leaseOwner: claim.leaseOwner,
            attemptCount: 1,
            result: { late: true },
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await f.other.settleTaskAssignment({
          taskId: claim.taskId,
          leaseOwner: "recovery",
          attemptCount: 2,
          result: { done: true },
        });
      });
    },
  );
}
