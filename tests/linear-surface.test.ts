import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../apps/cli/src/index.ts";
import { setupLinear } from "../apps/cli/src/setup.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import {
  linearTeamScope,
  parseLinearWebhook,
  postLinearIssueReply,
  resolveLinearTeamScope,
  verifyLinearAccount,
  verifyLinearWebhookSignature,
} from "../packages/surfaces/linear/src/index.ts";

const now = new Date("2026-08-01T00:00:00.000Z");
const teamId = "72b2a2dc-6f4f-4423-9d34-24b5bd10634a";
const workspaceId = "dc844923-f9a4-40a3-825c-dea7747e57d6";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Linear surface setup", () => {
  it("verifies the workspace and stores credentials outside account metadata", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          workspace: { id: workspaceId, name: "Acme", urlKey: "acme" },
          viewer: { id: "user-1", name: "Atem", email: "atem@example.com" },
        },
      }),
    );

    const account = await verifyLinearAccount(
      { apiKey: "lin_api_test", webhookSecret: "linear-webhook-secret" },
      request,
    );

    expect(account).toMatchObject({
      provider: "linear",
      externalAccountId: workspaceId,
      displayName: "Acme",
      authMethod: "linear-api-key",
      configuration: {
        workspaceId,
        workspaceName: "Acme",
        actorId: "user-1",
      },
      secrets: { apiKey: "lin_api_test", webhookSecret: "linear-webhook-secret" },
    });
    expect(JSON.stringify(account.configuration)).not.toContain("lin_api_test");
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("lin_api_test");
    expect(request).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("supports non-interactive CLI setup and documents required credentials", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_test");
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", "linear-webhook-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: {
            workspace: { id: workspaceId, name: "Acme", urlKey: "acme" },
            viewer: { id: "user-1", name: "Atem", email: "atem@example.com" },
          },
        }),
      ),
    );
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(setupLinear([])).resolves.toMatchObject({ provider: "linear" });
    await expect(main(["setup", "linear", "--help"])).resolves.toBe(0);

    const text = output.mock.calls.map(([value]) => String(value)).join("");
    expect(text).toContain("LINEAR_API_KEY");
    expect(text).toContain("LINEAR_WEBHOOK_SECRET");
    expect(text).not.toContain("lin_api_test");
  });
});

describe("Linear team scopes", () => {
  it("uses stable lowercase team UUIDs", () => {
    expect(linearTeamScope(teamId.toUpperCase())).toBe(`team:${teamId}`);
    expect(() => linearTeamScope("ENG")).toThrow("UUID");
  });

  it("resolves a team key or name through the enrolled workspace", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          teams: {
            nodes: [{ id: teamId, key: "ENG", name: "Engineering" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );

    await expect(
      resolveLinearTeamScope("eng", "lin_api_test", undefined, request),
    ).resolves.toEqual({ scope: `team:${teamId}`, displayName: "Engineering (ENG)" });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.variables).toEqual({ after: null });
  });
});

describe("Linear webhook ingestion", () => {
  it("verifies the HMAC and normalizes an issue description mention", async () => {
    const rawBody = issuePayload();
    const signature = sign(rawBody);

    expect(() =>
      verifyLinearWebhookSignature({
        rawBody,
        signature,
        webhookSecret: "linear-webhook-secret",
      }),
    ).not.toThrow();
    await expect(
      parseLinearWebhook(
        {
          rawBody,
          signature,
          deliveryId: "delivery-linear-1",
          eventName: "Issue",
          webhookSecret: "linear-webhook-secret",
          externalAccountId: workspaceId,
          apiKey: "lin_api_test",
        },
        () => now,
      ),
    ).resolves.toEqual({
      eventId: "delivery-linear-1",
      logicalEventId: `issue:${workspaceId}:issue-1`,
      provider: "linear",
      externalAccountId: workspaceId,
      kind: "issue",
      scope: `team:${teamId}`,
      sessionKey: `linear:${workspaceId}:issue:issue-1`,
      actor: { id: "user-2", displayName: "Jane", kind: "user" },
      text: "@supertag investigate the failed deployment",
      occurredAt: now.toISOString(),
      callback: {
        provider: "linear",
        mode: "linear_issue_comment",
        threadKey: "issue-1",
        target: { issueId: "issue-1" },
      },
      source: {
        workspaceId,
        teamId,
        issueId: "issue-1",
        issueIdentifier: "ENG-42",
        issueTitle: "Deployment failed",
        sourceId: "issue-1",
        url: "https://linear.app/acme/issue/ENG-42/deployment-failed",
      },
      metadata: { action: "create", linearEvent: "Issue", webhookId: "webhook-1" },
    });
  });

  it("resolves the parent issue before routing a comment mention", async () => {
    const rawBody = commentPayload();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          issue: {
            id: "issue-1",
            identifier: "ENG-42",
            title: "Deployment failed",
            team: { id: teamId, name: "Engineering" },
          },
        },
      }),
    );

    await expect(
      parseLinearWebhook(
        {
          rawBody,
          signature: sign(rawBody),
          deliveryId: "delivery-linear-2",
          eventName: "Comment",
          webhookSecret: "linear-webhook-secret",
          externalAccountId: workspaceId,
          apiKey: "lin_api_test",
          request,
        },
        () => now,
      ),
    ).resolves.toMatchObject({
      logicalEventId: `issue_comment:${workspaceId}:comment-1`,
      kind: "issue_comment",
      scope: `team:${teamId}`,
      text: "@supertag summarize this issue",
      callback: { target: { issueId: "issue-1" } },
      source: { teamName: "Engineering", issueIdentifier: "ENG-42" },
    });
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("lin_api_test");
  });

  it("rejects invalid signatures, stale deliveries, and workspace mismatches", async () => {
    const rawBody = issuePayload();
    const base = {
      rawBody,
      signature: sign(rawBody),
      deliveryId: "delivery-linear-3",
      eventName: "Issue",
      webhookSecret: "linear-webhook-secret",
      externalAccountId: workspaceId,
      apiKey: "lin_api_test",
    } as const;

    await expect(
      parseLinearWebhook({ ...base, signature: "0".repeat(64) }, () => now),
    ).rejects.toThrow("signature is invalid");
    await expect(parseLinearWebhook(base, () => new Date(now.getTime() + 60_001))).rejects.toThrow(
      "replay window",
    );
    await expect(
      parseLinearWebhook({ ...base, externalAccountId: "another-workspace" }, () => now),
    ).rejects.toThrow("workspace does not match");
  });
});

