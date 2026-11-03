import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SurfaceProvider, SurfaceSecretReference } from "@supertag/core";
import { verifyGitHubAppAccount, verifyGitHubTokenAccount } from "@supertag/surface-github";
import { verifyLarkAccount } from "@supertag/surface-lark";
import { verifyLinearAccount } from "@supertag/surface-linear";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { verifySlackAccount } from "@supertag/surface-slack";
import { verifyTeamsAccount } from "@supertag/surface-teams";

/**
 * A SurfaceAccount manifest declares one Surface Account: its provider, non-secret options,
 * and where each secret comes from. Secrets are references only. The CLI resolves them at apply
 * time, verifies them with the provider exactly as `supertag setup surface` does, and sends
 * the values over the authenticated setup path into the credential vault.
 */
export interface SurfaceAccountManifest {
  readonly name: string;
  readonly provider: SurfaceProvider;
  readonly displayName?: string;
  /** Canonical: defaults filled in, URLs normalized. */
  readonly configuration: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, SurfaceSecretReference>>;
}

/** The manifest-form spec field management compares: no values, only references. */
export interface SurfaceAccountManifestSpec {
  readonly provider: SurfaceProvider;
  readonly displayName?: string;
  readonly configuration: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, SurfaceSecretReference>>;
}

const PROVIDERS = ["slack", "github", "lark", "linear", "teams"] as const;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const GITHUB_API = "https://api.github.com";
const LINEAR_API = "https://api.linear.app/graphql";
const REFERENCE_FORMS = "{ secretRef: NAME }, { env: VARIABLE }, or { file: PATH }";

interface ProviderShape {
  /** Option name to its allowed values; an empty list allows any string. */
  readonly options: Readonly<Record<string, readonly string[]>>;
  /** Options that must be present after defaults, for a given configuration. */
  readonly requiredOptions: (configuration: Record<string, string>) => readonly string[];
  readonly defaults: Readonly<Record<string, string>>;
  readonly secrets: (configuration: Record<string, string>) => {
    readonly required: readonly string[];
    readonly optional: readonly string[];
  };
  /** Every secret name the provider uses, to catch a secret placed under configuration. */
  readonly allSecrets: readonly string[];
}

const SHAPES: Readonly<Record<SurfaceProvider, ProviderShape>> = {
  slack: {
    options: { transport: ["socket", "http"] },
    requiredOptions: () => [],
    defaults: { transport: "socket" },
    secrets: (configuration) =>
      configuration["transport"] === "http"
        ? { required: ["botToken", "signingSecret"], optional: [] }
        : { required: ["botToken", "appToken"], optional: [] },
    allSecrets: ["botToken", "appToken", "signingSecret"],
  },
  github: {
    options: { auth: ["token", "app"], apiBaseUrl: [], appId: [], installationId: [] },
    requiredOptions: (configuration) =>
      configuration["auth"] === "app" ? ["appId", "installationId"] : [],
    defaults: { auth: "token" },
    secrets: (configuration) =>
      configuration["auth"] === "app"
        ? { required: ["privateKey", "webhookSecret"], optional: [] }
        : { required: ["token"], optional: ["webhookSecret"] },
    allSecrets: ["token", "privateKey", "webhookSecret"],
  },
  lark: {
    options: { appId: [], domain: ["lark", "feishu"] },
    requiredOptions: () => ["appId"],
    defaults: { domain: "lark" },
    secrets: () => ({ required: ["appSecret"], optional: [] }),
    allSecrets: ["appSecret"],
  },
  linear: {
    options: { apiBaseUrl: [] },
    requiredOptions: () => [],
    defaults: {},
    secrets: () => ({ required: ["apiKey", "webhookSecret"], optional: [] }),
    allSecrets: ["apiKey", "webhookSecret"],
  },
  teams: {
    options: { appId: [], tenantId: [] },
    requiredOptions: () => ["appId", "tenantId"],
    defaults: {},
    secrets: () => ({ required: ["appSecret"], optional: [] }),
    allSecrets: ["appSecret"],
  },
};

export function isSurfaceProvider(value: unknown): value is SurfaceProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Validates a SurfaceAccount manifest without reading any secret. Literal secret values are
 * refused wherever they appear, so a manifest can be committed and reviewed safely.
 */
