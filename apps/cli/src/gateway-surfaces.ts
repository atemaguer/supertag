import {
  type ControlPlane,
  type OperatorNotificationSender,
  type OutboundReplyHandler,
  PermanentPullRequestError,
  type WorkspacePullRequestHandler,
  type WorkspacePullRequestTarget,
} from "@supertag/control-plane";
import type {
  CredentialValue,
  GatewayCredentialVault,
  InboundSurfaceEvent,
  Store,
  SurfaceAccount,
  SurfaceProvider,
} from "@supertag/core";
import {
  closeGitHubPullRequest,
  createGitHubInstallationToken,
  githubReplyCapabilities,
  markGitHubPullRequestReady,
  parseGitHubWebhook,
  postGitHubThreadReply,
} from "@supertag/surface-github";
import {
  type LarkDomain,
  LarkLongConnectionSurface,
  larkReplyCapabilities,
  postLarkThreadReply,
} from "@supertag/surface-lark";
import {
  linearReplyCapabilities,
  linearWebhookAccountId,
  parseLinearWebhook,
  postLinearIssueReply,
} from "@supertag/surface-linear";
import {
  readSurfaceAccountCredentials,
  requiredSurfaceSecret,
  surfaceConfigurationString,
} from "@supertag/surface-sdk";
import {
  parseSlackHttpRequest,
  postSlackMessage,
  postSlackThreadReply,
  SlackSocketModeSurface,
  slackReplyCapabilities,
} from "@supertag/surface-slack";
import {
  postTeamsThreadReply,
  type TeamsHttpResponse,
  TeamsHttpSurface,
  teamsReplyCapabilities,
} from "@supertag/surface-teams";

export interface GatewayController<Status> {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Status;
}
export interface SurfaceControllerStatus {
  readonly active: number;
  readonly errors: readonly string[];
}

interface SurfaceRuntime {
  stop(): Promise<void>;
  handleWebhook?(rawBody: string, authorization: string | undefined): Promise<TeamsHttpResponse>;
}
interface SurfaceStart {
  readonly account: SurfaceAccount;
  readonly secrets: CredentialValue;
  readonly sink: (event: InboundSurfaceEvent) => Promise<void>;
  readonly onError: (error: unknown) => void;
}
interface WebhookInput {
  readonly account: SurfaceAccount;
  readonly secrets: CredentialValue;
  readonly rawBody: string;
  readonly header: (name: string) => string | undefined;
  readonly githubMention: string;
  readonly linearMention: string;
  readonly handleRuntime: (
    rawBody: string,
    authorization: string | undefined,
  ) => Promise<TeamsHttpResponse>;
}
export type GatewayWebhookResult =
  | {
      readonly kind: "event";
      readonly event: InboundSurfaceEvent | undefined;
      readonly status: 200 | 202;
    }
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "response"; readonly response: TeamsHttpResponse };
interface GatewaySurfaceBinding {
  readonly label: string;
  readonly capabilities: ReturnType<NonNullable<OutboundReplyHandler["capabilities"]>>;
  readonly reply: (
    event: Parameters<OutboundReplyHandler>[0],
    presentation: Parameters<OutboundReplyHandler>[1],
    account: SurfaceAccount,
    delivery: Parameters<OutboundReplyHandler>[3],
    secrets: CredentialValue,
  ) => ReturnType<OutboundReplyHandler>;
  readonly lifecycle?: {
    readonly authMethod: string;
    readonly start: (input: SurfaceStart) => Promise<SurfaceRuntime>;
  };
  readonly webhook?: {
    readonly path: string;
    readonly accountFromBody?: (body: string) => string;
    readonly receive: (input: WebhookInput) => Promise<GatewayWebhookResult>;
  };
}

