import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuditTrail } from "../apps/cli/src/audit-trail.js";
import {
  ControlPlane,
  type ControlPlaneDependencies,
} from "../packages/control-plane/src/index.js";
import type { InboundSurfaceEvent } from "../packages/core/src/index.js";
import { parseSurfaceObjectiveCommand } from "../packages/core/src/index.js";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const thread = (ts: string) => ({
  sessionKey: `slack:T-THREAD:C1:${ts}`,
  callback: {
    provider: "slack" as const,
    mode: "slack_thread" as const,
    threadKey: `T-THREAD|C1|${ts}`,
    target: { channelId: "C1", threadTs: ts },
  },
});
let sequence = 0;
const event = (text: string, overrides: Partial<InboundSurfaceEvent> = {}): InboundSurfaceEvent => {
  sequence++;
  return {
    eventId: `event-${sequence}`,
    logicalEventId: `event-${sequence}`,
    provider: "slack",
    externalAccountId: "T-THREAD",
    kind: "mention",
    scope: "channel:C1",
    actor: { id: "U1", kind: "user" },
    text,
    occurredAt: new Date().toISOString(),
    source: {},
    metadata: {},
    ...thread("1.000"),
    ...overrides,
  };
};

it("parses @SuperTag approve only as the whole command", () => {
  expect(parseSurfaceObjectiveCommand(event("@SuperTag approve"))).toEqual({ kind: "approve" });
  expect(parseSurfaceObjectiveCommand(event("<@U123> Approve."))).toEqual({ kind: "approve" });
  expect(parseSurfaceObjectiveCommand(event("@SuperTag approve the pull request"))).toBeUndefined();
  expect(
    parseSurfaceObjectiveCommand(event("@SuperTag approve", { kind: "message" })),
  ).toBeUndefined();
});

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/** A Tag in a Slack channel whose first verified thread is the Objective's notification thread. */
async function threadFixture(
  dialect: "sqlite" | "postgresql",
  options: {
    readonly audit?: ControlPlaneDependencies["audit"];
    readonly onDispatchError?: (error: unknown) => void;
    readonly prepare?: (store: DrizzleStore) => void;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-thread-routing-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const isolated =
    dialect === "postgresql" ? await createIsolatedPostgresDatabase(postgres as string) : undefined;
  if (isolated) cleanups.push(() => isolated.cleanup());
  const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  cleanups.push(() => store.disconnect());
  options.prepare?.(store);
  const replies: Array<{ threadKey: string; kind?: string; markdown: string }> = [];
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: durableTestWorklet(
      new LocalWorklet("thread-worklet", "thread-host", [
        new StaticWorker({ id: "thread-worker", profile: { id: "default", revision: "1" } }),
      ]),
    ),
    reply: async (route: InboundSurfaceEvent, reply: { kind?: string; markdown: string }) => {
      replies.push({
        threadKey: route.callback.threadKey,
        ...(reply.kind === undefined ? {} : { kind: reply.kind }),
        markdown: reply.markdown,
      });
      return { externalMessageId: `reply-${replies.length}` };
    },
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    dispatch: {
      pollIntervalMs: 10,
      leaseDurationMs: 10000,
      retryBaseMs: 10,
      maxAttempts: 1,
      ...(options.onDispatchError === undefined
        ? {}
        : { onDispatchError: options.onDispatchError }),
    },
  });
  await controlPlane.start();
  cleanups.push(() => controlPlane.stop());
  const account = await controlPlane.setupSurfaceAccount({
    provider: "slack",
    externalAccountId: "T-THREAD",
    displayName: "Thread",
    authMethod: "slack-socket-mode",
    configuration: { transport: "socket" },
    secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
  });
  const tag = await store.createTag({ name: "Planner" });
  await store.bindTagWorkerHost(tag.id, "thread-host");
  await store.addTagRoute({
    tagId: tag.id,
    surfaceAccountId: account.id,
    scope: "channel:C1",
  });

  // A person talks to the Tag; that verified thread becomes the Objective's notification thread.
  const opened = await controlPlane.ingestSurfaceEvent(event("@SuperTag hello"));
  expect(opened.status).toBe("accepted");
  const objective = await store.createObjective({
    id: "launch-notes",
    ownerTagId: tag.id,
    outcome: "Write the launch notes. A person reviews them.",
    notificationTaskId: opened.taskId as string,
  });
  return { store, controlPlane, replies, tag, objective };
}

