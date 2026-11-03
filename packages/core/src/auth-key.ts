import { TagMessagingError } from "./mailbox.js";
import type { WorkerHost } from "./worker-host.js";

/** Every Auth Key secret starts with this prefix so scanners and people can recognize it. */
export const AUTH_KEY_PREFIX = "stak_";
/** Public lookup part of a secret, after the prefix. Only the full secret authorizes. */
export const AUTH_KEY_LOOKUP_LENGTH = 16;
const AUTH_KEY_SECRET_PATTERN = /^stak_[a-f0-9]{64}$/u;
/** A one-off Auth Key expires one hour after creation. The lifetime is fixed, not configurable. */
export const ONE_OFF_AUTH_KEY_LIFETIME_MS = 60 * 60_000;
/** A reusable Auth Key expires 90 days after creation. The lifetime is fixed, not configurable. */
export const REUSABLE_AUTH_KEY_LIFETIME_MS = 90 * 24 * 60 * 60_000;
/** Most Tags one Auth Key may bind. */
export const MAX_AUTH_KEY_TAGS = 32;

/**
 * An operator-issued secret that lets a machine join as a Worker Host without a copied
 * credential file. Hosts that redeem it are bound to its Tags.
 */
export interface AuthKey {
  readonly id: string;
  readonly name: string;
  /** Tag IDs bound to every Worker Host that redeems the key. */
  readonly tagIds: readonly string[];
  /** Placement labels granted to every Worker Host that redeems the key. */
  readonly labels: readonly string[];
  readonly reusable: boolean;
  /** Hosts joined with an ephemeral key are removed after they disconnect with no open work. */
  readonly ephemeral: boolean;
  readonly expiresAt: string;
  /** Last successful redemption. A one-off key is used after its first redemption. */
  readonly usedAt?: string;
  readonly redemptionCount: number;
  readonly revokedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAuthKeyInput {
  readonly name: string;
  readonly tagIds: readonly string[];
  /** Placement labels to grant; see {@link AuthKey.labels}. */
  readonly labels?: readonly string[];
  readonly reusable: boolean;
  readonly ephemeral: boolean;
  /** Public lookup part of the secret; see {@link authKeyLookupId}. */
  readonly lookupId: string;
  /** Hex SHA-256 digest of the full secret. The secret itself is never stored. */
  readonly secretDigest: string;
  readonly createdAt: string;
}

export interface RedeemAuthKeyInput {
  readonly lookupId: string;
  readonly secretDigest: string;
  /** Preferred Worker Host ID. On collision the store picks `NAME-2`, `NAME-3`, and so on. */
  readonly workerHostName: string;
  /** Vault address of the new host's first credential. */
  readonly credentialId: string;
  readonly redeemedAt: string;
}

export type AuthKeyRedemptionFailure = "invalid" | "expired" | "revoked" | "used" | "tag-missing";

export type AuthKeyRedemption =
  | {
      readonly status: "redeemed";
      readonly authKey: AuthKey;
      readonly workerHost: WorkerHost;
    }
  | { readonly status: AuthKeyRedemptionFailure };

export interface AuthKeyStore {
  /** Creates a key. Names are unique for the life of the Control Plane. */
  createAuthKey(input: CreateAuthKeyInput): Promise<AuthKey>;
  findAuthKeyByName(name: string): Promise<AuthKey | undefined>;
  listAuthKeys(): Promise<readonly AuthKey[]>;
  /** Idempotent. Blocks new redemptions; hosts that already joined keep their enrollment. */
  revokeAuthKey(name: string, revokedAt: string): Promise<AuthKey | undefined>;
  /**
   * Atomically validates the key, records the redemption, enrolls a new Worker Host, and binds
   * the key's Tags. A one-off key can succeed at most once, even under concurrent redemption.
   */
  redeemAuthKey(input: RedeemAuthKeyInput): Promise<AuthKeyRedemption>;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** Auth Key names appear in commands and audit history, so they stay small and plain. */
export function parseAuthKeyName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new TagMessagingError(
      400,
      "Auth Key name must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
    );
  return value;
}

/** Fixed expiry: one hour for a one-off key, 90 days for a reusable key. */
export function authKeyExpiresAt(createdAt: string, reusable: boolean): string {
  return new Date(
    Date.parse(createdAt) +
      (reusable ? REUSABLE_AUTH_KEY_LIFETIME_MS : ONE_OFF_AUTH_KEY_LIFETIME_MS),
  ).toISOString();
}

/** True when the text has the shape of an Auth Key secret. It does not prove the key is valid. */
export function isAuthKeySecret(value: string): boolean {
  return AUTH_KEY_SECRET_PATTERN.test(value);
}

/** The public lookup part of a well-formed secret. */
export function authKeyLookupId(secret: string): string {
  if (!isAuthKeySecret(secret)) throw new TagMessagingError(401, "Auth Key is invalid");
  return secret.slice(AUTH_KEY_PREFIX.length, AUTH_KEY_PREFIX.length + AUTH_KEY_LOOKUP_LENGTH);
}

export type AuthKeyPhase = "active" | "used" | "expired" | "revoked";

/** The key's current phase. Revocation wins over expiry, and expiry over use. */
export function authKeyPhase(key: AuthKey, at = new Date().toISOString()): AuthKeyPhase {
  if (key.revokedAt !== undefined) return "revoked";
  if (Date.parse(key.expiresAt) <= Date.parse(at)) return "expired";
  if (!key.reusable && key.usedAt !== undefined) return "used";
  return "active";
}

const WORKER_HOST_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

/** Worker Host IDs chosen at join time are small and plain, like other resource names. */
export function parseWorkerHostName(value: unknown): string {
  if (typeof value !== "string" || !WORKER_HOST_NAME.test(value))
    throw new TagMessagingError(
      400,
      "Worker Host name must be 1-63 lowercase letters, digits, dots, hyphens, or underscores, starting with a letter or digit",
    );
  return value;
}

/** Turns a machine hostname into a valid Worker Host name, such as `Build-01.local` to `build-01`. */
export function workerHostNameFromHostname(hostname: string): string {
  const name = hostname
    .trim()
    .toLowerCase()
    .replace(/\.local$/u, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 63)
    .replace(/[._-]+$/u, "");
  return name || "worker-host";
}

/** The candidate ID for the `attempt`-th join under one name: `NAME`, then `NAME-2`, `NAME-3`. */
export function workerHostNameCandidate(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const suffix = `-${attempt}`;
  return `${name.slice(0, 63 - suffix.length).replace(/[._-]+$/u, "") || "worker-host"}${suffix}`;
}
