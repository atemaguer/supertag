/** Whether the change an audit entry describes took effect. */
export type AuditOutcome = "succeeded" | "failed";

/** Where the Control Plane received the change: its API Server, or a work tool through the Gateway. */
export type AuditSource = "api" | "gateway";

/**
 * `supertag audit` and `OrganizationService.ListAuditEntries` return this many entries unless asked
 * for another number.
 */
export const AUDIT_DEFAULT_LIMIT = 50;
/** The most entries one audit read returns. */
export const AUDIT_MAX_LIMIT = 500;

/**
 * One operator change recorded in the durable audit trail. It names who acted and on what, never
 * a credential, secret value, digest, or request body.
 */
export interface AuditEntry {
  readonly id: string;
  /** When the Control Plane finished handling the change. */
  readonly at: string;
  /** The operator: `control-plane-break-glass`, `token:NAME`, a scoped `operatorId`, or `slack:USER`. */
  readonly actor: string;
  /** What was done, such as `apply`, `delete`, `auth-key.create`, or `approval.approve`. */
  readonly action: string;
  /** What it was done to, as `Kind/NAME` or `Kind/ID`, such as `Tag/builder`. */
  readonly target: string;
  readonly outcome: AuditOutcome;
  /** The HTTP status of the response, when the change arrived as a request. */
  readonly status?: number;
  readonly source: AuditSource;
  readonly method?: string;
  /**
   * The RPC procedure the request called, such as
   * `/supertag.operator.v1.ResourceService/ApplyManifests`. It is absent for changes that did not
   * arrive as a request.
   */
  readonly path?: string;
}

export type RecordAuditEntryInput = Omit<AuditEntry, "id"> & { readonly id?: string };

export interface ListAuditEntriesInput {
  /** Only entries at or after this ISO 8601 time. */
  readonly since?: string;
  /** Only entries by this exact actor. */
  readonly actor?: string;
  /** From 1 through {@link AUDIT_MAX_LIMIT}; defaults to {@link AUDIT_DEFAULT_LIMIT}. */
  readonly limit?: number;
  /**
   * Only entries listed after this one: older, or as old with a smaller ID. A page that continues
   * from the last entry of the previous one neither repeats nor skips entries recorded meanwhile.
   */
  readonly after?: AuditEntryPosition;
}

/** Where an entry falls in the newest-first audit order. */
export interface AuditEntryPosition {
  readonly at: string;
  readonly id: string;
}

export interface AuditStore {
  recordAuditEntry(input: RecordAuditEntryInput): Promise<AuditEntry>;
  /** Newest first. */
  listAuditEntries(input?: ListAuditEntriesInput): Promise<readonly AuditEntry[]>;
}

/** Validates audit read filters, as accepted from a query string or command line. */
export function parseAuditQuery(input: {
  readonly since?: string | undefined;
  readonly actor?: string | undefined;
  readonly limit?: string | number | undefined;
}): Required<Pick<ListAuditEntriesInput, "limit">> & Omit<ListAuditEntriesInput, "limit"> {
  let since: string | undefined;
  if (input.since !== undefined) {
    const text = input.since.trim();
    const time = Date.parse(text);
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/u.test(text) || Number.isNaN(time))
      throw new RangeError("since must be an ISO 8601 time, such as 2026-10-01T09:00:00Z");
    since = new Date(time).toISOString();
  }
  let actor: string | undefined;
  if (input.actor !== undefined) {
    actor = input.actor.trim();
    if (!actor || actor.length > 200) throw new RangeError("actor must be 1 to 200 characters");
  }
  let limit = AUDIT_DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    const text = String(input.limit).trim();
    limit = Number(text);
    if (!/^\d+$/u.test(text) || limit < 1 || limit > AUDIT_MAX_LIMIT)
      throw new RangeError(`limit must be an integer from 1 through ${AUDIT_MAX_LIMIT}`);
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(actor === undefined ? {} : { actor }),
    limit,
  };
}
