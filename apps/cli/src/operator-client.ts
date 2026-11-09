import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  ConversationService,
  EventService,
  InboxService,
  MailboxService,
  ObjectiveService,
  OrganizationService,
  TeamService,
  WorkService,
} from "@supertag/operator-api";
import {
  CLIENT_VERSION_HEADER,
  SUPERTAG_VERSION,
  VERSION_HEADER,
  versionMismatchHint,
  warnOnVersionSkew,
} from "./version.js";

/** The operator API version, from its protobuf package `supertag.operator.v1`. */
export const OPERATOR_API_VERSION = OrganizationService.typeName.split(".")[2] ?? "v1";

export interface OperatorClientOptions {
  /** The Control Plane URL. Only its origin is used, as for every `/api/v1/` request. */
  readonly url: string;
  /** Sent as `authorization: Bearer TOKEN`; absent for an anonymous call. */
  readonly token?: string;
  /** Warn on stderr when the Control Plane runs a different SuperTag release. */
  readonly warnOnSkew?: boolean;
  readonly fetch?: typeof fetch;
}

/** Calls operator RPCs over the Connect protocol with JSON bodies, so every call is plain HTTPS. */
export function operatorTransport(options: OperatorClientOptions) {
  const headers: Interceptor = (next) => async (request) => {
    if (options.token !== undefined) request.header.set("authorization", `Bearer ${options.token}`);
    request.header.set(CLIENT_VERSION_HEADER, SUPERTAG_VERSION);
    try {
      const response = await next(request);
      if (options.warnOnSkew) warnOnVersionSkew(controlPlaneVersion(response.header));
      return response;
    } catch (error) {
      if (options.warnOnSkew && error instanceof ConnectError)
        warnOnVersionSkew(controlPlaneVersion(error.metadata));
      throw error;
    }
  };
  return createConnectTransport({
    baseUrl: new URL(options.url).origin,
    fetch: options.fetch ?? globalThis.fetch,
    interceptors: [headers],
    defaultTimeoutMs: 30_000,
  });
}

export function organizationClient(options: OperatorClientOptions) {
  return createClient(OrganizationService, operatorTransport(options));
}

/** Calls `ConversationService`. Pass `timeoutMs: 0` to `followMessage`, which has no deadline. */
export function conversationClient(options: OperatorClientOptions) {
  return createClient(ConversationService, operatorTransport(options));
}

/** Calls `EventService`. Pass `timeoutMs: 0` to `watch`, which has no deadline. */
export function eventClient(options: OperatorClientOptions) {
  return createClient(EventService, operatorTransport(options));
}

export function inboxClient(options: OperatorClientOptions) {
  return createClient(InboxService, operatorTransport(options));
}

export function objectiveClient(options: OperatorClientOptions) {
  return createClient(ObjectiveService, operatorTransport(options));
}

export function workClient(options: OperatorClientOptions) {
  return createClient(WorkService, operatorTransport(options));
}

export function teamClient(options: OperatorClientOptions) {
  return createClient(TeamService, operatorTransport(options));
}

export function mailboxClient(options: OperatorClientOptions) {
  return createClient(MailboxService, operatorTransport(options));
}

/**
 * The message the CLI prints for a refused operator RPC. A Control Plane that does not serve the
 * RPC is probably an older release, so that refusal carries a version hint.
 */
export function operatorErrorMessage(error: ConnectError): string {
  if (error.code !== Code.Unimplemented) return error.rawMessage;
  const hint = versionMismatchHint(SUPERTAG_VERSION, controlPlaneVersion(error.metadata));
  const message = "Control Plane does not support this SuperTag operator API";
  return hint === undefined ? message : `${message}\n${hint}`;
}

function controlPlaneVersion(headers: Headers): string | undefined {
  return headers.get(VERSION_HEADER)?.trim() || undefined;
}