export function parseSurfaceAccountManifest(value: unknown): SurfaceAccountManifest {
  if (!isRecord(value) || !isRecord(value["metadata"]))
    throw new Error("SurfaceAccount requires apiVersion, kind, metadata, and spec");
  const name = value["metadata"]["name"];
  if (typeof name !== "string" || !NAME.test(name))
    throw new Error(
      "SurfaceAccount metadata.name must be 1-63 letters, digits, dots, hyphens, or underscores, starting with a letter or digit",
    );
  const spec = value["spec"];
  if (!isRecord(spec)) throw new Error("SurfaceAccount spec is required");
  const unknown = Object.keys(spec).filter(
    (key) => !["provider", "displayName", "configuration", "secrets"].includes(key),
  );
  if (unknown.length > 0)
    throw new Error(
      `SurfaceAccount spec contains unknown fields: ${unknown.join(", ")}. Allowed: provider, displayName, configuration, secrets`,
    );
  const provider = spec["provider"];
  if (!isSurfaceProvider(provider))
    throw new Error(`SurfaceAccount spec.provider must be ${PROVIDERS.join(", ")}`);
  const displayName = spec["displayName"];
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.trim() === ""))
    throw new Error("SurfaceAccount spec.displayName must be a non-empty string");
  const configuration = canonicalConfiguration(provider, spec["configuration"] ?? {});
  const secrets = parseSecretReferences(provider, configuration, spec["secrets"]);
  return {
    name,
    provider,
    ...(displayName === undefined ? {} : { displayName: displayName.trim() }),
    configuration,
    secrets,
  };
}

export function manifestSpec(manifest: SurfaceAccountManifest): SurfaceAccountManifestSpec {
  return {
    provider: manifest.provider,
    ...(manifest.displayName === undefined ? {} : { displayName: manifest.displayName }),
    configuration: manifest.configuration,
    secrets: manifest.secrets,
  };
}

/** Provider options with defaults filled in and API URLs normalized, so equal inputs compare equal. */
export function canonicalConfiguration(
  provider: SurfaceProvider,
  value: unknown,
): Record<string, string> {
  if (!isRecord(value)) throw new Error("SurfaceAccount spec.configuration must be a mapping");
  const shape = SHAPES[provider];
  const misplaced = Object.keys(value).filter((key) => shape.allSecrets.includes(key));
  if (misplaced.length > 0)
    throw new Error(
      `SurfaceAccount spec.configuration.${misplaced[0]} is a secret. Declare it under spec.secrets as a reference: ${REFERENCE_FORMS}`,
    );
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(shape.options, key));
  if (unknown.length > 0)
    throw new Error(
      `SurfaceAccount spec.configuration contains options ${provider} does not use: ${unknown.join(", ")}. Allowed: ${Object.keys(shape.options).join(", ") || "none"}`,
    );
  const configuration: Record<string, string> = { ...shape.defaults };
  for (const [key, option] of Object.entries(value)) {
    if (option === undefined || option === null) continue;
    if (typeof option !== "string" && typeof option !== "number")
      throw new Error(`SurfaceAccount spec.configuration.${key} must be a string`);
    const text = String(option).trim();
    const allowed = shape.options[key] ?? [];
    if (allowed.length > 0 && !allowed.includes(text))
      throw new Error(`SurfaceAccount spec.configuration.${key} must be ${allowed.join(" or ")}`);
    if (text !== "") configuration[key] = text;
  }
  if (provider === "github" && configuration["auth"] !== "app")
    for (const key of ["appId", "installationId"])
      if (configuration[key] !== undefined)
        throw new Error(
          `SurfaceAccount spec.configuration.${key} applies only to auth: app GitHub accounts`,
        );
  for (const key of shape.requiredOptions(configuration))
    if (configuration[key] === undefined)
      throw new Error(`SurfaceAccount spec.configuration.${key} is required for ${provider}`);
  const defaultUrl =
    provider === "github" ? GITHUB_API : provider === "linear" ? LINEAR_API : undefined;
  const url = configuration["apiBaseUrl"];
  if (url !== undefined && defaultUrl !== undefined) {
    let normalized: string;
    try {
      normalized = new URL(url).href.replace(/\/$/u, "");
    } catch {
      throw new Error("SurfaceAccount spec.configuration.apiBaseUrl must be a URL");
    }
    if (normalized === defaultUrl) delete configuration["apiBaseUrl"];
    else configuration["apiBaseUrl"] = normalized;
  }
  return sortedRecord(configuration);
}

