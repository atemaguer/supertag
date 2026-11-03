import type { InboundSurfaceEvent } from "@supertag/core";
import type { SurfacePresentation, SurfaceReplyCapabilities } from "@supertag/surface-sdk";
import { renderSlackPresentation } from "./render.js";

interface SlackReplyResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly ts?: string;
}

export const slackReplyCapabilities = {
  replacement: true,
} as const satisfies SurfaceReplyCapabilities;

export interface SlackThreadReplyOptions {
  readonly botToken: string;
  readonly replaceMessageTs?: string;
  readonly request?: typeof fetch;
}

/** Posts a response to the Slack thread that produced an inbound event. */
export async function postSlackThreadReply(
  event: InboundSurfaceEvent,
  presentation: SurfacePresentation,
  options: SlackThreadReplyOptions,
): Promise<{ readonly externalMessageId?: string }> {
  if (event.provider !== "slack") {
    throw new Error("Cannot post a Slack reply for a non-Slack event");
  }
  if (event.callback.provider !== "slack" || event.callback.mode !== "slack_thread") {
    throw new Error("Slack event callback route is not a Slack thread");
  }

  const channel = requiredCallbackField(event, "channelId");
  const threadTs = requiredCallbackField(event, "threadTs");
  if (options.botToken.trim().length === 0) {
    throw new Error("A Slack bot token is required to post a reply");
  }

  const replacing = options.replaceMessageTs?.trim();
  const method =
    replacing === undefined || replacing.length === 0 ? "chat.postMessage" : "chat.update";
  const response = await (options.request ?? fetch)(`https://slack.com/api/${method}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${options.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      ...(replacing === undefined || replacing.length === 0
        ? { thread_ts: threadTs }
        : { ts: replacing }),
      ...renderSlackPresentation(presentation),
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!isSlackReplyResponse(payload)) {
    throw new Error(`Slack ${method} returned an invalid response`);
  }
  if (!payload.ok) {
    throw new Error(`Slack ${method} failed: ${payload.error ?? "unknown_error"}`);
  }
  return payload.ts === undefined ? {} : { externalMessageId: payload.ts };
}

export interface SlackMessageOptions {
  readonly botToken: string;
  /** Channel ID (C, G), DM ID (D), or user ID (U, W). A user ID posts a direct message. */
  readonly channel: string;
  readonly request?: typeof fetch;
}

/** Posts a new top-level message, not tied to an inbound event, to a channel or user. */
export async function postSlackMessage(
  presentation: SurfacePresentation,
  options: SlackMessageOptions,
): Promise<{ readonly externalMessageId?: string }> {
  if (options.botToken.trim().length === 0)
    throw new Error("A Slack bot token is required to post a message");
  if (!/^[CGDUW][A-Z0-9]{2,}$/u.test(options.channel))
    throw new Error("Slack destination must be a channel or user ID");
  const response = await (options.request ?? fetch)("https://slack.com/api/chat.postMessage", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${options.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: options.channel,
      ...renderSlackPresentation(presentation),
    }),
  });
  if (!response.ok) throw new Error(`Slack chat.postMessage failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!isSlackReplyResponse(payload))
    throw new Error("Slack chat.postMessage returned an invalid response");
  if (!payload.ok)
    throw new Error(`Slack chat.postMessage failed: ${payload.error ?? "unknown_error"}`);
  return payload.ts === undefined ? {} : { externalMessageId: payload.ts };
}

function requiredCallbackField(event: InboundSurfaceEvent, field: string): string {
  const value = event.callback.target[field];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Slack callback route is missing ${field}`);
  }
  return value;
}

function isSlackReplyResponse(value: unknown): value is SlackReplyResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  const response = value as { readonly ok?: unknown; readonly error?: unknown };
  return (
    typeof response.ok === "boolean" &&
    (response.error === undefined || typeof response.error === "string") &&
    (!("ts" in response) || response.ts === undefined || typeof response.ts === "string")
  );
}
