import type { InboundSurfaceEvent } from "@supertag/core";
import type { SurfacePresentation, SurfaceReplyCapabilities } from "@supertag/surface-sdk";
import { renderGitHubPresentation } from "./render.js";

export const githubReplyCapabilities = {
  replacement: true,
} as const satisfies SurfaceReplyCapabilities;

export interface GitHubThreadReplyOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly replaceCommentId?: string;
  readonly request?: typeof fetch;
}

/** Posts a comment to the issue or pull request that produced an inbound event. */
export async function postGitHubThreadReply(
  event: InboundSurfaceEvent,
  presentation: SurfacePresentation,
  options: GitHubThreadReplyOptions,
): Promise<{ readonly externalMessageId?: string }> {
  if (event.provider !== "github") {
    throw new Error("Cannot post a GitHub reply for a non-GitHub event");
  }
  if (event.callback.provider !== "github" || event.callback.mode !== "github_issue_comment") {
    throw new Error("GitHub event callback route is not an issue or pull-request thread");
  }

  const repository = requiredCallbackField(event, "repository");
  const number = requiredCallbackField(event, "number");
  const repositoryParts = repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part.trim().length === 0)) {
    throw new Error("GitHub callback repository must be in owner/name format");
  }
  const repositoryPath = repositoryParts.map((segment) => encodeURIComponent(segment)).join("/");
  if (!/^[1-9]\d*$/.test(number)) {
    throw new Error("GitHub callback number must be a positive integer");
  }
  if (options.token.trim().length === 0) {
    throw new Error("A GitHub token is required to post a reply");
  }

  const replacing = options.replaceCommentId?.trim();
  if (replacing !== undefined && replacing.length > 0 && !/^[1-9]\d*$/u.test(replacing)) {
    throw new Error("GitHub replacement comment ID must be a positive integer");
  }
  const response = await (options.request ?? fetch)(
    replacing === undefined || replacing.length === 0
      ? `${normalizeApiBaseUrl(options.apiBaseUrl)}/repos/${repositoryPath}/issues/${number}/comments`
      : `${normalizeApiBaseUrl(options.apiBaseUrl)}/repos/${repositoryPath}/issues/comments/${replacing}`,
    {
      method: replacing === undefined || replacing.length === 0 ? "POST" : "PATCH",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "user-agent": "supertag-gateway",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ body: renderGitHubPresentation(presentation) }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub comment ${replacing ? "update" : "creation"} failed with HTTP ${response.status}`,
    );
  }
  const externalMessageId = await githubCommentId(response);
  return externalMessageId === undefined ? {} : { externalMessageId };
}

async function githubCommentId(response: Response): Promise<string | undefined> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== "object" || payload === null || !("id" in payload)) return undefined;
  const id = (payload as { readonly id?: unknown }).id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
  return typeof id === "string" && /^[1-9]\d*$/u.test(id.trim()) ? id.trim() : undefined;
}

function requiredCallbackField(event: InboundSurfaceEvent, field: string): string {
  const value = event.callback.target[field];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`GitHub callback route is missing ${field}`);
  }
  return value;
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