function parseSecretReferences(
  provider: SurfaceProvider,
  configuration: Record<string, string>,
  value: unknown,
): Record<string, SurfaceSecretReference> {
  const { required, optional } = SHAPES[provider].secrets(configuration);
  if (value === undefined)
    throw new Error(
      `SurfaceAccount spec.secrets is required: ${provider} needs ${required.join(", ")}`,
    );
  if (!isRecord(value))
    throw new Error(
      `SurfaceAccount spec.secrets must map each secret to a reference: ${REFERENCE_FORMS}`,
    );
  const references: Record<string, SurfaceSecretReference> = {};
  for (const [key, reference] of Object.entries(value)) {
    if (!required.includes(key) && !optional.includes(key))
      throw new Error(
        `SurfaceAccount spec.secrets.${key} is not used by this ${provider} account. It uses ${[...required, ...optional].join(", ")}`,
      );
    references[key] = parseSecretReference(reference, `spec.secrets.${key}`);
  }
  const missing = required.filter((key) => references[key] === undefined);
  if (missing.length > 0)
    throw new Error(`SurfaceAccount spec.secrets is missing ${missing.join(", ")}`);
  return sortedRecord(references);
}

/** Accepts exactly one reference form; anything else, a literal value above all, is refused. */
export function parseSecretReference(value: unknown, field: string): SurfaceSecretReference {
  if (!isRecord(value))
    throw new Error(
      `SurfaceAccount ${field} is a literal value. Manifests hold only references, never secret values: ${REFERENCE_FORMS}`,
    );
  const forms = Object.keys(value);
  const form = forms[0];
  if (forms.length !== 1 || (form !== "secretRef" && form !== "env" && form !== "file"))
    throw new Error(`SurfaceAccount ${field} must be exactly one of ${REFERENCE_FORMS}`);
  const target = value[form];
  if (typeof target !== "string" || target.trim() === "")
    throw new Error(`SurfaceAccount ${field}.${form} must name a ${referenceNoun(form)}`);
  const text = target.trim();
  if (form === "secretRef") return { secretRef: text };
  if (form === "env") return { env: text };
  return { file: text };
}

function referenceNoun(form: "secretRef" | "env" | "file"): string {
  return form === "secretRef" ? "secret" : form === "env" ? "environment variable" : "file";
}

/** Resolves a `{ secretRef: NAME }` reference; supplied by callers such as supertag.yaml. */
export type SecretResolver = (name: string) => Promise<string>;

