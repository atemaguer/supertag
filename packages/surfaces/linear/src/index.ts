import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { z } from "zod";

export { renderLinearPresentation } from "./render.js";
export {
  type LinearIssueReplyOptions,
  linearReplyCapabilities,
  postLinearIssueReply,
} from "./reply.js";

const actorSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1).optional(),
});

const webhookEnvelopeSchema = z
  .object({
    action: z.string().min(1),
    actor: actorSchema,
    data: z.unknown(),
    type: z.string().min(1),
    url: z.string().url(),
    createdAt: z.string().min(1),
    organizationId: z.string().min(1),
    webhookTimestamp: z.number().int().nonnegative(),
    webhookId: z.string().min(1),
  })
  .transform(({ organizationId: workspaceId, ...payload }) => ({ ...payload, workspaceId }));

const issueWebhookDataSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  teamId: z.string().min(1),
});

const commentWebhookDataSchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  issueId: z.string().min(1),
});

const accountResponseSchema = z.object({
  data: z.object({
    workspace: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      urlKey: z.string().min(1).optional(),
    }),
    viewer: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      email: z.string().min(1),
    }),
  }),
});

const teamsResponseSchema = z.object({
  data: z.object({
    teams: z.object({
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          key: z.string().min(1),
          name: z.string().min(1),
        }),
      ),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
    }),
  }),
});

const issueResponseSchema = z.object({
  data: z.object({
    issue: z.object({
      id: z.string().min(1),
      identifier: z.string().min(1),
      title: z.string().min(1),
      team: z.object({
        id: z.string().min(1),
        name: z.string().min(1),
      }),
    }),
  }),
});

const graphQlErrorSchema = z.object({
  errors: z.array(z.object({ message: z.string().min(1) })).min(1),
});

export interface LinearSetupInput {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly apiBaseUrl?: string;
}

export interface LinearWebhookRequest {
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly eventName: string | undefined;
  readonly webhookSecret: string;
  readonly externalAccountId: string;
  readonly apiKey: string;
  readonly apiBaseUrl?: string;
  readonly mention?: string;
  readonly request?: typeof fetch;
}

export interface LinearTeamScope {
  readonly scope: string;
  readonly displayName: string;
}

interface LinearIssueContext {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly teamId: string;
  readonly teamName?: string;
}

export function linearTeamScope(teamId: string): string {
  const normalized = teamId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error("Linear team ID must be a UUID");
  }
  return `team:${normalized}`;
}

export async function verifyLinearAccount(
  input: LinearSetupInput,
  request: typeof fetch = fetch,
): Promise<VerifiedSurfaceAccount> {
  const apiKey = required(input.apiKey, "A Linear API key");
  const webhookSecret = required(input.webhookSecret, "A Linear webhook signing secret");
  const apiBaseUrl = normalizeLinearApiUrl(input.apiBaseUrl);
  const payload = accountResponseSchema.parse(
    await linearGraphQl(
      apiKey,
      apiBaseUrl,
      `query SuperTagLinearAccount {
        workspace: organization { id name urlKey }
        viewer { id name email }
      }`,
      {},
      request,
    ),
  );

  return {
    provider: "linear",
    externalAccountId: payload.data.workspace.id,
    displayName: payload.data.workspace.name,
    authMethod: "linear-api-key",
    configuration: {
      apiBaseUrl,
      workspaceId: payload.data.workspace.id,
      workspaceName: payload.data.workspace.name,
      workspaceUrlKey: payload.data.workspace.urlKey ?? null,
      actorId: payload.data.viewer.id,
      actorName: payload.data.viewer.name,
      actorEmail: payload.data.viewer.email,
    },
    secrets: { apiKey, webhookSecret },
  };
}

