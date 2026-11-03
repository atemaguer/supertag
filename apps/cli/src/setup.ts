import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { input, password } from "@inquirer/prompts";
import { verifyGitHubAppAccount, verifyGitHubTokenAccount } from "@supertag/surface-github";
import { type LarkDomain, verifyLarkAccount } from "@supertag/surface-lark";
import { verifyLinearAccount } from "@supertag/surface-linear";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { type SlackTransport, verifySlackAccount } from "@supertag/surface-slack";
import { verifyTeamsAccount } from "@supertag/surface-teams";

/** Installed packages carry the same guides as their CLI version; checkout paths stay local too. */
function surfaceDocument(name: string): string {
  const candidates = [
    new URL(`./docs/surfaces/${name}`, import.meta.url),
    new URL(`../../../docs/surfaces/${name}`, import.meta.url),
  ].map((url) => fileURLToPath(url));
  return (
    candidates.find((path) => existsSync(path)) ??
    `docs/surfaces/${name} in the matching SuperTag source checkout (bundled guide unavailable)`
  );
}
const SURFACE_GUIDES = {
  github: surfaceDocument("github.md"),
  lark: surfaceDocument("lark.md"),
  linear: surfaceDocument("linear.md"),
  slack: surfaceDocument("slack.md"),
  teams: surfaceDocument("teams.md"),
} as const;
const SLACK_MANIFEST_PATH = surfaceDocument("slack-app-manifest.yaml");

export interface SetupSurfaceDependencies {
  readonly enroll: (verified: VerifiedSurfaceAccount) => Promise<{
    readonly provider: VerifiedSurfaceAccount["provider"];
    readonly externalAccountId: string;
    readonly displayName: string;
  }>;
}

export async function setupSurface(
  provider: "github" | "lark" | "linear" | "slack" | "teams",
  args: readonly string[],
  dependencies?: SetupSurfaceDependencies,
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(setupHelp(provider));
    return;
  }

  const verified =
    provider === "slack"
      ? await setupSlack(args)
      : provider === "github"
        ? await setupGitHub(args)
        : provider === "lark"
          ? await setupLark(args)
          : provider === "linear"
            ? await setupLinear(args)
            : await setupTeams(args);
  if (dependencies === undefined) {
    throw new Error("Surface enrollment requires the Control Plane API");
  }
  const account = await dependencies.enroll(verified);
  process.stdout.write(
    `Connected ${account.provider} account ${account.displayName} (${account.externalAccountId}).\n`,
  );
}

function setupHelp(provider: "github" | "lark" | "linear" | "slack" | "teams"): string {
  if (provider === "slack") {
    return `Usage: supertag setup surface slack [--transport socket|http]

Socket Mode (default): Slack bot token + app-level token.
HTTP events: Slack bot token + signing secret.
Guide: ${SURFACE_GUIDES.slack}
Manifest: ${SLACK_MANIFEST_PATH}

Optional environment variables:
  SLACK_BOT_TOKEN
  SLACK_APP_TOKEN
  SLACK_SIGNING_SECRET
`;
  }

  if (provider === "linear") {
    return `Usage: supertag setup surface linear [--api-base-url URL]

Enrolls a Linear workspace API key and webhook signing secret. Team locations and
webhooks are configured separately. Guide: ${SURFACE_GUIDES.linear}

Optional environment variables:
  LINEAR_API_KEY
  LINEAR_WEBHOOK_SECRET
`;
  }

  if (provider === "teams") {
    return `Usage: supertag setup surface teams

Enrolls the Microsoft Entra application and tenant used by the Teams bot.
Create and install the Teams app separately. Guide: ${SURFACE_GUIDES.teams}

Optional environment variables:
  TEAMS_APP_ID
  TEAMS_APP_SECRET
  TEAMS_TENANT_ID
  TEAMS_TENANT_NAME
`;
  }

  if (provider === "lark") {
    return `Usage: supertag setup surface lark [--domain lark|feishu]

Enrolls a Lark or Feishu app for outbound long-connection events and thread replies.
Create and publish the app separately. Guide: ${SURFACE_GUIDES.lark}

Optional environment variables:
  LARK_APP_ID
  LARK_APP_SECRET
`;
  }

  return `Usage: supertag setup surface github [--auth token|app] [--webhook] [--api-base-url URL]

Fine-grained token authentication is the default. GitHub App authentication is an
advanced self-hosted option and can be selected with --auth app.
With token authentication, --webhook also enrolls a repository webhook secret.
Guide: ${SURFACE_GUIDES.github}

Optional environment variables:
  SUPERTAG_GITHUB_TOKEN
  GITHUB_APP_ID
  GITHUB_INSTALLATION_ID
  GITHUB_PRIVATE_KEY_PATH
  GITHUB_WEBHOOK_SECRET
`;
}

