import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UncertainExecutionError } from "../packages/control-plane/src/durable-execution.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import type { InboundSurfaceEvent } from "../packages/core/src/index.js";
import type { TaskAttemptSpec, Worklet } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(dialect, () => {
    it.each([
      // The harness acknowledged the input before reporting it withdrawn.
      "after acknowledgement",
      "terminal failed",
      "terminal cancelled",
      "terminal completed",
      "terminal uncertain",
      "terminal before unknown acknowledgement",
      "terminal live accepted acknowledgement",
      "terminal live rejected acknowledgement",
      "terminal restart",
      "terminal restart during acknowledgement",
      "after unknown acknowledgement",
      "mismatched unknown acknowledgement",
      // The withdrawal arrives while the Control Plane still awaits the acknowledgement.
      "before acknowledgement",
      "before unknown acknowledgement",
    ] as const)(
      "handles operator input %s without loss or cross-Attempt withdrawal",
      async (order) => {
        const liveAck = order.startsWith("terminal live");
        const crashed = order === "terminal restart during acknowledgement";
        const beforeAcknowledgement =
          crashed ||
          liveAck ||
          order.startsWith("before") ||
          order === "terminal before unknown acknowledgement";
        const mismatched = order.startsWith("mismatched");
        const terminal = order.startsWith("terminal");
        const uncertain = terminal || order.includes("unknown");
        const directory = await mkdtemp(join(tmpdir(), "session-input-withdrawal-"));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres ?? "")
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const specs: TaskAttemptSpec[] = [];
        const errors: unknown[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        let acknowledge!: () => void;
        const acknowledged = new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        let withdrawn!: () => void;
        const withdrawalRecorded = new Promise<void>((resolve) => {
          withdrawn = resolve;
        });
        const control = vi.fn<NonNullable<Worklet["control"]>>(async (command) => {
          if (beforeAcknowledgement) await acknowledged;
          return {
            id: command.id,
            taskId: command.taskId,
            attemptId: command.attemptId,
            status: liveAck
              ? order.includes("rejected")
                ? "rejected"
                : "accepted"
              : uncertain
                ? "unknown"
                : "accepted",
          };
        });
        const reply = vi.fn(async () => ({ externalMessageId: "reply" }));
        let rogueCompleted = false;
        const worklet: Worklet = {
          id: "session-worklet",
          describe: async () => ({
            id: "session-worklet",
            protocolVersion: 1,
            host: {
              id: "host",
              workers: [
                {
                  profileCapabilities: [
                    {
                      profile: { id: "default", revision: "1" },
                      capabilities: [],
                      contextTypes: [],
                    },
                  ],
                  id: "worker",
                  type: "deterministic",
                  profiles: [{ id: "default", revision: "1" }],
                  capabilities: [],
                  contextTypes: [],
                  maxConcurrency: 2,
                },
              ],
            },
          }),
          control,
          controlCapabilities: async () => ({
            version: 1,
            operations: ["input"],
            inputMode: "queue",
          }),
          async *execute(spec) {
            if (spec.input.origin.sessionKey === "T1:C1:other-thread") {
              const command = control.mock.calls[0]?.[0];
              if (!command) throw new Error("Missing target command");
              // A different execution claims the target's IDs, which it does not own.
              yield {
                taskId: command.taskId,
                attemptId: command.attemptId,
                at: new Date().toISOString(),
                type: "input.withdrawn",
                commandId: command.id,
              };
              rogueCompleted = true;
              yield {
                taskId: spec.taskId,
                attemptId: spec.attemptId,
                at: new Date().toISOString(),
                type: "output.message",
                message: { role: "teammate", text: "Other execution completed" },
              };
              yield {
                taskId: spec.taskId,
                attemptId: spec.attemptId,
                at: new Date().toISOString(),
                type: "execution.completed",
              };
              return;
            }
            specs.push(spec);
            const identity = {
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
            };
            yield { ...identity, type: "execution.started", workerId: "worker" };
            if (specs.length === 1) {
              await blocked;
              if (order === "terminal uncertain") throw new UncertainExecutionError(spec.attemptId);
              if (
                order === "terminal failed" ||
                order === "terminal cancelled" ||
                order === "terminal restart"
              )
                throw new Error("Target execution stopped");
              // The final result arrived before the model read the queued input.
              const command = control.mock.calls[0]?.[0];
              if (command && !mismatched && !terminal)
                yield { ...identity, type: "input.withdrawn", commandId: command.id };
              // Repeating the report changes nothing.
              if (command && !mismatched && !terminal)
                yield { ...identity, type: "input.withdrawn", commandId: command.id };
              withdrawn();
            }
            yield {
              ...identity,
              type: "output.message",
              message: { role: "teammate", text: `Work ${specs.length} completed` },
            };
            yield {
              ...identity,
              type: "result",
              result: {
                summary: `Work ${specs.length} completed`,
                decisions: [],
                changes: [],
                unresolved: [],
                findings: [],
                references: [],
                artifacts: [],
              },
            };
            yield { ...identity, type: "execution.completed" };
          },
        };
        // Simulate a crash during the acknowledgement wait: no acknowledgement settlement
        // reaches durable storage. Restart must recover the remaining dispatching row.
        const crash = new Error("Simulated Control Plane crash");
        const lostSettlement = crashed
          ? vi.spyOn(store, "finishInboundControlDelivery").mockRejectedValue(crash)
          : undefined;
        const pausedNotices = order.startsWith("terminal restart")
          ? vi.spyOn(store, "enqueueUnresolvedSessionInputReplies").mockResolvedValue()
          : undefined;
        const controlPlane = new ControlPlane({
          store,
          worklet,
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          reply,
          dispatch: {
            pollIntervalMs: 5,
            leaseDurationMs: 10000,
            maxAttempts: 1,
            onDispatchError: (error) => errors.push(error),
          },
        });
        try {
          await controlPlane.start();
          const account = await controlPlane.setupSurfaceAccount({
            provider: "slack",
            externalAccountId: "T1",
            displayName: "Fixture",
            authMethod: "slack-socket-mode",
            configuration: { transport: "socket" },
            secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
          });
          const tag = await store.createTag({ name: "SuperTag" });
          await store.bindTagWorkerHost(tag.id, "host");
          await store.addTagRoute({
            tagId: tag.id,
            surfaceAccountId: account.id,
            scope: "channel:C1",
          });
          const event = (id: string): InboundSurfaceEvent => ({
            eventId: id,
            logicalEventId: id,
            provider: "slack",
            externalAccountId: "T1",
            kind: "mention",
            scope: "channel:C1",
            sessionKey: "T1:C1:thread",
            actor: { id: "U1", kind: "user" },
            text: id === "first" ? "Inspect the project" : "Also inspect the tests",
            occurredAt: new Date().toISOString(),
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "T1:C1:thread",
              target: { channelId: "C1", threadTs: "1.000" },
            },
            source: {},
            metadata: {},
          });
          await controlPlane.ingestSurfaceEvent(event("first"));
          await vi.waitFor(() => expect(specs).toHaveLength(1));
          const secondEvent = event("second");
          const admitting = controlPlane.ingestSurfaceEvent(secondEvent).catch((error: unknown) => {
            if (!crashed || error !== crash) throw error;
            return undefined;
          });
          await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
          if (beforeAcknowledgement) {
            if (crashed) {
              const follower = (await store.listTasks()).find(
                (task) => task.id !== specs[0]?.taskId,
              );
              expect(follower?.status).toBe("pending");
              expect(
                await store.findInboundControlDelivery(follower?.inboundEventId ?? ""),
              ).toMatchObject({
                status: "dispatching",
              });
            }
            release();
            if (terminal) {
              await vi.waitFor(async () =>
                expect((await store.listTaskAttempts(specs[0]?.taskId ?? ""))[0]?.status).toBe(
                  "completed",
                ),
              );
            } else {
              await withdrawalRecorded;
              // Let the Control Plane record the withdrawal before the late acknowledgement.
              await vi.waitFor(async () => {
                const events = await store.listTaskEvents(specs[0]?.taskId ?? "");
                expect(events.some((entry) => entry.type === "task.session-input")).toBe(true);
              });
            }
            if (liveAck) {
              const follower = (await store.listTasks()).find(
                (task) => task.id !== specs[0]?.taskId,
              );
              if (!follower?.inboundEventId) throw new Error("Missing follower");
              await store.enqueueUnresolvedSessionInputReplies({
                now: new Date().toISOString(),
                text: "Premature recovery notice",
              });
              expect(
                await store.findOutboundReply(follower.inboundEventId, "session-input-unresolved"),
              ).toBeUndefined();
            }
            acknowledge();
          }
          const result = await admitting;
          lostSettlement?.mockRestore();
          const second = result ?? (await controlPlane.ingestSurfaceEvent(secondEvent));
          if (second.status !== "accepted" && second.status !== "duplicate")
            throw new Error("Missing admitted follower");
          const admitted = await store.findTaskById(second.taskId);
          if (!admitted?.inboundEventId) throw new Error("Missing follower inbound event");
          if (liveAck) {
            const status = order.includes("rejected") ? "rejected" : "accepted";
            expect(await store.findInboundControlDelivery(admitted.inboundEventId)).toMatchObject({
              status,
            });
            await vi.waitFor(async () =>
              expect((await store.findTaskById(second.taskId))?.status).toBe("completed"),
            );
            expect(specs).toHaveLength(status === "rejected" ? 2 : 1);
            expect(
              await store.findOutboundReply(admitted.inboundEventId, "session-input-unresolved"),
            ).toBeUndefined();
            expect(errors).toEqual([]);
            return;
          }
          if (terminal) {
            const first = specs[0];
            if (!first) throw new Error("Missing target execution");
            if (order === "terminal cancelled")
              await controlPlane.requestTaskCancellation(first.taskId);
            release();
            const status =
              crashed ||
              order === "terminal completed" ||
              order === "terminal before unknown acknowledgement"
                ? "completed"
                : order === "terminal cancelled"
                  ? "cancelled"
                  : "failed";
            await vi.waitFor(async () =>
              expect((await store.listTaskAttempts(first.taskId))[0]?.status).toBe(status),
            );
            const notices = () =>
              reply.mock.calls.filter((call) =>
                JSON.stringify(call).includes("Your message may not have been delivered"),
              );
            if (pausedNotices) {
              await controlPlane.stop();
              expect(notices()).toHaveLength(0);
              pausedNotices.mockRestore();
              if (crashed) {
                vi.useFakeTimers({ toFake: ["Date"] });
                vi.setSystemTime(Date.now() + 10_000);
              }
              await controlPlane.start();
            }
            await vi.waitFor(() => expect(notices()).toHaveLength(1));
            expect(JSON.stringify(notices())).toContain("resend it in a new thread");
            await vi.waitFor(async () =>
              expect(
                await store.findOutboundReply(
                  admitted.inboundEventId ?? "",
                  "session-input-unresolved",
                ),
              ).toMatchObject({ status: "delivered" }),
            );
            const notice = await store.findOutboundReply(
              admitted.inboundEventId,
              "session-input-unresolved",
            );
            // Neither a replay nor a late withdrawal may auto-deliver input after the notice.
            await controlPlane.ingestSurfaceEvent(secondEvent);
            expect(
              await store.withdrawInboundControlDelivery({
                inboundEventId: admitted.inboundEventId,
                taskId: first.taskId,
                attemptId: first.attemptId,
              }),
            ).toBeUndefined();
            await controlPlane.stop();
            await controlPlane.start();
            // Reconcile from competing callers too; an existing reply must stay delivered.
            await Promise.all(
              [0, 1].map(() =>
                store.enqueueUnresolvedSessionInputReplies({
                  now: new Date().toISOString(),
                  text: "Duplicate recovery notice",
                }),
              ),
            );
            expect(notices()).toHaveLength(1);
            expect(
              await store.findOutboundReply(admitted.inboundEventId, "session-input-unresolved"),
            ).toMatchObject({ id: notice?.id, revision: 1, status: "delivered" });
            expect(await store.findInboundControlDelivery(admitted.inboundEventId)).toMatchObject({
              status: "unknown",
            });
            expect(
              (await store.findInboundEventById(admitted.inboundEventId))?.sessionBlocked,
            ).toBe(true);
            expect(specs).toHaveLength(1);
            expect(control).toHaveBeenCalledOnce();
            expect(
              errors.filter(
                (error) =>
                  !(error instanceof Error) ||
                  (error.message !== "Target execution stopped" &&
                    !(error instanceof UncertainExecutionError)),
              ),
            ).toEqual([]);
            return;
          }
          if (!beforeAcknowledgement) {
            expect(await store.findInboundControlDelivery(admitted.inboundEventId)).toMatchObject({
              status: uncertain ? "unknown" : "accepted",
            });
            // Another Task Attempt can't withdraw it.
            expect(
              await store.withdrawInboundControlDelivery({
                inboundEventId: admitted.inboundEventId,
                taskId: specs[0]?.taskId ?? "",
                attemptId: "another-attempt",
              }),
            ).toBeUndefined();
            expect((await store.findTaskById(second.taskId))?.status).toBe(
              uncertain ? "failed" : "completed",
            );
            if (mismatched) {
              release();
              const rogue = event("rogue");
              await controlPlane.ingestSurfaceEvent({
                ...rogue,
                sessionKey: "T1:C1:other-thread",
                callback: { ...rogue.callback, threadKey: "T1:C1:other-thread" },
              });
              await vi.waitFor(() => expect(rogueCompleted).toBe(true));
              expect(await store.findInboundControlDelivery(admitted.inboundEventId)).toMatchObject(
                {
                  status: "unknown",
                  taskId: specs[0]?.taskId,
                  attemptId: specs[0]?.attemptId,
                },
              );
              expect((await store.findTaskById(second.taskId))?.status).toBe("failed");
              expect(specs).toHaveLength(1);
              expect(errors).toEqual([]);
              return;
            }
            release();
          }
          const first = specs[0];
          if (!first) throw new Error("Missing first execution");
          await vi.waitFor(async () =>
            expect((await store.findTaskById(first.taskId))?.status).toBe("completed"),
          );
          // The withdrawn message runs as its own Task, on the next activation.
          await vi.waitFor(() => expect(specs).toHaveLength(2));
          expect(specs[1]?.taskId).toBe(second.taskId);
          expect(JSON.stringify(specs[1]?.input)).toContain(secondEvent.text);
          await vi.waitFor(async () =>
            expect((await store.findTaskById(second.taskId))?.status).toBe("completed"),
          );
          expect((await store.findTaskById(second.taskId))?.responseText).toContain(
            "Work 2 completed",
          );
          expect(await store.findInboundControlDelivery(admitted.inboundEventId)).toMatchObject({
            status: "withdrawn",
            taskId: first.taskId,
            attemptId: first.attemptId,
          });
          const inbound = await store.findInboundEventById(admitted.inboundEventId);
          expect(inbound?.sessionBlocked).toBe(false);
          expect(inbound?.failedAt).toBeUndefined();
          expect(inbound?.lastError).toBeUndefined();
          const recorded = (await store.listTaskEvents(first.taskId)).filter(
            (entry) => entry.type === "task.session-input",
          );
          expect(recorded).toHaveLength(1);
          expect(recorded[0]?.payload).toMatchObject({
            version: 1,
            status: "withdrawn",
            inboundEventId: admitted.inboundEventId,
            taskId: second.taskId,
          });
          // A redelivered surface event and later polling never run it again.
          await controlPlane.ingestSurfaceEvent(secondEvent);
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(specs).toHaveLength(2);
          expect(control).toHaveBeenCalledOnce();
          expect(errors).toEqual([]);
          if (uncertain && !beforeAcknowledgement) {
            const replies = JSON.stringify(reply.mock.calls);
            expect(replies).toContain(
              "retried on the next activation if the active execution withdraws it",
            );
            expect(replies).toContain("do not resend");
            expect(replies).not.toContain("will not resend it automatically");
          }
        } finally {
          vi.useRealTimers();
          release();
          acknowledge();
          await controlPlane.stop();
          await store.disconnect();
          await rm(directory, { recursive: true, force: true });
          await isolated?.cleanup();
        }
      },
      15_000,
    );
  });
}
