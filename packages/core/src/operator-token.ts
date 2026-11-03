import { TagMessagingError } from "./mailbox.js";

/** Every Operator Token secret starts with this prefix so scanners and people can recognize it. */
export const OPERATOR_TOKEN_PREFIX = "stop_";
/** Public lookup part of a secret, after the prefix. Only the full secret authenticates. */
export const OPERATOR_TOKEN_LOOKUP_LENGTH = 16;
const OPERATOR_TOKEN_SECRET_PATTERN = /^stop_[a-f0-9]{64}$/u;
/** An Operator Token expires 90 days after creation. The lifetime is fixed, not configurable. */
export const OPERATOR_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60_000;
/** `lastUsedAt` is refreshed at most this often, so reads do not write on every request. */
export const OPERATOR_TOKEN_LAST_USED_INTERVAL_MS = 60_000;
/** Requests made with an Operator Token act as `token:NAME` in approvals and audit records. */
export const OPERATOR_TOKEN_OPERATOR_PREFIX = "token:";

/**
 * A named, revocable credential an admin-token holder issues to one operator or machine. It
 * authenticates management and coordination requests, which SuperTag attributes to its name.
 */
export interface OperatorToken {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: string;
  /** Last successful authentication, refreshed at most once a minute. */
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateOperatorTokenInput {
  readonly name: string;
  /** Public lookup part of the secret; see {@link operatorTokenLookupId}. */
  readonly lookupId: string;
  /** Hex SHA-256 digest of the full secret. The secret itself is never stored. */
  readonly secretDigest: string;
  readonly createdAt: string;
}

export interface AuthenticateOperatorTokenInput {
  readonly lookupId: string;
  readonly secretDigest: string;
  readonly authenticatedAt: string;
}

export type OperatorTokenAuthentication =
  | { readonly status: "authenticated"; readonly operatorToken: OperatorToken }
  | { readonly status: "invalid" | "expired" | "revoked" };

export interface OperatorTokenStore {
  /** Creates a token. Names are unique for the life of the Control Plane. */
  createOperatorToken(input: CreateOperatorTokenInput): Promise<OperatorToken>;
  findOperatorTokenByName(name: string): Promise<OperatorToken | undefined>;
  listOperatorTokens(): Promise<readonly OperatorToken[]>;
  /** Idempotent. The token stops authenticating immediately. */
  revokeOperatorToken(name: string, revokedAt: string): Promise<OperatorToken | undefined>;
  /**
   * Finds the token by its lookup part, compares the secret digest in constant time, and checks
   * revocation and expiry. A successful call refreshes `lastUsedAt` at most once a minute.
   */
  authenticateOperatorToken(
    input: AuthenticateOperatorTokenInput,
  ): Promise<OperatorTokenAuthentication>;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** Operator Token names appear in approvals and audit records, so they stay small and plain. */
export function parseOperatorTokenName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new TagMessagingError(
      400,
      "Operator Token name must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
    );
  return value;
}

/** Fixed expiry: 90 days after creation. */
export function operatorTokenExpiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + OPERATOR_TOKEN_LIFETIME_MS).toISOString();
}

/** True when the text has the shape of an Operator Token. It does not prove the token is valid. */
export function isOperatorTokenSecret(value: string): boolean {
  return OPERATOR_TOKEN_SECRET_PATTERN.test(value);
}

/** The public lookup part of a well-formed secret. */
export function operatorTokenLookupId(secret: string): string {
  if (!isOperatorTokenSecret(secret)) throw new TagMessagingError(401, "Operator Token is invalid");
  return secret.slice(
    OPERATOR_TOKEN_PREFIX.length,
    OPERATOR_TOKEN_PREFIX.length + OPERATOR_TOKEN_LOOKUP_LENGTH,
  );
}

/** The operator ID requests made with this token act as, such as `token:laptop-2`. */
export function operatorTokenOperatorId(name: string): string {
  return `${OPERATOR_TOKEN_OPERATOR_PREFIX}${name}`;
}

export type OperatorTokenPhase = "active" | "expired" | "revoked";

/** The token's current phase. Revocation wins over expiry. */
export function operatorTokenPhase(
  token: OperatorToken,
  at = new Date().toISOString(),
): OperatorTokenPhase {
  if (token.revokedAt !== undefined) return "revoked";
  if (Date.parse(token.expiresAt) <= Date.parse(at)) return "expired";
  return "active";
}
