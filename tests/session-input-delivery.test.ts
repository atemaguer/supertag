import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
      "accepted",
      "unknown",
      "unsupported",
      "unresponsive-capabilities",
      "rejected",
      "changed-authority",
      "changed-execution",
    ] as const)(
      "delivers Session input with %s native support without losing or replaying input",
      async (mode) => {
        const directory = await mkdtemp(join(tmpdir(), "session-input-"));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres ?? "")
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const specs: TaskAttemptSpec[] = [];
        const errors: unknown[] = [];
        const received: string[] = [];
        const processed: string[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const sessionState = {
          id: "latest-sessionState",
          uri: "sessionState://latest",
          format: "test-v1",
        };
        const control = vi.fn<NonNullable<Worklet["control"]>>(async (command) => {
          received.push(command.type === "input" ? command.text : "unexpected");
          return {
            id: command.id,
            taskId: command.taskId,
            attemptId: command.attemptId,
            status: mode === "accepted" ? "accepted" : mode === "rejected" ? "rejected" : "unknown",
          };
        });
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
          controlCapabilities: async () =>
            mode === "unresponsive-capabilities"
              ? new Promise(() => {})
              : mode === "unsupported"
                ? undefined
                : { version: 1, operations: ["input"], inputMode: "queue" },
          async *execute(spec) {
            specs.push(spec);
            const identity = {
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
            };
            yield { ...identity, type: "execution.started", workerId: "worker" };
            if (specs.length === 1) {
              await blocked;
              processed.push(...received);
            }
            yield {
              ...identity,
              type: "output.message",
              message: { role: "teammate", text: "First work completed" },
            };
            yield {
              ...identity,
              type: "result",
              result: {
                summary: "First work completed",
                decisions: [],
                changes: [],
                unresolved: [],
                findings: [],
                references: [],
                artifacts: [],
              },
            };
            const state =
              specs.length === 1
                ? sessionState
                : { ...sessionState, id: `${sessionState.id}-${spec.attemptId}` };
            await store.putSessionState({
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              harnessId: "test",
              ref: state,
              data: { threadId: "native-test" },
            });
            yield { ...identity, type: "session.updated", sessionState: state };
            yield { ...identity, type: "execution.completed" };
          },
        };
        const controlPlane = new ControlPlane({
          store,
          worklet,
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          reply: async () => ({ externalMessageId: "reply" }),
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
          const route = await store.addTagRoute({
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
          if (mode === "changed-authority") {
            const permissions = await store.createTagPermissionSet({
              tagId: tag.id,
              name: "New authority",
            });
            await store.addTagPermission({
              permissionSetId: permissions.id,
              target: "runtime",
              action: "commands:execute",
            });
            await store.activateTagPermissionSet({
              permissionSetId: permissions.id,
              tagRouteId: route.id,
            });
          }
          const secondEvent = event("second");
          const second = await controlPlane.ingestSurfaceEvent(
            secondEvent,
            mode === "changed-execution"
              ? { execution: { profile: { id: "default", revision: "1" } } }
              : {},
          );
          expect(second.status).toBe("accepted");
          if (["accepted", "unknown", "rejected"].includes(mode)) {
            await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
            expect(control.mock.calls[0]?.[0]).toMatchObject({
              taskId: specs[0]?.taskId,
              attemptId: specs[0]?.attemptId,
              text: expect.stringContaining(secondEvent.text ?? ""),
            });
            await controlPlane.ingestSurfaceEvent(secondEvent);
            expect(control).toHaveBeenCalledOnce();
            expect(received).toEqual([expect.stringContaining(secondEvent.text ?? "")]);
            expect(received[0]).toContain(JSON.stringify(secondEvent.actor));
            if (second.status !== "accepted") throw new Error("Missing admitted follower");
            const admitted = await store.findTaskById(second.taskId);
            if (!admitted?.inboundEventId) throw new Error("Missing follower inbound event");
            expect(await store.findInboundControlDelivery(admitted.inboundEventId)).toMatchObject({
              status: mode,
              taskId: specs[0]?.taskId,
              attemptId: specs[0]?.attemptId,
            });
          } else expect(control).not.toHaveBeenCalled();
          expect(specs).toHaveLength(1);
          let blockedFollowerId: string | undefined;
          if (mode === "unknown") {
            const follower = await controlPlane.ingestSurfaceEvent(event("third"));
            if (follower.status !== "accepted") throw new Error("Follower not admitted");
            blockedFollowerId = follower.taskId;
            expect(control).toHaveBeenCalledOnce();
          }
          release();
          const first = specs[0];
          if (!first) throw new Error("Missing first execution");
          await vi.waitFor(async () =>
            expect((await store.findTaskById(first.taskId))?.status).toBe("completed"),
          );
          if (!["accepted", "unknown"].includes(mode)) {
            await vi.waitFor(() => expect(specs).toHaveLength(2));
            if (mode === "unsupported" || mode === "rejected")
              expect(specs[1]?.session?.sessionState).toMatchObject(sessionState);
            expect(
              specs[1]?.session?.history?.some((record) => record.taskId === specs[0]?.taskId),
            ).toBe(true);
          } else {
            await controlPlane.stop();
            expect(specs).toHaveLength(1);
            expect(control).toHaveBeenCalledOnce();
            expect(processed).toEqual(received);
            if (blockedFollowerId) {
              await store.connect();
              expect((await store.findTaskById(blockedFollowerId))?.status).toBe("pending");
            }
          }
          expect(errors).toEqual([]);
        } finally {
          release();
          await controlPlane.stop();
          await store.disconnect();
          await rm(directory, { recursive: true, force: true });
          await isolated?.cleanup();
        }
      },
      // Includes isolated database migration/cleanup and the real 2s capability deadline.
      // Keep that production deadline intact while allowing for concurrent suite load.
      15_000,
    );
  });
}
