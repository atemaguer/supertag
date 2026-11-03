import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import {
  parseGitHubWebhook,
  verifyGitHubWebhookSignature,
} from "../packages/surfaces/github/src/index.ts";
import {
  normalizeSlackEvent,
  parseSlackHttpRequest,
  SlackSocketModeSurface,
} from "../packages/surfaces/slack/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const slackCallback = {
  type: "event_callback",
  event_id: "Ev123",
  event_time: 1_785_531_750,
  team_id: "T123",
  event: {
    type: "app_mention",
    channel: "C123",
    user: "U123",
    text: "<@U999> investigate the failing build",
    ts: "1785531750.100",
  },
};

describe("Slack event ingestion", () => {
  it("normalizes an app mention without leaking the provider payload", () => {
    expect(normalizeSlackEvent(slackCallback, "T123")).toEqual({
      eventId: "Ev123",
      logicalEventId: "message:T123:C123:1785531750.100",
      provider: "slack",
      externalAccountId: "T123",
      kind: "mention",
      scope: "channel:C123",
      sessionKey: "slack:T123:C123:1785531750.100",
      actor: { id: "U123", kind: "user" },
      text: "<@U999> investigate the failing build",
      occurredAt: "2026-07-31T21:02:30.000Z",
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "T123|C123|1785531750.100",
        target: { channelId: "C123", threadTs: "1785531750.100" },
      },
      source: {
        workspaceId: "T123",
        channelId: "C123",
        messageTs: "1785531750.100",
        threadTs: "1785531750.100",
      },
      metadata: { slackEventType: "app_mention" },
    });
  });

  it("normalizes an ordinary human thread reply for Session-aware routing", () => {
    expect(
      normalizeSlackEvent(
        {
          ...slackCallback,
          event_id: "Ev124",
          event: {
            ...slackCallback.event,
            type: "message",
            text: "continue with the prior result",
            ts: "1785531760.200",
            thread_ts: "1785531750.100",
          },
        },
        "T123",
      ),
    ).toMatchObject({
      eventId: "Ev124",
      kind: "message",
      sessionKey: "slack:T123:C123:1785531750.100",
      text: "continue with the prior result",
      metadata: { slackEventType: "message" },
    });
  });

  it("persists through its sink before acknowledging a Socket Mode envelope", async () => {
    const order: string[] = [];
    let listener:
      | ((request: { type: string; body: unknown; ack(): Promise<void> }) => void)
      | undefined;
    const client = {
      on(
        _event: "slack_event",
        next: (request: { type: string; body: unknown; ack(): Promise<void> }) => void,
      ) {
        listener = next;
      },
      off() {
        listener = undefined;
      },
      async start() {
        return {};
      },
      async disconnect() {},
    };
    const surface = new SlackSocketModeSurface({
      appToken: "xapp-test",
      externalAccountId: "T123",
      displayName: "Acme",
      clientFactory: () => client,
      sink: async () => {
        order.push("persist");
      },
    });

    await surface.start();
    listener?.({
      type: "events_api",
      body: slackCallback,
      ack: async () => {
        order.push("ack");
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["persist", "ack"]));
    await surface.stop();
  });

  it("verifies signed HTTP events and handles Slack URL challenges", () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "challenge-value" });
    const timestamp = "1785531750";
    const signingSecret = "slack-signing-secret";
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;

    expect(
      parseSlackHttpRequest(
        {
          rawBody,
          signature,
          timestamp,
          signingSecret,
          externalAccountId: "T123",
        },
        () => new Date("2026-07-31T21:02:30.000Z"),
      ),
    ).toEqual({ kind: "challenge", challenge: "challenge-value" });
  });

  it("rejects an invalid HTTP signature before parsing the Slack payload", () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "do-not-return" });

    expect(() =>
      parseSlackHttpRequest(
        {
          rawBody,
          signature: "v0=invalid",
          timestamp: "1785531750",
          signingSecret: "slack-signing-secret",
          externalAccountId: "T123",
        },
        () => new Date("2026-07-31T21:02:30.000Z"),
      ),
    ).toThrow("Slack request signature is invalid");
  });

  it("rejects a correctly signed Slack request outside the replay window", () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "do-not-return" });
    const timestamp = "1785531750";
    const signingSecret = "slack-signing-secret";
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;

    expect(() =>
      parseSlackHttpRequest(
        {
          rawBody,
          signature,
          timestamp,
          signingSecret,
          externalAccountId: "T123",
        },
        () => new Date("2026-07-31T21:08:00.000Z"),
      ),
    ).toThrow("Slack request timestamp is outside the five-minute window");
  });
});

