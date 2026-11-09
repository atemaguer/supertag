import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { eventService } from "../apps/cli/src/event-rpc.ts";
import { conversationClient, eventClient } from "../apps/cli/src/operator-client.ts";
import { createOperatorRpcHandler } from "../apps/cli/src/operator-rpc.ts";
import type { OperatorAuthentication } from "../apps/cli/src/operator-rpc-context.ts";
import {
  type ChangeNotice,
  ChangeNotifications,
} from "../packages/control-plane/src/change-notifications.ts";
import {
  ErrorDetailSchema,
  ErrorReason,
  EventService,
  type WatchEvent,
  WatchKind,
} from "../packages/operator-api/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";
import { issueOperatorToken } from "./support/operator-access.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "watch-admin";

/** Reads a watch stream until `count` events arrived, or until `until` accepts one. */
async function watch(
  url: string,
  token: string,
  request: { readonly resumeToken?: string; readonly kinds?: WatchKind[] },
  until: number | ((event: WatchEvent) => boolean),
): Promise<WatchEvent[]> {
  const abort = new AbortController();
  const events: WatchEvent[] = [];
  try {
    for await (const event of eventClient({ url, token }).watch(request, {
      signal: abort.signal,
      timeoutMs: 0,
    })) {
      events.push(event);
      if (typeof until === "number" ? events.length >= until : until(event)) break;
    }
  } finally {
    abort.abort();
  }
  return events;
}

const notice = (
  change: Partial<ChangeNotice> & Pick<ChangeNotice, "kind" | "id">,
): ChangeNotice => ({
  reason: "changed",
  changedAt: new Date().toISOString(),
  ...change,
});

