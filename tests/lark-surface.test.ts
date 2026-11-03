import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import {
  type LarkInboundMessageEvent,
  LarkLongConnectionSurface,
  larkChatScope,
  normalizeLarkEvent,
  postLarkThreadReply,
  verifyLarkAccount,
} from "../packages/surfaces/lark/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const initialMessage: LarkInboundMessageEvent = {
  event_id: "event-lark-1",
  event_type: "im.message.receive_v1",
  create_time: "1785945600000",
  tenant_key: "tenant-lark-1",
  app_id: "cli_supertag",
  sender: {
    sender_id: { open_id: "ou_requester" },
    sender_type: "user",
    tenant_key: "tenant-lark-1",
  },
  message: {
    message_id: "om_root",
    chat_id: "oc_engineering",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 explain the Gateway" }),
    mentions: [{ key: "@_user_1", id: { open_id: "ou_supertag" }, name: "SuperTag" }],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Lark surface", () => {
  it("verifies app credentials and retains only durable bot identity", async () => {
    const request = vi.fn(async () => ({
      code: 0,
      bot: { open_id: "ou_supertag", app_name: "SuperTag" },
    }));
    const account = await verifyLarkAccount(
      { appId: "cli_supertag", appSecret: "app-secret", domain: "lark" },
      { clientFactory: () => ({ request }) },
    );

    expect(account).toEqual({
      provider: "lark",
      externalAccountId: "cli_supertag",
      displayName: "SuperTag",
      authMethod: "lark-long-connection",
      configuration: { appId: "cli_supertag", botOpenId: "ou_supertag", domain: "lark" },
      secrets: { appSecret: "app-secret" },
    });
    expect(request).toHaveBeenCalledWith({ method: "GET", url: "/open-apis/bot/v3/info" });
    expect(JSON.stringify(account.configuration)).not.toContain("app-secret");
  });

  it("normalizes a group mention into a stable chat route and thread session", () => {
    expect(normalize(initialMessage)).toEqual({
      eventId: "event-lark-1",
      logicalEventId: "message:cli_supertag:oc_engineering:om_root",
      provider: "lark",
      externalAccountId: "cli_supertag",
      kind: "mention",
      scope: "chat:oc_engineering",
      sessionKey: "lark:cli_supertag:oc_engineering:om_root",
      actor: { id: "ou_requester", kind: "user" },
      text: "explain the Gateway",
      occurredAt: "2026-08-05T16:00:00.000Z",
      callback: {
        provider: "lark",
        mode: "lark_thread",
        threadKey: "cli_supertag|oc_engineering|om_root",
        target: { chatId: "oc_engineering", messageId: "om_root" },
      },
      source: {
        appId: "cli_supertag",
        tenantKey: "tenant-lark-1",
        chatId: "oc_engineering",
        messageId: "om_root",
        rootMessageId: "om_root",
      },
      metadata: {
        larkEventType: "im.message.receive_v1",
        domain: "lark",
        chatType: "group",
      },
    });
    expect(larkChatScope(" oc_engineering ")).toBe("chat:oc_engineering");
  });

  it("accepts non-mentioned thread replies but ignores unaddressed top-level group messages", () => {
    const followUp: LarkInboundMessageEvent = {
      ...initialMessage,
      event_id: "event-lark-2",
      message: {
        ...initialMessage.message,
        message_id: "om_follow_up",
        root_id: "om_root",
        content: JSON.stringify({ text: "How does it recover after a crash?" }),
        mentions: [],
      },
    };
    expect(normalize(followUp)).toMatchObject({
      kind: "message",
      text: "How does it recover after a crash?",
      sessionKey: "lark:cli_supertag:oc_engineering:om_root",
      callback: { target: { messageId: "om_root" } },
    });
    expect(
      normalize({
        ...followUp,
        message: { ...followUp.message, root_id: undefined, parent_id: undefined },
      }),
    ).toBeUndefined();
  });

  it("delivers official long-connection events to the Gateway sink and closes cleanly", async () => {
    let handler: ((event: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const start = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const received: InboundSurfaceEvent[] = [];
    const surface = new LarkLongConnectionSurface({
      appId: "cli_supertag",
      appSecret: "app-secret",
      botOpenId: "ou_supertag",
      domain: "lark",
      displayName: "SuperTag",
      sink: async (event) => received.push(event),
      dispatcherFactory(callback) {
        handler = callback;
        return { provider: "lark-dispatcher" };
      },
      clientFactory: () => ({ start, close }),
    });

    await surface.start();
    await handler?.(initialMessage);
    await surface.stop();

    expect(start).toHaveBeenCalledWith({
      eventDispatcher: { provider: "lark-dispatcher" },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ provider: "lark", text: "explain the Gateway" });
    expect(close).toHaveBeenCalledWith({ force: true });
  });

  it("replies to the originating root message through the official message API", async () => {
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: "om_reply" } }));
    const event = normalize(initialMessage);
    if (event === undefined) throw new Error("Expected Lark event");

    await expect(
      postLarkThreadReply(
        event,
        {
          kind: "final-result",
          markdown: "The Gateway forwards collaboration ingress.",
        },
        {
          appId: "cli_supertag",
          appSecret: "app-secret",
          domain: "lark",
          clientFactory: () => ({ im: { message: { reply } } }),
        },
      ),
    ).resolves.toEqual({ externalMessageId: "om_reply" });

    expect(reply).toHaveBeenCalledWith({
      path: { message_id: "om_root" },
      data: {
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          header: {
            template: "green",
            title: { tag: "plain_text", content: "SuperTag" },
          },
          elements: [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: "The Gateway forwards collaboration ingress.",
              },
            },
          ],
        }),
        msg_type: "interactive",
        reply_in_thread: true,
      },
    });
  });

  it("replaces an existing thread reply", async () => {
    const patch = vi.fn(async () => ({ code: 0 }));
    const event = normalize(initialMessage);
    if (event === undefined) throw new Error("Expected Lark event");

    await expect(
      postLarkThreadReply(
        event,
        { kind: "status", markdown: "Inspecting the code" },
        {
          appId: "cli_supertag",
          appSecret: "app-secret",
          domain: "lark",
          replaceMessageId: "om_reply",
          clientFactory: () => ({ im: { message: { patch } } }),
        },
      ),
    ).resolves.toEqual({ externalMessageId: "om_reply" });
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: "om_reply" },
      data: { content: expect.stringContaining("Inspecting the code") },
    });
  });

  it("runs a mention and follow-up through one durable session and local Worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-lark-e2e-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const replies: Array<{ readonly event: InboundSurfaceEvent; readonly text: string }> = [];
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      worklet: new LocalWorklet("lark-worklet", "lark-local", [
        new StaticWorker({ profile: { id: "default", revision: "1" } }),
      ]),
      reply: async (event, presentation) => replies.push({ event, text: presentation.markdown }),
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
    });

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "lark",
        externalAccountId: "cli_supertag",
        displayName: "SuperTag",
        authMethod: "lark-long-connection",
        configuration: { appId: "cli_supertag", botOpenId: "ou_supertag", domain: "lark" },
        secrets: { appSecret: "app-secret" },
      });
      const tag = await store.createTag({ name: "Engineering" });
      await store.bindTagWorkerHost(tag.id, "lark-local");
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: larkChatScope("oc_engineering"),
      });

      const orphan = normalize({
        ...initialMessage,
        event_id: "event-lark-orphan",
        message: {
          ...initialMessage.message,
          message_id: "om_orphan",
          root_id: "om_unknown",
          content: JSON.stringify({ text: "unrelated thread reply" }),
          mentions: [],
        },
      });
      if (orphan === undefined) throw new Error("Expected orphan follow-up event");
      await expect(controlPlane.ingestSurfaceEvent(orphan)).resolves.toMatchObject({
        status: "ignored",
      });

      const first = normalize(initialMessage);
      if (first === undefined) throw new Error("Expected initial Lark event");
      await expect(controlPlane.ingestSurfaceEvent(first)).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(() => expect(replies).toHaveLength(2));

      const followUp = normalize({
        ...initialMessage,
        event_id: "event-lark-2",
        message: {
          ...initialMessage.message,
          message_id: "om_follow_up",
          root_id: "om_root",
          content: JSON.stringify({ text: "How does recovery work?" }),
          mentions: [],
        },
      });
      if (followUp === undefined) throw new Error("Expected Lark follow-up event");
      await expect(controlPlane.ingestSurfaceEvent(followUp)).resolves.toMatchObject({
        status: "accepted",
      });
      await vi.waitFor(() => expect(replies).toHaveLength(4));
      expect(
        replies
          .filter(({ text }) => text.startsWith("SuperTag received"))
          .map(({ event }) => event.sessionKey),
      ).toEqual([
        "lark:cli_supertag:oc_engineering:om_root",
        "lark:cli_supertag:oc_engineering:om_root",
      ]);
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes Lark setup in CLI help", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["setup", "lark", "--help"])).resolves.toBe(0);
    const text = output.mock.calls.map(([value]) => String(value)).join("");
    expect(text).toContain("--domain lark|feishu");
    expect(text).toContain("LARK_APP_ID");
    expect(text).toContain("LARK_APP_SECRET");
  });
});

function normalize(payload: LarkInboundMessageEvent): InboundSurfaceEvent | undefined {
  return normalizeLarkEvent(payload, {
    appId: "cli_supertag",
    botOpenId: "ou_supertag",
    domain: "lark",
  });
}
