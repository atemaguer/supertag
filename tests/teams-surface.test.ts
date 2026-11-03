import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import {
  normalizeTeamsActivity,
  postTeamsThreadReply,
  TeamsHttpSurface,
  teamsChannelScope,
  verifyTeamsAccount,
} from "../packages/surfaces/teams/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

const activity = {
  type: "message",
  id: "1741000000000",
  timestamp: "2026-08-04T18:30:00.000Z",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  channelId: "msteams",
  from: {
    id: "29:user-channel-id",
    aadObjectId: "11111111-2222-3333-4444-555555555555",
    name: "Atem Aguer",
  },
  recipient: { id: "28:supertag-app-id", name: "SuperTag" },
  conversation: {
    id: "19:channel-thread@thread.tacv2",
    conversationType: "channel",
    tenantId: "tenant-123",
  },
  text: "<at>SuperTag</at> explain the current architecture",
  entities: [
    {
      type: "mention",
      text: "<at>SuperTag</at>",
      mentioned: { id: "28:supertag-app-id", name: "SuperTag" },
    },
  ],
  channelData: {
    tenant: { id: "tenant-123" },
    team: {
      id: "19:team-id@thread.tacv2",
      aadGroupId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    channel: { id: "19:channel-id@thread.tacv2" },
  },
};

describe("Teams surface", () => {
  it("verifies client credentials without retaining an access token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "temporary-bot-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const account = await verifyTeamsAccount(
      {
        appId: "supertag-app-id",
        appSecret: "client-secret",
        tenantId: "tenant-123",
        tenantName: "Acme",
      },
      request,
    );

    expect(account).toEqual({
      provider: "teams",
      externalAccountId: "tenant-123",
      displayName: "Acme",
      authMethod: "teams-client-secret",
      configuration: { appId: "supertag-app-id" },
      secrets: { appSecret: "client-secret" },
    });
    expect(JSON.stringify(account)).not.toContain("temporary-bot-token");
    expect(request).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("normalizes a channel mention into a stable Tag route and thread session", () => {
    expect(normalizeTeamsActivity(activity, "tenant-123", "supertag-app-id")).toEqual({
      eventId: "1741000000000",
      logicalEventId: "message:tenant-123:19:channel-thread@thread.tacv2:1741000000000",
      provider: "teams",
      externalAccountId: "tenant-123",
      kind: "mention",
      scope: "team:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channel:19:channel-id@thread.tacv2",
      sessionKey: "teams:tenant-123:19:channel-thread@thread.tacv2:1741000000000",
      actor: {
        id: "11111111-2222-3333-4444-555555555555",
        displayName: "Atem Aguer",
        kind: "user",
      },
      text: "explain the current architecture",
      occurredAt: "2026-08-04T18:30:00.000Z",
      callback: {
        provider: "teams",
        mode: "teams_thread",
        threadKey: "tenant-123|19:channel-thread@thread.tacv2|1741000000000",
        target: {
          conversationId: "19:channel-thread@thread.tacv2",
          activityId: "1741000000000",
          serviceUrl: "https://smba.trafficmanager.net/amer",
        },
      },
      source: {
        tenantId: "tenant-123",
        teamId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        channelId: "19:channel-id@thread.tacv2",
        conversationId: "19:channel-thread@thread.tacv2",
        activityId: "1741000000000",
        threadRootId: "1741000000000",
      },
      metadata: { teamsActivityType: "message" },
    });
    expect(teamsChannelScope(" team-id ", " channel-id ")).toBe("team:team-id/channel:channel-id");
  });

  it("ignores non-mentions and rejects cross-tenant activities", () => {
    expect(
      normalizeTeamsActivity({ ...activity, entities: [] }, "tenant-123", "supertag-app-id"),
    ).toBeUndefined();
    expect(() => normalizeTeamsActivity(activity, "other-tenant", "supertag-app-id")).toThrow(
      "different tenant",
    );
  });

  it("uses the official Teams request pipeline before delivering to the Gateway sink", async () => {
    const handled: InboundSurfaceEvent[] = [];
    let messageHandler: ((context: { readonly activity: unknown }) => Promise<void>) | undefined;
    const initialize = vi.fn(async () => undefined);
    const surface = new TeamsHttpSurface({
      appId: "supertag-app-id",
      appSecret: "client-secret",
      tenantId: "tenant-123",
      sink: async (event) => handled.push(event),
      appFactory: () => ({
        initialize,
        on(_name, handler) {
          messageHandler = handler;
          return this;
        },
        server: {
          async handleRequest(request) {
            if (request.headers.authorization !== "Bearer signed-service-token") {
              return { status: 401 };
            }
            await messageHandler?.({ activity: request.body });
            return { status: 200 };
          },
        },
      }),
    });

    await surface.start();
    await expect(
      surface.handle(JSON.stringify(activity), "Bearer signed-service-token"),
    ).resolves.toEqual({ status: 200 });
    expect(initialize).toHaveBeenCalledOnce();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      provider: "teams",
      text: "explain the current architecture",
    });
  });

  it("replies through the SDK using the originating service URL and root activity", async () => {
    const initialize = vi.fn(async () => undefined);
    const reply = vi.fn(async () => ({ id: "reply-activity-1" }));
    const updateActivity = vi.fn(async () => ({}));
    const event = normalizeTeamsActivity(activity, "tenant-123", "supertag-app-id");
    if (event === undefined) throw new Error("Expected a Teams event");

    await expect(
      postTeamsThreadReply(
        event,
        { kind: "final-result", markdown: "Dynamic worker response" },
        {
          appId: "supertag-app-id",
          appSecret: "client-secret",
          tenantId: "tenant-123",
          appFactory(serviceUrl) {
            expect(serviceUrl).toBe("https://smba.trafficmanager.net/amer");
            return { api: { conversations: { updateActivity } }, initialize, reply };
          },
        },
      ),
    ).resolves.toEqual({ externalMessageId: "reply-activity-1" });

    expect(initialize).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("19:channel-thread@thread.tacv2", "1741000000000", {
      type: "message",
      text: "Dynamic worker response",
      textFormat: "markdown",
    });

    await expect(
      postTeamsThreadReply(
        event,
        { kind: "status", markdown: "Working through the plan" },
        {
          appId: "supertag-app-id",
          appSecret: "client-secret",
          tenantId: "tenant-123",
          replaceActivityId: "reply-activity-1",
          appFactory: () => ({ api: { conversations: { updateActivity } }, initialize, reply }),
        },
      ),
    ).resolves.toEqual({ externalMessageId: "reply-activity-1" });
    expect(updateActivity).toHaveBeenCalledWith(
      "19:channel-thread@thread.tacv2",
      "reply-activity-1",
      { type: "message", text: "Working through the plan", textFormat: "markdown" },
    );
  });

  it("runs a Teams activity through durable admission, a local Worker, and reply delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-teams-e2e-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const replies: Array<{ readonly event: InboundSurfaceEvent; readonly text: string }> = [];
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
      worklet: new LocalWorklet("teams-worklet", "teams-local", [
        new StaticWorker({ profile: { id: "default", revision: "1" } }),
      ]),
      reply: async (event, presentation) => replies.push({ event, text: presentation.markdown }),
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5 },
    });
    let messageHandler: ((context: { readonly activity: unknown }) => Promise<void>) | undefined;
    const surface = new TeamsHttpSurface({
      appId: "supertag-app-id",
      appSecret: "client-secret",
      tenantId: "tenant-123",
      sink: async (event) => {
        await controlPlane.ingestSurfaceEvent(event);
      },
      appFactory: () => ({
        async initialize() {},
        on(_name, handler) {
          messageHandler = handler;
          return this;
        },
        server: {
          async handleRequest(request) {
            if (request.headers.authorization !== "Bearer signed-service-token") {
              return { status: 401 };
            }
            await messageHandler?.({ activity: request.body });
            return { status: 200 };
          },
        },
      }),
    });

    try {
      await controlPlane.start();
      const account = await controlPlane.setupSurfaceAccount({
        provider: "teams",
        externalAccountId: "tenant-123",
        displayName: "Acme",
        authMethod: "teams-client-secret",
        configuration: { appId: "supertag-app-id" },
        secrets: { appSecret: "client-secret" },
      });
      const tag = await store.createTag({ name: "Engineering" });
      await store.bindTagWorkerHost(tag.id, "teams-local");
      await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: teamsChannelScope(
          "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          "19:channel-id@thread.tacv2",
        ),
      });
      await surface.start();

      await expect(
        surface.handle(JSON.stringify(activity), "Bearer signed-service-token"),
      ).resolves.toEqual({ status: 200 });
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies[1]).toMatchObject({
        event: {
          provider: "teams",
          externalAccountId: "tenant-123",
          text: "explain the current architecture",
        },
        text: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
      });
    } finally {
      await controlPlane.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