describe("Linear issue replies", () => {
  it("creates a comment on the originating issue", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: { commentCreate: { success: true, comment: { id: "reply-1" } } },
      }),
    );

    await expect(
      postLinearIssueReply(
        linearEvent(),
        { kind: "final-result", markdown: "Static worker response" },
        {
          apiKey: "lin_api_test",
          request,
        },
      ),
    ).resolves.toEqual({ externalMessageId: "reply-1" });

    const call = request.mock.calls[0];
    expect(call?.[0]).toBe("https://api.linear.app/graphql");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("authorization")).toBe("lin_api_test");
    expect(JSON.parse(String(call?.[1]?.body)).variables).toEqual({
      input: { issueId: "issue-1", body: "Static worker response" },
    });
  });

  it("replaces an existing issue comment", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: { commentUpdate: { success: true, comment: { id: "reply-1" } } },
      }),
    );

    await expect(
      postLinearIssueReply(
        linearEvent(),
        { kind: "status", markdown: "Inspecting the issue" },
        { apiKey: "lin_api_test", replaceCommentId: "reply-1", request },
      ),
    ).resolves.toEqual({ externalMessageId: "reply-1" });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      variables: { id: "reply-1", input: { body: "Inspecting the issue" } },
    });
  });

  it("does not expose its API key in provider errors", async () => {
    const apiKey = "lin_api_do_not_expose";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ errors: [{ message: "Forbidden" }] }));
    const reply = postLinearIssueReply(
      linearEvent(),
      { kind: "final-result", markdown: "reply" },
      { apiKey, request },
    );
    await expect(reply).rejects.toThrow("Forbidden");
    await expect(reply).rejects.not.toThrow(apiKey);
  });
});

function issuePayload(): string {
  return JSON.stringify({
    action: "create",
    actor: { id: "user-2", type: "user", name: "Jane" },
    data: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Deployment failed",
      description: "@supertag investigate the failed deployment",
      teamId,
    },
    type: "Issue",
    url: "https://linear.app/acme/issue/ENG-42/deployment-failed",
    createdAt: now.toISOString(),
    organizationId: workspaceId,
    webhookTimestamp: now.getTime(),
    webhookId: "webhook-1",
  });
}

function commentPayload(): string {
  return JSON.stringify({
    action: "create",
    actor: { id: "user-2", type: "user", name: "Jane" },
    data: {
      id: "comment-1",
      body: "@supertag summarize this issue",
      issueId: "issue-1",
    },
    type: "Comment",
    url: "https://linear.app/acme/issue/ENG-42/deployment-failed#comment-comment-1",
    createdAt: now.toISOString(),
    organizationId: workspaceId,
    webhookTimestamp: now.getTime(),
    webhookId: "webhook-1",
  });
}

function sign(rawBody: string): string {
  return createHmac("sha256", "linear-webhook-secret").update(rawBody).digest("hex");
}

function linearEvent(): InboundSurfaceEvent {
  return {
    eventId: "delivery-linear-1",
    logicalEventId: "comment-linear-1",
    provider: "linear",
    externalAccountId: workspaceId,
    kind: "issue_comment",
    scope: `team:${teamId}`,
    sessionKey: `linear:${workspaceId}:issue:issue-1`,
    actor: { id: "user-2", kind: "user" },
    occurredAt: now.toISOString(),
    callback: {
      provider: "linear",
      mode: "linear_issue_comment",
      threadKey: "issue-1",
      target: { issueId: "issue-1" },
    },
    source: { issueId: "issue-1", teamId },
    metadata: {},
  };
}
