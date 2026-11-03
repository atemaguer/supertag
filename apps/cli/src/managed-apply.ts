import type { ManagedResourceKind, ResourceManagementStore } from "@supertag/core";
import { parseApplySetName } from "@supertag/core";
import {
  APPLY_MANAGER,
  CLI_MANAGER,
  type FieldChange,
  type FieldConflict,
  type FieldMerge,
  type FlatFields,
  fieldOwners,
  flattenSpec,
  mergeFields,
  recordFields,
  sameValue,
  unflattenSpec,
} from "./field-management.js";

/** How one declarative write was requested, from its query parameters. */
export interface ManagedWriteOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  /** Imperative writes keep "listed fields replace, others stay" and are attributed to `cli`. */
  readonly imperative: boolean;
  readonly manager: string;
  readonly applySet?: string;
}

export function managedWriteOptions(url: URL): ManagedWriteOptions {
  const dryRun = url.searchParams.get("dryRun") === "true";
  const force = url.searchParams.get("force") === "true";
  const fieldManager = url.searchParams.get("fieldManager");
  const applySetValue = url.searchParams.get("applySet");
  if (fieldManager !== null && fieldManager !== APPLY_MANAGER && fieldManager !== CLI_MANAGER)
    throw new Error("fieldManager must be apply or cli; apply as a set with applySet=NAME");
  if (fieldManager === CLI_MANAGER && applySetValue !== null)
    throw new Error("fieldManager=cli cannot be combined with applySet");
  const applySet = applySetValue === null ? undefined : parseApplySetName(applySetValue);
  return {
    dryRun,
    force,
    imperative: fieldManager === CLI_MANAGER,
    manager: applySet ?? (fieldManager === CLI_MANAGER ? CLI_MANAGER : APPLY_MANAGER),
    ...(applySet === undefined ? {} : { applySet }),
  };
}

/** The outcome of merging a manifest into the stored resource, before anything is written. */
export interface ManagedPlan {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  readonly exists: boolean;
  readonly current: FlatFields;
  readonly merge: FieldMerge;
  /** The complete spec to reconcile the store to. */
  readonly spec: Record<string, unknown>;
}

export async function planManagedWrite(
  store: Pick<ResourceManagementStore, "findResourceManagement">,
  input: {
    readonly kind: ManagedResourceKind;
    readonly name: string;
    /** The stored spec in manifest form, or undefined when the resource does not exist. */
    readonly currentSpec: unknown;
    /** The manifest spec in the same form, holding only the fields the manifest sets. */
    readonly desiredSpec: unknown;
    readonly options: ManagedWriteOptions;
  },
): Promise<ManagedPlan> {
  const exists = input.currentSpec !== undefined;
  const current = exists ? flattenSpec(input.kind, input.currentSpec) : new Map();
  const record = exists ? await store.findResourceManagement(input.kind, input.name) : undefined;
  const merge = mergeFields({
    current,
    owners: fieldOwners(current, record?.fields),
    desired: flattenSpec(input.kind, input.desiredSpec),
    manager: input.options.manager,
    force: input.options.force,
  });
  return {
    kind: input.kind,
    name: input.name,
    exists,
    current,
    merge,
    spec: unflattenSpec(input.kind, merge.fields),
  };
}

/**
 * An imperative write keeps the rule imperative commands have always had: each listed field
 * replaces the stored one, and unlisted fields stay. It records no ownership.
 */
export function planImperativeWrite(input: {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  readonly currentSpec: unknown;
  readonly desiredSpec: unknown;
}): ManagedPlan {
  const exists = input.currentSpec !== undefined;
  const current = exists ? flattenSpec(input.kind, input.currentSpec) : new Map<string, unknown>();
  const desired = flattenSpec(input.kind, input.desiredSpec);
  const listed = new Set(
    Object.entries(isRecord(input.desiredSpec) ? input.desiredSpec : {})
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
  );
  const fields = new Map<string, unknown>();
  for (const [path, value] of current)
    if (!listed.has(topLevelField(path))) fields.set(path, value);
  for (const [path, value] of desired) fields.set(path, value);
  const changes: FieldChange[] = [];
  for (const [path, value] of fields)
    if (!current.has(path)) changes.push({ path, action: "add", after: value });
    else if (!sameValue(current.get(path), value))
      changes.push({ path, action: "change", before: current.get(path), after: value });
  for (const [path, value] of current)
    if (!fields.has(path)) changes.push({ path, action: "remove", before: value });
  return {
    kind: input.kind,
    name: input.name,
    exists,
    current,
    merge: { fields, owners: new Map(), changes, conflicts: [] },
    spec: unflattenSpec(input.kind, fields),
  };
}

function topLevelField(path: string): string {
  return /^spec\.([A-Za-z]+)/u.exec(path)?.[1] ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Records field ownership, and set membership, from the spec the store now holds. */
export async function recordManagedWrite(
  store: Pick<ResourceManagementStore, "saveResourceManagement">,
  plan: ManagedPlan,
  storedSpec: unknown,
  options: ManagedWriteOptions,
): Promise<void> {
  await store.saveResourceManagement({
    kind: plan.kind,
    name: plan.name,
    ...(options.applySet === undefined ? {} : { applySet: options.applySet }),
    fields: recordFields(flattenSpec(plan.kind, storedSpec), plan.merge.fields, plan.merge.owners),
  });
}

/** The machine-readable plan returned by a dry run. */
export function planReport(plan: ManagedPlan): {
  readonly action: "create" | "update" | "unchanged";
  readonly changes: readonly FieldChange[];
  readonly conflicts: readonly FieldConflict[];
} {
  return {
    action: !plan.exists ? "create" : plan.merge.changes.length > 0 ? "update" : "unchanged",
    changes: plan.merge.changes,
    conflicts: plan.merge.conflicts,
  };
}

export function conflictMessage(plan: ManagedPlan): string {
  return `${plan.kind} ${plan.name} conflicts: ${plan.merge.conflicts
    .map((conflict) => `${conflict.path} is owned by ${conflict.manager}`)
    .join("; ")}. Use --force-conflicts to take ownership.`;
}