/** Exhaustive composition of supported providers; no implicit fallback provider. */
const bindings: Readonly<Record<SurfaceProvider, GatewaySurfaceBinding>> = {
  // The Control Plane records CLI conversation replies itself; nothing is posted anywhere.
  cli: {
    label: "CLI",
    capabilities: { replacement: false },
    async reply() {
      throw new Error("CLI conversation replies are recorded by the Control Plane");
    },
  },
  slack: {
    label: "Slack",
    capabilities: slackReplyCapabilities,
    async reply(event, presentation, account, delivery, secrets) {
      return postSlackThreadReply(event, presentation, {
        botToken: requiredSurfaceSecret(secrets, "botToken", account),
        ...(presentation.resultCard === undefined ? {} : { resultCard: presentation.resultCard }),
        ...(delivery.replaceExternalMessageId === undefined
          ? {}
          : { replaceMessageTs: delivery.replaceExternalMessageId }),
      });
    },
    lifecycle: {
      authMethod: "slack-socket-mode",
      async start({ account, secrets, sink, onError }) {
        const socket = new SlackSocketModeSurface({
          appToken: requiredSurfaceSecret(secrets, "appToken", account),
          externalAccountId: account.externalAccountId,
          displayName: account.displayName,
          sink,
          onError,
        });
        await socket.start();
        return { stop: () => socket.stop() };
      },
    },
    webhook: {
      path: "/webhooks/slack",
      async receive({ account, secrets, rawBody, header }) {
        const parsed = parseSlackHttpRequest({
          rawBody,
          signature: header("x-slack-signature"),
          timestamp: header("x-slack-request-timestamp"),
          signingSecret: requiredSurfaceSecret(secrets, "signingSecret", account),
          externalAccountId: account.externalAccountId,
        });
        return parsed.kind === "challenge"
          ? { kind: "challenge", challenge: parsed.challenge }
          : { kind: "event", status: 200, event: parsed.event };
      },
    },
  },
  lark: {
    label: "Lark",
    capabilities: larkReplyCapabilities,
    async reply(event, presentation, account, delivery, secrets) {
      return postLarkThreadReply(event, presentation, {
        appId: requiredConfigurationString(account, "appId"),
        appSecret: requiredSurfaceSecret(secrets, "appSecret", account),
        domain: requiredLarkDomain(account),
        ...(delivery.replaceExternalMessageId === undefined
          ? {}
          : { replaceMessageId: delivery.replaceExternalMessageId }),
      });
    },
    lifecycle: {
      authMethod: "lark-long-connection",
      async start({ account, secrets, sink, onError }) {
        const connection = new LarkLongConnectionSurface({
          appId: requiredConfigurationString(account, "appId"),
          appSecret: requiredSurfaceSecret(secrets, "appSecret", account),
          botOpenId: requiredConfigurationString(account, "botOpenId"),
          domain: requiredLarkDomain(account),
          displayName: account.displayName,
          sink,
          onError,
        });
        await connection.start();
        return { stop: () => connection.stop() };
      },
    },
  },
  teams: {
    label: "Teams",
    capabilities: teamsReplyCapabilities,
    async reply(event, presentation, account, delivery, secrets) {
      return postTeamsThreadReply(event, presentation, {
        appId: requiredConfigurationString(account, "appId"),
        appSecret: requiredSurfaceSecret(secrets, "appSecret", account),
        tenantId: account.externalAccountId,
        ...(delivery.replaceExternalMessageId === undefined
          ? {}
          : { replaceActivityId: delivery.replaceExternalMessageId }),
      });
    },
    lifecycle: {
      authMethod: "teams-client-secret",
      async start({ account, secrets, sink }) {
        const http = new TeamsHttpSurface({
          appId: requiredConfigurationString(account, "appId"),
          appSecret: requiredSurfaceSecret(secrets, "appSecret", account),
          tenantId: account.externalAccountId,
          sink,
        });
        await http.start();
        return {
          stop: async () => {},
          handleWebhook: (body, authorization) => http.handle(body, authorization),
        };
      },
    },
    webhook: {
      path: "/webhooks/teams",
      async receive({ rawBody, header, handleRuntime }) {
        return {
          kind: "response",
          response: await handleRuntime(rawBody, header("authorization")),
        };
      },
    },
  },
  linear: {
    label: "Linear",
    capabilities: linearReplyCapabilities,
    async reply(event, presentation, account, delivery, secrets) {
      const apiBaseUrl = surfaceConfigurationString(account, "apiBaseUrl");
      return postLinearIssueReply(event, presentation, {
        apiKey: requiredSurfaceSecret(secrets, "apiKey", account),
        ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
        ...(delivery.replaceExternalMessageId === undefined
          ? {}
          : { replaceCommentId: delivery.replaceExternalMessageId }),
      });
    },
    webhook: {
      path: "/webhooks/linear",
      accountFromBody: linearWebhookAccountId,
      async receive({ account, secrets, rawBody, header, linearMention }) {
        const apiBaseUrl = surfaceConfigurationString(account, "apiBaseUrl");
        const event = await parseLinearWebhook({
          rawBody,
          signature: header("linear-signature"),
          deliveryId: header("linear-delivery"),
          eventName: header("linear-event"),
          webhookSecret: requiredSurfaceSecret(secrets, "webhookSecret", account),
          externalAccountId: account.externalAccountId,
          apiKey: requiredSurfaceSecret(secrets, "apiKey", account),
          ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
          mention: linearMention,
        });
        return { kind: "event", status: 200, event };
      },
    },
  },
  github: {
    label: "GitHub",
    capabilities: githubReplyCapabilities,
    async reply(event, presentation, account, delivery, secrets) {
      const apiBaseUrl = surfaceConfigurationString(account, "apiBaseUrl");
      return postGitHubThreadReply(event, presentation, {
        token: await githubReplyToken(account, secrets),
        ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
        ...(delivery.replaceExternalMessageId === undefined
          ? {}
          : { replaceCommentId: delivery.replaceExternalMessageId }),
      });
    },
    webhook: {
      path: "/webhooks/github",
      async receive({ account, secrets, rawBody, header, githubMention }) {
        return {
          kind: "event",
          status: 202,
          event: parseGitHubWebhook({
            rawBody,
            signature: header("x-hub-signature-256"),
            deliveryId: header("x-github-delivery"),
            eventName: header("x-github-event"),
            webhookSecret: requiredSurfaceSecret(secrets, "webhookSecret", account),
            externalAccountId: account.externalAccountId,
            mention: githubMention,
          }),
        };
      },
    },
  },
};