/** The last status answer SuperTag posted in the thread; the owner's own replies are skipped. */
const lastStatus = (replies: ReadonlyArray<{ kind?: string; markdown: string }>) =>
  replies.filter((reply) => reply.kind === "status").at(-1);

/** The Objective's own Session turns, oldest first, with the turn each Task was admitted for. */
async function ownerTurns(store: DrizzleStore, objectiveId: string) {
  const session = await store.findObjectiveOwnerSession(objectiveId);
  if (!session) return [];
  const tasks = (await store.listTasks({ sessionId: session.id })).toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return Promise.all(
    tasks.map(async (task) => ({
      task,
      event:
        task.inboundEventId === null
          ? undefined
          : await store.findInboundEventById(task.inboundEventId),
    })),
  );
}

/** Sets the status, re-reading the revision when the sweep changed it underneath. */
async function setStatus(
  store: DrizzleStore,
  objectiveId: string,
  input: { readonly status: "ready_for_review"; readonly completionSummary: string },
  actorTagId: string,
) {
  for (let attempt = 0; ; attempt += 1) {
    const current = await store.getObjective(objectiveId);
    try {
      return await store.updateObjectiveStatus(
        objectiveId,
        { ...input, expectedRevision: current.revision },
        actorTagId,
      );
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}

for (const dialect of ["sqlite", "postgresql"] as const)
  it.skipIf(dialect === "postgresql" && !postgres)(
    `routes replies in an Objective's home thread to its own Session and approves from it (${dialect})`,
    async () => {
      const { store, controlPlane, replies, tag, objective } = await threadFixture(dialect);

      const message = event("Please mention the pricing change.", {
        kind: "message",
        actor: { id: "U2", kind: "user" },
      });
      const reply = await controlPlane.ingestSurfaceEvent(message);
      expect(reply).toMatchObject({ status: "accepted", objectiveId: objective.id });
      expect(reply.taskId).toBeUndefined();
      // The message is a turn of the Objective's own Session, in its home thread.
      const [turn, ...rest] = await ownerTurns(store, objective.id);
      expect(rest).toHaveLength(0);
      expect(turn?.event?.event.text).toBe("Please mention the pricing change.");
      expect(turn?.event?.event.callback.threadKey).toBe("T-THREAD|C1|1.000");
      expect(turn?.event?.event.internal).toMatchObject({
        kind: "delivery",
        reason: "objective_message",
        objectiveId: objective.id,
        from: { kind: "person", id: "slack:U2" },
      });
      expect(lastStatus(replies)).toEqual({
        threadKey: "T-THREAD|C1|1.000",
        kind: "status",
        markdown: "Sent to the Objective.",
      });

      // The same surface event again is a duplicate, not a second turn.
      const repeated = await controlPlane.ingestSurfaceEvent(message);
      expect(repeated).toMatchObject({ status: "accepted", objectiveId: objective.id });
      expect(lastStatus(replies)?.markdown).toBe(
        "This message was already delivered to the Objective.",
      );
      expect(await ownerTurns(store, objective.id)).toHaveLength(1);

      // Approval works only once the owner submitted the Objective for review.
      await controlPlane.ingestSurfaceEvent(event("@SuperTag approve"));
      expect(lastStatus(replies)?.markdown).toContain("not ready_for_review");
      await setStatus(
        store,
        objective.id,
        { status: "ready_for_review", completionSummary: "Notes drafted with pricing." },
        tag.id,
      );
      const approved = await controlPlane.ingestSurfaceEvent(event("@SuperTag approve"));
      expect(approved).toMatchObject({ status: "accepted", objectiveId: objective.id });
      expect(lastStatus(replies)?.markdown).toBe("Approved. Objective launch-notes is completed.");
      expect(await store.getObjective(objective.id)).toMatchObject({
        status: "completed",
        completionSummary: "Notes drafted with pricing.",
      });
      // A completed Objective no longer owns its home thread: replies there are ordinary turns.
      const after = await controlPlane.ingestSurfaceEvent(
        event("One more thing", {
          kind: "message",
        }),
      );
      expect(after.status).toBe("accepted");
      expect(after.objectiveId).toBeUndefined();
      expect(after.taskId).toBeDefined();
      expect((await store.getObjective(objective.id)).status).toBe("completed");

      // Other threads keep their ordinary handling.
      const elsewhere = await controlPlane.ingestSurfaceEvent(
        event("@SuperTag approve", thread("2.000")),
      );
      expect(elsewhere.status).toBe("accepted");
      expect(elsewhere.objectiveId).toBeUndefined();
      expect(elsewhere.taskId).toBeDefined();
      expect(
        (
          await controlPlane.ingestSurfaceEvent(
            event("plain reply", { kind: "message", ...thread("3.000") }),
          )
        ).status,
      ).toBe("ignored");

      // Each operator decision from the thread is in the audit trail, attributed to the person.
      // Entries within one millisecond have no defined order, so compare them as a set.
      const audit = await store.listAuditEntries();
      for (const entry of audit) expect(Date.parse(entry.at)).not.toBeNaN();
      expect(
        audit.map(({ actor, action, target, outcome, status, source }) => ({
          actor,
          action,
          target,
          outcome,
          status,
          source,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            actor: "slack:U2",
            action: "objective.message",
            target: "Objective/launch-notes",
            outcome: "succeeded",
            status: undefined,
            source: "gateway",
          },
          {
            actor: "slack:U2",
            action: "objective.message",
            target: "Objective/launch-notes",
            outcome: "succeeded",
            status: undefined,
            source: "gateway",
          },
          {
            actor: "slack:U1",
            action: "objective.approve",
            target: "Objective/launch-notes",
            outcome: "failed",
            status: 409,
            source: "gateway",
          },
          {
            actor: "slack:U1",
            action: "objective.approve",
            target: "Objective/launch-notes",
            outcome: "succeeded",
            status: undefined,
            source: "gateway",
          },
        ]),
      );
      expect(audit).toHaveLength(4);
      const recorded = JSON.stringify(audit);
      for (const secret of ["xoxb-test", "xapp-test", "pricing change", "One more thing"])
        expect(recorded).not.toContain(secret);
    },
    60000,
  );

const thrown = (message: string) => () => {
  throw new Error(message);
};

for (const [name, options] of [
  [
    "the audit dependency throws synchronously and its reporter throws",
    { audit: thrown("audit is down"), onDispatchError: thrown("reporter is down") },
  ],
  [
    "the store's recordAuditEntry throws synchronously and its reporter throws",
    {
      prepare: (store: DrizzleStore) => {
        store.recordAuditEntry = thrown("database is down");
      },
      onDispatchError: thrown("reporter is down"),
    },
  ],
  [
    "the audit trail's store, sink, and reporter all throw synchronously",
    {
      audit: (entry: Parameters<AuditTrail["record"]>[0]) =>
        new AuditTrail(
          { recordAuditEntry: thrown("database is down") },
          thrown("sink is full"),
          thrown("reporter is down"),
        ).record(entry),
    },
  ],
] as const)
  it(`still delivers thread messages and approval answers when ${name}`, async () => {
    const { store, controlPlane, replies, objective } = await threadFixture("sqlite", options);
    const sent = await controlPlane.ingestSurfaceEvent(
      event("Please mention the pricing change.", { kind: "message" }),
    );
    expect(sent).toMatchObject({ status: "accepted", objectiveId: objective.id });
    expect(lastStatus(replies)?.markdown).toBe("Sent to the Objective.");
    expect(await ownerTurns(store, objective.id)).toHaveLength(1);
    // A refused approval still answers with its reason rather than an audit failure.
    const refused = await controlPlane.ingestSurfaceEvent(event("@SuperTag approve"));
    expect(refused).toMatchObject({ status: "accepted", objectiveId: objective.id });
    expect(lastStatus(replies)?.markdown).toContain("not ready_for_review");
  });
