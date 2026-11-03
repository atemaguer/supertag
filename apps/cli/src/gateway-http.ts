import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlane } from "@supertag/control-plane";
import type { GatewayCredentialVault } from "@supertag/core";
import type { DrizzleStore } from "@supertag/store";
import { readSurfaceAccountCredentials } from "@supertag/surface-sdk";
import type { TeamsHttpResponse } from "@supertag/surface-teams";
import {
  matchGatewayWebhook,
  receiveGatewayWebhook,
  type SurfaceController,
  webhookAccountId,
} from "./gateway-surfaces.js";

const MAX_WEBHOOK_BYTES = 1_000_000;

interface GatewayHttpContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly controlPlane: Pick<ControlPlane, "ingestSurfaceEvent">;
  readonly store: Pick<DrizzleStore, "findSurfaceAccount">;
  readonly credentialVault: GatewayCredentialVault;
  readonly surfaceController: Pick<SurfaceController, "handleWebhook">;
  readonly githubMention: string;
  readonly linearMention: string;
}

/**
 * Dispatch one collaboration-provider webhook through the Gateway boundary.
 * Returns false when the request does not match a Gateway route.
 */
export async function handleGatewayHttpRequest(context: GatewayHttpContext): Promise<boolean> {
  if (context.request.method !== "POST") return false;

  const route = matchGatewayWebhook(context.pathname);
  if (route === undefined) return false;

  const rawBody = await readBody(context.request);
  const externalAccountId = webhookAccountId(route, rawBody);
  const account = await context.store.findSurfaceAccount(route.provider, externalAccountId);
  if (account === undefined) {
    writeJson(context.response, 404, { error: "surface_account_not_found" });
    return true;
  }

  const secrets = await readSurfaceAccountCredentials(account, context.credentialVault);
  const received = await receiveGatewayWebhook(route.provider, {
    account,
    secrets,
    rawBody,
    header: (name) => header(context.request, name),
    githubMention: context.githubMention,
    linearMention: context.linearMention,
    handleRuntime: (body, authorization) =>
      context.surfaceController.handleWebhook(account.id, body, authorization),
  });
  if (received.kind === "challenge") {
    context.response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    context.response.end(received.challenge);
    return true;
  }
  if (received.kind === "response") {
    writeTeamsResponse(context.response, received.response);
    return true;
  }
  if (received.event === undefined) {
    writeJson(context.response, received.status, { ok: true, ignored: true });
    return true;
  }

  const result = await context.controlPlane.ingestSurfaceEvent(received.event);
  writeJson(context.response, received.status, result);
  return true;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WEBHOOK_BYTES) {
      throw new Error("Webhook body exceeds the one-megabyte limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeTeamsResponse(response: ServerResponse, result: TeamsHttpResponse): void {
  if (result.body === undefined) {
    response.writeHead(result.status);
    response.end();
    return;
  }
  writeJson(response, result.status, result.body);
}
