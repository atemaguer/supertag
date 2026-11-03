import type { IHttpServerAdapter, IHttpServerResponse } from "@microsoft/teams.apps";
import { App } from "@microsoft/teams.apps";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { InboundEventSink, VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { z } from "zod";

const teamsTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().min(1).optional(),
});

const teamsActivitySchema = z.object({
  type: z.string(),
  id: z.string().min(1).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  serviceUrl: z.string().url().optional(),
  channelId: z.string().optional(),
  from: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      aadObjectId: z.string().optional(),
      role: z.string().optional(),
    })
    .optional(),
  recipient: z.object({ id: z.string().min(1), name: z.string().optional() }).optional(),
  conversation: z
    .object({
      id: z.string().min(1),
      conversationType: z.string().optional(),
      tenantId: z.string().optional(),
    })
    .optional(),
  text: z.string().optional(),
  replyToId: z.string().optional(),
  entities: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        mentioned: z.object({ id: z.string().min(1), name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  channelData: z
    .object({
      tenant: z.object({ id: z.string().min(1) }).optional(),
      team: z
        .object({
          id: z.string().min(1),
          aadGroupId: z.string().min(1).optional(),
        })
        .optional(),
      channel: z.object({ id: z.string().min(1) }).optional(),
    })
    .passthrough()
    .optional(),
});

export interface TeamsSetupInput {
  readonly appId: string;
  readonly appSecret: string;
  readonly tenantId: string;
  readonly tenantName?: string;
}

export function teamsChannelScope(teamId: string, channelId: string): string {
  const team = requiredIdentifier(teamId, "Teams team ID");
  const channel = requiredIdentifier(channelId, "Teams channel ID");
  return `team:${team}/channel:${channel}`;
}

export async function verifyTeamsAccount(
  input: TeamsSetupInput,
  request: typeof fetch = fetch,
): Promise<VerifiedSurfaceAccount> {
  const appId = requiredIdentifier(input.appId, "Microsoft app ID");
  const appSecret = requiredIdentifier(input.appSecret, "Microsoft app secret");
  const tenantId = requiredIdentifier(input.tenantId, "Microsoft tenant ID");
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const response = await request(tokenUrl, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    }),
  });
  if (!response.ok) {
    throw new Error(`Microsoft bot credentials failed verification with HTTP ${response.status}`);
  }
  teamsTokenResponseSchema.parse(await response.json());

  return {
    provider: "teams",
    externalAccountId: tenantId,
    displayName: input.tenantName?.trim() || tenantId,
    authMethod: "teams-client-secret",
    configuration: { appId },
    secrets: { appSecret },
  };
}

export function normalizeTeamsActivity(
  payload: unknown,
  expectedTenantId: string,
  appId: string,
): InboundSurfaceEvent | undefined {
  const parsed = teamsActivitySchema.safeParse(payload);
  if (!parsed.success || parsed.data.type !== "message") return undefined;
  const activity = parsed.data;
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;
  if (tenantId !== expectedTenantId) {
    throw new Error("Teams activity belongs to a different tenant");
  }
  if (activity.channelId !== undefined && activity.channelId !== "msteams") return undefined;

  // Teams activities expose both the stable Microsoft 365 group ID and an
  // internal thread ID for the team. Prefer the group ID because it is the ID
  // users receive from Teams/Graph and therefore the one Tag routes bind.
  const teamId = activity.channelData?.team?.aadGroupId ?? activity.channelData?.team?.id;
  const channelId = activity.channelData?.channel?.id;
  const conversationId = activity.conversation?.id;
  const activityId = activity.id;
  const actor = activity.from;
  const recipientId = activity.recipient?.id ?? appId;
  if (
    teamId === undefined ||
    channelId === undefined ||
    conversationId === undefined ||
    activityId === undefined ||
    actor === undefined
  ) {
    return undefined;
  }
  if (actor.role === "bot" || actor.id === recipientId || actor.id === appId) return undefined;

  const mentions = (activity.entities ?? []).filter(
    (entity) => entity.type === "mention" && entity.mentioned?.id === recipientId,
  );
  if (mentions.length === 0) return undefined;

  const threadRootId = activity.replyToId ?? activityId;
  const text = stripTeamsMentions(
    activity.text ?? "",
    mentions.flatMap((mention) => (mention.text === undefined ? [] : [mention.text])),
  );
  const occurredAt = activity.timestamp ?? new Date().toISOString();

  return {
    eventId: activityId,
    logicalEventId: `message:${tenantId}:${conversationId}:${activityId}`,
    provider: "teams",
    externalAccountId: tenantId,
    kind: "mention",
    scope: teamsChannelScope(teamId, channelId),
    sessionKey: `teams:${tenantId}:${conversationId}:${threadRootId}`,
    actor: {
      id: actor.aadObjectId ?? actor.id,
      ...(actor.name === undefined ? {} : { displayName: actor.name }),
      kind: "user",
    },
    ...(text.length === 0 ? {} : { text }),
    occurredAt,
    callback: {
      provider: "teams",
      mode: "teams_thread",
      threadKey: `${tenantId}|${conversationId}|${threadRootId}`,
      target: {
        conversationId,
        activityId: threadRootId,
        serviceUrl: requiredServiceUrl(activity.serviceUrl),
      },
    },
    source: {
      tenantId,
      teamId,
      channelId,
      conversationId,
      activityId,
      threadRootId,
    },
    metadata: { teamsActivityType: activity.type },
  };
}

