import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CoordinationInboxItem,
  Store,
  SurfaceTagAuthorizationSnapshot,
  Task,
} from "@supertag/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredOperatorChannel,
  type NotificationDestination,
  OPERATOR_CHANNEL_WINDOW_MS,
  OperatorChannelNotifications,
  objectiveThreadCarries,
  parseNotificationDestination,
  parseOperatorChannel,
} from "../packages/control-plane/src/index.js";
import { coordinationInboxOccurrence, objectiveSessionKey } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const CHANNEL = parseOperatorChannel("slack:C0OPS");

describe("operator channel configuration", () => {
  it("accepts a Slack channel or user, optionally in a named workspace", () => {
    expect(parseOperatorChannel("slack:C0123ABC")).toEqual({
      key: "slack:C0123ABC",
      provider: "slack",
      target: "C0123ABC",
    });
    expect(parseOperatorChannel(" slack:T0WORK/U0PERSON ")).toEqual({
      key: "slack:T0WORK/U0PERSON",
      provider: "slack",
      workspaceId: "T0WORK",
      target: "U0PERSON",
    });
    for (const invalid of ["C0123", "slack:#ops", "slack:x0123", "lark:C0123", "slack:"])
      expect(() => parseOperatorChannel(invalid)).toThrow(/SUPERTAG_OPERATOR_CHANNEL/u);
  });

  it("resolves no destination when unconfigured", async () => {
    const item = { kind: "question" } as CoordinationInboxItem;
    expect(
      await configuredOperatorChannel(undefined).resolveNotificationDestinations(item),
    ).toEqual([]);
    expect(await configuredOperatorChannel(CHANNEL).resolveNotificationDestinations(item)).toEqual([
      CHANNEL,
    ]);
  });

  it("parses desktop and hashes webhook URLs before storing destination keys", () => {
    expect(parseNotificationDestination("desktop")).toMatchObject({
      provider: "desktop",
      key: "desktop",
    });
    const webhook = parseNotificationDestination("webhook:https://hooks.example/x?secret=y#hook");
    expect(webhook).toMatchObject({ provider: "webhook", secretName: "hook" });
    expect(webhook.key).toMatch(/^webhook:[a-f0-9]{64}$/u);
    expect(webhook.key).not.toContain("hooks.example");
    expect(() => parseNotificationDestination("webhook:http://hooks.example/x")).toThrow(/HTTPS/u);
  });

  it("treats items as carried only by an Objective's own verified thread", async () => {
    const item = (kind: CoordinationInboxItem["kind"], status?: "failed" | "delivered") =>
      ({
        kind,
        objectiveId: "objective-a",
        ...(status ? { notification: { status } } : {}),
      }) as CoordinationInboxItem;
    const store = (options: { notificationTaskId?: string; origin?: string; verified?: boolean }) =>
      ({
        getObjective: async () => ({
          id: "objective-a",
          ...(options.notificationTaskId ? { notificationTaskId: options.notificationTaskId } : {}),
          ...(options.origin ? { surfaceTaskId: options.origin } : {}),
        }),
        getVerifiedSurfaceTask: async (id: string) =>
          options.verified === false ? undefined : { id, inboundEventId: `event-${id}` },
      }) as unknown as Pick<Store, "getObjective" | "getVerifiedSurfaceTask">;
    const slackObjective = store({ origin: "surface-task" });
    // An Objective's own turns ask, and post their approval and limit notices, in its home thread.
    for (const kind of ["question", "approval", "objective_budget", "objective_limit"] as const)
      expect(await objectiveThreadCarries(slackObjective, item(kind)), kind).toBe(true);
    // Attention items never reach the thread; a failed thread delivery falls back.
    expect(await objectiveThreadCarries(slackObjective, item("task_attention"))).toBe(false);
    expect(await objectiveThreadCarries(slackObjective, item("mcp_login"))).toBe(false);
    expect(await objectiveThreadCarries(slackObjective, item("objective_budget", "failed"))).toBe(
      false,
    );
    // A CLI Objective has no thread of its own.
    expect(await objectiveThreadCarries(store({}), item("question"))).toBe(false);
    // The operator's chosen notification thread is a home thread too.
    expect(
      await objectiveThreadCarries(store({ notificationTaskId: "chosen" }), item("question")),
    ).toBe(true);
    expect(
      await objectiveThreadCarries(
        store({ origin: "surface-task", verified: false }),
        item("question"),
      ),
    ).toBe(false);
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} operator channel`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-operator-channel-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      const opened: DrizzleStore[] = [store];
      cleanups.push(async () => {
        for (const each of opened) await each.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      await store.bindTagWorkerHost(owner.id, "fixture-host");
      const team = await store.createTeam({
        id: `team-${randomUUID().slice(0, 8)}`,
        name: `Export ${randomUUID().slice(0, 8)}`,
        memberTagIds: [owner.id],
        maxConcurrency: 2,
      });
      const objective = await store.createObjective({
        id: `objective-${randomUUID().slice(0, 8)}`,
        ownerTagId: owner.id,
        outcome: "Ship the export",
        teamId: team.id,
      });
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: `T-${randomUUID().slice(0, 8)}`,
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      });
      const route = await store.addTagRoute({
        tagId: owner.id,
        surfaceAccountId: account.id,
        scope: "channel:export",
      });
      const sessionKey = objectiveSessionKey(objective.id);
      const session = await store.openSession({
        tagId: owner.id,
        sessionKey,
        origin: {},
        at: new Date().toISOString(),
        objectiveId: objective.id,
      });
      /** One turn of the Objective's own Session. */
      const ownerTask = async (): Promise<Task> => {
        const at = new Date().toISOString();
        const authorization: SurfaceTagAuthorizationSnapshot = {
          version: 5,
          capturedAt: at,
          tag: { id: owner.id, name: owner.name },
          origin: {
            provider: "slack",
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            scope: "channel:export",
          },
          requester: { id: "human", kind: "user" },
          roles: [],
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        };
        const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
        const id = randomUUID();
        const event = {
          eventId: id,
          logicalEventId: id,
          provider: "slack",
          externalAccountId: account.externalAccountId,
          kind: "message",
          scope: "channel:export",
          sessionKey,
          actor: { id: "human", kind: "user" },
          text: "Work on it",
          occurredAt: at,
          callback: {
            provider: "slack",
            mode: "slack_thread",
            threadKey: sessionKey,
            target: { channelId: "export", threadTs: sessionKey },
          },
          source: {},
          metadata: {},
        } as const;
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: owner.id,
          authorization,
          contextPlan,
          event,
        });
        return store.openTask({
          inboundEventId: admitted.work.id,
          tagId: owner.id,
          sessionId: session.id,
          execution: {},
          actor: event.actor,
          trigger: {},
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan,
          createdAt: at,
        });
      };
      const running = await ownerTask();

      let clock = Date.now();
      const sent: { destination: NotificationDestination; text: string }[] = [];
      const send = vi.fn(async (destination: NotificationDestination, text: string) => {
        sent.push({ destination, text });
        return { externalMessageId: `ts-${sent.length}` };
      });
      const channel = (
        options: {
          store?: DrizzleStore;
          carriedElsewhere?: (item: CoordinationInboxItem) => Promise<boolean>;
          resolver?: ReturnType<typeof configuredOperatorChannel>;
          sender?: typeof send;
          maxAttempts?: number;
          destinationFromKey?: (key: string) => NotificationDestination;
        } = {},
      ) => {
        const target = options.store ?? store;
        return new OperatorChannelNotifications({
          store: target,
          resolver: options.resolver ?? configuredOperatorChannel(CHANNEL),
          send: options.sender ?? send,
          ...(options.destinationFromKey ? { destinationFromKey: options.destinationFromKey } : {}),
          readInbox: (input) => target.readCoordinationInbox(input),
          ...(options.carriedElsewhere ? { carriedElsewhere: options.carriedElsewhere } : {}),
          leaseOwner: `instance-${randomUUID()}`,
          now: () => new Date(clock),
          retryBaseMs: 1_000,
          ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        });
      };
      /**
       * A Task of the Objective that needs an operator: its Workspace could not be trusted, so
       * it failed without replay. Each call adds one more inbox item.
       */
      const attention = async (summary: string) => {
        const task = await ownerTask();
        return store.closeTask({
          taskId: task.id,
          status: "failed",
          endedAt: new Date().toISOString(),
          // The source a Worker reports with a failed Attempt settles onto the Task's outcome.
          outcome: { error: summary, failureKind: "workspace-integrity" },
          result: {
            summary,
            decisions: [],
            changes: [],
            unresolved: [],
            references: [],
            artifacts: [],
            findings: [],
          },
        });
      };
      const approval = () =>
        store.createApprovalRequest({
          objectiveId: objective.id,
          taskId: running.id,
          attemptId: "attempt-1",
          requestingTagId: owner.id,
          kind: "surface-action",
          actions: [
            {
              target: "surface",
              action: "pull_request.merge",
              surfaceAccountId: "github-account",
              scope: "acme/app",
            },
          ],
          summary: "Merge pull request 42",
          ruleSources: ["release"],
          approvers: [],
        });
      const reopen = async () => {
        const next = new DrizzleStore({ url });
        await next.connect();
        opened.push(next);
        return next;
      };
      return {
        store,
        owner,
        objective,
        sent,
        send,
        channel,
        attention,
        approval,
        reopen,
        advance: (ms: number) => {
          clock += ms;
        },
      };
    }

    it("sends at most one message per Objective per window, then summarizes what waited", async () => {
      const f = await fixture();
      const notifications = f.channel();
      await f.attention("first");
      expect(await notifications.reconcile()).toBe(1);
      expect(await notifications.deliverNext()).toBe(true);
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]?.destination).toEqual(CHANNEL);
      expect(f.sent[0]?.text).toMatch(
        new RegExp(
          `^Objective ${f.objective.id} needs you: Task [^ ]+ needs attention\\n\`supertag describe objective ${f.objective.id}\`$`,
          "u",
        ),
      );
      expect(JSON.stringify(f.sent)).not.toContain("first");

      // New items inside the window wait; a second sweep never repeats the first item.
      await f.attention("second");
      await f.attention("third");
      expect(await notifications.reconcile()).toBe(0);
      f.advance(OPERATOR_CHANNEL_WINDOW_MS - 1_000);
      expect(await notifications.reconcile()).toBe(0);
      expect(await notifications.deliverNext()).toBe(false);

      f.advance(2_000);
      expect(await notifications.reconcile()).toBe(1);
      expect(await notifications.deliverNext()).toBe(true);
      expect(f.sent).toHaveLength(2);
      const summary = f.sent[1]?.text ?? "";
      expect(summary).toContain(`Objective ${f.objective.id} has 2 more items that need you:`);
      expect(summary).toContain("needs attention");
      expect(summary.split("\n").at(-1)).toBe(
        `\`supertag list inbox --objective ${f.objective.id}\``,
      );
      expect(await notifications.reconcile()).toBe(0);
    });

    it("sends an approval that running work waits on immediately", async () => {
      const f = await fixture();
      const notifications = f.channel();
      await f.attention("first");
      await notifications.reconcile();
      await notifications.deliverNext();
      const request = await f.approval();
      // Inside the window, yet delivered now, with the command to act last.
      expect(await notifications.reconcile()).toBe(1);
      expect(await notifications.deliverNext()).toBe(true);
      expect(f.sent[1]?.text).toBe(
        `Objective ${f.objective.id} needs you: Approval ${request.id} (work is waiting): Merge pull request 42 (requested by Tag ${f.owner.name})\n\`supertag describe objective ${f.objective.id}\``,
      );
    });

    it("does not repeat items the Objective's own thread carries", async () => {
      const f = await fixture();
      const carriedElsewhere = vi.fn(
        async (item: CoordinationInboxItem) => item.kind === "task_attention",
      );
      const notifications = f.channel({ carriedElsewhere });
      await f.attention("thread");
      expect(await notifications.reconcile()).toBe(0);
      expect(carriedElsewhere).toHaveBeenCalled();
      await f.approval();
      expect(await notifications.reconcile()).toBe(1);
      await notifications.deliverNext();
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]?.text).toContain("Approval ");
    });

    it("survives a restart without resending and delivers what was left", async () => {
      const f = await fixture();
      await f.attention("before-restart");
      expect(await f.channel().reconcile()).toBe(1);
      // The process stops before delivering. A new instance on a new connection resumes.
      const reopened = await f.reopen();
      const restarted = f.channel({ store: reopened });
      expect(await restarted.reconcile()).toBe(0);
      expect(await restarted.deliverNext()).toBe(true);
      expect(await restarted.deliverNext()).toBe(false);
      expect(f.sent).toHaveLength(1);

      // A delivery interrupted mid-send is retried after its lease expires, not lost.
      f.advance(OPERATOR_CHANNEL_WINDOW_MS + 1_000);
      await f.attention("interrupted");
      await restarted.reconcile();
      const hung = vi.fn(() => new Promise<never>(() => {}));
      void f.channel({ store: reopened, sender: hung }).deliverNext();
      await vi.waitFor(() => expect(hung).toHaveBeenCalled());
      const after = f.channel({ store: await f.reopen() });
      expect(await after.deliverNext()).toBe(false);
      f.advance(61_000);
      expect(await after.deliverNext()).toBe(true);
      expect(f.sent).toHaveLength(2);
      expect(await after.reconcile()).toBe(0);
    });

    it("retries failed deliveries with backoff and stops after the last attempt", async () => {
      const f = await fixture();
      let failures = 1;
      const flaky = vi.fn(async (destination: NotificationDestination, text: string) => {
        if (failures-- > 0) throw new Error("slack unavailable");
        return f.send(destination, text);
      });
      const notifications = f.channel({ sender: flaky });
      await f.attention("retry");
      await notifications.reconcile();
      expect(await notifications.deliverNext()).toBe(true);
      expect(f.sent).toHaveLength(0);
      const pending = await f.store.latestOperatorNotification(CHANNEL.key, f.objective.id);
      expect(pending).toMatchObject({
        status: "pending",
        attemptCount: 1,
        lastError: "slack unavailable",
      });
      expect(await notifications.deliverNext()).toBe(false);
      f.advance(1_000);
      expect(await notifications.deliverNext()).toBe(true);
      expect(f.sent).toHaveLength(1);
      expect(await f.store.latestOperatorNotification(CHANNEL.key, f.objective.id)).toMatchObject({
        status: "delivered",
        attemptCount: 2,
        externalMessageId: "ts-1",
      });

      // Exhausted attempts leave the message failed; its items are not recorded again.
      const broken = f.channel({
        sender: vi.fn(async () => {
          throw new Error("channel_not_found");
        }),
        maxAttempts: 2,
      });
      f.advance(OPERATOR_CHANNEL_WINDOW_MS + 1_000);
      await f.attention("broken");
      expect(await broken.reconcile()).toBe(1);
      expect(await broken.deliverNext()).toBe(true);
      f.advance(1_000);
      expect(await broken.deliverNext()).toBe(true);
      f.advance(60_000);
      expect(await broken.deliverNext()).toBe(false);
      expect(await f.store.latestOperatorNotification(CHANNEL.key, f.objective.id)).toMatchObject({
        status: "failed",
        attemptCount: 2,
        lastError: "channel_not_found",
      });
      expect(await broken.reconcile()).toBe(0);
    });

    it("records per-item status for each configured destination without leaking webhook URLs", async () => {
      const f = await fixture();
      const webhook = parseNotificationDestination("webhook:https://hooks.example/x?token=private");
      const notifications = f.channel({
        resolver: configuredOperatorChannel([CHANNEL, webhook]),
        destinationFromKey: (key) => (key === webhook.key ? webhook : parseOperatorChannel(key)),
        sender: vi.fn(async (destination) => {
          if (destination.provider === "webhook")
            throw new Error("failed at https://hooks.example/x?token=private");
          return undefined;
        }),
      });
      await f.attention("status");
      expect(await notifications.reconcile()).toBe(2);
      expect(await notifications.deliverNext()).toBe(true);
      expect(await notifications.deliverNext()).toBe(true);
      const page = await f.store.readCoordinationInbox();
      const item = page.items.find((entry) => entry.kind === "task_attention");
      expect(item).toBeDefined();
      const occurrence = item === undefined ? "" : coordinationInboxOccurrence(item);
      const records = await f.store.listOperatorNotificationsForItems([occurrence]);
      expect(records.get(occurrence)).toHaveLength(2);
      expect(
        records
          .get(occurrence)
          ?.map((record) => record.status)
          .sort(),
      ).toEqual(["delivered", "pending"]);
      expect(
        JSON.stringify(records.get(occurrence)?.map((record) => record.lastError)),
      ).not.toContain("hooks.example");
    });

    it("retries an unavailable desktop notifier three times", async () => {
      const f = await fixture();
      const desktop = parseNotificationDestination("desktop");
      const notifications = f.channel({
        resolver: configuredOperatorChannel(desktop),
        sender: vi.fn(async () => {
          throw new Error("Desktop notification unavailable");
        }),
      });
      await f.attention("desktop-unavailable");
      await notifications.reconcile();
      expect(await notifications.deliverNext()).toBe(true);
      f.advance(1_000);
      expect(await notifications.deliverNext()).toBe(true);
      f.advance(2_000);
      expect(await notifications.deliverNext()).toBe(true);
      expect(await f.store.latestOperatorNotification("desktop", "*")).toMatchObject({
        status: "failed",
        attemptCount: 3,
        maxAttempts: 3,
        lastError: "Desktop notification unavailable",
      });
    });

    it("coalesces desktop items across Objectives into one host notification", async () => {
      const f = await fixture();
      await f.attention("seed");
      const page = await f.store.readCoordinationInbox();
      const original = page.items.find((item) => item.kind === "task_attention");
      expect(original).toBeDefined();
      const items = [
        { ...original, key: "task_attention:first", objectiveId: "first" },
        { ...original, key: "task_attention:second", objectiveId: "second" },
      ] as CoordinationInboxItem[];
      const desktop = parseNotificationDestination("desktop");
      const sent = vi.fn(async (_destination: NotificationDestination, _text: string) => undefined);
      const notifications = new OperatorChannelNotifications({
        store: f.store,
        resolver: configuredOperatorChannel(desktop),
        send: sent,
        readInbox: async () => ({ ...page, items }),
        leaseOwner: `instance-${randomUUID()}`,
      });
      expect(await notifications.reconcile()).toBe(1);
      expect(await notifications.deliverNext()).toBe(true);
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls[0]?.[1]).toContain("2 new items across 2 Objectives");
    });

    it("does nothing when no destination is configured", async () => {
      const f = await fixture();
      const notifications = f.channel({ resolver: configuredOperatorChannel(undefined) });
      await f.attention("unconfigured");
      await f.approval();
      expect(await notifications.reconcile()).toBe(0);
      expect(await notifications.deliverNext()).toBe(false);
      expect(f.send).not.toHaveBeenCalled();
    });

    it("drops an item resolved after it enters the outbox and before delivery", async () => {
      const f = await fixture();
      await f.attention("resolved");
      const notifications = f.channel();
      expect(await notifications.reconcile()).toBe(1);
      // Closing the Objective settles everything that waited on it.
      await f.store.cancelObjective(
        f.objective.id,
        { reason: "Superseded" },
        { operatorId: "operator" },
      );
      expect(await notifications.deliverNext()).toBe(true);
      expect(f.sent).toHaveLength(0);
    });

    it("checks only the queued notification's Objective at delivery", async () => {
      const f = await fixture();
      await f.attention("scoped-delivery");
      const notifications = f.channel();
      await notifications.reconcile();
      const read = vi.spyOn(f.store, "readCoordinationInbox");
      expect(await notifications.deliverNext()).toBe(true);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.every(([input]) => input?.objectiveId === f.objective.id)).toBe(true);
    });

    it("records each item occurrence once when two instances race", async () => {
      const f = await fixture();
      await f.attention("race");
      const results = await Promise.all([f.channel().reconcile(), f.channel().reconcile()]);
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    });
  });
}
