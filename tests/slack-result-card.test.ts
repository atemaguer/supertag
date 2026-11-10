import { describe, expect, it, vi } from "vitest";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import { renderSlackMarkdown } from "../packages/surfaces/slack/src/render.ts";
import { postSlackThreadReply } from "../packages/surfaces/slack/src/reply.ts";
import { renderSlackResultCardBlocks } from "../packages/surfaces/slack/src/result-card.ts";

const PR_URL = "https://github.com/example/supertag/pull/42";
const TEXT = "Work Session finished. See *results* below.";

const event: InboundSurfaceEvent = {
  eventId: "event-1",
  logicalEventId: "logical-event-1",
  externalAccountId: "account-1",
  kind: "mention",
  scope: "test",
  sessionKey: "session-1",
  actor: { id: "user-1", kind: "user" },
  occurredAt: "2026-07-31T21:02:30.000Z",
  metadata: {},
  provider: "slack",
  callback: {
    provider: "slack",
    mode: "slack_thread",
    threadKey: "account-1|C123|1785531750.100",
    target: { channelId: "C123", threadTs: "1785531750.100" },
  },
  source: { channelId: "C123", threadTs: "1785531750.100" },
};

const presentation = { kind: "final-result", markdown: TEXT } as const;

function okRequest() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 }));
}

function sentBody(request: ReturnType<typeof okRequest>): Record<string, unknown> {
  return JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

const textOnly = {
  channel: "C123",
  thread_ts: "1785531750.100",
  // The current text-only renderer output, so the fallback must match it exactly.
  text: renderSlackMarkdown(TEXT),
  mrkdwn: true,
  unfurl_links: false,
  unfurl_media: false,
};

describe("Slack work Session result cards", () => {
  it("renders the exact PR URL and omits sections without data", () => {
    const blocks = renderSlackResultCardBlocks({ pullRequestUrl: PR_URL });
    expect(blocks).toContainEqual(
      expect.objectContaining({
        type: "actions",
        elements: [expect.objectContaining({ type: "button", url: PR_URL })],
      }),
    );
    const json = JSON.stringify(blocks);
    expect(json).not.toContain("Branch");
    expect(renderSlackResultCardBlocks(undefined)).toBeUndefined();
  });

  it("adds the card beside an unchanged text fallback in the same thread", async () => {
    const request = okRequest();
    await postSlackThreadReply(event, presentation, {
      botToken: "xoxb-token",
      resultCard: { pullRequestUrl: PR_URL, branch: "supertag/session/abc" },
      request,
    });
    const { attachments, ...rest } = sentBody(request);
    expect(rest).toEqual(textOnly);
    expect(JSON.stringify(attachments)).toContain(JSON.stringify(PR_URL));
  });

  it("sends the current text-only message without delivery data", async () => {
    const request = okRequest();
    await postSlackThreadReply(event, presentation, {
      botToken: "xoxb-token",
      request,
    });
    expect(sentBody(request)).toEqual(textOnly);
  });

  it("escapes mentions and leaves non-PR URLs out of the card", () => {
    const blocks = renderSlackResultCardBlocks({
      branch: "supertag/session/<!channel>",
      pullRequestUrl: "https://github.com.example.net/example/supertag/pull/42",
    });
    const json = JSON.stringify(blocks);
    expect(json).toContain("&lt;!channel&gt;");
    expect(json).not.toContain("example.net");
  });

  it("sends the current text-only message when rendering fails", async () => {
    const request = okRequest();
    await postSlackThreadReply(event, presentation, {
      botToken: "xoxb-token",
      resultCard: { branch: 42 as unknown as string },
      request,
    });
    expect(sentBody(request)).toEqual(textOnly);
  });

  it("falls back to text when Slack explicitly rejects the card", async () => {
    const request = okRequest().mockResolvedValueOnce(
      Response.json({ ok: false, error: "invalid_blocks" }),
    );
    await postSlackThreadReply(event, presentation, {
      botToken: "xoxb-token",
      resultCard: { pullRequestUrl: PR_URL },
      request,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual(textOnly);
  });
});
