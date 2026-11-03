import { ControlPlaneRequestError } from "./control-plane-client.js";

/**
 * Fills in the current revision for a human update, like kubectl edit. With `--revision` the
 * update is strict. Without it, the CLI reads the resource, writes with that revision, and on a
 * stale-revision conflict rereads once: it retries only when another writer left the fields this
 * update changes untouched, and otherwise reports the conflict.
 */
export async function withCurrentRevision<T>(input: {
  readonly explicit: string | undefined;
  /** For example "Objective ship-sso-7f3k". */
  readonly resource: string;
  readonly read: () => Promise<Readonly<Record<string, unknown>>>;
  /** Resource fields this update changes. */
  readonly fields: readonly string[];
  readonly write: (revision: number) => Promise<T>;
}): Promise<T> {
  if (input.explicit !== undefined) {
    const revision = Number(input.explicit);
    if (!/^\d+$/u.test(input.explicit) || !Number.isSafeInteger(revision) || revision < 1)
      throw new Error("--revision must be a positive integer");
    return input.write(revision);
  }
  const first = await input.read();
  try {
    return await input.write(revisionOf(first, input.resource));
  } catch (error) {
    if (!isConflict(error)) throw error;
    const current = await input.read();
    // Other conflicts, such as unsettled Tasks, leave the revision unchanged; report them as is.
    if (revisionOf(current, input.resource) === revisionOf(first, input.resource)) throw error;
    const changed = input.fields.filter(
      (field) => JSON.stringify(first[field]) !== JSON.stringify(current[field]),
    );
    if (changed.length > 0)
      throw new Error(
        `${input.resource} changed while you were updating it (revision ${revisionOf(first, input.resource)} to ${revisionOf(current, input.resource)}; ${changed.join(", ")} changed). Inspect it and retry.`,
      );
    try {
      return await input.write(revisionOf(current, input.resource));
    } catch (retry) {
      if (
        !isConflict(retry) ||
        revisionOf(await input.read(), input.resource) === revisionOf(current, input.resource)
      )
        throw retry;
      throw new Error(
        `${input.resource} is changing concurrently. Inspect it and retry, or pass --revision.`,
      );
    }
  }
}

function revisionOf(resource: Readonly<Record<string, unknown>>, name: string): number {
  const revision = resource["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision))
    throw new Error(`${name} has no readable revision; pass --revision`);
  return revision;
}

function isConflict(error: unknown): boolean {
  return error instanceof ControlPlaneRequestError && error.status === 409;
}
