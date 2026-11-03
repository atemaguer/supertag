import type {
  GatewayCredentialVault,
  Store,
  SurfaceAccount,
  SurfaceProvider,
} from "@supertag/core";
import {
  createGitHubInstallationToken,
  githubRepositoryScope,
  resolveGitHubRepositoryScope,
} from "@supertag/surface-github";
import { larkChatScope } from "@supertag/surface-lark";
import { linearTeamScope, resolveLinearTeamScope } from "@supertag/surface-linear";
import {
  readSurfaceAccountCredentials,
  requiredSurfaceSecret,
  surfaceConfigurationString,
} from "@supertag/surface-sdk";
import { slackChannelScope } from "@supertag/surface-slack";
import { teamsChannelScope } from "@supertag/surface-teams";

/** Provider identifiers, independent of command-line spelling or presentation. */
export type SurfaceTarget = { readonly accountSelector?: string } & (
  | { readonly provider: "slack"; readonly channelId: string }
  | { readonly provider: "lark"; readonly chatId: string }
  | { readonly provider: "teams"; readonly teamId: string; readonly channelId: string }
  | { readonly provider: "github"; readonly repositoryId: string }
  | { readonly provider: "github"; readonly repositoryName: string }
  | { readonly provider: "linear"; readonly teamId: string }
  | { readonly provider: "linear"; readonly teamName: string }
);

type AccountSelectionFailure = {
  readonly provider: SurfaceProvider;
  readonly selector: string | undefined;
  readonly matches: readonly SurfaceAccount[];
};

export class AccountSelectionError extends Error {
  constructor(readonly selection: AccountSelectionFailure) {
    super(
      `Expected one connected ${selection.provider} account; found ${selection.matches.length}`,
    );
    this.name = "AccountSelectionError";
  }
}

export class TargetValueError extends Error {
  constructor(
    readonly field:
      | "chatId"
      | "channelId"
      | "teamId"
      | "teamName"
      | "repositoryId"
      | "repositoryName",
  ) {
    super(`Surface target requires ${field}`);
    this.name = "TargetValueError";
  }
}

function targetValue(value: string, field: TargetValueError["field"]): string {
  const normalized = value.trim();
  if (!normalized) throw new TargetValueError(field);
  return normalized;
}

/** Resolves provider names with credentials owned by the connected account. */
export class SurfaceTargetResolver {
  constructor(
    private readonly store: Pick<Store, "listSurfaceAccounts">,
    private readonly credentialVault: GatewayCredentialVault,
  ) {}

  async resolve(target: SurfaceTarget, accounts?: readonly SurfaceAccount[]) {
    const matches = (accounts ?? (await this.store.listSurfaceAccounts())).filter(
      (account) =>
        account.provider === target.provider &&
        (target.accountSelector === undefined ||
          account.id === target.accountSelector ||
          account.externalAccountId === target.accountSelector ||
          account.name === target.accountSelector),
    );
    if (matches.length !== 1)
      throw new AccountSelectionError({
        provider: target.provider,
        selector: target.accountSelector,
        matches,
      });
    const account = matches[0] as SurfaceAccount;
    const resolved = await this.resolveScope(target, account);
    return { account, ...resolved };
  }

  private async resolveScope(
    target: SurfaceTarget,
    account: SurfaceAccount,
  ): Promise<{ scope: string; displayName: string; reference?: string }> {
    if (target.provider === "lark") {
      const id = targetValue(target.chatId, "chatId");
      return { scope: larkChatScope(id), displayName: `chat ${id}` };
    }
    if (target.provider === "slack") {
      const id = targetValue(target.channelId, "channelId").toUpperCase();
      return { scope: slackChannelScope(id), displayName: id };
    }
    if (target.provider === "teams") {
      const teamId = targetValue(target.teamId, "teamId");
      const channelId = targetValue(target.channelId, "channelId");
      return {
        scope: teamsChannelScope(teamId, channelId),
        displayName: `team ${teamId} channel ${channelId}`,
      };
    }
    if (target.provider === "linear") {
      if ("teamId" in target) {
        const id = targetValue(target.teamId, "teamId");
        return { scope: linearTeamScope(id), displayName: `team ${id}` };
      }
      const secrets = await readSurfaceAccountCredentials(account, this.credentialVault);
      return resolveLinearTeamScope(
        targetValue(target.teamName, "teamName"),
        requiredSurfaceSecret(secrets, "apiKey", account),
        surfaceConfigurationString(account, "apiBaseUrl"),
      );
    }
    if ("repositoryId" in target) {
      const id = targetValue(target.repositoryId, "repositoryId");
      return { scope: githubRepositoryScope(id), displayName: `repository ${id}` };
    }
    const secrets = await readSurfaceAccountCredentials(account, this.credentialVault);
    const apiBaseUrl = surfaceConfigurationString(account, "apiBaseUrl");
    const token = await githubAccountToken(account, secrets, apiBaseUrl);
    const resolved = await resolveGitHubRepositoryScope(
      targetValue(target.repositoryName, "repositoryName"),
      token,
      apiBaseUrl,
    );
    return { ...resolved, reference: resolved.displayName };
  }
}

async function githubAccountToken(
  account: SurfaceAccount,
  secrets: Readonly<Record<string, string>>,
  apiBaseUrl: string | undefined,
): Promise<string> {
  if (account.authMethod === "github-token")
    return requiredSurfaceSecret(secrets, "token", account);
  if (account.authMethod === "github-app") {
    const token = await createGitHubInstallationToken({
      appId: requiredConfiguration(account, "appId"),
      installationId: requiredConfiguration(account, "installationId"),
      privateKey: requiredSurfaceSecret(secrets, "privateKey", account),
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    });
    return token.token;
  }
  throw new Error(
    `GitHub account ${account.displayName} has unsupported auth ${account.authMethod}`,
  );
}

function requiredConfiguration(account: SurfaceAccount, name: string): string {
  const value = surfaceConfigurationString(account, name);
  if (value === undefined)
    throw new Error(`Surface account ${account.displayName} is missing configuration ${name}`);
  return value;
}