export function createProviderReply(credentialVault: GatewayCredentialVault): OutboundReplyHandler {
  const reply: OutboundReplyHandler = async (event, presentation, account, delivery) =>
    bindings[event.provider].reply(
      event,
      presentation,
      account,
      delivery,
      await readSurfaceAccountCredentials(account, credentialVault),
    );
  return Object.assign(reply, {
    capabilities: (event: InboundSurfaceEvent) => bindings[event.provider].capabilities,
  });
}

/**
 * Marks Workspace pull requests ready for review and closes them with the GitHub Surface
 * Account credential the Control Plane already holds for that account.
 */
export function createWorkspacePullRequestHandler(
  store: Pick<Store, "findSurfaceAccountById">,
  credentialVault: GatewayCredentialVault,
  request?: typeof fetch,
): WorkspacePullRequestHandler {
  const options = async (target: WorkspacePullRequestTarget) => {
    const account = await store.findSurfaceAccountById(target.surfaceAccountId);
    // A retired account holds no credential, so retrying cannot succeed.
    if (account?.provider !== "github" || account.status === "retired")
      throw new PermanentPullRequestError(
        `GitHub Surface Account ${target.surfaceAccountId} was not found`,
      );
    const secrets = await readSurfaceAccountCredentials(account, credentialVault);
    const apiBaseUrl = surfaceConfigurationString(account, "apiBaseUrl");
    return {
      token: await githubReplyToken(account, secrets),
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
      repository: target.repository,
      number: target.number,
      ...(request === undefined ? {} : { request }),
      ...(target.signal === undefined ? {} : { signal: target.signal }),
    };
  };
  return {
    async markReadyForReview(target) {
      await markGitHubPullRequestReady(await options(target));
    },
    async close(target) {
      await closeGitHubPullRequest({ ...(await options(target)), comment: target.comment });
    },
  };
}

/**
 * Sends operator channel messages through an enrolled Slack Surface Account. The destination
 * names the workspace when more than one Slack Surface Account is enrolled.
 */
