import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { InboundSurfaceEvent } from "@supertag/core";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { z } from "zod";

export {
  closeGitHubPullRequest,
  GitHubPullRequestError,
  type GitHubPullRequestOptions,
  markGitHubPullRequestReady,
} from "./pull-request.js";
export { renderGitHubPresentation } from "./render.js";
export {
  type GitHubThreadReplyOptions,
  githubReplyCapabilities,
  postGitHubThreadReply,
} from "./reply.js";

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    type: z.string().optional(),
  }),
  repository_selection: z.string().optional(),
  permissions: z.record(z.string(), z.string()).optional(),
});

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  type: z.string().optional(),
});

const repositoryLookupSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full_name: z.string().min(1),
});

const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

const webhookActorSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  type: z.string().optional(),
});

const webhookRepositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  html_url: z.string().url(),
});

const issueCommentWebhookSchema = z.object({
  action: z.string().min(1),
  sender: webhookActorSchema,
  repository: webhookRepositorySchema,
  issue: z.object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string().nullable(),
    html_url: z.string().url(),
    created_at: z.string().min(1),
  }),
});

const issueWebhookSchema = z.object({
  action: z.string().min(1),
  sender: webhookActorSchema,
  repository: webhookRepositorySchema,
  issue: z.object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    body: z.string().nullable(),
    html_url: z.string().url(),
    created_at: z.string().min(1),
  }),
});

const pullRequestWebhookSchema = z.object({
  action: z.string().min(1),
  sender: webhookActorSchema,
  repository: webhookRepositorySchema,
  pull_request: z.object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    body: z.string().nullable(),
    html_url: z.string().url(),
    created_at: z.string().min(1),
  }),
});

export interface GitHubTokenSetupInput {
  readonly token: string;
  readonly webhookSecret?: string;
  readonly apiBaseUrl?: string;
}

export interface GitHubAppSetupInput {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly apiBaseUrl?: string;
}

export interface GitHubWebhookRequest {
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly eventName: string | undefined;
  readonly webhookSecret: string;
  readonly externalAccountId: string;
  readonly mention?: string;
}

export interface GitHubInstallationTokenInput {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly apiBaseUrl?: string;
}

export interface GitHubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface GitHubRepositoryScope {
  readonly scope: string;
  readonly displayName: string;
}

export function githubRepositoryScope(repositoryId: string | number): string {
  const normalized = String(repositoryId).trim();
  if (!/^\d+$/u.test(normalized) || normalized === "0") {
    throw new Error("GitHub repository ID must be a positive integer");
  }
  if (typeof repositoryId === "number" && !Number.isSafeInteger(repositoryId)) {
    throw new Error("GitHub repository ID must be a safe integer");
  }
  return `repository:${BigInt(normalized).toString()}`;
}

export async function resolveGitHubRepositoryScope(
  repository: string,
  token: string,
  apiBaseUrl?: string,
  request: typeof fetch = fetch,
): Promise<GitHubRepositoryScope> {
  const normalizedRepository = repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalizedRepository)) {
    throw new Error("GitHub repository must use owner/name format");
  }
  if (!token.trim()) {
    throw new Error("A GitHub token is required to resolve a repository");
  }
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const response = await request(`${baseUrl}/repos/${normalizedRepository}`, {
    redirect: "error",
    headers: githubHeaders(`Bearer ${token}`),
  });
  if (!response.ok) {
    throw new Error(`GitHub repository lookup failed with HTTP ${response.status}`);
  }
  const resolved = repositoryLookupSchema.parse(await response.json());
  return {
    scope: githubRepositoryScope(resolved.id),
    displayName: resolved.full_name,
  };
}

export async function verifyGitHubTokenAccount(
  input: GitHubTokenSetupInput,
  request: typeof fetch = fetch,
): Promise<VerifiedSurfaceAccount> {
  if (input.token.trim().length === 0) {
    throw new Error("A GitHub token is required");
  }
  if (input.webhookSecret !== undefined && input.webhookSecret.trim().length === 0) {
    throw new Error("A GitHub webhook secret cannot be empty when provided");
  }
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const response = await request(`${apiBaseUrl}/user`, {
    redirect: "error",
    headers: githubHeaders(`Bearer ${input.token}`),
  });

  if (!response.ok) {
    throw new Error(`GitHub token verification failed with HTTP ${response.status}`);
  }

  const user = userSchema.parse(await response.json());
  return {
    provider: "github",
    externalAccountId: `user-${user.id}`,
    displayName: user.login,
    authMethod: "github-token",
    configuration: {
      apiBaseUrl,
      accountId: String(user.id),
      accountLogin: user.login,
      accountType: user.type ?? null,
    },
    secrets: {
      token: input.token,
      ...(input.webhookSecret === undefined ? {} : { webhookSecret: input.webhookSecret }),
    },
  };
}

