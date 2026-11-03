import { describe, expect, it, vi } from "vitest";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import { postGitHubThreadReply } from "../packages/surfaces/github/src/reply.ts";
import { postSlackThreadReply } from "../packages/surfaces/slack/src/reply.ts";

const baseEvent = {
  eventId: "event-1",
  logicalEventId: "logical-event-1",
  externalAccountId: "account-1",
  kind: "mention",
  scope: "test",
  sessionKey: "session-1",
  actor: { id: "user-1", kind: "user" },
  occurredAt: "2026-07-31T21:02:30.000Z",
  metadata: {},
} as const;

describe("Slack thread replies", () => {
  it("posts a response to the originating Slack thread", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1785531751.100" }), {
        status: 200,
      }),
    );
    const event: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "slack",
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "account-1|C123|1785531750.100",
        target: { channelId: "C123", threadTs: "1785531750.100" },
      },
      source: { channelId: "C123", threadTs: "1785531750.100" },
    };

    await expect(
      postSlackThreadReply(event, finalPresentation("Static worker response"), {
        botToken: "xoxb-secret-token",
        request,
      }),
    ).resolves.toEqual({ externalMessageId: "1785531751.100" });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer xoxb-secret-token" }),
        body: JSON.stringify({
          channel: "C123",
          thread_ts: "1785531750.100",
          text: "Static worker response",
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false,
        }),
      }),
    );
  });

  it("updates an existing work message instead of adding another thread reply", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1785531751.100" })),
      );
    const event: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "slack",
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "account-1|C123|1785531750.100",
        target: { channelId: "C123", threadTs: "1785531750.100" },
      },
      source: { channelId: "C123", threadTs: "1785531750.100" },
    };

    await postSlackThreadReply(event, finalPresentation("Here’s what I found."), {
      botToken: "xoxb-secret-token",
      replaceMessageTs: "1785531751.100",
      request,
    });

    expect(request).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          ts: "1785531751.100",
          text: "Here’s what I found.",
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false,
        }),
      }),
    );
  });

  it("rejects invalid routing and Slack application errors without exposing the token", async () => {
    const token = "xoxb-do-not-expose";
    const wrongProvider: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "github",
      callback: {
        provider: "github",
        mode: "github_issue_comment",
        threadKey: "atemaguer/supertag#1",
        target: { repository: "atemaguer/supertag", number: "1" },
      },
      source: { repository: "atemaguer/supertag", number: "1" },
    };
    await expect(
      postSlackThreadReply(wrongProvider, finalPresentation("reply"), { botToken: token }),
    ).rejects.toThrow("non-Slack");

    const missingThread: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "slack",
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "account-1|C123|missing",
        target: { channelId: "C123" },
      },
      source: { channelId: "C123" },
    };
    await expect(
      postSlackThreadReply(missingThread, finalPresentation("reply"), { botToken: token }),
    ).rejects.toThrow("threadTs");

    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "not_in_channel" })));
    const event: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "slack",
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "account-1|C123|1785531750.100",
        target: { channelId: "C123", threadTs: "1785531750.100" },
      },
      source: { channelId: "C123", threadTs: "1785531750.100" },
    };
    const reply = postSlackThreadReply(event, finalPresentation("reply"), {
      botToken: token,
      request,
    });
    await expect(reply).rejects.toThrow("not_in_channel");
    await expect(reply).rejects.not.toThrow(token);
  });
});

describe("GitHub thread replies", () => {
  it("posts a comment to the originating issue or pull request", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 12345 }));
    const event: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "github",
      kind: "issue_comment",
      callback: {
        provider: "github",
        mode: "github_issue_comment",
        threadKey: "atemaguer/supertag#7",
        target: { repository: "atemaguer/supertag", number: "7" },
      },
      source: { repository: "atemaguer/supertag", number: "7" },
    };

    await expect(
      postGitHubThreadReply(event, finalPresentation("Static worker response"), {
        token: "github-secret-token",
        request,
      }),
    ).resolves.toEqual({ externalMessageId: "12345" });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/repos/atemaguer/supertag/issues/7/comments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer github-secret-token" }),
        body: JSON.stringify({ body: "Static worker response" }),
      }),
    );
  });

  it("replaces an existing issue comment", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 12345 }));
    const event: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "github",
      kind: "issue_comment",
      callback: {
        provider: "github",
        mode: "github_issue_comment",
        threadKey: "atemaguer/supertag#7",
        target: { repository: "atemaguer/supertag", number: "7" },
      },
      source: { repository: "atemaguer/supertag", number: "7" },
    };

    await expect(
      postGitHubThreadReply(event, finalPresentation("Updated response"), {
        token: "github-secret-token",
        replaceCommentId: "12345",
        request,
      }),
    ).resolves.toEqual({ externalMessageId: "12345" });
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/repos/atemaguer/supertag/issues/comments/12345",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ body: "Updated response" }),
      }),
    );
  });

  it("rejects invalid routing and HTTP failures without exposing the token", async () => {
    const token = "github-do-not-expose";
    const wrongProvider: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "slack",
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "account-1|C123|1.1",
        target: { channelId: "C123", threadTs: "1.1" },
      },
      source: { channelId: "C123", threadTs: "1.1" },
    };
    await expect(
      postGitHubThreadReply(wrongProvider, finalPresentation("reply"), { token }),
    ).rejects.toThrow("non-GitHub");

    const missingNumber: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "github",
      callback: {
        provider: "github",
        mode: "github_issue_comment",
        threadKey: "atemaguer/supertag#missing",
        target: { repository: "atemaguer/supertag" },
      },
      source: { repository: "atemaguer/supertag" },
    };
    await expect(
      postGitHubThreadReply(missingNumber, finalPresentation("reply"), { token }),
    ).rejects.toThrow("number");

    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const event: InboundSurfaceEvent = {
      ...baseEvent,
      provider: "github",
      callback: {
        provider: "github",
        mode: "github_issue_comment",
        threadKey: "atemaguer/supertag#7",
        target: { repository: "atemaguer/supertag", number: "7" },
      },
      source: { repository: "atemaguer/supertag", number: "7" },
    };
    const reply = postGitHubThreadReply(event, finalPresentation("reply"), { token, request });
    await expect(reply).rejects.toThrow("HTTP 403");
    await expect(reply).rejects.not.toThrow(token);
  });
});

function finalPresentation(markdown: string) {
  return { kind: "final-result" as const, markdown };
}
