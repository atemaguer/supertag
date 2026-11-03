import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdmitInboundEventInput,
  DurableInboundEvent,
  OpenSurfaceTaskAttemptInput,
  SettleSurfaceAttemptInput,
  SettleSurfaceFailureInput,
  Task,
  TaskResult,
} from "@supertag/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} durable Session inputs`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-session-input-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "store.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url }),
          other = new DrizzleStore({ url });
        await store.connect();
        await other.connect();
        cleanups.push(
          () => other.disconnect(),
          () => store.disconnect(),
        );
        const tag = await store.createTag({ name: "Tag" });
        const now = new Date().toISOString();
        const account = await store.saveSurfaceAccount({
          provider: "slack",
          externalAccountId: randomUUID(),
          displayName: "Slack",
          authMethod: "test",
          credentialId: "test",
          status: "connected",
          configuration: {},
          verifiedAt: now,
        });
        const route = await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: "channel:test",
        });
        async function input(
          sessionKey = "thread",
          availableAt?: string,
          origin?: { provider: string; surfaceAccountId: string; scope: string },
        ) {
          const at = new Date().toISOString();
          const admission: AdmitInboundEventInput = {
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            tagId: tag.id,
            authorization: {
              version: 5,
              capturedAt: at,
              tag: { id: tag.id, name: tag.name },
              origin: {
                surfaceAccountId: account.id,
                tagRouteId: route.id,
                provider: "slack",
                scope: "channel:test",
              },
              requester: { id: "human", kind: "user" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            contextPlan: { version: 7, capturedAt: at, sets: [] },
            event: {
              eventId: randomUUID(),
              logicalEventId: randomUUID(),
              provider: "slack",
              externalAccountId: account.externalAccountId,
              kind: "message",
              scope: "channel:test",
              sessionKey,
              actor: { id: "human", kind: "user" },
              text: "Continue",
              occurredAt: at,
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: sessionKey,
                target: { channelId: "test", threadTs: sessionKey },
              },
              source: {},
              metadata: {},
            },
            ...(availableAt ? { availableAt } : {}),
          };
          const admitted = await store.admitInboundEvent(admission);
          const session = await store.openSession({ tagId: tag.id, sessionKey, origin: {}, at });
          const task = await store.openTask({
            inboundEventId: admitted.work.id,
            tagId: tag.id,
            sessionId: session.id,
            execution: {},
            actor: admission.event.actor,
            trigger: { origin: origin ?? admission.authorization.origin },
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: admission.authorization,
            contextPlan: admission.contextPlan,
            createdAt: at,
          });
          return { work: admitted.work, task };
        }
        const lease = (inboundEventId: string) => ({
          inboundEventId,
          leaseOwner: "owner",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        });
        async function activate() {
          const first = await input();
          await store.claimDueInboundEvent(lease(first.work.id));
          await store.startTask({ taskId: first.task.id, startedAt: now });
          const attempt = await store.createTaskAttempt({
            taskId: first.task.id,
            attemptNumber: 1,
            workerProfile: { id: "native", revision: "1" },
            workerSnapshot: {},
            startedAt: now,
          });
          return { ...first, attempt };
        }
        return { store, other, input, lease, activate, url };
      }
      function surfaceAdmission(pending: {
        task: { id: string };
        work: { id: string };
      }): OpenSurfaceTaskAttemptInput {
        const now = new Date().toISOString();
        return {
          taskId: pending.task.id,
          inboundEventId: pending.work.id,
          leaseOwner: "owner",
          now,
          attemptNumber: 1,
          workerProfile: { id: "native", revision: "1" },
          workerSnapshot: {},
          startedAt: now,
        };
      }
      it("atomically admits surface execution and rolls back supersession on duplicate admission", async () => {
        const f = await fixture();
        const pending = await f.input();
        await f.store.claimDueInboundEvent(f.lease(pending.work.id));
        const request = surfaceAdmission(pending);
        const attempt = await f.store.openSurfaceTaskAttempt(request);
        expect((await f.store.findTaskById(pending.task.id))?.status).toBe("running");
        await expect(f.other.openSurfaceTaskAttempt(request)).rejects.toThrow();
        expect(await f.store.listTaskAttempts(pending.task.id)).toMatchObject([
          { id: attempt.id, status: "running", attemptNumber: 1 },
        ]);
        expect(await f.store.listTaskAttempts(pending.task.id)).toHaveLength(1);
      });
      it("does not let stale surface admission supersede the replacement owner's running Attempt", async () => {
        const f = await fixture();
        const pending = await f.input();
        await f.store.claimDueInboundEvent(f.lease(pending.work.id));
        const stale = surfaceAdmission(pending);
        const now = new Date(Date.now() + 120000).toISOString();
        await f.other.claimDueInboundEvent({
          inboundEventId: pending.work.id,
          leaseOwner: "replacement",
          now,
          leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
        });
        const replacement = await f.other.openSurfaceTaskAttempt({
          ...stale,
          leaseOwner: "replacement",
          attemptNumber: 2,
          now,
        });
        await expect(f.store.openSurfaceTaskAttempt({ ...stale, now })).rejects.toThrow();
        await expect(
          f.store.openSurfaceTaskAttempt({ ...stale, leaseOwner: "replacement", now }),
        ).rejects.toThrow();
        expect(await f.store.listTaskAttempts(pending.task.id)).toMatchObject([
          { id: replacement.id, status: "running", attemptNumber: 2 },
        ]);
        expect(await f.store.listTaskAttempts(pending.task.id)).toHaveLength(1);
      });
      it("cannot admit another Attempt when the previous owner already prepared its result", async () => {
        const f = await fixture();
        const active = await f.activate();
        await f.store.prepareSurfaceAttempt(settlement(active));
        const now = new Date(Date.now() + 120000).toISOString();
        await f.other.claimDueInboundEvent({
          inboundEventId: active.work.id,
          leaseOwner: "replacement",
          now,
          leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
        });
        await expect(
          f.other.openSurfaceTaskAttempt({
            ...surfaceAdmission(active),
            leaseOwner: "replacement",
            attemptNumber: 2,
            now,
          }),
        ).rejects.toThrow("Prepared surface outcome");
        expect(await f.store.listTaskAttempts(active.task.id)).toMatchObject([
          { id: active.attempt.id, status: "running" },
        ]);
        expect(await f.store.listTaskAttempts(active.task.id)).toHaveLength(1);
      });
      it("cancels pending surface work with its reply and removes it from dispatch eligibility", async () => {
        const f = await fixture();
        const pending = await f.input();
        const cancelledAt = new Date().toISOString();
        expect(
          await f.store.cancelPendingSurfaceTask({ taskId: pending.task.id, cancelledAt }),
        ).toMatchObject({ status: "cancelled" });
        expect((await f.store.findInboundEventById(pending.work.id))?.status).toBe("completed");
        expect(await f.store.findOutboundReply(pending.work.id, "final")).toMatchObject({
          text: "I stopped working on this.",
          workerId: "control-plane",
        });
        expect(await f.store.claimDueInboundEvent(f.lease(pending.work.id))).toBeUndefined();
        expect(
          await f.store.cancelPendingSurfaceTask({ taskId: pending.task.id, cancelledAt }),
        ).toBeUndefined();
        expect(await f.store.listTaskAttempts(pending.task.id)).toEqual([]);
      });
      it.each([true, false])(
        "serializes pending cancellation against surface admission (cancel first: %s)",
        async (cancelFirst) => {
          const f = await fixture();
          const pending = await f.input();
          await f.store.claimDueInboundEvent(f.lease(pending.work.id));
          const request = surfaceAdmission(pending);
          const cancel = () =>
            f.store.cancelPendingSurfaceTask({ taskId: pending.task.id, cancelledAt: request.now });
          const admit = () => f.other.openSurfaceTaskAttempt(request);
          await Promise.allSettled(cancelFirst ? [cancel(), admit()] : [admit(), cancel()]);
          const task = await f.store.findTaskById(pending.task.id);
          const attempts = await f.store.listTaskAttempts(pending.task.id);
          if (task?.status === "cancelled") {
            expect(attempts).toEqual([]);
            expect((await f.store.findInboundEventById(pending.work.id))?.status).toBe("completed");
            expect(await f.store.findOutboundReply(pending.work.id, "final")).toBeDefined();
          } else {
            expect(task?.status).toBe("running");
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.status).toBe("running");
            expect(await f.store.findOutboundReply(pending.work.id, "final")).toBeUndefined();
          }
        },
      );
      it("keeps operator notifications immutable across concurrent enqueue and delivery", async () => {
        const f = await fixture();
        const pending = await f.input();
        const now = new Date().toISOString();
        const input = {
          inboundEventId: pending.work.id,
          workerId: "objective-controller",
          presentation: "status" as const,
          deliveryKey: "operator-message:test",
          text: "Research is underway",
          createdAt: now,
        };
        const replies = await Promise.all([
          f.store.enqueueOutboundReply(input),
          f.other.enqueueOutboundReply(input),
        ]);
        expect(replies[0]?.id).toBe(replies[1]?.id);
        expect(replies[0]?.revision).toBe(replies[1]?.revision);
        const claim = await f.store.claimNextOutboundReply({
          leaseOwner: "delivery",
          now,
          leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        });
        if (!claim) throw new Error("Missing outbound claim");
        expect(claim.deliveryKey).toBe(input.deliveryKey);
        expect((await f.other.enqueueOutboundReply(input)).status).toBe("delivering");
        expect(
          await f.store.completeOutboundReply({
            outboundReplyId: claim.id,
            leaseOwner: "delivery",
            revision: claim.revision,
            deliveredAt: now,
          }),
        ).toBe(true);
        expect((await f.other.enqueueOutboundReply(input)).status).toBe("delivered");
        expect(
          await f.store.claimNextOutboundReply({
            leaseOwner: "delivery",
            now,
            leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
        ).toBeUndefined();
      });
      it("rolls back pending cancellation when its final reply cannot be inserted", async () => {
        const f = await fixture();
        const pending = await f.input();
        const cancelledAt = new Date().toISOString();
        await f.store.enqueueOutboundReply({
          inboundEventId: pending.work.id,
          workerId: "control-plane",
          presentation: "final-result",
          deliveryKey: "final",
          text: "Existing",
          createdAt: cancelledAt,
        });
        await expect(
          f.store.cancelPendingSurfaceTask({ taskId: pending.task.id, cancelledAt }),
        ).rejects.toThrow();
        expect((await f.store.findTaskById(pending.task.id))?.status).toBe("pending");
        expect((await f.store.findInboundEventById(pending.work.id))?.status).toBe("pending");
      });
      function failure(active: {
        work: { id: string };
        task: { id: string };
        attempt?: { id: string };
      }): SettleSurfaceFailureInput {
        const now = new Date().toISOString();
        return {
          inboundEventId: active.work.id,
          taskId: active.task.id,
          ...(active.attempt ? { attemptId: active.attempt.id } : {}),
          leaseOwner: "owner",
          now,
          claimAttemptCount: 1,
          error: "Worker failed",
          retryable: true,
          retryAt: now,
          workerId: "worker",
          responseText: "Could not finish",
          failedAt: now,
        };
      }
      it("recovers prepared failure without spending another execution claim and consumes retry intent", async () => {
        const f = await fixture(),
          active = await f.activate(),
          request = failure(active);
        await f.store.prepareSurfaceFailure(request);
        const now = new Date(Date.now() + 120000).toISOString();
        const claim = await f.other.claimDueInboundEvent({
          ...f.lease(active.work.id),
          leaseOwner: "recovery",
          recoveryOnly: true,
          now,
          leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
        });
        expect(claim?.attemptCount).toBe(1);
        await expect(f.store.settleSurfaceFailure({ ...request, now })).rejects.toThrow();
        expect(
          await f.other.settleSurfaceFailure({ ...request, leaseOwner: "recovery", now }),
        ).toBe("pending");
        expect(
          await f.other.settleSurfaceFailure({ ...request, leaseOwner: "recovery", now }),
        ).toBe("pending");
        expect((await f.store.listTaskAttempts(active.task.id))[0]?.status).toBe("failed");
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("pending");
        const next = await f.store.claimDueInboundEvent({
          ...f.lease(active.work.id),
          now,
          leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
        });
        expect(next?.attemptCount).toBe(2);
        await f.store.openSurfaceTaskAttempt({
          ...surfaceAdmission(active),
          now,
          attemptNumber: 2,
        });
        expect(
          (await f.store.listTaskEvents(active.task.id)).filter(
            (e) => e.type === "surface.failure-settled",
          ),
        ).toHaveLength(1);
      });
      it("does not turn stale recovery preflight into an execution claim after another owner consumes failure", async () => {
        const f = await fixture(),
          active = await f.activate(),
          request = failure(active);
        await f.store.prepareSurfaceFailure(request);
        // A recovery controller observed the prepared event, then the owner
        // committed retry before that controller could acquire the lease.
        expect(await f.store.settleSurfaceFailure(request)).toBe("pending");
        const recovery = await f.other.claimDueInboundEvent({
          ...f.lease(active.work.id),
          recoveryOnly: true,
        });
        expect(recovery).toBeUndefined();
        expect(await f.store.findInboundEventById(active.work.id)).toMatchObject({
          status: "pending",
          attemptCount: 1,
        });
        expect((await f.store.claimDueInboundEvent(f.lease(active.work.id)))?.attemptCount).toBe(2);
      });
      it("atomically settles pre-Attempt failure and never cancels or admits behind prepared failure", async () => {
        const f = await fixture(),
          pending = await f.input();
        await f.store.claimDueInboundEvent(f.lease(pending.work.id));
        const request = { ...failure(pending), retryable: false };
        await f.store.prepareSurfaceFailure(request);
        expect(
          await f.store.cancelPendingSurfaceTask({
            taskId: pending.task.id,
            cancelledAt: request.now,
          }),
        ).toBeUndefined();
        await expect(f.store.openSurfaceTaskAttempt(surfaceAdmission(pending))).rejects.toThrow();
        expect(await f.store.settleSurfaceFailure(request)).toBe("failed");
        expect((await f.store.findTaskById(pending.task.id))?.status).toBe("failed");
        expect((await f.store.findInboundEventById(pending.work.id))?.status).toBe("failed");
        expect(await f.store.findOutboundReply(pending.work.id, "final")).toMatchObject({
          presentation: "error",
          text: request.responseText,
        });
        expect(await f.store.listTaskAttempts(pending.task.id)).toEqual([]);
      });
      it("rolls back failure settlement and marker consumption when error outbox conflicts", async () => {
        const f = await fixture(),
          active = await f.activate();
        const request = { ...failure(active), sessionBlockReason: "External write uncertain" };
        await f.store.prepareSurfaceFailure(request);
        await f.store.enqueueOutboundReply({
          inboundEventId: active.work.id,
          workerId: "other",
          text: "Existing",
          deliveryKey: "final",
          presentation: "error",
          createdAt: request.now,
        });
        await expect(f.store.settleSurfaceFailure(request)).rejects.toThrow();
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("running");
        expect((await f.store.listTaskAttempts(active.task.id))[0]?.status).toBe("running");
        expect(await f.store.findInboundEventById(active.work.id)).toMatchObject({
          status: "processing",
          sessionBlocked: false,
        });
        expect(
          (await f.store.listTaskEvents(active.task.id)).filter(
            (e) => e.type === "surface.failure-settled",
          ),
        ).toEqual([]);
      });
      it("fences immutable failure preparation and blocks unsafe retries atomically", async () => {
        const f = await fixture(),
          active = await f.activate();
        const request = { ...failure(active), sessionBlockReason: "External write uncertain" };
        await f.store.prepareSurfaceFailure(request);
        await expect(
          f.store.prepareSurfaceFailure({ ...request, error: "Different" }),
        ).rejects.toThrow();
        await expect(f.store.settleSurfaceAttempt(settlement(active))).rejects.toThrow();
        await expect(f.store.prepareSurfaceAttempt(settlement(active))).rejects.toThrow();
        expect(await f.store.settleSurfaceFailure(request)).toBe("failed");
        expect(await f.store.findInboundEventById(active.work.id)).toMatchObject({
          status: "failed",
          sessionBlocked: true,
        });
        expect((await f.store.findOutboundReply(active.work.id, "final"))?.presentation).toBe(
          "error",
        );
      });
      it("rejects stale-owner and expired-owner failure preparation", async () => {
        const f = await fixture(),
          active = await f.activate(),
          request = failure(active);
        const now = new Date(Date.now() + 120000).toISOString();
        await expect(f.store.prepareSurfaceFailure({ ...request, now })).rejects.toThrow();
        await f.other.claimDueInboundEvent({
          ...f.lease(active.work.id),
          leaseOwner: "new",
          now,
          leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
        });
        await expect(f.store.prepareSurfaceFailure({ ...request, now })).rejects.toThrow();
        expect(
          (await f.store.listTaskEvents(active.task.id)).filter(
            (e) => e.type === "surface.failure-prepared",
          ),
        ).toEqual([]);
      });
      function settlement(active: {
        work: DurableInboundEvent;
        task: Task;
        attempt: { id: string };
      }): SettleSurfaceAttemptInput & { result: TaskResult } {
        const now = new Date().toISOString();
        return {
          inboundEventId: active.work.id,
          taskId: active.task.id,
          attemptId: active.attempt.id,
          leaseOwner: "owner",
          workerId: "worker",
          responseText: "Finished",
          completedAt: now,
          now,
          status: "completed",
          outcome: { responseLength: 8, nested: { a: 1, b: 2 } },
          result: {
            summary: "Finished",
            decisions: [],
            changes: [],
            unresolved: [],
            findings: [],
            artifacts: [],
            references: [
              {
                provider: "slack",
                resourceType: "channel",
                reference: "slack:test",
                relationship: "originated-in",
              },
            ],
          },
        };
      }
      it("selects canonical history by exact origin and shared references before applying limits", async () => {
        const f = await fixture();
        const origin = {
          provider: "slack" as const,
          surfaceAccountId: "account-a",
          scope: "channel:test",
        };
        const a = await f.input("earlier", undefined, origin),
          b = await f.input("later", undefined, origin),
          c = await f.input("other-account", undefined, {
            ...origin,
            surfaceAccountId: "account-b",
          });
        const related = {
          provider: "github" as const,
          resourceType: "repository" as const,
          resourceId: "repo",
          surfaceAccountId: "github-account",
          reference: "github:repo",
        };
        const result: TaskResult = {
          summary: "Done",
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          artifacts: [],
          references: [
            { ...related, relationship: "inspected" },
            {
              provider: "slack",
              resourceType: "channel",
              resourceId: "test",
              surfaceAccountId: "account-a",
              reference: "slack:test",
              relationship: "originated-in",
            },
          ],
        };
        await f.store.closeTask({
          taskId: a.task.id,
          status: "completed",
          result,
          endedAt: "2026-09-01T00:00:00.000Z",
        });
        await f.store.closeTask({
          taskId: b.task.id,
          status: "completed",
          result,
          endedAt: "2026-09-02T00:00:00.000Z",
        });
        await f.store.closeTask({
          taskId: c.task.id,
          status: "completed",
          // A model forges account-a in its result. The immutable account-b
          // admission origin must still exclude this newer Task before LIMIT.
          result,
          endedAt: "2026-09-03T00:00:00.000Z",
        });
        const filter = {
          tagId: a.task.tagId,
          relatedTo: [related],
          originSurfaces: [origin],
          limit: 1,
        };
        expect((await f.store.listTaskHistory(filter)).map((h) => h.taskId)).toEqual([b.task.id]);
        expect(
          (await f.store.listTaskHistory({ ...filter, excludeTaskId: b.task.id })).map(
            (h) => h.taskId,
          ),
        ).toEqual([a.task.id]);
        expect(
          await f.store.listTaskHistory({ ...filter, createdAfter: "2026-09-03T00:00:00.000Z" }),
        ).toEqual([]);
        expect(
          await f.store.listTaskHistory({
            ...filter,
            relatedTo: [{ ...related, resourceId: "another" }],
          }),
        ).toEqual([]);
        expect(
          await f.store.listTaskHistory({
            ...filter,
            originSurfaces: [{ ...origin, scope: "channel:private" }],
          }),
        ).toEqual([]);
        expect(
          await f.store.listTaskHistory({
            ...filter,
            relatedTo: [{ ...related, surfaceAccountId: "different-account" }],
          }),
        ).toEqual([]);
      });
      it("finds source artifacts despite more than 100 newer ordinary Tasks", async () => {
        const f = await fixture();
        const active = await f.activate();
        const digest = `sha256:${"a".repeat(64)}`;
        await f.store.recordArtifactUpload({
          taskId: active.task.id,
          attemptId: active.attempt.id,
          digest,
          sizeBytes: 2,
        });
        const base = {
          taskId: active.task.id,
          attemptId: active.attempt.id,
          tagId: active.task.tagId,
          sessionId: active.task.sessionId,
          title: "Research",
          kind: "research",
          entries: [
            { path: "findings.md", uri: `supertag-artifact:${digest}`, digest, sizeBytes: 2 },
          ],
        };
        const first = await f.store.commitCapturedArtifact({ ...base, operationId: "first" });
        const second = await f.store.commitCapturedArtifact({ ...base, operationId: "second" });
        const reference = {
          provider: "github" as const,
          resourceType: "repository" as const,
          resourceId: "repo",
          reference: "github:repo",
          surfaceAccountId: "github-account",
          relationship: "inspected" as const,
        };
        const result: TaskResult = {
          summary: "Done",
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [reference],
          artifacts: [],
        };
        await f.store.closeTask({
          taskId: active.task.id,
          status: "completed",
          result,
          endedAt: "2026-09-01T00:00:00.000Z",
        });
        for (let n = 0; n < 101; n++) {
          const ordinary = await f.input(`ordinary-${n}`);
          await f.store.closeTask({
            taskId: ordinary.task.id,
            status: "completed",
            result,
            endedAt: "2026-09-02T00:00:00.000Z",
          });
        }
        const source = {
          tagId: active.task.tagId,
          tagRouteId: active.work.tagRouteId,
          provider: "slack" as const,
          surfaceAccountId: active.work.surfaceAccountId,
          scope: active.work.event.scope,
          excludeSessionKey: "consumer",
          completedAfter: "2026-08-01T00:00:00.000Z",
          relatedTo: [reference],
        };
        const filter = { source, newestFirst: true, limit: 1 };
        const page = await f.store.listCapturedArtifacts(filter);
        const next = await f.store.listCapturedArtifacts({ ...filter, cursor: page.nextCursor });
        const expected = [first, second].sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
        expect([...page.artifacts, ...next.artifacts].map((a) => a.id)).toEqual(
          expected.map((a) => a.id),
        );
        expect(
          (
            await f.store.listCapturedArtifacts({
              ...filter,
              source: { ...source, surfaceAccountId: "other" },
            })
          ).artifacts,
        ).toEqual([]);
        expect(
          (
            await f.store.listCapturedArtifacts({
              ...filter,
              source: { ...source, relatedTo: [{ ...reference, surfaceAccountId: "other" }] },
            })
          ).artifacts,
        ).toEqual([]);
        expect(
          (
            await f.store.listCapturedArtifacts({
              ...filter,
              source: { ...source, excludeSessionKey: active.work.sessionKey },
            })
          ).artifacts,
        ).toEqual([]);
        // Creating 101 historical Tasks adds real database round trips before the pagination assertions.
      }, 15_000);
      it("prepares one immutable outcome across concurrent retries and journal appenders", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await Promise.all([
          f.store.prepareSurfaceAttempt(request),
          f.other.prepareSurfaceAttempt(request),
          f.other.appendTaskEvent({
            taskId: active.task.id,
            attemptId: active.attempt.id,
            type: "execution.progress",
          }),
        ]);
        const events = await f.store.listTaskEvents(active.task.id);
        const markers = events.filter((e) => e.type === "surface.settlement-prepared");
        expect(markers).toHaveLength(1);
        expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);
        expect(markers[0]?.payload).toMatchObject({
          taskId: request.taskId,
          attemptId: request.attemptId,
          result: request.result,
        });
        await expect(
          f.store.prepareSurfaceAttempt({ ...request, responseText: "Different" }),
        ).rejects.toThrow();
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("running");
      });
      it("cannot commit a different result after preparing an immutable outcome", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await f.store.prepareSurfaceAttempt(request);
        for (const changed of [
          { responseText: "Different" },
          { outcome: { reason: "different" } },
          { status: "cancelled" as const },
          { result: undefined },
        ])
          await expect(f.other.settleSurfaceAttempt({ ...request, ...changed })).rejects.toThrow(
            "prepared outcome",
          );
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("running");
        expect(await f.store.findOutboundReply(active.work.id, "final")).toBeUndefined();
        await f.store.settleSurfaceAttempt(request);
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("completed");
      });
      it("refuses a new prepared outcome after another owner takes over the lease", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        const now = new Date(Date.now() + 120000).toISOString();
        expect(
          await f.other.claimDueInboundEvent({
            inboundEventId: active.work.id,
            leaseOwner: "replacement",
            now,
            leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
          }),
        ).toBeDefined();
        await expect(f.store.prepareSurfaceAttempt({ ...request, now })).rejects.toThrow();
        expect(
          (await f.store.listTaskEvents(active.task.id)).filter(
            (e) => e.type === "surface.settlement-prepared",
          ),
        ).toEqual([]);
        await f.store.blockInboundSession(active.work.id, "Old owner's failed preparation", {
          leaseOwner: "owner",
          now,
        });
        expect((await f.store.findInboundEventById(active.work.id))?.sessionBlocked).toBe(false);
      });
      it("retains prepared evidence through takeover for settlement by the new owner", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await f.store.prepareSurfaceAttempt(request);
        const now = new Date(Date.now() + 120000).toISOString();
        await f.other.claimDueInboundEvent({
          inboundEventId: active.work.id,
          leaseOwner: "replacement",
          now,
          leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
        });
        await f.store.prepareSurfaceAttempt({ ...request, now });
        await f.other.settleSurfaceAttempt({ ...request, leaseOwner: "replacement", now });
        expect(
          (await f.store.listTaskEvents(active.task.id)).filter(
            (e) => e.type === "surface.settlement-prepared",
          ),
        ).toHaveLength(1);
        expect(await f.store.listTaskAttempts(active.task.id)).toHaveLength(1);
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("completed");
      });
      it("does not prepare or block an expired lease even when the owner string still matches", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        const now = new Date(Date.now() + 120000).toISOString();
        await expect(f.store.prepareSurfaceAttempt({ ...request, now })).rejects.toThrow();
        await f.store.blockInboundSession(active.work.id, "Expired owner", {
          leaseOwner: "owner",
          now,
        });
        expect((await f.store.findInboundEventById(active.work.id))?.sessionBlocked).toBe(false);
        await f.store.blockInboundSession(active.work.id, "Current owner", {
          leaseOwner: "owner",
          now: request.now,
        });
        expect((await f.store.findInboundEventById(active.work.id))?.sessionBlocked).toBe(true);
      });
      it("atomically settles a surface attempt and returns one final reply across concurrent retries", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        const replies = await Promise.all([
          f.store.settleSurfaceAttempt(request),
          f.other.settleSurfaceAttempt(request),
        ]);
        expect(replies[0]?.id).toBe(replies[1]?.id);
        expect(await f.store.findTaskById(active.task.id)).toMatchObject({
          status: "completed",
          outcome: request.outcome,
          endedAt: request.completedAt,
        });
        expect(await f.store.listTaskAttempts(active.task.id)).toMatchObject([
          { id: active.attempt.id, status: "completed", outcome: request.outcome },
        ]);
        expect(await f.store.findInboundEventById(active.work.id)).toMatchObject({
          status: "completed",
        });
        await f.store.disconnect();
        await f.store.connect();
        const retried = await f.store.settleSurfaceAttempt({
          ...request,
          now: new Date(Date.now() + 120000).toISOString(),
          outcome: { nested: { b: 2, a: 1 }, responseLength: 8 },
        });
        expect(retried.id).toBe(replies[0]?.id);
        expect(await f.store.listArtifacts({ taskId: active.task.id })).toEqual([]);
        expect(await f.store.findTaskById(active.task.id)).toMatchObject({
          result: request.result,
          responseText: "Finished",
        });
        expect(await f.store.listTaskHistory({ sessionId: active.task.sessionId })).toMatchObject([
          { taskId: active.task.id, result: request.result },
        ]);
      });
      it("recognizes canonical results when recovered JSON changes key order", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await f.store.settleSurfaceAttempt(request);
        const reordered = Object.fromEntries(
          Object.entries(request.result).reverse(),
        ) as unknown as TaskResult;
        await f.store.settleSurfaceAttempt({ ...request, result: reordered });
        expect(await f.store.listTaskHistory({ sessionId: active.task.sessionId })).toHaveLength(1);
        expect(await f.store.listArtifacts({ taskId: active.task.id })).toEqual([]);
      });
      it("rejects invalid result references without terminal writes", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await expect(
          f.store.settleSurfaceAttempt({
            ...request,
            result: {
              ...request.result,
              references: [
                {
                  provider: "slack",
                  resourceType: "channel",
                  relationship: "originated-in",
                  reference: " ",
                },
              ],
            },
          }),
        ).rejects.toThrow();
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("running");
        expect(await f.store.findOutboundReply(active.work.id, "final")).toBeUndefined();
      });
      it("rejects surface settlement with stale leases or a different latest Attempt", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await expect(
          f.store.settleSurfaceAttempt({ ...request, leaseOwner: "other" }),
        ).rejects.toThrow();
        await expect(
          f.store.settleSurfaceAttempt({
            ...request,
            now: new Date(Date.now() + 120000).toISOString(),
          }),
        ).rejects.toThrow();
        await expect(
          f.store.settleSurfaceAttempt({ ...request, taskId: "missing" }),
        ).rejects.toThrow();
        const newer = await f.store.createTaskAttempt({
          taskId: active.task.id,
          attemptNumber: 2,
          workerProfile: { id: "native", revision: "1" },
          workerSnapshot: {},
          startedAt: request.now,
        });
        await expect(f.store.settleSurfaceAttempt(request)).rejects.toThrow();
        expect((await f.store.findTaskById(active.task.id))?.status).toBe("running");
        expect(await f.store.findOutboundReply(active.work.id, "final")).toBeUndefined();
        await f.store.settleSurfaceAttempt({ ...request, attemptId: newer.id });
      });
      it("reconciles matching partial terminal writes while rejecting different stored outcomes", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await f.store.closeTaskAttempt({
          attemptId: active.attempt.id,
          status: request.status,
          outcome: request.outcome,
          endedAt: request.completedAt,
        });
        await f.store.closeTask({
          taskId: active.task.id,
          status: request.status,
          outcome: request.outcome,
          endedAt: request.completedAt,
        });
        await expect(
          f.store.settleSurfaceAttempt({ ...request, outcome: { reason: "different" } }),
        ).rejects.toThrow();
        expect((await f.store.findInboundEventById(active.work.id))?.status).toBe("processing");
        await f.store.settleSurfaceAttempt(request);
        expect((await f.store.findInboundEventById(active.work.id))?.status).toBe("completed");
      });
      it("refuses to replace a committed surface outcome or final content", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        const committed = await f.store.settleSurfaceAttempt(request);
        for (const conflict of [
          { status: "cancelled" as const },
          { outcome: { reason: "different" } },
          { responseText: "Changed" },
          { workerId: "other" },
          { completedAt: new Date(Date.now() + 1000).toISOString() },
          { sessionBlockReason: "new block" },
          { result: { ...request.result, summary: "Changed" } },
        ]) {
          await expect(f.other.settleSurfaceAttempt({ ...request, ...conflict })).rejects.toThrow();
        }
        expect((await f.store.findOutboundReply(active.work.id, "final"))?.text).toBe(
          committed.text,
        );
      });
      it("rolls back surface Task, Attempt, inbound and block changes if final reply insertion fails", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = settlement(active);
        await f.store.enqueueOutboundReply({
          inboundEventId: active.work.id,
          workerId: "worker",
          deliveryKey: "final",
          presentation: "final-result",
          text: "Existing",
          createdAt: request.now,
        });
        await expect(
          f.store.settleSurfaceAttempt({
            ...request,
            status: "cancelled",
            sessionBlockReason: "Cancellation outcome unknown",
          }),
        ).rejects.toThrow();
        expect(await f.store.findTaskById(active.task.id)).toMatchObject({ status: "running" });
        expect(await f.store.listTaskAttempts(active.task.id)).toMatchObject([
          { status: "running" },
        ]);
        expect(await f.store.listArtifacts({ taskId: active.task.id })).toEqual([]);
        expect(await f.store.findInboundEventById(active.work.id)).toMatchObject({
          status: "processing",
          sessionBlocked: false,
          leaseOwner: "owner",
        });
      });
      it("commits cancellation and its Session block together with the final reply", async () => {
        const f = await fixture();
        const active = await f.activate();
        const request = {
          ...settlement(active),
          status: "cancelled" as const,
          sessionBlockReason: "Host cancellation unconfirmed",
        };
        const reply = await f.store.settleSurfaceAttempt(request);
        expect(await f.store.findTaskById(active.task.id)).toMatchObject({ status: "cancelled" });
        expect(await f.store.listTaskAttempts(active.task.id)).toMatchObject([
          { status: "cancelled" },
        ]);
        expect(await f.store.findInboundEventById(active.work.id)).toMatchObject({
          status: "completed",
          sessionBlocked: true,
          lastError: request.sessionBlockReason,
        });
        expect((await f.other.settleSurfaceAttempt(request)).id).toBe(reply.id);
        const follower = await f.input();
        expect(await f.other.claimDueInboundEvent(f.lease(follower.work.id))).toBeUndefined();
      });
      it("serializes concurrent claims while allowing other Sessions", async () => {
        const f = await fixture();
        const first = await f.input();
        const next = await f.input();
        const independent = await f.input("other");
        const claims = await Promise.all([
          f.store.claimDueInboundEvent(f.lease(first.work.id)),
          f.other.claimDueInboundEvent(f.lease(next.work.id)),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await f.store.claimDueInboundEvent(f.lease(independent.work.id))).toBeDefined();
      });
      it("orders simultaneous admissions without timestamp or UUID tie breaking", async () => {
        const f = await fixture();
        vi.useFakeTimers({ toFake: ["Date"] });
        let admitted: Awaited<ReturnType<typeof f.input>>[];
        try {
          admitted = await Promise.all([f.input(), f.input()]);
        } finally {
          vi.useRealTimers();
        }
        expect(new Set(admitted.map((entry) => entry.work.admissionOrder)).size).toBe(2);
        admitted.sort((a, b) => a.work.admissionOrder - b.work.admissionOrder);
        const first = admitted[0],
          later = admitted[1];
        if (!first || !later) throw new Error("Missing admissions");
        expect(first.work.createdAt).toBe(later.work.createdAt);
        expect(await f.store.claimDueInboundEvent(f.lease(later.work.id))).toBeUndefined();
        expect(await f.other.claimDueInboundEvent(f.lease(first.work.id))).toBeDefined();
      });
      it("uses the latest executed Task even when it failed without a sessionState", async () => {
        const f = await fixture();
        const older = await f.input();
        const latest = await f.input();
        const pending = await f.input();
        const at = new Date().toISOString();
        await f.store.startTask({ taskId: older.task.id, startedAt: at });
        await f.store.closeTask({ taskId: older.task.id, status: "completed", endedAt: at });
        await f.store.startTask({ taskId: latest.task.id, startedAt: at });
        await f.store.closeTask({ taskId: latest.task.id, status: "failed", endedAt: at });
        expect(
          (await f.store.findLatestSessionExecutionTask(pending.task.sessionId, pending.task.id))
            ?.id,
        ).toBe(latest.task.id);
        await f.store.startTask({ taskId: pending.task.id, startedAt: at });
        expect(
          (await f.store.findLatestSessionExecutionTask(pending.task.sessionId, pending.task.id))
            ?.id,
        ).toBe(latest.task.id);
      });
      it("does not let later input bypass an earlier delayed input", async () => {
        const f = await fixture();
        await f.input("thread", new Date(Date.now() + 60000).toISOString());
        const later = await f.input();
        expect(await f.other.claimDueInboundEvent(f.lease(later.work.id))).toBeUndefined();
      });
      it("prevents live input overtaking queued or blocked Session input", async () => {
        const f = await fixture();
        const active = await f.activate();
        const queued = await f.input();
        const newer = await f.input();
        expect(await f.store.findActiveSessionAttempt(newer.work.id)).toBeUndefined();
        expect(
          await f.store.prepareInboundControlDelivery({
            inboundEventId: newer.work.id,
            taskId: active.task.id,
            attemptId: active.attempt.id,
            command: { id: "newer", type: "input", text: "Newer" },
          }),
        ).toBeUndefined();
        await f.store.blockInboundSession(queued.work.id, "Uncertain execution");
        expect(await f.store.findActiveSessionAttempt(queued.work.id)).toBeUndefined();
        const other = await f.input("independent");
        expect(await f.store.claimDueInboundEvent(f.lease(other.work.id))).toBeDefined();
      });
      it("never steers an expired execution lease", async () => {
        const f = await fixture();
        const active = await f.activate();
        const follower = await f.input();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 120000);
        try {
          expect(await f.store.findActiveSessionAttempt(follower.work.id)).toBeUndefined();
          expect(
            await f.store.prepareInboundControlDelivery({
              inboundEventId: follower.work.id,
              taskId: active.task.id,
              attemptId: active.attempt.id,
              command: { id: "expired", type: "input", text: "Continue" },
            }),
          ).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });
      it.each(["accepted", "rejected"] as const)(
        "preserves a live acknowledgement wait for %s input",
        async (status) => {
          const f = await fixture();
          const active = await f.activate();
          const follower = await f.input();
          const prepared = await f.store.prepareInboundControlDelivery({
            inboundEventId: follower.work.id,
            taskId: active.task.id,
            attemptId: active.attempt.id,
            command: { id: "command", type: "input", text: "Continue" },
          });
          await f.store.closeTaskAttempt({
            attemptId: active.attempt.id,
            status: "completed",
            endedAt: new Date().toISOString(),
          });
          await f.other.enqueueUnresolvedSessionInputReplies({
            now: new Date(Date.parse(prepared?.delivery.createdAt ?? "") + 9_999).toISOString(),
            text: "Recovery notice",
          });
          expect(
            await f.store.findOutboundReply(follower.work.id, "session-input-unresolved"),
          ).toBeUndefined();
          expect(
            await f.store.finishInboundControlDelivery({
              inboundEventId: follower.work.id,
              status,
            }),
          ).toMatchObject({ status });
          expect(await f.store.findTaskById(follower.task.id)).toMatchObject({
            status: status === "accepted" ? "completed" : "pending",
          });
        },
      );
      it.each(["accepted", "rejected"] as const)(
        "settles crashed input once and fences late %s acknowledgements",
        async (status) => {
          const f = await fixture();
          const active = await f.activate();
          const follower = await f.input();
          const prepared = await f.store.prepareInboundControlDelivery({
            inboundEventId: follower.work.id,
            taskId: active.task.id,
            attemptId: active.attempt.id,
            command: { id: "command", type: "input", text: "Continue" },
          });
          await f.store.closeTaskAttempt({
            attemptId: active.attempt.id,
            status: "completed",
            endedAt: new Date().toISOString(),
          });
          await f.store.disconnect();
          await f.store.connect();
          const recovery = {
            now: new Date(Date.parse(prepared?.delivery.createdAt ?? "") + 10_000).toISOString(),
            text: "Recovery notice",
          };
          await Promise.all([
            f.store.enqueueUnresolvedSessionInputReplies(recovery),
            f.other.enqueueUnresolvedSessionInputReplies(recovery),
          ]);
          const notice = await f.store.findOutboundReply(
            follower.work.id,
            "session-input-unresolved",
          );
          expect(notice).toBeDefined();
          expect(await f.store.findInboundEventById(follower.work.id)).toMatchObject({
            status: "failed",
            sessionBlocked: true,
          });
          expect(await f.store.findTaskById(follower.task.id)).toMatchObject({
            status: "failed",
            outcome: { reason: "input-unknown" },
          });
          expect(
            await f.store.finishInboundControlDelivery({
              inboundEventId: follower.work.id,
              status,
            }),
          ).toMatchObject({ status: "unknown" });
          await f.store.enqueueUnresolvedSessionInputReplies(recovery);
          expect(
            await f.store.findOutboundReply(follower.work.id, "session-input-unresolved"),
          ).toMatchObject({ id: notice?.id, revision: 1 });
          expect(await f.store.findTaskById(follower.task.id)).toMatchObject({ status: "failed" });
        },
      );
      it("persists exactly one dispatch and never retries unknown input", async () => {
        const f = await fixture();
        const active = await f.activate();
        const follower = await f.input();
        expect((await f.store.findActiveSessionAttempt(follower.work.id))?.attempt.id).toBe(
          active.attempt.id,
        );
        const request = {
          inboundEventId: follower.work.id,
          taskId: active.task.id,
          attemptId: active.attempt.id,
          command: { id: "command", type: "input", text: "Continue" },
        };
        const prepared = await Promise.all([
          f.store.prepareInboundControlDelivery(request),
          f.other.prepareInboundControlDelivery(request),
        ]);
        expect(prepared.filter((entry) => entry?.created)).toHaveLength(1);
        await f.store.disconnect();
        await f.store.connect();
        expect((await f.store.prepareInboundControlDelivery(request))?.created).toBe(false);
        await f.store.finishInboundControlDelivery({
          inboundEventId: follower.work.id,
          status: "unknown",
        });
        expect((await f.store.findTaskById(follower.task.id))?.status).toBe("failed");
        expect((await f.store.findInboundEventById(follower.work.id))?.sessionBlocked).toBe(true);
        expect(await f.store.claimDueInboundEvent(f.lease(follower.work.id))).toBeUndefined();
        await expect(
          f.store.finishInboundControlDelivery({
            inboundEventId: follower.work.id,
            status: "accepted",
          }),
        ).rejects.toThrow();
      });
      it("completes accepted follower without an execution Attempt", async () => {
        const f = await fixture();
        const active = await f.activate();
        const follower = await f.input();
        await f.store.prepareInboundControlDelivery({
          inboundEventId: follower.work.id,
          taskId: active.task.id,
          attemptId: active.attempt.id,
          command: { id: "command", type: "input", text: "Continue" },
        });
        await f.store.finishInboundControlDelivery({
          inboundEventId: follower.work.id,
          status: "accepted",
        });
        expect((await f.store.findTaskById(follower.task.id))?.status).toBe("completed");
        expect((await f.store.findInboundEventById(follower.work.id))?.status).toBe("completed");
      });
      it("leaves rejected input queued and refuses history mutation after execution starts", async () => {
        const f = await fixture();
        const active = await f.activate();
        const follower = await f.input();
        await f.store.prepareInboundControlDelivery({
          inboundEventId: follower.work.id,
          taskId: active.task.id,
          attemptId: active.attempt.id,
          command: { id: "command", type: "input", text: "Continue" },
        });
        await f.store.finishInboundControlDelivery({
          inboundEventId: follower.work.id,
          status: "rejected",
        });
        expect((await f.store.findTaskById(follower.task.id))?.status).toBe("pending");
        expect((await f.store.refreshPendingTaskSessionHistory(follower.task.id, [])).id).toBe(
          follower.task.id,
        );
        await expect(
          f.store.refreshPendingTaskSessionHistory(active.task.id, []),
        ).rejects.toThrow();
      });
    },
  );
