import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { AuditEntry, RecordAuditEntryInput, Store } from "@supertag/core";

/** One audit entry as an external sink receives it: the stored entry and a `type` for log routing. */
export interface ManagementAuditEvent extends AuditEntry {
  readonly type: "supertag.audit";
}

/** What one request changed. Handlers refine the route's default as they learn the target. */
export interface AuditNote {
  action: string;
  target: string;
  /**
   * The matched route as a template, such as `/api/v1/tags/{name}`. It never repeats the request's
   * own path, and is absent when the request matched no management route.
   */
  readonly route?: string;
}

/**
 * Records operator changes in the database and, when configured, one more sink such as standard
 * error or a JSON-lines file. Recording never throws: a failure is reported and the request it
 * describes still succeeds.
 */
export class AuditTrail {
  readonly #store: Pick<Store, "recordAuditEntry">;
  readonly #sink: ((event: ManagementAuditEvent) => void) | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #pending = new Set<Promise<void>>();

  constructor(
    store: Pick<Store, "recordAuditEntry">,
    sink?: (event: ManagementAuditEvent) => void,
    onError: (error: unknown) => void = (error) =>
      process.stderr.write(
        `Could not record the audit entry: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
  ) {
    this.#store = store;
    this.#sink = sink;
    this.#onError = onError;
  }

  record(input: RecordAuditEntryInput): Promise<void> {
    let entry: AuditEntry;
    try {
      entry = { ...input, id: input.id ?? randomUUID() };
    } catch (error) {
      this.#report(error);
      return Promise.resolve();
    }
    if (this.#sink !== undefined) {
      try {
        this.#sink({ type: "supertag.audit", ...entry });
      } catch (error) {
        this.#report(error);
      }
    }
    // An async function turns a synchronous throw from the store into a rejection it handles.
    const pending: Promise<void> = (async () => {
      try {
        await this.#store.recordAuditEntry(entry);
      } catch (error) {
        this.#report(error);
      }
    })().finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
    return pending;
  }

  /** Reports a recording failure. A reporter that fails too is ignored, so recording never throws. */
  #report(error: unknown): void {
    reportSafely(this.#onError, error);
  }

  /** Waits for every entry recorded so far to reach the database. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
}

/** The kind part of an audit target, such as `Tag` from `Tag/reviewer`. */
export function auditTargetKind(target: string): string {
  const slash = target.indexOf("/");
  return slash === -1 ? target : target.slice(0, slash);
}

/**
 * Appends each entry to `path` as one JSON line, in order, with owner-only permissions. A failed
 * write is reported and never fails the request the entry describes.
 */
export function fileAuditSink(
  path: string,
  onError: (error: unknown) => void = (error) =>
    process.stderr.write(
      `Could not write the audit event to ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    ),
): (event: ManagementAuditEvent) => void {
  let queue: Promise<void> = Promise.resolve();
  return (event) => {
    const line = `${JSON.stringify(event)}\n`;
    queue = queue
      .then(() => appendFile(path, line, { mode: 0o600 }))
      .catch((error: unknown) => {
        reportSafely(onError, error);
      });
  };
}

/** Calls `onError` and ignores any failure of its own, so a broken reporter fails nothing. */
function reportSafely(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // Nothing is left to report to.
  }
}

const RESOURCE_PATHS: Readonly<Record<string, string>> = {
  tags: "Tag",
  roles: "Role",
  "permission-sets": "PermissionSet",
  "context-sets": "ContextSet",
  volumes: "Volume",
  workspaces: "Workspace",
  "surface-accounts": "SurfaceAccount",
  objectives: "Objective",
};

/** Names and IDs that may appear in a target. Anything else is left out rather than recorded. */
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;

function named(kind: string, value: string | undefined): string {
  return value !== undefined && TARGET_NAME.test(value) ? `${kind}/${value}` : kind;
}

function segment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

type Route = readonly [
  method: string | undefined,
  pattern: RegExp,
  classify: (match: RegExpExecArray, method: string, dryRun: string) => AuditNote | undefined,
];

const id = (match: RegExpExecArray, index = 1) => segment(match[index]);

/** Management write routes, in match order. A method of `undefined` matches any write. */
const ROUTES: readonly Route[] = [
  [
    "POST",
    /^\/api\/v1\/([a-z-]+)$/u,
    (match, _method, dryRun) => {
      const collection = match[1] as string;
      const kind = RESOURCE_PATHS[collection];
      return kind === undefined
        ? undefined
        : { action: `apply${dryRun}`, target: kind, route: `/api/v1/${collection}` };
    },
  ],
  [
    "DELETE",
    /^\/api\/v1\/([a-z-]+)\/([^/]+)$/u,
    (match, _method, dryRun) => {
      const collection = match[1] as string;
      const kind = RESOURCE_PATHS[collection];
      return kind === undefined || kind === "Objective"
        ? undefined
        : {
            action: `delete${dryRun}`,
            target: named(kind, id(match, 2)),
            route: `/api/v1/${collection}/{name}`,
          };
    },
  ],
  [
    "POST",
    /^\/api\/v1\/apply-sets\/([^/]+)\/prune$/u,
    (match, _method, dryRun) => ({
      action: `prune${dryRun}`,
      target: named("ApplySet", id(match)),
      route: "/api/v1/apply-sets/{name}/prune",
    }),
  ],
];

/**
 * The action, target, and route template a management write performs, from its method and route
 * alone. A request that matches no route is recorded as `request` on `UnknownRoute`, so nothing
 * from its path, which the caller chose and might hold a credential, is ever kept.
 */
export function classifyManagementRequest(method: string, url: URL): AuditNote {
  const dryRun = url.searchParams.get("dryRun") === "true" ? ".dry-run" : "";
  for (const [routeMethod, pattern, classify] of ROUTES) {
    if (routeMethod !== undefined && routeMethod !== method) continue;
    const match = pattern.exec(url.pathname);
    const note = match === null ? undefined : classify(match, method, dryRun);
    if (note !== undefined) return { ...note };
  }
  return { action: "request", target: "UnknownRoute" };
}

/**
 * Names the resource a manifest or creation request is about, from `metadata.name` or
 * `metadata.id`. Only a name is read; the rest of the body is never recorded.
 */
export function noteRequestBody(note: AuditNote | undefined, body: unknown): void {
  if (note === undefined || note.target.includes("/")) return;
  const document = Array.isArray(body) ? body[0] : body;
  if (typeof document !== "object" || document === null) return;
  const metadata = (document as Record<string, unknown>)["metadata"];
  if (typeof metadata !== "object" || metadata === null) return;
  const { name, id } = metadata as Record<string, unknown>;
  const value = typeof name === "string" ? name : typeof id === "string" ? id : undefined;
  note.target = named(note.target, value);
}