export function createOperatorNotificationSender(
  store: Pick<Store, "findSurfaceAccount" | "listSurfaceAccounts">,
  credentialVault: GatewayCredentialVault,
  request?: typeof fetch,
): OperatorNotificationSender {
  return async (destination, text) => {
    let account: SurfaceAccount | undefined;
    if (destination.workspaceId) {
      account = await store.findSurfaceAccount("slack", destination.workspaceId);
      if (!account)
        throw new Error(`No Slack Surface Account is enrolled for ${destination.workspaceId}`);
    } else {
      const slack = (await store.listSurfaceAccounts()).filter(
        (candidate) => candidate.provider === "slack",
      );
      if (slack.length !== 1)
        throw new Error(
          slack.length === 0
            ? "No Slack Surface Account is enrolled for the operator channel"
            : "Several Slack Surface Accounts are enrolled; name one as slack:WORKSPACE_ID/TARGET",
        );
      account = slack[0];
    }
    if (!account) throw new Error("No Slack Surface Account is enrolled");
    const secrets = await readSurfaceAccountCredentials(account, credentialVault);
    try {
      return await postSlackMessage(
        { kind: "status", markdown: text },
        {
          botToken: requiredSurfaceSecret(secrets, "botToken", account),
          channel: destination.target,
          request:
            request ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) })),
        },
      );
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      for (const value of Object.values(secrets))
        if (typeof value === "string" && value) message = message.replaceAll(value, "<redacted>");
      throw new Error(message.replace(/https?:\/\/[^\s)]+/giu, "<redacted URL>"));
    }
  };
}

export function matchGatewayWebhook(
  pathname: string,
): { provider: SurfaceProvider; externalAccountId?: string } | undefined {
  for (const provider of Object.keys(bindings) as SurfaceProvider[]) {
    const webhook = bindings[provider].webhook;
    if (!webhook) continue;
    if (pathname === webhook.path && webhook.accountFromBody) return { provider };
    const prefix = `${webhook.path}/`;
    if (!pathname.startsWith(prefix)) continue;
    const suffix = pathname.slice(prefix.length);
    if (suffix && !suffix.includes("/"))
      return { provider, externalAccountId: decodeURIComponent(suffix) };
  }
  return undefined;
}

export function webhookAccountId(
  route: { provider: SurfaceProvider; externalAccountId?: string },
  rawBody: string,
): string {
  if (route.externalAccountId !== undefined) return route.externalAccountId;
  const infer = bindings[route.provider].webhook?.accountFromBody;
  if (!infer) throw new Error("Webhook account is required");
  return infer(rawBody);
}

export async function receiveGatewayWebhook(
  provider: SurfaceProvider,
  input: WebhookInput,
): Promise<GatewayWebhookResult> {
  const webhook = bindings[provider].webhook;
  if (!webhook) throw new Error("Provider has no HTTP webhook");
  return webhook.receive(input);
}

interface SurfaceControllerDependencies {
  readonly store: Pick<Store, "listSurfaceAccounts">;
  readonly credentialVault: GatewayCredentialVault;
  readonly controlPlane: Pick<ControlPlane, "ingestSurfaceEvent">;
  readonly refreshIntervalMs: number;
}

/** Keeps surface runtimes aligned with durable configuration without restarting the Gateway. */
export class SurfaceController implements GatewayController<SurfaceControllerStatus> {
  readonly name = "surfaces";
  readonly #store: Pick<Store, "listSurfaceAccounts">;
  readonly #credentialVault: GatewayCredentialVault;
  readonly #controlPlane: Pick<ControlPlane, "ingestSurfaceEvent">;
  readonly #refreshIntervalMs: number;
  readonly #active = new Map<string, { revision: string; runtime: SurfaceRuntime }>();
  readonly #errors = new Map<string, string>();
  #reconcileError: string | undefined;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reconcilePromise: Promise<void> | undefined;

  constructor(dependencies: SurfaceControllerDependencies) {
    if (!Number.isFinite(dependencies.refreshIntervalMs) || dependencies.refreshIntervalMs <= 0) {
      throw new Error("surfaceRefreshIntervalMs must be greater than zero");
    }
    this.#store = dependencies.store;
    this.#credentialVault = dependencies.credentialVault;
    this.#controlPlane = dependencies.controlPlane;
    this.#refreshIntervalMs = dependencies.refreshIntervalMs;
  }