describe("GitHub event ingestion", () => {
  it("matches GitHub's published webhook signature test vector", () => {
    expect(() =>
      verifyGitHubWebhookSignature({
        rawBody: "Hello, World!",
        signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        webhookSecret: "It's a Secret to Everybody",
      }),
    ).not.toThrow();
  });

  it("verifies and normalizes an issue comment delivery", () => {
    const rawBody = JSON.stringify({
      action: "created",
      sender: { id: 25001132, login: "atemaguer", type: "User" },
      repository: {
        id: 123,
        full_name: "atemaguer/supertag",
        html_url: "https://github.com/atemaguer/supertag",
      },
      issue: {
        number: 7,
        html_url: "https://github.com/atemaguer/supertag/issues/7",
      },
      comment: {
        id: 456,
        body: "@supertag investigate this",
        html_url: "https://github.com/atemaguer/supertag/issues/7#issuecomment-456",
        created_at: "2026-07-31T21:02:30Z",
      },
    });
    const webhookSecret = "github-webhook-secret";
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;

    expect(
      parseGitHubWebhook({
        rawBody,
        signature,
        deliveryId: "delivery-123",
        eventName: "issue_comment",
        webhookSecret,
        externalAccountId: "installation-42",
      }),
    ).toMatchObject({
      eventId: "delivery-123",
      logicalEventId: "issue_comment:123:456",
      provider: "github",
      externalAccountId: "installation-42",
      kind: "issue_comment",
      scope: "repository:123",
      sessionKey: "github:installation-42:atemaguer/supertag:issue:7",
      callback: {
        provider: "github",
        mode: "github_issue_comment",
        threadKey: "atemaguer/supertag#7",
        target: { repository: "atemaguer/supertag", number: "7" },
      },
      actor: { id: "25001132", displayName: "atemaguer", kind: "user" },
      text: "@supertag investigate this",
      metadata: { action: "created", githubEvent: "issue_comment" },
    });
  });
});

