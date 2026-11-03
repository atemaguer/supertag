import * as lark from "@larksuiteoapi/node-sdk";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { InboundEventSink, VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { z } from "zod";

export { type LarkMarkdownCard, renderLarkPresentation } from "./render.js";
export {
  type LarkThreadReplyOptions,
  larkReplyCapabilities,
  postLarkThreadReply,
} from "./reply.js";

export type LarkDomain = "feishu" | "lark";

const larkInboundEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().optional(),
  create_time: z.union([z.string(), z.number()]),
  tenant_key: z.string().min(1).optional(),
  app_id: z.string().min(1).optional(),
  sender: z.object({
    sender_id: z.object({
      open_id: z.string().min(1).optional(),
      user_id: z.string().min(1).optional(),
      union_id: z.string().min(1).optional(),
    }),
    sender_type: z.string().optional(),
    tenant_key: z.string().min(1).optional(),
  }),
  message: z.object({
    message_id: z.string().min(1),
    root_id: z.string().min(1).optional(),
    parent_id: z.string().min(1).optional(),
    chat_id: z.string().min(1),
    chat_type: z.string().min(1),
    message_type: z.string().min(1),
    content: z.string(),
    mentions: z
      .array(
        z.object({
          key: z.string().optional(),
          id: z.object({ open_id: z.string().min(1).optional() }).optional(),
          name: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

export interface LarkSetupInput {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: LarkDomain;
}

interface LarkBotInfoClient {
  request(input: { readonly method: "GET"; readonly url: string }): Promise<unknown>;
}

export interface LarkAccountVerificationDependencies {
  readonly clientFactory?: (input: LarkSetupInput) => LarkBotInfoClient;
}

export function larkChatScope(chatId: string): string {
  const normalized = chatId.trim();
  if (!/^oc_[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new Error("Lark chat must be a stable chat_id beginning with oc_");
  }
  return `chat:${normalized}`;
}

export async function verifyLarkAccount(
  input: LarkSetupInput,
  dependencies: LarkAccountVerificationDependencies = {},
): Promise<VerifiedSurfaceAccount> {
  const appId = required(input.appId, "Lark App ID");
  const appSecret = required(input.appSecret, "Lark App Secret");
  const client =
    dependencies.clientFactory?.({ ...input, appId, appSecret }) ??
    createLarkClient({ ...input, appId, appSecret });
  const response = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
  const bot = larkBotIdentity(response);
  if (bot === undefined) {
    throw new Error(
      "Lark credentials could not be verified: bot/v3/info did not return bot.open_id",
    );
  }
  return {
    provider: "lark",
    externalAccountId: appId,
    displayName: bot.name,
    authMethod: "lark-long-connection",
    configuration: { appId, botOpenId: bot.openId, domain: input.domain },
    secrets: { appSecret },
  };
}

export interface LarkInboundMessageEvent {
  readonly event_id?: string;
  readonly event_type?: string;
  readonly create_time?: string | number;
  readonly tenant_key?: string;
  readonly app_id?: string;
  readonly sender?: {
    readonly sender_id?: {
      readonly open_id?: string;
      readonly user_id?: string;
      readonly union_id?: string;
    };
    readonly sender_type?: string;
    readonly tenant_key?: string;
  };
  readonly message?: {
    readonly message_id?: string;
    readonly root_id?: string;
    readonly parent_id?: string;
    readonly chat_id?: string;
    readonly chat_type?: string;
    readonly message_type?: string;
    readonly content?: string;
    readonly mentions?: ReadonlyArray<{
      readonly key?: string;
      readonly id?: { readonly open_id?: string };
      readonly name?: string;
    }>;
  };
}

export interface NormalizeLarkEventOptions {
  readonly appId: string;
  readonly botOpenId: string;
  readonly domain: LarkDomain;
}

export function normalizeLarkEvent(
  payload: unknown,
  options: NormalizeLarkEventOptions,
): InboundSurfaceEvent | undefined {
  const parsed = larkInboundEventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  if (event.app_id !== undefined && event.app_id !== options.appId) {
    throw new Error("Lark event belongs to a different application");
  }
  if (event.message.message_type !== "text") return undefined;
  if (event.sender.sender_type !== undefined && event.sender.sender_type !== "user") {
    return undefined;
  }

  const actorId =
    event.sender.sender_id.open_id ??
    event.sender.sender_id.user_id ??
    event.sender.sender_id.union_id;
  if (actorId === undefined) return undefined;
  const text = stripLarkMentions(larkText(event.message.content));
  if (text.length === 0) return undefined;

  const isThreadReply =
    event.message.root_id !== undefined || event.message.parent_id !== undefined;
  const mentioned = (event.message.mentions ?? []).some(
    (mention) => mention.id?.open_id === options.botOpenId,
  );
  const isDirectMessage = event.message.chat_type === "p2p";
  if (!isDirectMessage && !mentioned && !isThreadReply) return undefined;

  const rootMessageId =
    event.message.root_id ?? event.message.parent_id ?? event.message.message_id;
  const tenantKey = event.tenant_key ?? event.sender.tenant_key;
  return {
    eventId: event.event_id,
    logicalEventId: `message:${options.appId}:${event.message.chat_id}:${event.message.message_id}`,
    provider: "lark",
    externalAccountId: options.appId,
    kind: mentioned || (isDirectMessage && !isThreadReply) ? "mention" : "message",
    scope: larkChatScope(event.message.chat_id),
    sessionKey: `lark:${options.appId}:${event.message.chat_id}:${rootMessageId}`,
    actor: { id: actorId, kind: "user" },
    text,
    occurredAt: larkOccurredAt(event.create_time),
    callback: {
      provider: "lark",
      mode: "lark_thread",
      threadKey: `${options.appId}|${event.message.chat_id}|${rootMessageId}`,
      target: { chatId: event.message.chat_id, messageId: rootMessageId },
    },
    source: {
      appId: options.appId,
      ...(tenantKey === undefined ? {} : { tenantKey }),
      chatId: event.message.chat_id,
      messageId: event.message.message_id,
      rootMessageId,
    },
    metadata: {
      larkEventType: event.event_type ?? "im.message.receive_v1",
      domain: options.domain,
      chatType: event.message.chat_type,
    },
  };
}

interface LarkWsClientLike {
  start(input: { readonly eventDispatcher: unknown }): Promise<void>;
  close?(input?: { readonly force?: boolean }): void | Promise<void>;
}

export interface LarkLongConnectionSurfaceOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly botOpenId: string;
  readonly domain: LarkDomain;
  readonly displayName: string;
  readonly sink: InboundEventSink;
  readonly onError?: (error: unknown) => void;
  readonly clientFactory?: () => LarkWsClientLike;
  readonly dispatcherFactory?: (
    handler: (event: LarkInboundMessageEvent) => Promise<void>,
  ) => unknown;
}

/** Receives Lark/Feishu events through the provider's outbound long connection. */
export class LarkLongConnectionSurface {
  readonly identity: { readonly id: string; readonly displayName: string };
  readonly #client: LarkWsClientLike;
  readonly #dispatcher: unknown;
  readonly #onError: (error: unknown) => void;
  #startPromise: Promise<void> | undefined;

  constructor(options: LarkLongConnectionSurfaceOptions) {
    const appId = required(options.appId, "Lark App ID");
    const appSecret = required(options.appSecret, "Lark App Secret");
    const botOpenId = required(options.botOpenId, "Lark bot open_id");
    this.identity = { id: appId, displayName: options.displayName };
    this.#onError = options.onError ?? (() => undefined);
    const handler = async (payload: LarkInboundMessageEvent) => {
      try {
        const event = normalizeLarkEvent(payload, {
          appId,
          botOpenId,
          domain: options.domain,
        });
        if (event !== undefined) await options.sink(event);
      } catch (error) {
        this.#onError(error);
      }
    };
    this.#dispatcher =
      options.dispatcherFactory?.(handler) ??
      new lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data) => handler(data as unknown as LarkInboundMessageEvent),
      });
    this.#client =
      options.clientFactory?.() ??
      new lark.WSClient({
        appId,
        appSecret,
        domain: sdkDomain(options.domain),
      });
  }

  async start(): Promise<void> {
    if (this.#startPromise !== undefined) return;
    this.#startPromise = this.#client.start({ eventDispatcher: this.#dispatcher });
    void this.#startPromise.catch(this.#onError);
  }

  async stop(): Promise<void> {
    if (this.#startPromise === undefined) return;
    await this.#client.close?.({ force: true });
    this.#startPromise = undefined;
  }
}

function createLarkClient(input: LarkSetupInput): LarkBotInfoClient {
  return new lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: sdkDomain(input.domain),
  });
}

function sdkDomain(domain: LarkDomain): lark.Domain {
  return domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;
}

function larkBotIdentity(
  response: unknown,
): { readonly openId: string; readonly name: string } | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const envelope = response as {
    readonly code?: unknown;
    readonly msg?: unknown;
    readonly bot?: unknown;
    readonly data?: { readonly bot?: unknown };
  };
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    throw new Error(
      `Lark credentials could not be verified: ${typeof envelope.msg === "string" ? envelope.msg : `API code ${envelope.code}`}`,
    );
  }
  const bot = envelope.bot ?? envelope.data?.bot;
  if (typeof bot !== "object" || bot === null) return undefined;
  const identity = bot as {
    readonly open_id?: unknown;
    readonly app_name?: unknown;
    readonly name?: unknown;
  };
  if (typeof identity.open_id !== "string" || identity.open_id.trim().length === 0) {
    return undefined;
  }
  const displayName =
    typeof identity.app_name === "string" && identity.app_name.trim().length > 0
      ? identity.app_name.trim()
      : typeof identity.name === "string" && identity.name.trim().length > 0
        ? identity.name.trim()
        : "SuperTag";
  return { openId: identity.open_id, name: displayName };
}

function larkText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || !("text" in parsed)) return "";
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function stripLarkMentions(text: string): string {
  return text
    .replace(/@_user_\d+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function larkOccurredAt(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Lark event create_time is invalid");
  const milliseconds = parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
  return new Date(milliseconds).toISOString();
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required`);
  return normalized;
}
