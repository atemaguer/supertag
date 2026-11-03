import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { runTagMessagingCommand } from "../apps/cli/src/messaging.js";
import { runObjectiveCommand } from "../apps/cli/src/objectives.js";
import { runWorkstreamCommand } from "../apps/cli/src/workstreams.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { TagMailboxClient } from "../packages/supertag-ai/src/messaging.js";

describe("Tag messaging HTTP, CLI, and public Worker SDK", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-mailbox-http-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const sender = await store.createTag({ name: "leadership" });
    const recipient = await store.createTag({ name: "marketing" });
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "embedded",
      adminToken: "test-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    cleanups.push(() => runtime.close());
    const target = { url: runtime.url, token: "test-admin" };
    const pathA = join(directory, "sender.json"),
      pathB = join(directory, "recipient.json");
    const output = await runTagMessagingCommand(target, [
      "credential",
      "leadership",
      "--out",
      pathA,
    ]);
    await runTagMessagingCommand(target, ["credential", "marketing", "--out", pathB]);
    const a = await TagMailboxClient.fromCredentialFile(pathA),
      b = await TagMailboxClient.fromCredentialFile(pathB);
    const credentialA = JSON.parse(await readFile(pathA, "utf8")) as { token: string; id: string };
    return {
      directory,
      store,
      sender,
      recipient,
      runtime,
      target,
      a,
      b,
      pathA,
      credentialA,
      output,
    };
  }
  it("paginates authenticated history and restricts body retention to operators", async () => {
    const f = await fixture();
    await f.store.setTagMessagingGrant({
      senderTagId: f.sender.id,
      recipientTagId: f.recipient.id,
      messageTypes: ["delegation.requested"],
    });
    const request = {
      recipientTagId: f.recipient.id,
      objectiveId: "history",
      type: "delegation.requested" as const,
      body: { private: "Old context" },
      idempotencyKey: "old",
    };
    const sent = await f.a.send(request);
    const delivery = await f.b.receive();
    if (!delivery) throw new Error("Missing message");
    await f.b.acknowledge(delivery);
    await f.a.send({ ...request, idempotencyKey: "new" });
    const history = (body: unknown) =>
      fetch(`${f.runtime.url}/internal/v1/mailbox/history`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.credentialA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const first = await (await history({ limit: 1 })).json();
    expect(await f.a.history({ limit: 1 })).toEqual(first);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const next = await (await history({ before: first.nextCursor, limit: 1 })).json();
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(first.items[0].id);
    expect(
      JSON.parse(
        await runTagMessagingCommand(f.target, [
          "history",
          "leadership",
          "--before-created-at",
          first.nextCursor.createdAt,
          "--before-id",
          first.nextCursor.id,
          "--limit",
          "1",
        ]),
      ),
    ).toEqual(next);
    expect((await history({ before: { id: "partial" } })).status).toBe(400);
    const before = new Date(Date.now() + 1000).toISOString();
    const retention = (token: string) =>
      fetch(`${f.runtime.url}/api/v1/tag-messaging/retention`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ before, limit: 10 }),
      });
    expect((await retention(f.credentialA.token)).status).toBe(401);
    expect(await (await retention("test-admin")).json()).toEqual({ pruned: 1 });
    expect(
      JSON.parse(
        await runTagMessagingCommand(f.target, [
          "prune-bodies",
          "--before",
          before,
          "--limit",
          "10",
        ]),
      ),
    ).toEqual({ pruned: 0 });
    const replay = await f.a.send(request);
    expect(replay.duplicate).toBe(true);
    expect(replay.message.id).toBe(sent.message.id);
    expect(replay.message.bodyPrunedAt).toEqual(expect.any(String));
    expect(replay.message.body).toEqual({});
    const admin = await fetch(
      `${f.runtime.url}/api/v1/tag-messaging/history?tagId=${f.sender.id}&beforeId=partial`,
      { headers: { Authorization: "Bearer test-admin" } },
    );
    expect(admin.status).toBe(400);
  });

  it("creates shared posts through authenticated HTTP without accepting forged authors", async () => {
    const f = await fixture();
    await f.store.createObjective({
      id: "posts-objective",
      outcome: "Coordinate research",
      ownerTagId: f.sender.id,
    });
    await f.store.createTeam({
      id: "posts",
      objectiveId: "posts-objective",
      name: "Shared research",
      leadTagId: f.sender.id,
      memberTagIds: [f.sender.id, f.recipient.id],
    });
    const invoke = (operation: string, body: unknown) =>
      fetch(`${f.runtime.url}/internal/v1/mailbox/workstreams/posts/posts/${operation}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.credentialA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const first = await invoke("create", {
      body: "Research summary",
      references: ["artifact:research"],
      idempotencyKey: "summary",
    });
    expect(first.status).toBe(200);
    const post = await first.json();
    expect(post).toMatchObject({
      authorTagId: f.sender.id,
      body: "Research summary",
      type: "note",
      to: [],
      sequence: 1,
    });
    expect(
      await (
        await invoke("create", {
          body: "Research summary",
          references: ["artifact:research"],
          idempotencyKey: "summary",
        })
      ).json(),
    ).toEqual(post);
    expect(
      (
        await invoke("create", {
          body: "Forged",
          authorTagId: f.recipient.id,
          idempotencyKey: "forged",
        })
      ).status,
    ).toBe(400);
    const question = await invoke("create", {
      body: "Which clinics did you interview?",
      type: "question",
      to: [f.recipient.id, f.recipient.id],
      idempotencyKey: "question",
    });
    expect(question.status).toBe(200);
    expect(await question.json()).toMatchObject({
      type: "question",
      to: [f.recipient.id],
      sequence: 2,
    });
    expect(
      (await invoke("create", { body: "Typed", type: "urgent", idempotencyKey: "bad-type" }))
        .status,
    ).toBe(400);
    expect(
      (await invoke("create", { body: "Addressed", to: ["outsider"], idempotencyKey: "bad-to" }))
        .status,
    ).toBe(400);
    expect(
      (
        await invoke("create", {
          body: "Too many",
          to: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
          idempotencyKey: "too-many",
        })
      ).status,
    ).toBe(400);
    expect((await invoke("list", { afterSequence: -1 })).status).toBe(400);
    expect(await (await invoke("list", { afterSequence: 2, limit: 1 })).json()).toEqual({
      items: [],
    });
    const admin = await fetch(
      `${f.runtime.url}/api/v1/tag-messaging/workstreams/posts/posts?afterSequence=0&limit=1`,
      { headers: { Authorization: "Bearer test-admin" } },
    );
    expect(await admin.json()).toEqual({ items: [post] });
    expect(await f.store.listTaskAssignments("posts-objective")).toEqual([]);
  });

  it("offers no route that creates or updates a Workstream or lists its messages", async () => {
    const f = await fixture();
    await f.store.createObjective({
      id: "routes",
      outcome: "Check routes",
      ownerTagId: f.sender.id,
    });
    await f.store.createTeam({
      id: "routes-team",
      objectiveId: "routes",
      name: "Routes",
      leadTagId: f.sender.id,
      memberTagIds: [f.sender.id, f.recipient.id],
    });
    const tag = (path: string, body: unknown = {}) =>
      fetch(`${f.runtime.url}/internal/v1/mailbox${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.credentialA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    for (const path of [
      "/workstreams/create",
      "/workstreams/routes-team/messages",
      "/workstreams/routes-team/status",
      "/workstreams/routes-team/update",
    ])
      expect((await tag(path)).status, path).toBe(404);
    expect((await tag("/workstreams/routes-team/get")).status).toBe(200);
    const admin = (path: string, method: string, body?: unknown) =>
      fetch(`${f.runtime.url}/api/v1/tag-messaging${path}`, {
        method,
        headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect(
      (
        await admin("/workstreams", "POST", {
          id: "ad-hoc",
          objectiveId: "routes",
          title: "Ad hoc",
          ownerTagId: f.sender.id,
          participantTagIds: [],
        })
      ).status,
    ).toBe(404);
    expect((await admin("/workstreams/routes-team", "PATCH", { status: "blocked" })).status).toBe(
      404,
    );
    expect((await admin("/workstreams/routes-team/messages", "GET")).status).toBe(404);
    expect((await admin("/workstreams/routes-team", "GET")).status).toBe(200);
    // A Mailbox message no longer names a Workstream.
    await f.store.setTagMessagingGrant({
      senderTagId: f.sender.id,
      recipientTagId: f.recipient.id,
      messageTypes: ["message"],
    });
    const sent = await tag("/send", {
      recipientTagId: f.recipient.id,
      objectiveId: "routes",
      workstreamId: "routes-team",
      type: "message",
      body: { text: "Hello" },
      idempotencyKey: "with-workstream",
    });
    expect(sent.status).toBe(400);
  });

  it("manages Objectives through the CLI and SDK without implicit completion", async () => {
    const f = await fixture();
    const created = JSON.parse(
      await runObjectiveCommand(f.target, [
        "create",
        "launch",
        "--ongoing",
        "--outcome",
        "Launch product",
        "--owner",
        "leadership",
        "--observe",
        "shared",
        "--observe",
        "service-measurements",
        "--output",
        "json",
      ]),
    );
    expect(created.ongoing).toBe(true);
    expect(created.ownerTagId).toBe(f.sender.id);
    expect(created.outcome).toBe("Launch product");
    expect(created).not.toHaveProperty("successCriteria");
    expect(created.observations).toEqual([
      { workstreamId: "shared" },
      { workstreamId: "service-measurements" },
    ]);
    await expect(
      f.a.updateObjectiveStatus("launch", {
        status: "completed",
        expectedRevision: 1,
        completionSummary: "An agent cannot end the ongoing responsibility",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await f.a.getObjective("launch")).revision).toBe(1);
    expect((await f.a.listObjectives()).map((o) => o.id)).toEqual(["launch"]);
    await expect(f.b.getObjective("launch")).rejects.toMatchObject({ statusCode: 404 });
    await f.store.createTeam({
      id: "shared",
      objectiveId: "launch",
      name: "Launch",
      leadTagId: f.sender.id,
      memberTagIds: [f.sender.id, f.recipient.id],
    });
    expect((await f.b.getObjective("launch")).id).toBe("launch");
    await expect(
      f.b.updateObjectiveStatus("launch", { status: "blocked", expectedRevision: 1 }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      runObjectiveCommand(f.target, ["status", "launch", "completed", "--revision", "1"]),
    ).rejects.toThrow();
    expect(
      (
        await f.a.updateObjectiveStatus("launch", {
          status: "ready_for_review",
          expectedRevision: 1,
        })
      ).revision,
    ).toBe(2);
    expect(
      await runObjectiveCommand(f.target, [
        "status",
        "launch",
        "completed",
        "--revision",
        "2",
        "--summary",
        "Approved materials and training attendance recorded in launch review.",
      ]),
    ).toBe("objective/launch completed (revision 3).\n");
    expect(
      JSON.parse(await runObjectiveCommand(f.target, ["list", "--owner", "marketing"])),
    ).toEqual({
      items: [],
    });
    expect(await runObjectiveCommand(f.target, ["get", "launch"])).toContain("training attendance");
    expect((await f.a.getWorkstream("shared")).title).toBe("Launch");
    await expect(
      f.a.updateObjectiveStatus("launch", { status: "blocked", expectedRevision: 2 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("filters CLI Objective listings by owner instead of Team membership", async () => {
    const f = await fixture();
    await f.store.createObjective({
      id: "lead-owned",
      ownerTagId: f.sender.id,
      outcome: "Lead the release",
    });
    await f.store.createTeam({
      id: "release-team",
      objectiveId: "lead-owned",
      name: "Release",
      leadTagId: f.sender.id,
      memberTagIds: [f.recipient.id],
      maxConcurrency: 1,
    });
    await f.store.createObjective({
      id: "reviewer-owned",
      ownerTagId: f.recipient.id,
      outcome: "Review the release",
    });
    const result = JSON.parse(
      await runObjectiveCommand(f.target, ["list", "--owner", "marketing"]),
    ) as { items: { id: string }[] };
    expect(result.items.map((objective) => objective.id)).toEqual(["reviewer-owned"]);
  });

  it("shares posts through the public SDK without direct messages", async () => {
    const f = await fixture();
    await f.a.createObjective({
      id: "shared",
      outcome: "Review evidence",
    });
    await f.store.createTeam({
      id: "posts",
      objectiveId: "shared",
      name: "Evidence",
      leadTagId: f.sender.id,
      memberTagIds: [f.sender.id, f.recipient.id],
    });
    const input = {
      body: "Clinics need recurring appointments",
      references: ["opaque:interview-3"],
      idempotencyKey: "finding",
    };
    const post = await f.a.postWorkstream("posts", input);
    expect(await f.a.postWorkstream("posts", input)).toEqual(post);
    expect(post.authorTagId).toBe(f.sender.id);
    expect(await f.b.workstreamPosts("posts", { limit: 1 })).toEqual([post]);
    const reply = await f.b.postWorkstream("posts", {
      body: "Prioritizing recurring appointments",
      type: "decision",
      to: [f.sender.id],
      replyTo: post.id,
      idempotencyKey: "reply",
    });
    expect(reply).toMatchObject({ type: "decision", to: [f.sender.id], replyTo: post.id });
    expect(await f.a.workstreamPosts("posts", { afterSequence: post.sequence })).toEqual([reply]);
    expect(
      JSON.parse(
        await runWorkstreamCommand(f.target, [
          "posts",
          "posts",
          "--after-sequence",
          String(post.sequence),
          "--limit",
          "1",
        ]),
      ),
    ).toEqual({ items: [reply] });
    expect((await f.a.history()).items).toEqual([]);
    expect(await f.store.listTaskAssignments("shared")).toEqual([]);
  });

  it("inspects Team channels through the CLI and authenticated SDK", async () => {
    const f = await fixture();
    await f.a.createObjective({
      id: "launch",
      outcome: "Launch product",
    });
    await f.store.createTeam({
      id: "ws-launch",
      objectiveId: "launch",
      name: "Launch messaging",
      leadTagId: f.recipient.id,
      memberTagIds: [f.recipient.id, f.sender.id],
    });
    const stream = await f.a.getWorkstream("ws-launch");
    expect(stream).toMatchObject({
      id: "ws-launch",
      objectiveId: "launch",
      title: "Launch messaging",
      ownerTagId: f.recipient.id,
      participantTagIds: [f.recipient.id, f.sender.id].sort(),
    });
    expect((await f.a.listWorkstreams()).map((channel) => channel.id)).toContain("ws-launch");
    const blocker = await f.a.postWorkstream("ws-launch", {
      body: "Waiting on pricing",
      type: "blocker",
      idempotencyKey: "pricing",
    });
    // A blocker without to is addressed to the Team lead.
    expect(blocker).toMatchObject({ type: "blocker", to: [f.recipient.id] });
    expect(JSON.parse(await runWorkstreamCommand(f.target, ["get", "ws-launch"]))).toEqual(stream);
    expect(await runWorkstreamCommand(f.target, ["list", "leadership"])).toContain("ws-launch");
    expect(
      JSON.parse(await runWorkstreamCommand(f.target, ["posts", "ws-launch"])).items,
    ).toMatchObject([{ type: "blocker", to: [f.recipient.id], body: "Waiting on pricing" }]);
    for (const removed of [
      ["create", "ws-new", "--objective", "launch", "--title", "New", "--owner", "marketing"],
      ["status", "ws-launch", "completed"],
      ["messages", "ws-launch"],
    ])
      await expect(runWorkstreamCommand(f.target, removed)).rejects.toThrow(/Usage/u);
    // The Objective owner reads every channel in its Objective but posts only where it is a member.
    await f.store.createTeam({
      id: "ws-marketing",
      objectiveId: "launch",
      name: "Marketing",
      leadTagId: f.recipient.id,
      memberTagIds: [f.recipient.id],
    });
    expect((await f.a.getWorkstream("ws-marketing")).title).toBe("Marketing");
    await expect(
      f.a.postWorkstream("ws-marketing", { body: "Owner note", idempotencyKey: "owner" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await f.store.createTeam({
      id: "ws-owned",
      objectiveId: "launch",
      name: "Leadership planning",
      leadTagId: f.sender.id,
      memberTagIds: [f.sender.id],
    });
    await expect(f.b.getWorkstream("ws-owned")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("round-trips a delegation and reply between unbound Tags, with inspectable receipts and no surface tasks", async () => {
    const f = await fixture();
    expect((await stat(f.pathA)).mode & 0o777).toBe(0o600);
    expect(f.output).not.toContain(f.credentialA.token);
    await expect(
      runTagMessagingCommand(f.target, ["credential", "leadership", "--out", f.pathA]),
    ).rejects.toThrow();
    await runTagMessagingCommand(f.target, [
      "grant",
      "leadership",
      "marketing",
      "--types",
      "delegation.requested",
    ]);
    await runTagMessagingCommand(f.target, [
      "grant",
      "marketing",
      "leadership",
      "--types",
      "result.submitted",
    ]);
    const controller = new AbortController();
    const consumer = f.b.consume(async (message, context) => {
      await context.mailbox.send(
        {
          recipientTagId: message.senderTagId,
          objectiveId: message.objectiveId,
          type: "result.submitted",
          inReplyTo: message.id,
          body: { summary: "Draft ready for review" },
          idempotencyKey: `reply-${message.id}`,
        },
        context.signal,
      );
    }, controller.signal);
    try {
      const result = await f.a.send({
        recipientTagId: f.recipient.id,
        objectiveId: "launch",
        type: "delegation.requested",
        body: { outcome: "Draft launch messaging" },
        idempotencyKey: "launch-marketing",
      });
      const reply = await f.a.receive({ waitMs: 2_000 });
      expect(reply?.message).toMatchObject({
        senderTagId: f.recipient.id,
        inReplyTo: result.message.id,
        type: "result.submitted",
      });
      if (!reply) throw new Error("Missing reply");
      await f.a.acknowledge(reply);
      await f.a.acknowledge(reply);
      await expect
        .poll(
          async () =>
            (await f.store.listTagMessages(f.recipient.id)).find(
              (message) => message.id === result.message.id,
            )?.status,
        )
        .toBe("processed");
      const inspection = await runTagMessagingCommand(f.target, ["messages", "marketing"]);
      expect(inspection).toContain("Draft ready for review");
      expect(inspection).not.toContain("leaseToken");
      expect(await f.store.listTasks()).toEqual([]);
    } finally {
      controller.abort();
      await consumer;
    }
    await runTagMessagingCommand(f.target, ["revoke-credential", f.credentialA.id]);
    await expect(f.a.receive()).rejects.toMatchObject({ statusCode: 401 });
  });
  it("separates administrative and Tag authentication and rejects forged sender fields", async () => {
    const f = await fixture();
    const post = (path: string, token: string, body: unknown) =>
      fetch(`${f.runtime.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post("/api/v1/tag-messaging/credentials", f.credentialA.token, {
          tagId: f.recipient.id,
        })
      ).status,
    ).toBe(401);
    expect((await post("/internal/v1/mailbox/receive", "test-admin", {})).status).toBe(401);
    expect(
      (
        await post("/internal/v1/mailbox/send", f.credentialA.token, {
          senderTagId: f.recipient.id,
          recipientTagId: f.sender.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/internal/v1/mailbox/receive", f.credentialA.token, { tagId: f.recipient.id }))
        .status,
    ).toBe(400);
    expect(
      (await post("/internal/v1/mailbox/send", f.credentialA.token, { body: "a".repeat(80_000) }))
        .status,
    ).toBe(413);
    expect(
      () => new TagMailboxClient({ controlPlaneUrl: "http://example.com", token: "secret" }),
    ).toThrow("HTTPS");
    expect(
      () =>
        new TagMailboxClient({
          controlPlaneUrl: "https://example.com?token=secret",
          token: "secret",
        }),
    ).toThrow();
  });
  it("retries an ambiguous acknowledgement without rerunning the handler", async () => {
    const f = await fixture();
    await runTagMessagingCommand(f.target, [
      "grant",
      "leadership",
      "marketing",
      "--types",
      "delegation.requested",
    ]);
    await f.a.send({
      recipientTagId: f.recipient.id,
      objectiveId: "launch",
      type: "delegation.requested",
      body: {},
      idempotencyKey: "ambiguous-ack",
    });
    const ack = f.b.acknowledge.bind(f.b);
    const acknowledge = vi
      .spyOn(f.b, "acknowledge")
      .mockImplementationOnce(async (delivery, signal) => {
        await ack(delivery, signal);
        throw new TypeError("Acknowledgement response lost after persistence");
      });
    const handler = vi.fn(async () => undefined);
    const stop = new AbortController();
    const consuming = f.b.consume(handler, stop.signal);
    try {
      await expect.poll(() => acknowledge.mock.calls.length).toBe(2);
      await expect
        .poll(async () => (await f.store.listTagMessages(f.recipient.id))[0]?.status)
        .toBe("processed");
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      stop.abort();
      await consuming;
    }
  });

  it("preserves retryable HTTP errors when a proxy returns a non-JSON body", async () => {
    const f = await fixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream unavailable", { status: 502 }),
    );
    await expect(f.b.receive()).rejects.toMatchObject({ statusCode: 502 });
  });

  it("does not automatically replay a failed handler", async () => {
    const f = await fixture();
    await runTagMessagingCommand(f.target, [
      "grant",
      "leadership",
      "marketing",
      "--types",
      "delegation.requested",
    ]);
    await f.a.send({
      recipientTagId: f.recipient.id,
      objectiveId: "launch",
      type: "delegation.requested",
      body: {},
      idempotencyKey: "failing",
    });
    const controller = new AbortController();
    await expect(
      f.b.consume(async () => {
        throw new Error("Provider outcome unknown");
      }, controller.signal),
    ).rejects.toThrow("Provider outcome unknown");
    expect((await f.store.listTagMessages(f.recipient.id))[0]?.status).toBe("failed");
    expect(await f.b.receive()).toBeUndefined();
  });
});