describe("Control Plane inbound idempotency", () => {
  it("keeps unmentioned human replies in the activated Session across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-thread-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const url = `file:${databasePath}`;
    const replies: InboundSurfaceEvent[] = [];
    const create = () => {
      const store = new DrizzleStore({ url });
      const controlPlane = new ControlPlane({
        store,
        credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
        dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
        worklet: new LocalWorklet("thread-worklet", "thread-host", [
          new StaticWorker({ profile: { id: "default", revision: "1" } }),
        ]),
        reply: async (event) => {
          replies.push(event);
        },
      });
      return { store, controlPlane };
    };
    let current = create();
    const mention = normalizeSlackEvent(slackCallback, "T123");
    const followup = normalizeSlackEvent(
      {
        ...slackCallback,
        event_id: "thread-reply",
        event: {
          ...slackCallback.event,
          type: "message",
          user: "U456",
          text: "Use option A",
          ts: "1785531760.200",
          thread_ts: slackCallback.event.ts,
        },
      },
      "T123",
    );
    if (!mention || !followup) throw new Error("Expected Slack events");
    try {
      await current.controlPlane.start();
      const account = await current.controlPlane.setupSurfaceAccount({
        provider: "slack",
        externalAccountId: "T123",
        displayName: "Acme",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
      });
      const tag = await current.store.createTag({ name: "Thread Test" });
      await current.store.bindTagWorkerHost(tag.id, "thread-host");
      await current.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      await expect(current.controlPlane.ingestSurfaceEvent(followup)).resolves.toMatchObject({
        status: "ignored",
      });
      expect(await current.store.listSessions()).toHaveLength(0);
      await current.controlPlane.ingestSurfaceEvent(mention);
      await vi.waitFor(async () =>
        expect((await current.store.listTasks())[0]?.status).toBe("completed"),
      );
      const [session] = await current.store.listSessions();
      await current.controlPlane.stop();
      current = create();
      await current.controlPlane.start();
      await expect(current.controlPlane.ingestSurfaceEvent(followup)).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(async () =>
        expect((await current.store.listTasks()).every((task) => task.status === "completed")).toBe(
          true,
        ),
      );
      await vi.waitFor(() =>
        expect(replies.some((event) => event.eventId === followup.eventId)).toBe(true),
      );
      await expect(current.controlPlane.ingestSurfaceEvent(followup)).resolves.toMatchObject({
        status: "duplicate",
      });
      for (const changed of [
        { actor: { id: "bot", kind: "bot" as const } },
        { sessionKey: "unrelated-thread" },
        { callback: { ...followup.callback, threadKey: "other-thread" } },
      ]) {
        await expect(
          current.controlPlane.ingestSurfaceEvent({
            ...followup,
            ...changed,
            eventId: "ignored",
            logicalEventId: "ignored",
          }),
        ).resolves.toMatchObject({ status: "ignored" });
      }
      expect(await current.store.listSessions()).toHaveLength(1);
      const tasks = await current.store.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.sessionId === session?.id)).toBe(true);
      expect(
        replies.every((event) => event.callback.threadKey === mention.callback.threadKey),
      ).toBe(true);
    } finally {
      await current.controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate GitHub delivery after a Control Plane restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-github-restart-"));
    const databasePath = join(directory, "supertag.db");
    const credentialPath = join(directory, "credentials.json");
    const url = `file:${databasePath}`;
    await migrateSqlite(databasePath);
    const rawBody = JSON.stringify({
      action: "created",
      sender: { id: 25001132, login: "atemaguer", type: "User" },
      repository: {
        id: 123,
        full_name: "atemaguer/supertag",
        html_url: "https://github.com/atemaguer/supertag",
      },
      issue: {
        number: 7,
        html_url: "https://github.com/atemaguer/supertag/issues/7",
      },
      comment: {
        id: 456,
        body: "@supertag investigate this",
        html_url: "https://github.com/atemaguer/supertag/issues/7#issuecomment-456",
        created_at: "2026-07-31T21:02:30Z",
      },
    });
    const webhookSecret = "github-restart-webhook-secret";
    const inbound = parseGitHubWebhook({
      rawBody,
      signature: `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`,
      deliveryId: "github-delivery-across-restart",
      eventName: "issue_comment",
      webhookSecret,
      externalAccountId: "user-25001132",
    });
    if (inbound === undefined) throw new Error("Expected a normalized GitHub delivery");

    const createControlPlane = () =>
      new ControlPlane({
        store: new DrizzleStore({ url }),
        credentialVault: new FileGatewayCredentialVault(credentialPath),
        dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
      });
    const first = createControlPlane();
    try {
      await first.start();
      const account = await first.setupSurfaceAccount({
        provider: "github",
        externalAccountId: "user-25001132",
        displayName: "atemaguer",
        authMethod: "github-token",
        configuration: { apiBaseUrl: "https://api.github.com" },
        secrets: { token: "github-test-token", webhookSecret },
      });
      const routeStore = new DrizzleStore({ url });
      await routeStore.connect();
      try {
        const tag = await routeStore.createTag({ name: "GitHub Restart Test" });
        await routeStore.bindTagWorkerHost(tag.id, "fixture-host");
        await routeStore.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: "repository:123",
        });
      } finally {
        await routeStore.disconnect();
      }
      await expect(first.ingestSurfaceEvent(inbound)).resolves.toMatchObject({
        status: "accepted",
      });
      await first.stop();

      const restarted = createControlPlane();
      try {
        await restarted.start();
        await expect(restarted.ingestSurfaceEvent(inbound)).resolves.toMatchObject({
          status: "duplicate",
        });
        const verificationStore = new DrizzleStore({ url });
        await verificationStore.connect();
        try {
          expect(await verificationStore.listTasks()).toHaveLength(1);
        } finally {
          await verificationStore.disconnect();
        }
      } finally {
        await restarted.stop();
      }
    } finally {
      await first.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hands a provider delivery downstream exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-ingestion-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const handled: InboundSurfaceEvent[] = [];
    const replies: Array<{ event: InboundSurfaceEvent; text: string }> = [];
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
      onInboundEvent: async (event) => {
        handled.push(event);
      },
      worklet: new LocalWorklet("static-test-worklet", "static-test-host", [
        new StaticWorker({ profile: { id: "default", revision: "1" } }),
      ]),
      reply: async (event, presentation) => {
        replies.push({ event, text: presentation.markdown });
      },
    });

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "slack",
        externalAccountId: "T123",
        displayName: "Acme",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
      });
      const tag = await store.createTag({ name: "Ingestion Test" });
      await store.bindTagWorkerHost(tag.id, "static-test-host");
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      const event = normalizeSlackEvent(slackCallback, "T123");
      expect(event).toBeDefined();
      if (event === undefined) {
        throw new Error("Expected a normalized Slack event");
      }
      const unrelatedReply = normalizeSlackEvent(
        {
          ...slackCallback,
          event_id: "Ev-unrelated",
          event: {
            ...slackCallback.event,
            type: "message",
            text: "this belongs to an unrelated thread",
            ts: "1785531740.200",
            thread_ts: "1785531740.100",
          },
        },
        "T123",
      );
      expect(unrelatedReply).toBeDefined();
      if (unrelatedReply === undefined) {
        throw new Error("Expected a normalized unrelated Slack reply");
      }
      await expect(controlPlane.ingestSurfaceEvent(unrelatedReply)).resolves.toMatchObject({
        status: "ignored",
      });

      await expect(controlPlane.ingestSurfaceEvent(event)).resolves.toMatchObject({
        status: "accepted",
      });
      await expect(controlPlane.ingestSurfaceEvent(event)).resolves.toMatchObject({
        status: "duplicate",
      });
      await expect(
        controlPlane.ingestSurfaceEvent({ ...event, eventId: "Ev123-twin" }),
      ).resolves.toMatchObject({ status: "duplicate" });
      const followUp = normalizeSlackEvent(
        {
          ...slackCallback,
          event_id: "Ev-follow-up",
          event: {
            ...slackCallback.event,
            type: "message",
            text: "continue without another mention",
            ts: "1785531760.200",
            thread_ts: "1785531750.100",
          },
        },
        "T123",
      );
      expect(followUp).toBeDefined();
      if (followUp === undefined) {
        throw new Error("Expected a normalized Slack follow-up");
      }
      await expect(controlPlane.ingestSurfaceEvent(followUp)).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(() => expect(handled).toEqual([event, followUp]));
      await vi.waitFor(() => expect(replies).toHaveLength(4));
      expect(replies.filter((reply) => reply.text.startsWith("SuperTag received"))).toEqual([
        {
          event,
          text: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
        },
        {
          event: followUp,
          text: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
        },
      ]);
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
