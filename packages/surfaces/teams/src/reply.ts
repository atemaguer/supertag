import type { IHttpServerAdapter } from "@microsoft/teams.apps";
import { App } from "@microsoft/teams.apps";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { SurfacePresentation, SurfaceReplyCapabilities } from "@supertag/surface-sdk";
import { renderTeamsPresentation, type TeamsMarkdownActivity } from "./render.js";

interface TeamsReplyApp {
  initialize(): Promise<void>;
  readonly api: {
    readonly conversations: {
      updateActivity(
        conversationId: string,
        activityId: string,
        activity: TeamsMarkdownActivity,
      ): Promise<unknown>;
    };
  };
  reply(
    conversationId: string,
    activityId: string,
    activity: TeamsMarkdownActivity,
  ): Promise<unknown>;
}

export const teamsReplyCapabilities = {
  replacement: true,
} as const satisfies SurfaceReplyCapabilities;

export interface TeamsThreadReplyOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly tenantId: string;
  readonly replaceActivityId?: string;
  readonly appFactory?: (serviceUrl: string) => TeamsReplyApp;
}

/** Posts a response to the Teams channel thread that produced an inbound event. */
export async function postTeamsThreadReply(
  event: InboundSurfaceEvent,
  presentation: SurfacePresentation,
  options: TeamsThreadReplyOptions,
): Promise<{ readonly externalMessageId?: string }> {
  if (event.provider !== "teams")
    throw new Error("Cannot post a Teams reply for a non-Teams event");
  if (event.callback.provider !== "teams" || event.callback.mode !== "teams_thread") {
    throw new Error("Teams event callback route is not a Teams thread");
  }
  const conversationId = requiredCallbackField(event, "conversationId");
  const activityId = requiredCallbackField(event, "activityId");
  const serviceUrl = requiredCallbackField(event, "serviceUrl");
  const appId = required(options.appId, "Microsoft app ID");
  const appSecret = required(options.appSecret, "Microsoft app secret");
  const tenantId = required(options.tenantId, "Microsoft tenant ID");
  const app =
    options.appFactory?.(serviceUrl) ??
    (new App({
      clientId: appId,
      clientSecret: appSecret,
      tenantId,
      serviceUrl,
      httpServerAdapter: new PassiveHttpAdapter(),
    }) as TeamsReplyApp);
  await app.initialize();
  const rendered = renderTeamsPresentation(presentation);
  const replacing = options.replaceActivityId?.trim();
  if (replacing !== undefined && replacing.length > 0) {
    await app.api.conversations.updateActivity(conversationId, replacing, rendered);
    return { externalMessageId: replacing };
  }
  const response = await app.reply(conversationId, activityId, rendered);
  const externalMessageId = teamsActivityId(response);
  return externalMessageId === undefined ? {} : { externalMessageId };
}

class PassiveHttpAdapter implements IHttpServerAdapter {
  registerRoute(): void {}
}

function requiredCallbackField(event: InboundSurfaceEvent, field: string): string {
  return required(event.callback.target[field], `Teams callback ${field}`);
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function teamsActivityId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}