export async function verifyGitHubAppAccount(
  input: GitHubAppSetupInput,
  request: typeof fetch = fetch,
  now = (): Date => new Date(),
): Promise<VerifiedSurfaceAccount> {
  if (!/^\d+$/.test(input.appId) || !/^\d+$/.test(input.installationId)) {
    throw new Error("GitHub App and installation IDs must be numeric");
  }
  if (input.privateKey.trim().length === 0 || input.webhookSecret.trim().length === 0) {
    throw new Error("GitHub private key and webhook secret are required");
  }
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const response = await request(`${apiBaseUrl}/app/installations/${input.installationId}`, {
    redirect: "error",
    headers: githubHeaders(`Bearer ${createAppJwt(input.appId, input.privateKey, now())}`),
  });

  if (!response.ok) {
    throw new Error(`GitHub installation verification failed with HTTP ${response.status}`);
  }

  const installation = installationSchema.parse(await response.json());
  if (String(installation.id) !== input.installationId) {
    throw new Error("GitHub returned a different installation than requested");
  }

  return {
    provider: "github",
    externalAccountId: `installation-${installation.id}`,
    displayName: installation.account.login,
    authMethod: "github-app",
    configuration: {
      appId: input.appId,
      installationId: input.installationId,
      apiBaseUrl,
      accountType: installation.account.type ?? null,
      accountId: String(installation.account.id),
      repositorySelection: installation.repository_selection ?? null,
      permissions: installation.permissions ?? {},
    },
    secrets: {
      privateKey: input.privateKey,
      webhookSecret: input.webhookSecret,
    },
  };
}

export async function createGitHubInstallationToken(
  input: GitHubInstallationTokenInput,
  request: typeof fetch = fetch,
  now = (): Date => new Date(),
): Promise<GitHubInstallationToken> {
  if (!/^\d+$/.test(input.appId) || !/^\d+$/.test(input.installationId)) {
    throw new Error("GitHub App and installation IDs must be numeric");
  }
  if (!input.privateKey.trim()) {
    throw new Error("A GitHub App private key is required");
  }
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const response = await request(
    `${apiBaseUrl}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      redirect: "error",
      headers: githubHeaders(`Bearer ${createAppJwt(input.appId, input.privateKey, now())}`),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token creation failed with HTTP ${response.status}`);
  }
  const token = installationTokenSchema.parse(await response.json());
  return { token: token.token, expiresAt: token.expires_at };
}

export function parseGitHubWebhook(request: GitHubWebhookRequest): InboundSurfaceEvent | undefined {
  verifyGitHubWebhookSignature(request);
  if (request.deliveryId === undefined || request.deliveryId.trim().length === 0) {
    throw new Error("GitHub delivery ID is required");
  }
  if (request.eventName === undefined || request.eventName.trim().length === 0) {
    throw new Error("GitHub event name is required");
  }
  const payload: unknown = JSON.parse(request.rawBody);
  const mention = request.mention ?? "@supertag";

  if (request.eventName === "issue_comment") {
    const parsed = issueCommentWebhookSchema.parse(payload);
    if (parsed.action !== "created" && parsed.action !== "edited") {
      return undefined;
    }
    if (!containsMention(parsed.comment.body, mention)) {
      return undefined;
    }
    return githubInboundEvent({
      request,
      repository: parsed.repository,
      actor: parsed.sender,
      kind: "issue_comment",
      number: parsed.issue.number,
      text: parsed.comment.body ?? undefined,
      occurredAt: parsed.comment.created_at,
      url: parsed.comment.html_url,
      sourceId: String(parsed.comment.id),
      action: parsed.action,
      isPullRequest: parsed.issue.pull_request !== undefined,
    });
  }

  if (request.eventName === "issues") {
    const parsed = issueWebhookSchema.parse(payload);
    if (parsed.action !== "opened" && parsed.action !== "edited") {
      return undefined;
    }
    if (!containsMention(parsed.issue.body, mention)) {
      return undefined;
    }
    return githubInboundEvent({
      request,
      repository: parsed.repository,
      actor: parsed.sender,
      kind: "issue",
      number: parsed.issue.number,
      text: parsed.issue.body ?? undefined,
      occurredAt: parsed.issue.created_at,
      url: parsed.issue.html_url,
      sourceId: String(parsed.issue.id),
      action: parsed.action,
      isPullRequest: false,
    });
  }

  if (request.eventName === "pull_request") {
    const parsed = pullRequestWebhookSchema.parse(payload);
    if (parsed.action !== "opened" && parsed.action !== "edited") {
      return undefined;
    }
    if (!containsMention(parsed.pull_request.body, mention)) {
      return undefined;
    }
    return githubInboundEvent({
      request,
      repository: parsed.repository,
      actor: parsed.sender,
      kind: "pull_request",
      number: parsed.pull_request.number,
      text: parsed.pull_request.body ?? undefined,
      occurredAt: parsed.pull_request.created_at,
      url: parsed.pull_request.html_url,
      sourceId: String(parsed.pull_request.id),
      action: parsed.action,
      isPullRequest: true,
    });
  }

  return undefined;
}

