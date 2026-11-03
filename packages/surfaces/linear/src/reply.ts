import type { InboundSurfaceEvent } from "@supertag/core";
import type { SurfacePresentation, SurfaceReplyCapabilities } from "@supertag/surface-sdk";
import { z } from "zod";
import { renderLinearPresentation } from "./render.js";

export const linearReplyCapabilities = {
  replacement: true,
} as const satisfies SurfaceReplyCapabilities;

const createResponseSchema = z.object({
  data: z.object({
    commentCreate: z.object({
      success: z.boolean(),
      comment: z.object({ id: z.string().min(1) }).nullable(),
    }),
  }),
});

const updateResponseSchema = z.object({
  data: z.object({
    commentUpdate: z.object({
      success: z.boolean(),
      comment: z.object({ id: z.string().min(1) }).nullable(),
    }),
  }),
});

const errorSchema = z.object({
  errors: z.array(z.object({ message: z.string().min(1) })).min(1),
});

export interface LinearIssueReplyOptions {
  readonly apiKey: string;
  readonly apiBaseUrl?: string;
  readonly replaceCommentId?: string;
  readonly request?: typeof fetch;
}

/** Posts a comment to the Linear issue that produced an inbound event. */
export async function postLinearIssueReply(
  event: InboundSurfaceEvent,
  presentation: SurfacePresentation,
  options: LinearIssueReplyOptions,
): Promise<{ readonly externalMessageId?: string }> {
  if (event.provider !== "linear") {
    throw new Error("Cannot post a Linear reply for a non-Linear event");
  }
  if (event.callback.provider !== "linear" || event.callback.mode !== "linear_issue_comment") {
    throw new Error("Linear event callback route is not an issue comment");
  }
  const issueId = event.callback.target["issueId"]?.trim();
  if (!issueId) {
    throw new Error("Linear callback route is missing issueId");
  }
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("A Linear API key is required to post a reply");
  }
  const body = renderLinearPresentation(presentation);
  const replacing = options.replaceCommentId?.trim();

  const response = await (options.request ?? fetch)(normalizeLinearApiUrl(options.apiBaseUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
      "user-agent": "supertag-gateway",
    },
    body: JSON.stringify({
      query:
        replacing === undefined || replacing.length === 0
          ? `mutation SuperTagLinearReply($input: CommentCreateInput!) {
              commentCreate(input: $input) { success comment { id } }
            }`
          : `mutation SuperTagLinearReplyUpdate($id: String!, $input: CommentUpdateInput!) {
              commentUpdate(id: $id, input: $input) { success comment { id } }
            }`,
      variables:
        replacing === undefined || replacing.length === 0
          ? { input: { issueId, body } }
          : { id: replacing, input: { body } },
    }),
  });
  if (!response.ok) {
    throw new Error(`Linear comment creation failed with HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const graphQlError = errorSchema.safeParse(payload);
  if (graphQlError.success) {
    throw new Error(
      `Linear comment creation failed: ${graphQlError.data.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  if (replacing !== undefined && replacing.length > 0) {
    const parsed = updateResponseSchema.parse(payload);
    if (!parsed.data.commentUpdate.success || !parsed.data.commentUpdate.comment) {
      throw new Error("Linear comment update was not successful");
    }
    return { externalMessageId: parsed.data.commentUpdate.comment.id };
  }
  const parsed = createResponseSchema.parse(payload);
  if (!parsed.data.commentCreate.success || !parsed.data.commentCreate.comment)
    throw new Error("Linear comment creation was not successful");
  return { externalMessageId: parsed.data.commentCreate.comment.id };
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