export async function resolveLinearTeamScope(
  team: string,
  apiKey: string,
  apiBaseUrl?: string,
  request: typeof fetch = fetch,
): Promise<LinearTeamScope> {
  const selector = required(team, "Linear team");
  const token = required(apiKey, "A Linear API key");
  const url = normalizeLinearApiUrl(apiBaseUrl);
  const teams: Array<{ readonly id: string; readonly key: string; readonly name: string }> = [];
  let after: string | null = null;

  do {
    const payload = teamsResponseSchema.parse(
      await linearGraphQl(
        token,
        url,
        `query SuperTagLinearTeams($after: String) {
          teams(first: 100, after: $after) {
            nodes { id key name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
        request,
      ),
    );
    teams.push(...payload.data.teams.nodes);
    after = payload.data.teams.pageInfo.hasNextPage ? payload.data.teams.pageInfo.endCursor : null;
    if (payload.data.teams.pageInfo.hasNextPage && after === null) {
      throw new Error("Linear team lookup returned an invalid pagination cursor");
    }
  } while (after !== null);

  const normalized = selector.toLowerCase();
  const matches = teams.filter(
    (candidate) =>
      candidate.id.toLowerCase() === normalized ||
      candidate.key.toLowerCase() === normalized ||
      candidate.name.toLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new Error(`No Linear team matches ${JSON.stringify(selector)}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Linear teams match ${JSON.stringify(selector)}; use --team-id with the team UUID`,
    );
  }
  const match = matches[0] as (typeof matches)[number];
  return { scope: linearTeamScope(match.id), displayName: `${match.name} (${match.key})` };
}

export async function parseLinearWebhook(
  input: LinearWebhookRequest,
  now = (): Date => new Date(),
): Promise<InboundSurfaceEvent | undefined> {
  verifyLinearWebhookSignature(input);
  const deliveryId = required(input.deliveryId, "Linear delivery ID");
  const eventName = required(input.eventName, "Linear event name");
  const payload = webhookEnvelopeSchema.parse(JSON.parse(input.rawBody));
  verifyLinearWebhookTimestamp(payload.webhookTimestamp, now());
  if (payload.workspaceId !== input.externalAccountId) {
    throw new Error("Linear webhook workspace does not match the Surface Account");
  }
  if (eventName.toLowerCase() !== payload.type.toLowerCase()) {
    throw new Error("Linear event header does not match the webhook payload type");
  }
  if (payload.action !== "create" && payload.action !== "update") {
    return undefined;
  }
  if (actorKind(payload.actor.type) === "bot") {
    return undefined;
  }

  const mention = input.mention ?? "@supertag";
  if (payload.type === "Issue") {
    const issue = issueWebhookDataSchema.parse(payload.data);
    if (!containsMention(issue.description, mention)) {
      return undefined;
    }
    return linearInboundEvent({
      deliveryId,
      payload,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        teamId: issue.teamId,
      },
      kind: "issue",
      sourceId: issue.id,
      text: issue.description ?? undefined,
    });
  }

  if (payload.type === "Comment") {
    const comment = commentWebhookDataSchema.parse(payload.data);
    if (!containsMention(comment.body, mention)) {
      return undefined;
    }
    const issue = await resolveLinearIssue(
      comment.issueId,
      input.apiKey,
      input.apiBaseUrl,
      input.request ?? fetch,
    );
    return linearInboundEvent({
      deliveryId,
      payload,
      issue,
      kind: "issue_comment",
      sourceId: comment.id,
      text: comment.body,
    });
  }

  return undefined;
}

/** Reads the routing identity before account-specific signature verification. */
export function linearWebhookAccountId(rawBody: string): string {
  return webhookEnvelopeSchema.parse(JSON.parse(rawBody)).workspaceId;
}

export function verifyLinearWebhookSignature(
  input: Pick<LinearWebhookRequest, "rawBody" | "signature" | "webhookSecret">,
): void {
  if (input.signature === undefined || !/^[0-9a-f]{64}$/iu.test(input.signature)) {
    throw new Error("Linear HMAC-SHA256 signature is required");
  }
  const expected = createHmac("sha256", input.webhookSecret).update(input.rawBody).digest();
  const actual = Buffer.from(input.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Linear webhook signature is invalid");
  }
}

interface LinearInboundEventInput {
  readonly deliveryId: string;
  readonly payload: z.infer<typeof webhookEnvelopeSchema>;
  readonly issue: LinearIssueContext;
  readonly kind: "issue" | "issue_comment";
  readonly sourceId: string;
  readonly text: string | undefined;
}

function linearInboundEvent(input: LinearInboundEventInput): InboundSurfaceEvent {
  return {
    eventId: input.deliveryId,
    logicalEventId: `${input.kind}:${input.payload.workspaceId}:${input.sourceId}`,
    provider: "linear",
    externalAccountId: input.payload.workspaceId,
    kind: input.kind,
    scope: linearTeamScope(input.issue.teamId),
    sessionKey: `linear:${input.payload.workspaceId}:issue:${input.issue.id}`,
    actor: {
      id: input.payload.actor.id,
      ...(input.payload.actor.name === undefined ? {} : { displayName: input.payload.actor.name }),
      kind: actorKind(input.payload.actor.type),
    },
    ...(input.text === undefined ? {} : { text: input.text }),
    occurredAt: new Date(input.payload.createdAt).toISOString(),
    callback: {
      provider: "linear",
      mode: "linear_issue_comment",
      threadKey: input.issue.id,
      target: { issueId: input.issue.id },
    },
    source: {
      workspaceId: input.payload.workspaceId,
      teamId: input.issue.teamId,
      ...(input.issue.teamName === undefined ? {} : { teamName: input.issue.teamName }),
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      issueTitle: input.issue.title,
      sourceId: input.sourceId,
      url: input.payload.url,
    },
    metadata: {
      action: input.payload.action,
      linearEvent: input.payload.type,
      webhookId: input.payload.webhookId,
    },
  };
}

async function resolveLinearIssue(
  issueId: string,
  apiKey: string,
  apiBaseUrl: string | undefined,
  request: typeof fetch,
): Promise<LinearIssueContext> {
  const payload = issueResponseSchema.parse(
    await linearGraphQl(
      required(apiKey, "A Linear API key"),
      normalizeLinearApiUrl(apiBaseUrl),
      `query SuperTagLinearIssue($id: String!) {
        issue(id: $id) { id identifier title team { id name } }
      }`,
      { id: issueId },
      request,
    ),
  );
  return {
    id: payload.data.issue.id,
    identifier: payload.data.issue.identifier,
    title: payload.data.issue.title,
    teamId: payload.data.issue.team.id,
    teamName: payload.data.issue.team.name,
  };
}

async function linearGraphQl(
  apiKey: string,
  apiBaseUrl: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  request: typeof fetch,
): Promise<unknown> {
  const response = await request(apiBaseUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
      "user-agent": "supertag",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Linear API request failed with HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const graphQlError = graphQlErrorSchema.safeParse(payload);
  if (graphQlError.success) {
    throw new Error(
      `Linear API request failed: ${graphQlError.data.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return payload;
}

function verifyLinearWebhookTimestamp(timestamp: number, now: Date): void {
  if (Math.abs(now.getTime() - timestamp) > 60_000) {
    throw new Error("Linear webhook timestamp is outside the 60-second replay window");
  }
}

function containsMention(text: string | null | undefined, mention: string): boolean {
  const normalizedMention = mention.trim().toLowerCase();
  if (text === null || text === undefined || normalizedMention.length === 0) {
    return false;
  }
  return text
    .toLowerCase()
    .split(/\s+/u)
    .some((token) => token.replace(/[\]()[\]{},.:;!?]+$/u, "") === normalizedMention);
}

function actorKind(type: string): "bot" | "unknown" | "user" {
  const normalized = type.toLowerCase();
  if (normalized === "user") {
    return "user";
  }
  if (
    normalized.includes("app") ||
    normalized.includes("bot") ||
    normalized.includes("integration") ||
    normalized.includes("oauth")
  ) {
    return "bot";
  }
  return "unknown";
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeLinearApiUrl(value: string | undefined): string {
  const apiUrl = new URL(value ?? "https://api.linear.app/graphql");
  if (
    apiUrl.protocol !== "https:" &&
    apiUrl.hostname !== "localhost" &&
    apiUrl.hostname !== "127.0.0.1"
  ) {
    throw new Error("Linear API URL must use HTTPS except for loopback development");
  }
  return apiUrl.href.replace(/\/$/u, "");
}
