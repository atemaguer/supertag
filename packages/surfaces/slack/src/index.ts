import { createHmac, timingSafeEqual } from "node:crypto";
import { SocketModeClient } from "@slack/socket-mode";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { InboundEventSink, VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { z } from "zod";

export {
  escapeSlackText,
  renderSlackMarkdown,
  renderSlackPresentation,
  type SlackRenderedPresentation,
} from "./render.js";
export {
  postSlackMessage,
  postSlackThreadReply,
  type SlackMessageOptions,
  type SlackThreadReplyOptions,
  slackReplyCapabilities,
} from "./reply.js";

const slackResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const slackAuthResponseSchema = slackResponseSchema.extend({
  team: z.string(),
  team_id: z.string(),
  user: z.string().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
});

const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string().min(1),
  event_time: z.number().int().nonnegative(),
  team_id: z.string().min(1),
  event: z.object({
    type: z.string().min(1),
    channel: z.string().min(1),
    user: z.string().min(1).optional(),
    bot_id: z.string().min(1).optional(),
    text: z.string().optional(),
    ts: z.string().min(1),
    thread_ts: z.string().min(1).optional(),
    subtype: z.string().min(1).optional(),
  }),
});

const slackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1),
});

export type SlackTransport = "http" | "socket";

export function slackChannelScope(channelId: string): string {
  const normalized = channelId.trim().toUpperCase();
  if (!/^[CG][A-Z0-9]+$/u.test(normalized)) {
    throw new Error("Slack channel must be a stable channel ID beginning with C or G");
  }
  return `channel:${normalized}`;
}

export interface SlackSetupInput {
  readonly botToken: string;
  readonly transport: SlackTransport;
  readonly appToken?: string;
  readonly signingSecret?: string;
}

export interface SlackHttpRequest {
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly signingSecret: string;
  readonly externalAccountId: string;
}

export type SlackHttpEventResult =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "event"; readonly event: InboundSurfaceEvent | undefined };

interface SocketModeEventRequest {
  readonly type: string;
  readonly body: unknown;
  ack(): Promise<void>;
}

