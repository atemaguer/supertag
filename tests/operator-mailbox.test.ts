import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { ObjectiveMessages } from "../packages/control-plane/src/objective-messages.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import { decodeMessage, encodeMessage } from "../packages/runtime/transport/src/mailbox-codec.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} operator mailbox`, () => {
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "operator-mailbox-"));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      const owner = await store.createTag({ name: randomUUID() });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Maintain service",
        ongoing: true,
        budgetLimitMinor: 1000,
      });
      await store.bindTagWorkerHost(owner.id, "operator-host");
      return {
        directory,
        url,
        store,
        owner,
        objective,
        async close() {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        },
      };
    }
    it("persists a headless request, survives restart, approves through HTTP, and resumes actual work", async () => {
      const f = await fixture();
      const errors: unknown[] = [];
      let requestId = "",
        rootAttempts = 0,
        childRuns = 0;
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
      const worker: Worker = {
        async describe() {
          return {
            profileCapabilities: [
              {
                profile: { id: "operator-profile", revision: "1" },
                capabilities: [{ id: "supertag.coordination", version: 1 }],
                contextTypes: [],
              },
            ],
            id: "operator-worker",
            type: "deterministic",
            profiles: [{ id: "operator-profile", revision: "1" }],
            contextTypes: [],
            maxConcurrency: 1,
            trustLevel: "standard",
            capabilities: [{ id: "supertag.coordination", version: 1 }],
          };
        },
        async *execute(spec) {
          const identity = {
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
          };
          yield { ...identity, type: "execution.started", workerId: "operator-worker" };
          const call = async (name: string, args: Record<string, unknown> = {}) => {
            const response = await fetch(
              `${spec.coordination?.controlPlaneUrl}/internal/v1/coordination/mcp`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${spec.coordination?.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name, arguments: args },
                }),
              },
            );
            const value = await response.json();
            expect(response.status, JSON.stringify(value)).toBe(200);
            expect(value.result?.isError, JSON.stringify(value)).not.toBe(true);
            return JSON.parse(value.result?.content[0]?.text ?? "null");
          };
          try {
            if (spec.taskId === `${f.objective.id}:start`) {
              rootAttempts++;
              if (rootAttempts === 1) {
                const args = {
                  recipientObjectiveId: f.objective.id,
                  type: "message",
                  body: {
                    message: "Need 100 allocation units for the new workload; only 50 remain.",
                  },
                  idempotencyKey: "new-workload",
                };
                const sent = await call("send_message", args);
                requestId = sent.message.id;
                expect((await call("send_message", args)).message.id).toBe(requestId);
                expect(
                  (await call("read_mailbox", { recipientObjectiveId: f.objective.id })).messages,
                ).toHaveLength(1);
                await call("wait_for", {
                  mailbox: true,
                  reason: "Waiting for an operator allocation decision",
                });
              } else if (rootAttempts === 2) {
                const objective = await f.store.getObjective(f.objective.id);
                expect(objective.budgetLimitMinor).toBe(1050);
                const messages = await call("read_mailbox");
                expect(messages.messages).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      operatorId: "test-operator",
                      inReplyTo: requestId,
                      body: { message: "Limit increased to 1050; continue the repair." },
                    }),
                  ]),
                );
                await call("assign_task", {
                  taskId: "repair-after-approval",
                  teamId: `${f.objective.id}:leadership`,
                  assignedTagId: f.owner.id,
                  instruction: "Repair using the approved allocation",
                  acceptanceCriteria: ["Repair verified"],
                  maxCostMinor: 100,
                });
                await call("wait_for", {
                  submittedTaskIds: ["repair-after-approval"],
                  reason: "Repair is now authorized and underway",
                });
              } else {
                await call("update_task", {
                  taskId: "repair-after-approval",
                  expectedStatus: "submitted",
                  status: "accepted",
                  assessment: "Repair verified",
                });
              }
            } else if (spec.taskId === "repair-after-approval") childRuns++;
          } catch (error) {
            errors.push(error);
            throw error;
          }
          yield {
            ...identity,
            type: "output.message",
            message: { role: "teammate", text: "Work completed" },
          };
          yield { ...identity, type: "execution.completed" };
        },
      };
      const local = new LocalWorklet("operator-worklet", "operator-host", [worker]);
      const durable = new DurableLocalWorklet(
        local,
        new FileAttemptJournal(join(f.directory, "journal")),
      );
      let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
      let credential: string | undefined;
      const connect = async () => {
        credential ??= await enrollWorkerHost(runtime?.url, "test-admin", "operator-host");
        connection = await connectWorklet({
          url: `${runtime?.url.replace(/^http/u, "ws")}/worklets`,
          credential,
          worklet: local,
          durableWorklet: durable,
          reconnectIntervalMs: 20,
        });
      };
      const start = () =>
        startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl: f.url,
          adminToken: "test-admin",
          workletTransport: "remote",
          credentialVault: new FileGatewayCredentialVault(join(f.directory, "vault.json")),
          coordinationOperatorCredentials: [
            {
              token: "scoped-operator",
              operatorId: "test-operator",
              actions: [
                "read_coordination_inbox",
                "read_mailbox",
                "send_message",
                "update_objective",
              ],
              objectiveIds: [f.objective.id],
            },
            {
              token: "outsider",
              operatorId: "outsider",
              actions: ["*"],
              objectiveIds: ["different-objective"],
            },
          ],
        });
      const post = async (
        command: string,
        input: Record<string, unknown>,
        token = "scoped-operator",
      ) =>
        fetch(`${runtime?.url}/api/v1/coordination/${command}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ objectiveId: f.objective.id, ...input }),
        });
      try {
        runtime = await start();
        await connect();
        const launched = await post("start_objective", { maxCostMinor: 950 }, "test-admin");
        expect(launched.status, await launched.text()).toBe(200);
        await expect
          .poll(
            async () => {
              expect(errors).toEqual([]);
              return (await f.store.getTaskAssignment(`${f.objective.id}:start`))?.status;
            },
            {
              timeout: 15000,
            },
          )
          .toBe("waiting");
        expect(errors).toEqual([]);
        expect((await f.store.getObjective(f.objective.id)).spentMinor).toBe(950);
        await connection?.stop();
        await runtime.close();
        runtime = await start();
        await connect();
        expect(
          (await post("read_mailbox", { recipientObjectiveId: f.objective.id }, "outsider")).status,
        ).toBe(403);
        expect(
          (await post("read_mailbox", { recipientObjectiveId: f.objective.id }, "invalid")).status,
        ).toBe(401);
        const inboxResponse = await fetch(
          `${runtime.url}/api/v1/coordination/inbox?objectiveId=${f.objective.id}&kind=operator_message`,
          { headers: { Authorization: "Bearer scoped-operator" } },
        );
        expect(inboxResponse.status).toBe(200);
        const inbox = await inboxResponse.json();
        expect(inbox.items).toHaveLength(1);
        expect(inbox.items[0].notification.status).toBe("not configured");
        // This operator may read the operator mailbox, so the inbox carries the text too.
        expect(inbox.items[0].message).toMatchObject({
          text: "Need 100 allocation units for the new workload; only 50 remain.",
          truncated: false,
        });
        const read = await post("read_mailbox", {
          recipientObjectiveId: f.objective.id,
          messageId: requestId,
        });
        expect((await read.json()).messages[0].body.message).toContain("only 50 remain");
        const increase = await post("update_objective", {
          expectedRevision: 1,
          budgetLimitMinor: 1050,
        });
        expect(increase.status, await increase.text()).toBe(200);
        expect(
          (await post("update_objective", { expectedRevision: 1, budgetLimitMinor: 1100 })).status,
        ).toBe(409);
        const action = inbox.items[0].permittedActions[0];
        const replyArgs = {
          ...action.arguments,
          body: { message: "Limit increased to 1050; continue the repair." },
          idempotencyKey: "operator-answer",
        };
        const reply = await post(action.tool, replyArgs);
        expect(reply.status, await reply.text()).toBe(200);
        const duplicate = await post(action.tool, replyArgs);
        expect((await duplicate.json()).duplicate).toBe(true);
        await expect
          .poll(async () => (await f.store.getTaskAssignment("repair-after-approval"))?.status, {
            timeout: 15000,
          })
          .toBe("accepted");
        expect(childRuns).toBe(1);
        expect(rootAttempts).toBe(3);
        expect(errors).toEqual([]);
        expect((await f.store.getObjectiveMessage(requestId))?.status).toBe("replied");
        expect(
          (
            await f.store.readCoordinationInbox({
              objectiveId: f.objective.id,
              kind: "operator_message",
            })
          ).items,
        ).toHaveLength(0);
        expect((await f.store.getObjective(f.objective.id)).spentMinor).toBe(1050);
        expect(
          await f.store.listResourceChanges({
            resourceType: "objective",
            resourceId: f.objective.id,
          }),
        ).toMatchObject([
          {
            operatorId: "test-operator",
            changes: { budgetLimitMinor: { previous: 1000, next: 1050 } },
          },
        ]);
      } finally {
        await connection?.stop();
        await runtime?.close();
        await durable.shutdown("Test finished");
        await f.close();
      }
    }, 45000);

    it("shows owner message text and time in the inbox and the overview conversation", async () => {
      const f = await fixture();
      try {
        const team = await f.store.createTeam({
          id: `${f.objective.id}:leadership`,
          objectiveId: f.objective.id,
          name: "Leadership",
          leadTagId: f.owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
        const at = new Date().toISOString();
        const root = await f.store.admitTaskAssignment({
          taskId: `${f.objective.id}:start`,
          objectiveId: f.objective.id,
          teamId: team.id,
          requestedByTagId: f.owner.id,
          assignedTagId: f.owner.id,
          instruction: "Maintain service",
          acceptanceCriteria: ["Safe"],
          execution: {},
          startObjectiveExecution: true,
          contextPlan: emptyTagContextPlan(at),
          workspacePlan: { version: 1, status: "none" },
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: f.owner.id, name: f.owner.name },
            origin: { kind: "internal", objectiveId: f.objective.id, requestedByTagId: f.owner.id },
            requester: { id: f.owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
        const send = (message: string, idempotencyKey: string) =>
          f.store.enqueueObjectiveMessage({
            objectiveId: f.objective.id,
            senderTagId: f.owner.id,
            sourceTaskId: root.taskId,
            type: "message",
            body: { message },
            idempotencyKey,
          });
        const short = await send("Which region should the repair target?", "short");
        const long = await send(`Details: ${"x".repeat(700)}`, "long");
        const controller = new ObjectiveController(f.store, undefined);

        const overview = await controller.readObjectiveOverview({ objectiveId: f.objective.id });
        // Both messages may share a millisecond, so their order is not asserted.
        expect(overview.conversation).toHaveLength(2);
        expect(overview.conversation).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: short.message.id,
              from: "owner",
              text: "Which region should the repair target?",
              status: "pending",
              createdAt: short.message.createdAt,
            }),
            expect.objectContaining({ id: long.message.id, from: "owner", status: "pending" }),
          ]),
        );

        const inbox = await controller.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "operator_message",
        });
        const byMessage = (id: string) =>
          inbox.items.find((item) => item.evidence.some((entry) => entry.id === id));
        expect(byMessage(short.message.id)).toMatchObject({
          message: {
            text: "Which region should the repair target?",
            createdAt: short.message.createdAt,
            truncated: false,
          },
          redaction: { omitted: [] },
        });
        const cut = byMessage(long.message.id);
        expect(cut?.message?.truncated).toBe(true);
        expect(cut?.message?.text).toHaveLength(500);
        expect(cut?.message?.text.endsWith("…")).toBe(true);
        expect(cut?.redaction.omitted).toEqual(["body"]);

        // Principals that could not read the text elsewhere receive metadata only.
        for (const scopes of [
          { actions: ["read_coordination_inbox"], objectiveIds: [f.objective.id] },
          { actions: ["*"], objectiveIds: [f.objective.id], teamIds: [team.id] },
        ]) {
          const limited = await controller.readCoordinationInbox(
            { objectiveId: f.objective.id, kind: "operator_message" },
            { operatorId: "limited", scopes },
          );
          expect(limited.items).toHaveLength(2);
          for (const item of limited.items) {
            expect(item.message).toBeUndefined();
            expect(item.redaction.omitted).toEqual(["body"]);
          }
        }

        // Other body fields stay omitted even when the message text fits.
        const extra = await f.store.enqueueObjectiveMessage({
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: root.taskId,
          type: "message",
          body: { message: "Short", options: ["a", "b"] },
          idempotencyKey: "extra",
        });
        const withExtra = (
          await controller.readCoordinationInbox({
            objectiveId: f.objective.id,
            kind: "operator_message",
          })
        ).items.find((item) => item.evidence.some((entry) => entry.id === extra.message.id));
        expect(withExtra).toMatchObject({
          message: { text: "Short", truncated: false },
          redaction: { omitted: ["body"] },
        });
      } finally {
        await f.close();
      }
    });

    it("keeps the newest owner messages in the overview conversation beyond one page", async () => {
      const f = await fixture();
      try {
        const team = await f.store.createTeam({
          id: `${f.objective.id}:leadership`,
          objectiveId: f.objective.id,
          name: "Leadership",
          leadTagId: f.owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
        const at = new Date().toISOString();
        const root = await f.store.admitTaskAssignment({
          taskId: `${f.objective.id}:start`,
          objectiveId: f.objective.id,
          teamId: team.id,
          requestedByTagId: f.owner.id,
          assignedTagId: f.owner.id,
          instruction: "Maintain service",
          acceptanceCriteria: ["Safe"],
          execution: {},
          startObjectiveExecution: true,
          contextPlan: emptyTagContextPlan(at),
          workspacePlan: { version: 1, status: "none" },
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: f.owner.id, name: f.owner.name },
            origin: { kind: "internal", objectiveId: f.objective.id, requestedByTagId: f.owner.id },
            requester: { id: f.owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
        // 198 messages span two store pages. Answer the first 99 so neither the operator mailbox
        // nor the owner's Mailbox reaches its outstanding limit of 100.
        for (let index = 0; index < 198; index += 1) {
          const { message } = await f.store.enqueueObjectiveMessage({
            objectiveId: f.objective.id,
            senderTagId: f.owner.id,
            sourceTaskId: root.taskId,
            type: "message",
            body: { message: `Message ${index}` },
            idempotencyKey: `bulk-${index}`,
          });
          if (index < 99)
            await f.store.replyToObjectiveMessage({
              messageId: message.id,
              objectiveId: f.objective.id,
              recipientTagId: f.owner.id,
              body: { message: `Reply ${index}` },
              idempotencyKey: `bulk-reply-${index}`,
              operatorId: "test-operator",
            });
        }
        // Every message, oldest first, through the store's forward cursor.
        const all: string[] = [];
        let after: { createdAt: string; id: string } | undefined;
        for (;;) {
          const page = await f.store.listObjectiveMessages({
            objectiveId: f.objective.id,
            limit: 100,
            ...(after === undefined ? {} : { after }),
          });
          all.push(...page.map((message) => message.id));
          const last = page.at(-1);
          if (page.length < 100 || !last) break;
          after = { createdAt: last.createdAt, id: last.id };
        }
        expect(all).toHaveLength(198);

        // Newest first reverses the order and continues to older messages from its cursor.
        const newest = await f.store.listObjectiveMessages({
          objectiveId: f.objective.id,
          limit: 100,
          newestFirst: true,
        });
        const last = newest.at(-1);
        const older = await f.store.listObjectiveMessages({
          objectiveId: f.objective.id,
          limit: 100,
          newestFirst: true,
          ...(last === undefined ? {} : { after: { createdAt: last.createdAt, id: last.id } }),
        });
        expect([...newest, ...older].map((message) => message.id)).toEqual(
          all.toReversed().slice(0, 200),
        );

        const overview = await new ObjectiveController(f.store, undefined).readObjectiveOverview({
          objectiveId: f.objective.id,
        });
        const fromOwner = overview.conversation
          .filter((message) => message.from === "owner")
          .map((message) => message.id);
        expect(fromOwner.length).toBeGreaterThan(0);
        expect(fromOwner).toEqual(all.slice(-fromOwner.length));
      } finally {
        await f.close();
      }
    }, 45000);

    it("bounds and fences generic correspondence without deriving authority from reply prose", async () => {
      const f = await fixture();
      const other = new DrizzleStore({ url: f.url });
      await other.connect();
      try {
        const team = await f.store.createTeam({
          id: `${f.objective.id}:leadership`,
          objectiveId: f.objective.id,
          name: "Leadership",
          leadTagId: f.owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
        });
        const at = new Date().toISOString();
        const root = await f.store.admitTaskAssignment({
          taskId: `${f.objective.id}:start`,
          objectiveId: f.objective.id,
          teamId: team.id,
          requestedByTagId: f.owner.id,
          assignedTagId: f.owner.id,
          instruction: "Maintain service",
          acceptanceCriteria: ["Safe"],
          execution: {},
          startObjectiveExecution: true,
          contextPlan: emptyTagContextPlan(at),
          workspacePlan: { version: 1, status: "none" },
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: f.owner.id, name: f.owner.name },
            origin: { kind: "internal", objectiveId: f.objective.id, requestedByTagId: f.owner.id },
            requester: { id: f.owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
        });
        const input = {
          objectiveId: f.objective.id,
          senderTagId: f.owner.id,
          sourceTaskId: root.taskId,
          type: "message" as const,
          body: { message: "Please clarify scope", detail: "private" },
          idempotencyKey: "scope",
        };
        const request = await f.store.enqueueObjectiveMessage(input);
        await expect(
          other.enqueueObjectiveMessage({ ...input, body: { message: "Different" } }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const outsider = await f.store.createTag({ name: randomUUID() });
        await expect(
          f.store.enqueueObjectiveMessage({ ...input, senderTagId: outsider.id }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const controller = new ObjectiveController(f.store, undefined);
        await expect(
          controller.commandAsAdministrator(
            "send_message",
            {
              objectiveId: f.objective.id,
              recipientTagId: f.owner.id,
              type: "message",
              inReplyTo: request.message.id,
              body: { message: "approved" },
              idempotencyKey: "forged",
            },
            {
              operatorId: "limited",
              scopes: { actions: ["read_mailbox"], objectiveIds: [f.objective.id] },
            },
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        const replies = await Promise.allSettled(
          [f.store, other].map((store, index) =>
            store.replyToObjectiveMessage({
              messageId: request.message.id,
              objectiveId: f.objective.id,
              recipientTagId: f.owner.id,
              body: { message: index ? "declined" : "approved for unlimited spending" },
              idempotencyKey: `reply-${index}`,
              operatorId: `operator-${index}`,
            }),
          ),
        );
        expect(replies.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        expect((await f.store.getObjective(f.objective.id)).budgetLimitMinor).toBe(1000);
        const delivered = (await f.store.listTagMessages(f.owner.id))[0];
        if (!delivered) throw new Error("Missing reply");
        expect(decodeMessage(encodeMessage(delivered)).operatorId).toBe(delivered.operatorId);
        expect(
          await new ObjectiveMessages(f.store).mayDeliver({
            deliveryKey: `operator-message:${request.message.id}`,
            inboundEventId: "none",
          }),
        ).toBe(false);
        for (let n = 0; n < 3; n++)
          await f.store.enqueueObjectiveMessage({ ...input, idempotencyKey: `pending-${n}` });
        const another = await f.store.enqueueObjectiveMessage({
          ...input,
          idempotencyKey: "prose-is-not-approval",
        });
        await f.store.replyToObjectiveMessage({
          messageId: another.message.id,
          objectiveId: f.objective.id,
          recipientTagId: f.owner.id,
          body: { message: "Approved for unlimited spending" },
          idempotencyKey: "prose-only-reply",
          operatorId: "operator",
        });
        expect((await f.store.getObjective(f.objective.id)).budgetLimitMinor).toBe(1000);
        for (let n = 3; n < 100; n++)
          await f.store.enqueueObjectiveMessage({ ...input, idempotencyKey: `pending-${n}` });
        await expect(
          f.store.enqueueObjectiveMessage({ ...input, idempotencyKey: "over-capacity" }),
        ).rejects.toMatchObject({ statusCode: 429 });
        const first = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "operator_message",
          limit: 1,
        });
        const second = await f.store.readCoordinationInbox({ cursor: first.nextCursor, limit: 1 });
        expect(first.items[0]?.key).not.toBe(second.items[0]?.key);
        for (let n = 0; n < 2; n++) {
          const now = new Date().toISOString();
          const delivery = await f.store.claimTagMessage({
            tagId: f.owner.id,
            credentialId: "test-manager",
            now,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
          if (!delivery) throw new Error("Missing earlier operator reply");
          expect(
            await f.store.settleTagMessage({
              tagId: f.owner.id,
              credentialId: "test-manager",
              messageId: delivery.message.id,
              leaseToken: delivery.leaseToken,
              now,
              status: "processed",
            }),
          ).toBe(true);
        }
        await f.store.cancelObjective(
          f.objective.id,
          { reason: "Operator ended responsibility" },
          { operatorId: "operator" },
        );
        // Cancellation clears the inbox while preserving question history and linked replies.
        expect(
          await f.store.listObjectiveMessages({ objectiveId: f.objective.id, pendingOnly: true }),
        ).toHaveLength(0);
        const resolved = (
          await f.store.listObjectiveMessages({ objectiveId: f.objective.id })
        ).find((message) => message.status === "resolved");
        if (!resolved) throw new Error("Missing resolved message");
        expect(resolved.resolutionReason).toBe("Objective cancelled");
        await f.store.replyToObjectiveMessage({
          messageId: resolved.id,
          objectiveId: f.objective.id,
          recipientTagId: f.owner.id,
          body: { message: "Acknowledged; responsibility ended" },
          idempotencyKey: "closed-reply",
          operatorId: "operator",
        });
        expect((await f.store.getObjectiveMessage(resolved.id))?.status).toBe("replied");
        expect(await f.store.admitMailboxTaskAssignments()).toHaveLength(0);
        expect((await f.store.getObjective(f.objective.id)).status).toBe("cancelled");
        await expect(
          f.store.enqueueObjectiveMessage({ ...input, idempotencyKey: "closed-send" }),
        ).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await other.disconnect();
        await f.close();
      }
    }, 30000);
  });