export interface TeamsHttpResponse {
  readonly status: number;
  readonly body?: unknown;
}

interface TeamsAppLike {
  initialize(): Promise<void>;
  on(name: "message", handler: (context: { readonly activity: unknown }) => Promise<void>): unknown;
  readonly server: {
    handleRequest(request: {
      readonly body: unknown;
      readonly headers: Record<string, string | string[]>;
    }): Promise<IHttpServerResponse>;
  };
}

export interface TeamsHttpSurfaceOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly tenantId: string;
  readonly sink: InboundEventSink;
  readonly appFactory?: () => TeamsAppLike;
}

/** Embeds the official Teams activity/auth pipeline into the existing Gateway HTTP server. */
export class TeamsHttpSurface {
  readonly #app: TeamsAppLike;
  readonly #appId: string;
  readonly #tenantId: string;
  readonly #sink: InboundEventSink;

  constructor(options: TeamsHttpSurfaceOptions) {
    this.#appId = requiredIdentifier(options.appId, "Microsoft app ID");
    this.#tenantId = requiredIdentifier(options.tenantId, "Microsoft tenant ID");
    requiredIdentifier(options.appSecret, "Microsoft app secret");
    this.#sink = options.sink;
    this.#app =
      options.appFactory?.() ??
      (new App({
        clientId: this.#appId,
        clientSecret: options.appSecret,
        tenantId: this.#tenantId,
        httpServerAdapter: new PassiveHttpAdapter(),
        messagingEndpoint: "/api/messages",
      }) as TeamsAppLike);
    this.#app.on("message", async ({ activity }) => {
      const event = normalizeTeamsActivity(activity, this.#tenantId, this.#appId);
      if (event !== undefined) await this.#sink(event);
    });
  }

  async start(): Promise<void> {
    await this.#app.initialize();
  }

  async handle(rawBody: string, authorization: string | undefined): Promise<TeamsHttpResponse> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    const response = await this.#app.server.handleRequest({
      body,
      headers: authorization === undefined ? {} : { authorization },
    });
    return {
      status: response.status,
      ...(response.body === undefined ? {} : { body: response.body }),
    };
  }
}

class PassiveHttpAdapter implements IHttpServerAdapter {
  registerRoute(): void {}
}

function stripTeamsMentions(text: string, mentions: readonly string[]): string {
  let result = text;
  for (const mention of mentions) result = result.replaceAll(mention, "");
  return result.replace(/^\s*[:,;-]?\s*/u, "").trim();
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required`);
  return normalized;
}

function requiredServiceUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("Teams activity is missing serviceUrl");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Teams activity serviceUrl must use HTTPS");
  return url.toString().replace(/\/$/u, "");
}

export {
  renderTeamsPresentation,
  type TeamsMarkdownActivity,
} from "./render.js";
export {
  postTeamsThreadReply,
  type TeamsThreadReplyOptions,
  teamsReplyCapabilities,
} from "./reply.js";
