import { TagMessagingError } from "@supertag/core";

export const RESOURCE_CHANGE_MAX_BYTES = 196_608;
export const RESOURCE_CHANGE_MAX_FIELDS = 32;

/** Store-internal append-only audit record for one durable resource revision. */
export interface ResourceChange {
  readonly id: string;
  readonly resourceType: "team" | "objective";
  readonly resourceId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly actorTagId: string | null;
  readonly operatorId: string | null;
  readonly sourceTaskId: string | null;
  readonly changes: Readonly<
    Record<string, { readonly previous: unknown; readonly next: unknown }>
  >;
  readonly createdAt: string;
}

export interface ResourceChangeListInput {
  readonly resourceType: "team" | "objective";
  readonly resourceId: string;
  readonly afterRevision?: number;
  readonly limit?: number;
}

export interface ResourceChangeStore {
  listResourceChanges(input: ResourceChangeListInput): Promise<readonly ResourceChange[]>;
}

export function resourceChangeDelta(
  previous: Readonly<Record<string, unknown>> | null,
  next: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): ResourceChange["changes"] {
  if (fields.length > RESOURCE_CHANGE_MAX_FIELDS)
    throw new TagMessagingError(413, "Resource change has too many fields");
  const changes: Record<string, { previous: unknown; next: unknown }> = {};
  for (const field of [...new Set(fields)].sort()) {
    if (!field || field.length > 100 || /\p{Cc}/u.test(field))
      throw new TagMessagingError(400, "Invalid resource change field");
    const before = previous?.[field] ?? null;
    const after = next[field] ?? null;
    if (previous !== null && JSON.stringify(before) === JSON.stringify(after)) continue;
    changes[field] = { previous: before, next: after };
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(changes);
  } catch {
    throw new TagMessagingError(400, "Resource change must be JSON serializable");
  }
  if (new TextEncoder().encode(encoded).length > RESOURCE_CHANGE_MAX_BYTES)
    throw new TagMessagingError(413, "Resource change exceeds 192 KiB");
  return JSON.parse(encoded) as ResourceChange["changes"];
}

export function parseResourceChangeListInput(
  value: ResourceChangeListInput,
): Required<ResourceChangeListInput> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TagMessagingError(400, "Invalid resource change query");
  if (value.resourceType !== "team" && value.resourceType !== "objective")
    throw new TagMessagingError(400, "Unsupported resource type");
  if (
    typeof value.resourceId !== "string" ||
    !value.resourceId.trim() ||
    value.resourceId.length > 200
  )
    throw new TagMessagingError(400, "Invalid resourceId");
  const afterRevision = value.afterRevision ?? 0;
  const limit = value.limit ?? 50;
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0)
    throw new TagMessagingError(400, "afterRevision must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TagMessagingError(400, "limit must be an integer between 1 and 100");
  return { resourceType: value.resourceType, resourceId: value.resourceId, afterRevision, limit };
}