export interface SecretResolution {
  readonly resolveSecret?: SecretResolver;
  /** Relative `file:` paths resolve against the manifest's directory. */
  readonly baseDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Reads each referenced secret. Errors name the reference, never the value. Values are trimmed,
 * as `supertag setup surface` trims environment values.
 */
export async function resolveSurfaceSecrets(
  manifest: SurfaceAccountManifest,
  resolution: SecretResolution,
): Promise<Record<string, string>> {
  const environment = resolution.environment ?? process.env;
  const values: Record<string, string> = {};
  for (const [key, reference] of Object.entries(manifest.secrets)) {
    const field = `spec.secrets.${key}`;
    let value: string;
    if ("env" in reference) {
      const found = environment[reference.env];
      if (found === undefined || found.trim() === "")
        throw new Error(`${field}: environment variable ${reference.env} is not set`);
      value = found;
    } else if ("file" in reference) {
      const path = resolve(resolution.baseDirectory, reference.file);
      try {
        value = await readFile(path, "utf8");
      } catch (error) {
        const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "error";
        throw new Error(`${field}: cannot read file ${reference.file} (${code})`);
      }
    } else {
      if (resolution.resolveSecret === undefined)
        throw new Error(
          `${field}: secretRef ${reference.secretRef} needs a secret resolver, such as the secrets map in supertag.yaml. With supertag apply -f, use { env: VARIABLE } or { file: PATH }`,
        );
      try {
        value = await resolution.resolveSecret(reference.secretRef);
      } catch (error) {
        throw new Error(
          `${field}: secretRef ${reference.secretRef} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof value !== "string")
        throw new Error(`${field}: secretRef ${reference.secretRef} did not resolve to text`);
    }
    if (value.trim() === "") throw new Error(`${field}: the referenced secret is empty`);
    values[key] = value.trim();
  }
  return values;
}

/** Calls the provider with the same verification `supertag setup surface` uses. */
export async function verifySurfaceAccount(
  manifest: SurfaceAccountManifest,
  secrets: Readonly<Record<string, string>>,
  request: typeof fetch = fetch,
): Promise<VerifiedSurfaceAccount> {
  const options = manifest.configuration;
  const secret = (key: string) => secrets[key] ?? "";
  const optional = (key: string) => (secrets[key] === undefined ? {} : { [key]: secrets[key] });
  let verified: VerifiedSurfaceAccount;
  if (manifest.provider === "slack")
    verified =
      options["transport"] === "http"
        ? await verifySlackAccount(
            {
              transport: "http",
              botToken: secret("botToken"),
              signingSecret: secret("signingSecret"),
            },
            request,
          )
        : await verifySlackAccount(
            { transport: "socket", botToken: secret("botToken"), appToken: secret("appToken") },
            request,
          );
  else if (manifest.provider === "github")
    verified =
      options["auth"] === "app"
        ? await verifyGitHubAppAccount(
            {
              appId: options["appId"] ?? "",
              installationId: options["installationId"] ?? "",
              privateKey: secret("privateKey"),
              webhookSecret: secret("webhookSecret"),
              apiBaseUrl: options["apiBaseUrl"] ?? GITHUB_API,
            },
            request,
          )
        : await verifyGitHubTokenAccount(
            {
              token: secret("token"),
              ...optional("webhookSecret"),
              apiBaseUrl: options["apiBaseUrl"] ?? GITHUB_API,
            },
            request,
          );
  else if (manifest.provider === "lark")
    verified = await verifyLarkAccount({
      appId: options["appId"] ?? "",
      appSecret: secret("appSecret"),
      domain: options["domain"] === "feishu" ? "feishu" : "lark",
    });
  else if (manifest.provider === "linear")
    verified = await verifyLinearAccount(
      {
        apiKey: secret("apiKey"),
        webhookSecret: secret("webhookSecret"),
        apiBaseUrl: options["apiBaseUrl"] ?? LINEAR_API,
      },
      request,
    );
  else
    verified = await verifyTeamsAccount(
      {
        appId: options["appId"] ?? "",
        appSecret: secret("appSecret"),
        tenantId: options["tenantId"] ?? "",
        ...(manifest.displayName === undefined ? {} : { tenantName: manifest.displayName }),
      },
      request,
    );
  return manifest.displayName === undefined
    ? verified
    : { ...verified, displayName: manifest.displayName };
}

/** The stored account's options in manifest form, recovered from what verification recorded. */
export function declaredConfiguration(account: {
  readonly provider: SurfaceProvider;
  readonly authMethod: string;
  readonly externalAccountId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
}): Record<string, string> {
  const stored = account.configuration;
  const text = (key: string) =>
    typeof stored[key] === "string" && stored[key] !== "" ? { [key]: stored[key] } : {};
  const declared: Record<string, unknown> =
    account.provider === "slack"
      ? { transport: account.authMethod === "slack-http" ? "http" : "socket" }
      : account.provider === "github"
        ? account.authMethod === "github-app"
          ? { auth: "app", ...text("appId"), ...text("installationId"), ...text("apiBaseUrl") }
          : { auth: "token", ...text("apiBaseUrl") }
        : account.provider === "lark"
          ? { ...text("appId"), ...text("domain") }
          : account.provider === "linear"
            ? text("apiBaseUrl")
            : { ...text("appId"), tenantId: account.externalAccountId };
  return canonicalConfiguration(account.provider, declared);
}

/** Compares two credential maps in constant time, by digest of their canonical form. */
export function sameCredential(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>>,
): boolean {
  if (left === undefined) return false;
  const digest = (value: Readonly<Record<string, string>>) =>
    createHash("sha256")
      .update(JSON.stringify(sortedRecord({ ...value })))
      .digest();
  return timingSafeEqual(digest(left), digest(right));
}

function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