function containsMention(text: string | null, mention: string): boolean {
  const normalizedMention = mention.trim().toLowerCase();
  if (text === null || normalizedMention.length === 0) {
    return false;
  }
  return text
    .toLowerCase()
    .split(/\s+/u)
    .some((token) => token.replace(/[),.:;!?]+$/u, "") === normalizedMention);
}

export function verifyGitHubWebhookSignature(
  request: Pick<GitHubWebhookRequest, "rawBody" | "signature" | "webhookSecret">,
): void {
  if (request.signature === undefined || !request.signature.startsWith("sha256=")) {
    throw new Error("GitHub SHA-256 signature is required");
  }
  const expected = `sha256=${createHmac("sha256", request.webhookSecret)
    .update(request.rawBody)
    .digest("hex")}`;
  const actualBuffer = Buffer.from(request.signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("GitHub webhook signature is invalid");
  }
}

interface GitHubInboundEventInput {
  readonly request: GitHubWebhookRequest;
  readonly repository: z.infer<typeof webhookRepositorySchema>;
  readonly actor: z.infer<typeof webhookActorSchema>;
  readonly kind: "issue" | "issue_comment" | "pull_request";
  readonly number: number;
  readonly text: string | undefined;
  readonly occurredAt: string;
  readonly url: string;
  readonly sourceId: string;
  readonly action: string;
  readonly isPullRequest: boolean;
}

function githubInboundEvent(input: GitHubInboundEventInput): InboundSurfaceEvent | undefined {
  if (input.actor.type?.toLowerCase() === "bot") {
    return undefined;
  }
  const threadKind = input.isPullRequest ? "pull" : "issue";
  return {
    eventId: input.request.deliveryId ?? "",
    logicalEventId: `${input.kind}:${input.repository.id}:${input.sourceId}`,
    provider: "github",
    externalAccountId: input.request.externalAccountId,
    kind: input.kind,
    scope: githubRepositoryScope(input.repository.id),
    sessionKey: `github:${input.request.externalAccountId}:${input.repository.full_name}:${threadKind}:${input.number}`,
    actor: {
      id: String(input.actor.id),
      displayName: input.actor.login,
      kind: input.actor.type?.toLowerCase() === "bot" ? "bot" : "user",
    },
    ...(input.text === undefined ? {} : { text: input.text }),
    occurredAt: new Date(input.occurredAt).toISOString(),
    callback: {
      provider: "github",
      mode: "github_issue_comment",
      threadKey: `${input.repository.full_name}#${input.number}`,
      target: {
        repository: input.repository.full_name,
        number: String(input.number),
      },
    },
    source: {
      repositoryId: String(input.repository.id),
      repository: input.repository.full_name,
      number: String(input.number),
      sourceId: input.sourceId,
      url: input.url,
    },
    metadata: {
      action: input.action,
      githubEvent: input.request.eventName ?? "",
      isPullRequest: input.isPullRequest,
    },
  };
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const apiUrl = new URL(value ?? "https://api.github.com");
  if (
    apiUrl.protocol !== "https:" &&
    apiUrl.hostname !== "localhost" &&
    apiUrl.hostname !== "127.0.0.1"
  ) {
    throw new Error("GitHub API URL must use HTTPS except for loopback development");
  }
  return apiUrl.href.replace(/\/$/, "");
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "x-github-api-version": "2026-03-10",
    "user-agent": "supertag-cli",
  };
}

function createAppJwt(appId: string, privateKey: string, time: Date): string {
  const issuedAt = Math.floor(time.getTime() / 1000) - 60;
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({ iat: issuedAt, exp: issuedAt + 600, iss: appId });
  const unsignedToken = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsignedToken).sign(privateKey, "base64url");
  return `${unsignedToken}.${signature}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
