import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { AuditEntry, RecordAuditEntryInput, Store } from "@supertag/core";

/** One audit entry as an external sink receives it: the stored entry and a `type` for log routing. */
export interface ManagementAuditEvent extends AuditEntry {
  readonly type: "supertag.audit";
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
