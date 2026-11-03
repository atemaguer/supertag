import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../../packages/core/src/index.ts";
import { LocalWorklet, StaticWorker } from "../../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../../packages/store/src/index.ts";
import {
  githubReplyCapabilities,
  parseGitHubWebhook,
  postGitHubThreadReply,
} from "../../packages/surfaces/github/src/index.ts";
import {
  postSlackThreadReply,
  SlackSocketModeSurface,
  slackReplyCapabilities,
} from "../../packages/surfaces/slack/src/index.ts";
import { migrateSqlite } from "../support/database.ts";

async function createDatabase(directory: string): Promise<DrizzleStore> {
  const databasePath = join(directory, "supertag.db");
  await migrateSqlite(databasePath);
  return new DrizzleStore({ url: `file:${databasePath}` });
}

describe("static mention vertical slice", () => {
  it("routes a Slack mention through the Gateway and Worker back to its thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-slack-e2e-"));
    const store = await createDatabase(directory);
    const order: string[] = [];
    const deliveryTargets: Array<string | undefined> = [];
    const deliveryReceipts: Array<string | undefined> = [];
    const presentationKinds: string[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      order.push("reply");
      if (request.mock.calls.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return Response.json({ ok: true, channel: "C123", ts: "1785531751.100" });
    });
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
      worklet: staticHost(),
      reply: Object.assign(
        async (event, presentation, _account, delivery) => {
          presentationKinds.push(presentation.kind);
          deliveryTargets.push(delivery.replaceExternalMessageId);
          const receipt = await postSlackThreadReply(event, presentation, {
            botToken: "xoxb-test",
            ...(delivery.replaceExternalMessageId === undefined
              ? {}
              : { replaceMessageTs: delivery.replaceExternalMessageId }),
            request,
          });
          deliveryReceipts.push(receipt.externalMessageId);
          return receipt;
        },
        { capabilities: () => slackReplyCapabilities },
      ),
    });
    let listener:
      | ((input: { type: string; body: unknown; ack(): Promise<void> }) => void)
      | undefined;
    const client = {
      on(
        _event: "slack_event",
        next: (input: { type: string; body: unknown; ack(): Promise<void> }) => void,
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
      sink: async (event) => {
        await controlPlane.ingestSurfaceEvent(event);
      },
    });
    const body = {
      type: "event_callback",
      event_id: "EvE2E1",
      event_time: 1_785_531_750,
      team_id: "T123",
      event: {
        type: "app_mention",
        channel: "C123",
        user: "U123",
        text: "<@U_APP> run the static worker",
        ts: "1785531750.100",
      },
    };

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
      const tag = await store.createTag({ name: "Slack E2E" });
      await store.bindTagWorkerHost(tag.id, "static-test-host");
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      await surface.start();
      listener?.({
        type: "events_api",
        body,
        ack: async () => {
          order.push("ack");
        },
      });
      await vi.waitFor(() => expect(order).toEqual(["ack", "reply", "reply", "reply"]));

      listener?.({
        type: "events_api",
        body: { ...body, event_id: "EvE2E1-twin" },
        ack: async () => {
          order.push("duplicate-ack");
        },
      });
      await vi.waitFor(() =>
        expect(order).toEqual(["ack", "reply", "reply", "reply", "duplicate-ack"]),
      );
      expect(request).toHaveBeenCalledTimes(3);
      expect(presentationKinds).toEqual(["acknowledgement", "status", "final-result"]);
      expect(deliveryReceipts).toEqual(["1785531751.100", "1785531751.100", "1785531751.100"]);
      expect(deliveryTargets).toEqual([undefined, "1785531751.100", "1785531751.100"]);
      expect(request.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postMessage");
      expect(request.mock.calls[1]?.[0]).toBe("https://slack.com/api/chat.update");
      expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({
        channel: "C123",
        ts: "1785531751.100",
        text: "Preparing the answer\n\n✓ Inspected the relevant code\n• Writing a clear response",
      });
      expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toMatchObject({
        channel: "C123",
        ts: "1785531751.100",
        text: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
      });
    } finally {
      await surface.stop();
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes a signed GitHub mention through the Gateway and Worker back to its issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-github-e2e-"));
    const store = await createDatabase(directory);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 991 }));
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
      worklet: staticHost(),
      reply: Object.assign(
        async (event, presentation, _account, delivery) =>
          await postGitHubThreadReply(event, presentation, {
            token: "github-test",
            request,
            ...(delivery.replaceExternalMessageId === undefined
              ? {}
              : { replaceCommentId: delivery.replaceExternalMessageId }),
          }),
        { capabilities: () => githubReplyCapabilities },
      ),
    });
    const rawBody = JSON.stringify({
      action: "created",
      sender: { id: 25001132, login: "atemaguer", type: "User" },
      repository: {
        id: 123,
        full_name: "atemaguer/supertag",
        html_url: "https://github.com/atemaguer/supertag",
      },
      issue: {
        number: 1,
        html_url: "https://github.com/atemaguer/supertag/issues/1",
      },
      comment: {
        id: 456,
        body: "@supertag run the static worker",
        html_url: "https://github.com/atemaguer/supertag/issues/1#issuecomment-456",
        created_at: "2026-07-31T21:02:30Z",
      },
    });
    const webhookSecret = "github-webhook-secret";
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "github",
        externalAccountId: "installation-42",
        displayName: "atemaguer",
        authMethod: "github-app",
        configuration: { appId: "7", installationId: "42" },
        secrets: { privateKey: "test", webhookSecret },
      });
      const tag = await store.createTag({ name: "GitHub E2E" });
      await store.bindTagWorkerHost(tag.id, "static-test-host");
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "repository:123",
      });
      const event = parseGitHubWebhook({
        rawBody,
        signature,
        deliveryId: "delivery-e2e-1",
        eventName: "issue_comment",
        webhookSecret,
        externalAccountId: "installation-42",
      });
      expect(event).toBeDefined();
      if (event === undefined) {
        throw new Error("Expected a normalized GitHub mention");
      }

      await expect(controlPlane.ingestSurfaceEvent(event)).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
      expect(request.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/atemaguer/supertag/issues/1/comments",
      );
      expect(request.mock.calls[1]?.[0]).toBe(
        "https://api.github.com/repos/atemaguer/supertag/issues/comments/991",
      );
      expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
      expect(request.mock.calls[2]?.[0]).toBe(
        "https://api.github.com/repos/atemaguer/supertag/issues/comments/991",
      );
      expect(request.mock.calls[3]?.[0]).toBe(
        "https://api.github.com/repos/atemaguer/supertag/issues/comments/991",
      );
      expect(JSON.parse(String(request.mock.calls[3]?.[1]?.body))).toMatchObject({
        body: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
      });
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("omits intermediate progress for a create-only reply surface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-create-only-e2e-"));
    const store = await createDatabase(directory);
    const deliveries: Array<{ readonly kind: string; readonly replacement?: string }> = [];
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
      worklet: staticHost(),
      reply: async (_event, presentation, _account, delivery) => {
        deliveries.push({
          kind: presentation.kind,
          ...(delivery.replaceExternalMessageId === undefined
            ? {}
            : { replacement: delivery.replaceExternalMessageId }),
        });
        return { externalMessageId: "create-only-reply" };
      },
    });

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "slack",
        externalAccountId: "T-CREATE-ONLY",
        displayName: "Create Only",
        authMethod: "test",
        configuration: {},
        secrets: { token: "test" },
      });
      const tag = await store.createTag({ name: "Create Only" });
      await store.bindTagWorkerHost(tag.id, "static-test-host");
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C-CREATE-ONLY",
      });
      await controlPlane.ingestSurfaceEvent(createOnlyEvent());

      await vi.waitFor(() =>
        expect(deliveries).toEqual([{ kind: "acknowledgement" }, { kind: "final-result" }]),
      );
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createOnlyEvent(): InboundSurfaceEvent {
  return {
    eventId: "create-only-event",
    logicalEventId: "create-only-message",
    provider: "slack",
    externalAccountId: "T-CREATE-ONLY",
    kind: "app_mention",
    scope: "channel:C-CREATE-ONLY",
    sessionKey: "slack:T-CREATE-ONLY:C-CREATE-ONLY:1.1",
    actor: { id: "U-CREATE-ONLY", kind: "user" },
    occurredAt: "2026-08-16T21:00:00.000Z",
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: "T-CREATE-ONLY|C-CREATE-ONLY|1.1",
      target: { channelId: "C-CREATE-ONLY", threadTs: "1.1" },
    },
    source: { channelId: "C-CREATE-ONLY", threadTs: "1.1" },
    text: "run the create-only test",
  };
}

function staticHost(): LocalWorklet {
  return new LocalWorklet("static-test-worklet", "static-test-host", [
    new StaticWorker({
      profile: { id: "default", revision: "1" },
      progress: [
        {
          summary: "Working through the request",
          items: [
            { id: "inspect", text: "Inspecting the relevant code", status: "active" },
            { id: "answer", text: "Preparing the answer", status: "pending" },
          ],
        },
        {
          summary: "Preparing the answer",
          items: [
            { id: "inspect", text: "Inspected the relevant code", status: "completed" },
            { id: "answer", text: "Writing a clear response", status: "active" },
          ],
        },
      ],
    }),
  ]);
}
