import type {
  CredentialValue,
  GatewayCredentialVault,
  InboundSurfaceEvent,
  OutboundPresentation,
  SurfaceAccount,
  SurfaceProvider,
} from "@supertag/core";
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";

export interface SurfaceIdentity {
  readonly id: string;
  readonly displayName: string;
}

export interface Surface {
  readonly identity: SurfaceIdentity;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type InboundEventSink = (event: InboundSurfaceEvent) => Promise<void>;

/** Canonical Gateway output rendered by a surface immediately before delivery. */
export interface SurfacePresentation {
  readonly kind: OutboundPresentation;
  readonly markdown: string;
}

/** Surface delivery behavior used by the Gateway without provider-specific branching. */
export interface SurfaceReplyCapabilities {
  /** A delivered reply can be replaced in place using its provider receipt ID. */
  readonly replacement: boolean;
}

/** Internal, provider-neutral rendering IR produced from canonical Markdown. */
export type SurfaceMarkdownDocument = Root;
export type SurfaceMarkdownNode = Nodes;

export function parseSurfaceMarkdown(markdown: string): SurfaceMarkdownDocument {
  const normalized = markdown.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) throw new Error("A surface presentation cannot be empty");
  return fromMarkdown(normalized, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

export function serializeSurfaceMarkdown(document: SurfaceMarkdownDocument): string {
  return toMarkdown(document, { extensions: [gfmToMarkdown()] }).trim();
}

export interface VerifiedSurfaceAccount {
  readonly provider: SurfaceProvider;
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly authMethod: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly secrets: CredentialValue;
}

/**
 * Reads a Surface Account's credentials from the Gateway's
 * credential boundary.
 *
 * These credentials drive surface ingress and egress. Worker-host MCP servers
 * have their own configuration and secret boundary; nothing derived from a
 * Worker or model may select a credential identifier here.
 */
export async function readSurfaceAccountCredentials(
  account: SurfaceAccount,
  credentialVault: GatewayCredentialVault,
): Promise<CredentialValue> {
  const secrets = await credentialVault.resolve(account.credentialId);
  if (secrets === undefined) {
    throw new Error(`Credentials for Surface Account ${account.displayName} were not found`);
  }
  return secrets;
}

export function requiredSurfaceSecret(
  secrets: CredentialValue,
  name: string,
  account: SurfaceAccount,
): string {
  const value = secrets[name]?.trim();
  if (!value) {
    throw new Error(`Credentials for Surface Account ${account.displayName} are missing ${name}`);
  }
  return value;
}

export function surfaceConfigurationString(
  account: SurfaceAccount,
  name: string,
): string | undefined {
  const value = account.configuration[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
