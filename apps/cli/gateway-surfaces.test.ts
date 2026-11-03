import { createHmac } from "node:crypto";
import type { GatewayCredentialVault, SurfaceAccount, SurfaceProvider } from "@supertag/core";
import { LarkLongConnectionSurface } from "@supertag/surface-lark";
import { SlackSocketModeSurface } from "@supertag/surface-slack";
import { TeamsHttpSurface } from "@supertag/surface-teams";
import { afterEach, expect, it, vi } from "vitest";
import {
  matchGatewayWebhook,
  receiveGatewayWebhook,
  SurfaceController,
  webhookAccountId,
} from "./src/gateway-surfaces.js";

function account(provider: SurfaceProvider, authMethod = "test"): SurfaceAccount {
  return {
    id: provider,
    provider,
    externalAccountId: "T_TEST",
    displayName: provider,
    authMethod,
    credentialId: provider,
    status: "connected",
    configuration: { appId: "app", botOpenId: "bot", domain: "lark" },
    verifiedAt: "2026-09-08T00:00:00Z",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps provider HTTP routes explicit, with account inference only for Linear", () => {
  for (const provider of ["slack", "teams", "github", "linear"])
    expect(matchGatewayWebhook(`/webhooks/${provider}/account%2Fid`)).toEqual({
      provider,
      externalAccountId: "account/id",
    });
  expect(matchGatewayWebhook("/webhooks/linear")).toEqual({ provider: "linear" });
  for (const path of [
    "/webhooks/slack",
    "/webhooks/lark/id",
    "/webhooks/github/id/extra",
    "/webhooks/unknown/id",
    "/webhooks/teams/",
  ])
    expect(matchGatewayWebhook(path)).toBeUndefined();
  expect(webhookAccountId({ provider: "github", externalAccountId: "id" }, "not JSON")).toBe("id");
});

it("preserves signed Slack challenge handling and GitHub ignored-event status", async () => {
  const rawBody = JSON.stringify({
    type: "url_verification",
    challenge: "challenge",
    team_id: "T_TEST",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = "test-signing-secret";
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const input = {
    account: account("slack"),
    secrets: { signingSecret: secret },
    rawBody,
    header: (name: string) =>
      ({ "x-slack-signature": signature, "x-slack-request-timestamp": timestamp })[name],
    githubMention: "@supertag",
    linearMention: "@supertag",
    handleRuntime: vi.fn().mockResolvedValue({ status: 200 }),
  };
  expect(await receiveGatewayWebhook("slack", input)).toEqual({
    kind: "challenge",
    challenge: "challenge",
  });
  await expect(
    receiveGatewayWebhook("slack", { ...input, header: () => "invalid" }),
  ).rejects.toThrow();
  const githubBody = "{}";
  const githubSignature = `sha256=${createHmac("sha256", secret).update(githubBody).digest("hex")}`;
  expect(
    await receiveGatewayWebhook("github", {
      ...input,
      account: account("github"),
      rawBody: githubBody,
      secrets: { webhookSecret: secret },
      header: (name) =>
        ({
          "x-hub-signature-256": githubSignature,
          "x-github-delivery": "delivery",
          "x-github-event": "ping",
        })[name],
    }),
  ).toEqual({ kind: "event", event: undefined, status: 202 });
});

it("reconciles socket, long-connection, and HTTP runtimes with start-before-stop replacement", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  vi.spyOn(SlackSocketModeSurface.prototype, "start").mockImplementation(async () => {
    calls.push("slack:start");
  });
  vi.spyOn(SlackSocketModeSurface.prototype, "stop").mockImplementation(async () => {
    calls.push("slack:stop");
  });
  vi.spyOn(LarkLongConnectionSurface.prototype, "start").mockImplementation(async () => {
    calls.push("lark:start");
  });
  vi.spyOn(LarkLongConnectionSurface.prototype, "stop").mockImplementation(async () => {
    calls.push("lark:stop");
  });
  vi.spyOn(TeamsHttpSurface.prototype, "start").mockResolvedValue(undefined);
  const handle = vi.spyOn(TeamsHttpSurface.prototype, "handle").mockResolvedValue({ status: 202 });
  let accounts = [
    account("slack", "slack-socket-mode"),
    account("lark", "lark-long-connection"),
    account("teams", "teams-client-secret"),
  ];
  const vault: GatewayCredentialVault = {
    resolve: async () => ({ appToken: "token", appSecret: "secret" }),
    store: async () => {},
    delete: async () => {},
  };
  const controller = new SurfaceController({
    store: { listSurfaceAccounts: async () => accounts },
    credentialVault: vault,
    gateway: { ingestSurfaceEvent: vi.fn() },
    refreshIntervalMs: 10,
  });
  try {
    await controller.start();
    expect(controller.status()).toEqual({ active: 3, errors: [] });
    accounts = accounts.map((item) =>
      item.provider === "slack" ? { ...item, updatedAt: "2026-09-09T00:00:00Z" } : item,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["slack:start", "lark:start", "slack:start", "slack:stop"]);
    expect(await controller.handleWebhook("teams", "body", "Bearer token")).toEqual({
      status: 202,
    });
    expect(handle).toHaveBeenCalledExactlyOnceWith("body", "Bearer token");
    accounts = accounts.filter((item) => item.provider !== "lark");
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.status().active).toBe(2);
    expect(calls.at(-1)).toBe("lark:stop");
  } finally {
    await controller.stop();
  }
  expect(controller.status().active).toBe(0);
  expect(calls.at(-1)).toBe("slack:stop");
});