  async start(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    await this.#runReconcile();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#reconcilePromise;
    const active = [...this.#active.values()];
    this.#active.clear();
    await Promise.allSettled(active.map(({ runtime }) => runtime.stop()));
  }

  status(): SurfaceControllerStatus {
    return {
      active: this.#active.size,
      errors: [
        ...this.#errors.values(),
        ...(this.#reconcileError === undefined ? [] : [this.#reconcileError]),
      ],
    };
  }

  async handleWebhook(
    accountId: string,
    rawBody: string,
    authorization: string | undefined,
  ): Promise<TeamsHttpResponse> {
    const surface = this.#active.get(accountId);
    if (!surface?.runtime.handleWebhook)
      throw new Error("Teams surface is not ready for this account");
    return surface.runtime.handleWebhook(rawBody, authorization);
  }

  async #runReconcile(): Promise<void> {
    if (!this.#running || this.#reconcilePromise !== undefined) {
      return;
    }
    this.#reconcilePromise = this.#reconcile();
    try {
      await this.#reconcilePromise;
      this.#reconcileError = undefined;
    } catch (error) {
      this.#reconcileError = "surface configuration unavailable";
      process.stderr.write(`Surface reconciliation failed: ${errorMessage(error)}\n`);
    } finally {
      this.#reconcilePromise = undefined;
      if (this.#running) {
        this.#timer = setTimeout(() => void this.#runReconcile(), this.#refreshIntervalMs);
      }
    }
  }

  async #reconcile(): Promise<void> {
    const accounts = await this.#store.listSurfaceAccounts();
    const desired = new Set<string>();
    for (const account of accounts) {
      const binding = bindings[account.provider];
      if (!binding.lifecycle || account.authMethod !== binding.lifecycle.authMethod) continue;
      desired.add(account.id);
      const revision = `${account.updatedAt}:${account.credentialId}`;
      const current = this.#active.get(account.id);
      if (current?.revision === revision) {
        this.#errors.delete(account.id);
        continue;
      }
      try {
        const secrets = await readSurfaceAccountCredentials(account, this.#credentialVault);
        const runtime = await binding.lifecycle.start({
          account,
          secrets,
          sink: async (event) => {
            await this.#controlPlane.ingestSurfaceEvent(event);
          },
          onError: (error) => {
            process.stderr.write(
              `${binding.label} event handling failed for ${account.displayName}: ${errorMessage(error)}\n`,
            );
          },
        });
        this.#active.set(account.id, { revision, runtime });
        this.#errors.delete(account.id);
        await current?.runtime.stop();
      } catch (error) {
        this.#errors.set(account.id, account.displayName);
        process.stderr.write(
          `${binding.label} surface failed for ${account.displayName}: ${errorMessage(error)}\n`,
        );
      }
    }
    for (const [accountId, surface] of this.#active) {
      if (!desired.has(accountId)) {
        this.#active.delete(accountId);
        this.#errors.delete(accountId);
        await surface.runtime.stop();
      }
    }
  }
}

async function githubReplyToken(
  account: SurfaceAccount,
  secrets: CredentialValue,
): Promise<string> {
  if (secrets["token"] !== undefined) {
    return secrets["token"];
  }
  const apiBaseUrl = surfaceConfigurationString(account, "apiBaseUrl");
  const installation = await createGitHubInstallationToken({
    appId: requiredConfigurationString(account, "appId"),
    installationId: requiredConfigurationString(account, "installationId"),
    privateKey: requiredSurfaceSecret(secrets, "privateKey", account),
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
  });
  return installation.token;
}

function requiredConfigurationString(account: SurfaceAccount, key: string): string {
  const value = surfaceConfigurationString(account, key);
  if (value === undefined) {
    throw new Error(`${account.provider} ${account.displayName} is missing ${key}`);
  }
  return value;
}

function requiredLarkDomain(account: SurfaceAccount): LarkDomain {
  const domain = requiredConfigurationString(account, "domain");
  if (domain === "lark" || domain === "feishu") return domain;
  throw new Error(`lark ${account.displayName} has invalid domain ${domain}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