export async function setupLark(args: readonly string[]): Promise<VerifiedSurfaceAccount> {
  const { values } = parseArgs({
    args,
    options: { domain: { type: "string", default: "lark" } },
    strict: true,
  });
  const domain = parseLarkDomain(values.domain);
  process.stdout.write(
    "Lark uses an app with bot messaging and im.message.receive_v1 over a long connection. " +
      `See ${SURFACE_GUIDES.lark}.\n`,
  );
  return verifyLarkAccount({
    appId: await valueFromEnvironmentOrPrompt("LARK_APP_ID", "Lark App ID"),
    appSecret: await secretFromEnvironmentOrPrompt("LARK_APP_SECRET", "Lark App Secret"),
    domain,
  });
}

async function setupTeams(args: readonly string[]): Promise<VerifiedSurfaceAccount> {
  parseArgs({ args, options: {}, strict: true });
  process.stdout.write(
    "Teams requires an installed bot app with the Gateway messaging endpoint. " +
      `See ${SURFACE_GUIDES.teams}.\n`,
  );
  const appId = await valueFromEnvironmentOrPrompt(
    "TEAMS_APP_ID",
    "Microsoft application (client) ID",
  );
  const appSecret = await secretFromEnvironmentOrPrompt(
    "TEAMS_APP_SECRET",
    "Microsoft client secret",
  );
  const tenantId = await valueFromEnvironmentOrPrompt("TEAMS_TENANT_ID", "Microsoft tenant ID");
  const tenantName = await optionalValueFromEnvironmentOrPrompt(
    "TEAMS_TENANT_NAME",
    "Tenant display name (optional)",
  );
  return verifyTeamsAccount({
    appId,
    appSecret,
    tenantId,
    ...(tenantName === undefined ? {} : { tenantName }),
  });
}

export async function setupLinear(args: readonly string[]): Promise<VerifiedSurfaceAccount> {
  const { values } = parseArgs({
    args,
    options: {
      "api-base-url": { type: "string", default: "https://api.linear.app/graphql" },
    },
    strict: true,
  });
  process.stdout.write(
    "Linear setup enrolls credentials only. Tag locations and webhooks are configured " +
      `separately. See ${SURFACE_GUIDES.linear}.\n`,
  );
  return verifyLinearAccount({
    apiKey: await secretFromEnvironmentOrPrompt("LINEAR_API_KEY", "Linear personal API key"),
    webhookSecret: await secretFromEnvironmentOrPrompt(
      "LINEAR_WEBHOOK_SECRET",
      "Linear webhook signing secret",
    ),
    apiBaseUrl: values["api-base-url"],
  });
}

async function setupSlack(args: readonly string[]): Promise<VerifiedSurfaceAccount> {
  const { values } = parseArgs({
    args,
    options: {
      transport: { type: "string", default: "socket" },
    },
    strict: true,
  });
  const transport = parseSlackTransport(values.transport);
  process.stdout.write(
    `Slack requires an installed app. Guide: ${SURFACE_GUIDES.slack}\n` +
      `Slack app manifest: ${SLACK_MANIFEST_PATH}\n`,
  );
  const botToken = await secretFromEnvironmentOrPrompt(
    "SLACK_BOT_TOKEN",
    "Slack bot token (xoxb-…)",
  );

  if (transport === "socket") {
    return verifySlackAccount({
      transport,
      botToken,
      appToken: await secretFromEnvironmentOrPrompt(
        "SLACK_APP_TOKEN",
        "Slack app-level token (xapp-…)",
      ),
    });
  }

  return verifySlackAccount({
    transport,
    botToken,
    signingSecret: await secretFromEnvironmentOrPrompt(
      "SLACK_SIGNING_SECRET",
      "Slack signing secret",
    ),
  });
}