describe("EventService.Watch", () => {
  let url = "";
  let server: Server | undefined;
  const changes = new ChangeNotifications({ capacity: 4 });

  const principals: Record<string, OperatorAuthentication> = {};

  beforeAll(async () => {
    Object.assign(principals, {
      [`Bearer ${ADMIN}`]: {
        kind: "break-glass",
        principal: { operatorId: "control-plane-break-glass", scopes: { actions: ["*"] } },
      },
      "Bearer alice": {
        kind: "operator-token",
        principal: { operatorId: "token:alice", scopes: { actions: ["*"] } },
      },
      "Bearer bob": {
        kind: "operator-token",
        principal: { operatorId: "token:bob", scopes: { actions: ["*"] } },
      },
      "Bearer scoped": {
        kind: "operator-token",
        principal: {
          operatorId: "token:scoped",
          scopes: { actions: ["watch_events", "read_objective"], objectiveIds: ["objective-1"] },
        },
      },
      "Bearer coordinator": {
        kind: "coordination",
        principal: {
          operatorId: "coordinator",
          scopes: { actions: ["watch_events", "read_objective"], objectiveIds: ["objective-1"] },
        },
      },
    } satisfies Record<string, OperatorAuthentication>);
    const handler = createOperatorRpcHandler(
      {
        auditTrail: { record: async () => {} },
        authenticate: async (authorization) =>
          authorization === undefined ? undefined : principals[authorization],
        accepting: () => true,
        reauthenticateMs: 100,
      },
      (router) =>
        router.service(
          EventService,
          eventService({
            changes,
            store: {
              getObjective: async (id: string) =>
                ({ id, teamId: id === "objective-1" ? "team-1" : null }) as never,
            },
            draining: () => new AbortController().signal,
            heartbeatMs: 100,
          }),
        ),
    );
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  /**
   * Opens a watch, publishes `published` once its first event arrived, and reads until `done`
   * accepts what it received.
   */
  async function watchWhile(
    token: string,
    published: readonly ChangeNotice[],
    done: (events: readonly WatchEvent[]) => boolean,
    request: { readonly kinds?: WatchKind[] } = {},
  ): Promise<WatchEvent[]> {
    const events: WatchEvent[] = [];
    const abort = new AbortController();
    try {
      for await (const event of eventClient({ url, token }).watch(request, {
        signal: abort.signal,
        timeoutMs: 0,
      })) {
        events.push(event);
        if (events.length === 1) for (const value of published) changes.publish(value);
        if (done(events)) break;
      }
    } finally {
      abort.abort();
    }
    return events;
  }
  const changed = (events: readonly WatchEvent[]) =>
    events.flatMap((event) => (event.event.case === "change" ? [event.event.value] : []));
  const changedCount = (count: number) => (events: readonly WatchEvent[]) =>
    changed(events).length >= count;

  it("starts with a heartbeat that marks the start, then sends each change in order", async () => {
    const events = await watchWhile(
      ADMIN,
      [
        notice({ kind: "tag", id: "tag-1", tag: "planner", reason: "created" }),
        notice({ kind: "task", id: "task-1", tag: "planner", sessionId: "session-1" }),
      ],
      changedCount(2),
    );
    expect(events[0]?.event.case).toBe("heartbeat");
    expect(events.slice(1).map((event) => event.event.value)).toMatchObject([
      { kind: WatchKind.TAG, id: "tag-1", tag: "planner", reason: "created" },
      { kind: WatchKind.TASK, id: "task-1", tag: "planner", sessionId: "session-1" },
    ]);
    const tokens = events.map((event) => event.resumeToken);
    expect(new Set(tokens).size).toBe(3);
  });

  it("sends a heartbeat after a quiet interval, carrying the latest position", async () => {
    const events = await watchWhile(
      ADMIN,
      [notice({ kind: "tag", id: "tag-1", tag: "planner" })],
      (received) => received.length === 3,
    );
    expect(events.map((event) => event.event.case)).toEqual(["heartbeat", "change", "heartbeat"]);
    expect(events[2]?.resumeToken).toBe(events[1]?.resumeToken);
  });

  it("shows each caller only what it may read", async () => {
    const published = [
      notice({
        kind: "conversation_message",
        id: "message-admin",
        conversation: "plan",
        conversationOwner: "admin",
      }),
      notice({ kind: "task", id: "task-admin", conversationOwner: "admin" }),
      notice({
        kind: "conversation_message",
        id: "message-alice",
        conversation: "plan",
        conversationOwner: "token:alice",
      }),
      notice({ kind: "objective", id: "objective-1", objectiveId: "objective-1" }),
      notice({ kind: "objective", id: "objective-2", objectiveId: "objective-2" }),
      notice({ kind: "approval", id: "approval-1", taskId: "task-x" }),
      notice({ kind: "task", id: "task-objective-1", objectiveId: "objective-1" }),
      notice({ kind: "session", id: "session-objective-1" }),
      notice({ kind: "tag", id: "tag-last", tag: "last" }),
      notice({ kind: "workstream_post", id: "post-team-2", teamId: "team-2" }),
      notice({ kind: "workstream_post", id: "post-team-1", teamId: "team-1" }),
    ];
    const ids = (events: readonly WatchEvent[]) => changed(events).map((change) => change.id);
    const last = (events: readonly WatchEvent[]) => ids(events).includes("tag-last");
    expect(ids(await watchWhile(ADMIN, published, last))).toEqual([
      "message-admin",
      "task-admin",
      "objective-1",
      "objective-2",
      "approval-1",
      "task-objective-1",
      "session-objective-1",
      "tag-last",
    ]);
    expect(ids(await watchWhile("alice", published, last))).toEqual([
      "message-alice",
      "objective-1",
      "objective-2",
      "approval-1",
      "task-objective-1",
      "session-objective-1",
      "tag-last",
    ]);
    // A scoped coordination credential sees its Objectives, their Tasks and their Team's posts,
    // and no conversations, Sessions or Tags.
    expect(
      ids(
        await watchWhile("coordinator", published, (events) => ids(events).includes("post-team-1")),
      ),
    ).toEqual(["objective-1", "task-objective-1", "post-team-1"]);
    expect(
      changed(
        await watchWhile(ADMIN, published, (events) => ids(events).includes("post-team-1")),
      ).at(-1),
    ).toMatchObject({ kind: WatchKind.WORKSTREAM_POST, id: "post-team-1", teamId: "team-1" });
    // Objectives in scope only; no approval outside an Objective, nor kinds it lacks actions for.
    expect(ids(await watchWhile("scoped", published, last))).toEqual([
      "objective-1",
      "task-objective-1",
      "session-objective-1",
      "tag-last",
    ]);
    // `kinds` narrows what a caller may see.
    expect(ids(await watchWhile(ADMIN, published, last, { kinds: [WatchKind.TAG] }))).toEqual([
      "tag-last",
    ]);
  });

  it("replays from a resume token, and resynchronizes when it cannot", async () => {
    const start = changes.resumeToken();
    changes.publish(notice({ kind: "tag", id: "one", tag: "one" }));
    const afterOne = changes.resumeToken();
    changes.publish(notice({ kind: "tag", id: "two", tag: "two" }));
    const replayed = await watch(url, ADMIN, { resumeToken: start }, 2);
    expect(replayed.map((event) => event.event.case === "change" && event.event.value.id)).toEqual([
      "one",
      "two",
    ]);
    expect(replayed[0]?.resumeToken).toBe(afterOne);
    expect((await watch(url, ADMIN, { resumeToken: afterOne }, 1))[0]?.event).toMatchObject({
      case: "change",
      value: { id: "two" },
    });

    // Past the ring's four notices, the changes since the token are lost.
    for (const id of ["three", "four", "five", "six"])
      changes.publish(notice({ kind: "tag", id, tag: id }));
    expect((await watch(url, ADMIN, { resumeToken: afterOne }, 1))[0]?.event.case).toBe("resync");
    // So are a restarted Control Plane's.
    const elsewhere = new ChangeNotifications().resumeToken();
    const resynced = await watch(url, ADMIN, { resumeToken: elsewhere }, 1);
    expect(resynced[0]?.event.case).toBe("resync");
    expect(resynced[0]?.resumeToken).toBe(changes.resumeToken());
  });

  it("ends an open stream once its Operator Token is revoked", async () => {
    const refused = await watchWhile("bob", [], (events) => {
      if (events.length === 1)
        principals["Bearer bob"] = {
          kind: "refused",
          reason: "revoked",
          message: "This Operator Token was revoked; ask an admin for a new one",
        };
      return false;
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).code).toBe(Code.Unauthenticated);
    expect((refused as ConnectError).rawMessage).toBe(
      "This Operator Token was revoked; ask an admin for a new one",
    );
    expect((refused as ConnectError).findDetails(ErrorDetailSchema)[0]?.reason).toBe(
      ErrorReason.CREDENTIAL_REVOKED,
    );
  });

  it("refuses a token the server did not issue", async () => {
    for (const resumeToken of ["not-a-token", changes.resumeToken(changes.position + 5)]) {
      const refused = await watch(url, ADMIN, { resumeToken }, 1).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConnectError);
      expect((refused as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `EventService.Watch on a Control Plane (${dialect})`,
    () => {
      let directory: string;
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
      let store: DrizzleStore;
      let cleanup: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "supertag-event-watch-"));
        let databaseUrl = `file:${join(directory, "supertag.db")}`;
        cleanup = undefined;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          databaseUrl = isolated.url;
          cleanup = isolated.cleanup;
        }
        await migrateDatabase({ url: databaseUrl });
        vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl,
          adminToken: ADMIN,
          worklet: new LocalWorklet("watch-worklet", "watch-host", [
            new StaticWorker({
              id: "watch-worker",
              profile: { id: "default", revision: "1" },
              text: "Hello from planner.",
            }),
          ]),
        });
        store = new DrizzleStore({ url: databaseUrl });
        await store.connect();
        const tag = await store.createTag({ name: "planner" });
        await store.bindTagWorkerHost(tag.id, "watch-host");
      });

      afterEach(async () => {
        await store.disconnect();
        await runtime.close();
        await cleanup?.();
        await rm(directory, { recursive: true, force: true });
        vi.unstubAllEnvs();
      });

      it("tells the operator whose conversation it is when a message is sent and answered", async () => {
        const issued = { secret: await issueOperatorToken(runtime.url, ADMIN, "alice") };
        const changesFor = async (token: string, taskId: () => string) => {
          const events: WatchEvent[] = [];
          const abort = new AbortController();
          const reading = (async () => {
            for await (const event of eventClient({ url: runtime.url, token }).watch(
              {},
              { signal: abort.signal, timeoutMs: 0 },
            )) {
              events.push(event);
              const change = event.event.case === "change" ? event.event.value : undefined;
              if (
                change?.kind === WatchKind.CONVERSATION_MESSAGE &&
                change.id === taskId() &&
                change.reason === "status completed"
              )
                break;
            }
          })().catch(() => undefined);
          return {
            events,
            started: () => vi.waitFor(() => expect(events.length).toBeGreaterThan(0)),
            stop: async () => {
              abort.abort();
              await reading;
            },
            reading,
          };
        };
        let sentId = "";
        const admin = await changesFor(ADMIN, () => sentId);
        const alice = await changesFor(issued.secret, () => sentId);
        await Promise.all([admin.started(), alice.started()]);
        const sent = await conversationClient({ url: runtime.url, token: ADMIN }).sendMessage({
          tag: "planner",
          conversation: "plan",
          text: "Hello",
        });
        sentId = sent.taskId;
        await admin.reading;
        const messages = admin.events.flatMap((event) =>
          event.event.case === "change" && event.event.value.kind === WatchKind.CONVERSATION_MESSAGE
            ? [event.event.value]
            : [],
        );
        expect(messages[0]).toMatchObject({
          id: sent.taskId,
          tag: "planner",
          conversation: "plan",
          sessionId: sent.sessionId,
        });
        expect(
          admin.events.some(
            (event) =>
              event.event.case === "change" &&
              event.event.value.kind === WatchKind.TASK &&
              event.event.value.id === sent.taskId,
          ),
        ).toBe(true);
        // Alice watches every Tag and Session but not the admin's conversation or its Tasks.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await alice.stop();
        expect(
          alice.events.filter(
            (event) =>
              event.event.case === "change" &&
              (event.event.value.id === sent.taskId ||
                event.event.value.sessionId === sent.sessionId),
          ),
        ).toEqual([]);
      });
    },
  );
}
