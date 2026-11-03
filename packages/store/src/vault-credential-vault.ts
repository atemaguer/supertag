import type { CredentialValue, GatewayCredentialVault } from "@supertag/core";

export interface VaultGatewayCredentialVaultOptions {
  readonly address: string;
  readonly token: string;
  readonly mount?: string;
  /** Provider-side namespace applied before SuperTag's logical credential IDs. */
  readonly pathPrefix?: string;
  /** Optional Vault Enterprise namespace sent through X-Vault-Namespace. */
  readonly vaultNamespace?: string;
  readonly request?: typeof fetch;
}

/** HashiCorp Vault KV v2 implementation of the provider-neutral Gateway vault contract. */
export class VaultGatewayCredentialVault implements GatewayCredentialVault {
  readonly #address: string;
  readonly #token: string;
  readonly #mount: string;
  readonly #pathPrefix: string;
  readonly #vaultNamespace: string | undefined;
  readonly #request: typeof fetch;

  constructor(options: VaultGatewayCredentialVaultOptions) {
    this.#address = normalizeAddress(options.address);
    this.#token = required(options.token, "Vault token");
    this.#mount = pathComponent(options.mount ?? "secret", "Vault mount");
    this.#pathPrefix = pathPrefix(options.pathPrefix ?? "supertag");
    this.#vaultNamespace = options.vaultNamespace?.trim() || undefined;
    this.#request = options.request ?? fetch;
  }

  async store(credentialId: string, value: CredentialValue): Promise<void> {
    validateCredentialId(credentialId);
    const response = await this.call("data", credentialId, {
      method: "POST",
      body: JSON.stringify({ data: value }),
    });
    if (!response.ok) throw vaultResponseError("store", response.status);
  }

  async storeIfAbsent(credentialId: string, value: CredentialValue): Promise<CredentialValue> {
    validateCredentialId(credentialId);
    const response = await this.call("data", credentialId, {
      method: "POST",
      body: JSON.stringify({ options: { cas: 0 }, data: value }),
    });
    if (response.ok) return value;
    // KV v2 reports create-only CAS conflicts as HTTP 400. Never retry with an unconditional write.
    if (response.status === 400) {
      const existing = await this.resolve(credentialId);
      if (existing !== undefined) return existing;
    }
    throw vaultResponseError("initialize", response.status);
  }

  async resolve(credentialId: string): Promise<CredentialValue | undefined> {
    validateCredentialId(credentialId);
    const response = await this.call("data", credentialId, { method: "GET" });
    if (response.status === 404) return undefined;
    if (!response.ok) throw vaultResponseError("resolve", response.status);
    const body: unknown = await response.json();
    const value = nestedCredentialValue(body);
    if (value === undefined) throw new Error("Vault returned an invalid credential payload");
    return value;
  }

  async delete(credentialId: string): Promise<void> {
    validateCredentialId(credentialId);
    const response = await this.call("metadata", credentialId, { method: "DELETE" });
    if (response.status !== 404 && !response.ok) {
      throw vaultResponseError("delete", response.status);
    }
  }

  private call(
    area: "data" | "metadata",
    credentialId: string,
    init: RequestInit,
  ): Promise<Response> {
    const path = [this.#pathPrefix, ...credentialId.split("/")]
      .map((component) => encodeURIComponent(component))
      .join("/");
    const headers = new Headers({ "X-Vault-Token": this.#token });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.#vaultNamespace !== undefined) {
      headers.set("X-Vault-Namespace", this.#vaultNamespace);
    }
    return this.#request(`${this.#address}/v1/${this.#mount}/${area}/${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  }
}

function nestedCredentialValue(value: unknown): CredentialValue | undefined {
  if (!isRecord(value)) return undefined;
  const outer = value["data"];
  if (!isRecord(outer)) return undefined;
  const credential = outer["data"];
  if (!isRecord(credential)) return undefined;
  if (!Object.values(credential).every((item) => typeof item === "string")) return undefined;
  return credential as CredentialValue;
}

function normalizeAddress(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Vault address must use http: or https:");
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "::1"
  ) {
    throw new Error("Non-loopback Vault addresses must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Vault address must not contain credentials, query parameters, or fragments");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function pathComponent(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/iu.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function pathPrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
  if (!normalized) throw new Error("Vault path prefix contains unsupported characters");
  for (const item of normalized.split("/")) pathComponent(item, "Vault path");
  return normalized;
}

function validateCredentialId(credentialId: string): void {
  if (!/^[a-z0-9][a-z0-9/_-]{2,200}$/iu.test(credentialId)) {
    throw new Error("Credential identifier contains unsupported characters");
  }
}

function vaultResponseError(operation: string, status: number): Error {
  return new Error(`Vault could not ${operation} Gateway credentials (HTTP ${status})`);
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