export async function setupGitHub(args: readonly string[]): Promise<VerifiedSurfaceAccount> {
  const { values } = parseArgs({
    args,
    options: {
      auth: { type: "string", default: "token" },
      webhook: { type: "boolean", default: false },
      "api-base-url": { type: "string", default: "https://api.github.com" },
    },
    strict: true,
  });
  const auth = parseGitHubAuth(values.auth);
  if (auth === "token") {
    process.stdout.write(
      "GitHub setup enrolls credentials only. Tag locations and webhooks are configured " +
        `separately. See ${SURFACE_GUIDES.github}.\n`,
    );
    const token = await secretFromEnvironmentOrPrompt(
      "SUPERTAG_GITHUB_TOKEN",
      "GitHub fine-grained personal access token",
    );
    return verifyGitHubTokenAccount({
      token,
      ...(values.webhook
        ? {
            webhookSecret: await secretFromEnvironmentOrPrompt(
              "GITHUB_WEBHOOK_SECRET",
              "GitHub repository webhook secret",
            ),
          }
        : {}),
      apiBaseUrl: values["api-base-url"],
    });
  }

  const appId = await valueFromEnvironmentOrPrompt("GITHUB_APP_ID", "GitHub App ID");
  const installationId = await valueFromEnvironmentOrPrompt(
    "GITHUB_INSTALLATION_ID",
    "GitHub App installation ID",
  );
  const privateKeyPath = await valueFromEnvironmentOrPrompt(
    "GITHUB_PRIVATE_KEY_PATH",
    "Path to the GitHub App private key (.pem)",
  );

  return verifyGitHubAppAccount({
    appId,
    installationId,
    privateKey: await readFile(privateKeyPath, "utf8"),
    webhookSecret: await secretFromEnvironmentOrPrompt(
      "GITHUB_WEBHOOK_SECRET",
      "GitHub App webhook secret",
    ),
    apiBaseUrl: values["api-base-url"],
  });
}

function parseGitHubAuth(value: string | undefined): "app" | "token" {
  if (value === "app" || value === "token") {
    return value;
  }
  throw new Error("--auth must be token or app");
}

function parseSlackTransport(value: string | undefined): SlackTransport {
  if (value === "socket" || value === "http") {
    return value;
  }
  throw new Error("--transport must be socket or http");
}

function parseLarkDomain(value: string | undefined): LarkDomain {
  if (value === "lark" || value === "feishu") return value;
  throw new Error("--domain must be lark or feishu");
}

async function valueFromEnvironmentOrPrompt(
  environmentName: string,
  message: string,
): Promise<string> {
  const environmentValue = process.env[environmentName]?.trim();
  if (environmentValue !== undefined && environmentValue.length > 0) {
    return environmentValue;
  }
  return input({ message, validate: required });
}

async function secretFromEnvironmentOrPrompt(
  environmentName: string,
  message: string,
): Promise<string> {
  const environmentValue = process.env[environmentName]?.trim();
  if (environmentValue !== undefined && environmentValue.length > 0) {
    return environmentValue;
  }
  return password({ message, mask: "*", validate: required });
}

async function optionalValueFromEnvironmentOrPrompt(
  environmentName: string,
  message: string,
): Promise<string | undefined> {
  const environmentValue = process.env[environmentName]?.trim();
  if (environmentValue !== undefined && environmentValue.length > 0) return environmentValue;
  const answer = await input({ message });
  return answer.trim() || undefined;
}

function required(value: string): true | string {
  return value.trim().length > 0 || "A value is required";
}