interface SocketModeClientLike {
  on(event: "slack_event", listener: (request: SocketModeEventRequest) => void): unknown;
  off(event: "slack_event", listener: (request: SocketModeEventRequest) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackSocketModeSurfaceOptions {
  readonly appToken: string;
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly sink: InboundEventSink;
  readonly onError?: (error: unknown) => void;
  readonly clientFactory?: () => SocketModeClientLike;
}

export class SlackSocketModeSurface {
  readonly identity: { readonly id: string; readonly displayName: string };
  readonly #client: SocketModeClientLike;
  readonly #externalAccountId: string;
  readonly #sink: InboundEventSink;
  readonly #onError: (error: unknown) => void;
  readonly #listener: (request: SocketModeEventRequest) => void;

  constructor(options: SlackSocketModeSurfaceOptions) {
    if (!options.appToken.trim()) {
      throw new Error("A Slack app-level token is required for Socket Mode");
    }
    this.identity = { id: options.externalAccountId, displayName: options.displayName };
    this.#externalAccountId = options.externalAccountId;
    this.#sink = options.sink;
    this.#onError = options.onError ?? (() => undefined);
    this.#client =
      options.clientFactory?.() ??
      (new SocketModeClient({ appToken: options.appToken }) as SocketModeClientLike);
    this.#listener = (request) => {
      void this.handle(request).catch(this.#onError);
    };
  }

  async start(): Promise<void> {
    this.#client.on("slack_event", this.#listener);
    await this.#client.start();
  }

  async stop(): Promise<void> {
    this.#client.off("slack_event", this.#listener);
    await this.#client.disconnect();
  }

  private async handle(request: SocketModeEventRequest): Promise<void> {
    const event = normalizeSlackEvent(request.body, this.#externalAccountId);
    if (event !== undefined) {
      await this.#sink(event);
    }
    await request.ack();
  }
}

export async function verifySlackAccount(
  input: SlackSetupInput,
  request: typeof fetch = fetch,
): Promise<VerifiedSurfaceAccount> {
  if (input.botToken.trim().length === 0) {
    throw new Error("A Slack bot token is required");
  }
  if (input.transport === "socket" && !input.appToken?.trim()) {
    throw new Error("A Slack app-level token is required for Socket Mode");
  }
  if (input.transport === "http" && !input.signingSecret?.trim()) {
    throw new Error("A Slack signing secret is required for HTTP events");
  }

  const auth = slackAuthResponseSchema.parse(
    await callSlackApi("auth.test", input.botToken, request),
  );

  if (input.transport === "socket") {
    await callSlackApi("apps.connections.open", input.appToken ?? "", request);
  }

  return {
    provider: "slack",
    externalAccountId: auth.team_id,
    displayName: auth.team,
    authMethod: input.transport === "socket" ? "slack-socket-mode" : "slack-http",
    configuration: {
      transport: input.transport,
      botId: auth.bot_id ?? null,
      botUserId: auth.user_id ?? null,
    },
    secrets: {
      botToken: input.botToken,
      ...(input.appToken === undefined ? {} : { appToken: input.appToken }),
      ...(input.signingSecret === undefined ? {} : { signingSecret: input.signingSecret }),
    },
  };
}

export function normalizeSlackEvent(
  payload: unknown,
  externalAccountId: string,
): InboundSurfaceEvent | undefined {
  const callback = slackEventCallbackSchema.safeParse(payload);
  if (!callback.success) {
    return undefined;
  }
  if (callback.data.team_id !== externalAccountId) {
    throw new Error("Slack event belongs to a different workspace");
  }
  const event = callback.data.event;
  const isMention = event.type === "app_mention";
  const isThreadReply = event.type === "message" && event.thread_ts !== undefined;
  if ((!isMention && !isThreadReply) || event.subtype !== undefined) {
    return undefined;
  }
  if (event.bot_id !== undefined) {
    return undefined;
  }
  const thread = event.thread_ts ?? event.ts;
  return {
    eventId: callback.data.event_id,
    logicalEventId: `message:${externalAccountId}:${event.channel}:${event.ts}`,
    provider: "slack",
    externalAccountId,
    kind: isMention ? "mention" : "message",
    scope: slackChannelScope(event.channel),
    sessionKey: `slack:${externalAccountId}:${event.channel}:${thread}`,
    actor: {
      id: event.user ?? event.bot_id ?? "unknown",
      kind: event.bot_id === undefined ? "user" : "bot",
    },
    ...(event.text === undefined ? {} : { text: event.text }),
    occurredAt: new Date(callback.data.event_time * 1000).toISOString(),
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: `${externalAccountId}|${event.channel}|${thread}`,
      target: { channelId: event.channel, threadTs: thread },
    },
    source: {
      workspaceId: externalAccountId,
      channelId: event.channel,
      messageTs: event.ts,
      threadTs: thread,
    },
    metadata: { slackEventType: event.type },
  };
}

export function parseSlackHttpRequest(
  request: SlackHttpRequest,
  now = (): Date => new Date(),
): SlackHttpEventResult {
  verifySlackSignature(request, now);
  const payload: unknown = JSON.parse(request.rawBody);
  const verification = slackUrlVerificationSchema.safeParse(payload);
  if (verification.success) {
    return { kind: "challenge", challenge: verification.data.challenge };
  }
  return {
    kind: "event",
    event: normalizeSlackEvent(payload, request.externalAccountId),
  };
}

export function verifySlackSignature(
  request: Pick<SlackHttpRequest, "rawBody" | "signature" | "timestamp" | "signingSecret">,
  now = (): Date => new Date(),
): void {
  if (request.signature === undefined || request.timestamp === undefined) {
    throw new Error("Slack signature headers are required");
  }
  const timestamp = Number(request.timestamp);
  if (!Number.isInteger(timestamp)) {
    throw new Error("Slack request timestamp is invalid");
  }
  if (Math.abs(Math.floor(now().getTime() / 1000) - timestamp) > 300) {
    throw new Error("Slack request timestamp is outside the five-minute window");
  }
  const expected = `v0=${createHmac("sha256", request.signingSecret)
    .update(`v0:${request.timestamp}:${request.rawBody}`)
    .digest("hex")}`;
  const actualBuffer = Buffer.from(request.signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Slack request signature is invalid");
  }
}

async function callSlackApi(
  method: string,
  token: string,
  request: typeof fetch,
): Promise<unknown> {
  const response = await request(`https://slack.com/api/${method}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const envelope = slackResponseSchema.parse(payload);
  if (!envelope.ok) {
    throw new Error(`Slack ${method} failed: ${envelope.error ?? "unknown_error"}`);
  }
  return payload;
}
