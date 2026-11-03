import * as lark from "@larksuiteoapi/node-sdk";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { SurfacePresentation, SurfaceReplyCapabilities } from "@supertag/surface-sdk";
import type { LarkDomain } from "./index.js";
import { renderLarkPresentation } from "./render.js";

export const larkReplyCapabilities = {
  replacement: true,
} as const satisfies SurfaceReplyCapabilities;

interface LarkReplyPayload {
  readonly path: { readonly message_id: string };
  readonly data: {
    readonly content: string;
    readonly msg_type: "interactive";
    readonly reply_in_thread: true;
  };
}

interface LarkMessageApi {
  reply?(payload: LarkReplyPayload): Promise<unknown>;
  patch?(payload: {
    readonly path: { readonly message_id: string };
    readonly data: { readonly content: string };
  }): Promise<unknown>;
}

export interface LarkReplyClient {
  readonly im: {
    readonly message?: LarkMessageApi;
    readonly v1?: { readonly message?: LarkMessageApi };
  };
}

export interface LarkThreadReplyOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: LarkDomain;
  readonly replaceMessageId?: string;
  readonly clientFactory?: () => LarkReplyClient;
}

/** Replies in the Lark/Feishu thread that produced an inbound event. */
export async function postLarkThreadReply(
  event: InboundSurfaceEvent,
  presentation: SurfacePresentation,
  options: LarkThreadReplyOptions,
): Promise<{ readonly externalMessageId?: string }> {
  if (event.provider !== "lark") {
    throw new Error("Cannot post a Lark reply for a non-Lark event");
  }
  if (event.callback.provider !== "lark" || event.callback.mode !== "lark_thread") {
    throw new Error("Lark event callback route is not a Lark thread");
  }
  const messageId = required(event.callback.target["messageId"], "Lark callback messageId");
  const appId = required(options.appId, "Lark App ID");
  const appSecret = required(options.appSecret, "Lark App Secret");
  const client =
    options.clientFactory?.() ??
    (new lark.Client({
      appId,
      appSecret,
      domain: options.domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark,
    }) as LarkReplyClient);
  const api = client.im.message ?? client.im.v1?.message;
  const content = JSON.stringify(renderLarkPresentation(presentation));
  const replacing = options.replaceMessageId?.trim();
  if (replacing !== undefined && replacing.length > 0) {
    if (api?.patch === undefined) throw new Error("Lark client does not support message.patch");
    await api.patch({ path: { message_id: replacing }, data: { content } });
    return { externalMessageId: replacing };
  }
  if (api?.reply === undefined) throw new Error("Lark client does not support message.reply");
  const response = await api.reply({
    path: { message_id: messageId },
    data: {
      content,
      msg_type: "interactive",
      reply_in_thread: true,
    },
  });
  const externalMessageId = larkMessageId(response);
  return externalMessageId === undefined ? {} : { externalMessageId };
}

function larkMessageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("data" in value)) return undefined;
  const data = (value as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("message_id" in data)) return undefined;
  const id = (data as { readonly message_id?: unknown }).message_id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
