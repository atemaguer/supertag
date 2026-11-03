import type { ManagedFields, ManagedResourceKind } from "@supertag/core";

/** `supertag apply` without `--set`. */
export const APPLY_MANAGER = "apply";
/** Imperative CLI and API writes, and any change no other manager recorded. */
export const CLI_MANAGER = "cli";

/**
 * A resource spec as a flat, ordered map from field path to value. Scalar fields use
 * `spec.field`; list entries use `spec.field[key]`, so managers own individual entries.
 */
export type FlatFields = ReadonlyMap<string, unknown>;
export type FieldOwners = ReadonlyMap<string, string | undefined>;

export interface FieldChange {
  readonly path: string;
  readonly action: "add" | "remove" | "change";
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface FieldConflict {
  readonly path: string;
  readonly manager: string;
}

export interface FieldMerge {
  readonly fields: FlatFields;
  readonly owners: FieldOwners;
  readonly changes: readonly FieldChange[];
  readonly conflicts: readonly FieldConflict[];
}

/**
 * Who owns each current field. A field whose value still matches the recorded write keeps its
 * recorded manager; anything else changed outside a managed write, so it belongs to `cli`. With no
 * record at all, every field belongs to `cli`: resources that predate field managers are adopted
 * with a conflict rather than silently pruned.
 */
export function fieldOwners(current: FlatFields, recorded: ManagedFields | undefined): FieldOwners {
  const owners = new Map<string, string | undefined>();
  for (const [path, value] of current) {
    const entry = recorded?.[path];
    owners.set(
      path,
      entry !== undefined && sameValue(entry.value, value) ? entry.manager : CLI_MANAGER,
    );
  }
  return owners;
}

/**
 * Server-side apply for one manager. Fields the manager sets become its own; a field it owned and
 * now omits is removed; fields other managers own are kept. Changing another manager's value is a
 * conflict unless `force` transfers ownership. Setting the value another manager already set is
 * not a conflict and transfers ownership, so each field has at most one manager.
 */
export function mergeFields(input: {
  readonly current: FlatFields;
  readonly owners: FieldOwners;
  readonly desired: FlatFields;
  readonly manager: string;
  readonly force: boolean;
}): FieldMerge {
  const { current, owners, desired, manager, force } = input;
  const fields = new Map(current);
  const nextOwners = new Map(owners);
  const changes: FieldChange[] = [];
  const conflicts: FieldConflict[] = [];
  for (const [path, value] of desired) {
    if (!current.has(path)) {
      fields.set(path, value);
      nextOwners.set(path, manager);
      changes.push({ path, action: "add", after: value });
      continue;
    }
    const before = current.get(path);
    const owner = owners.get(path);
    if (sameValue(before, value)) {
      nextOwners.set(path, manager);
      continue;
    }
    if (owner !== undefined && owner !== manager && !force) {
      conflicts.push({ path, manager: owner });
      continue;
    }
    fields.set(path, value);
    nextOwners.set(path, manager);
    changes.push({ path, action: "change", before, after: value });
  }
  for (const [path, value] of current) {
    if (desired.has(path) || owners.get(path) !== manager) continue;
    fields.delete(path);
    nextOwners.delete(path);
    changes.push({ path, action: "remove", before: value });
  }
  return { fields, owners: nextOwners, changes, conflicts };
}

/**
 * The record written after a managed write: every stored field with its value, and the manager
 * that set it. A field the store filled in differently, such as a restored default, is unowned.
 */
export function recordFields(
  stored: FlatFields,
  planned: FlatFields,
  owners: FieldOwners,
): ManagedFields {
  const record: Record<string, { manager?: string; value: unknown }> = {};
  for (const [path, value] of stored) {
    const manager = sameValue(planned.get(path), value) ? owners.get(path) : undefined;
    record[path] = manager === undefined ? { value } : { manager, value };
  }
  return record;
}

/** How a kind's spec maps to field paths. */
interface FieldModel {
  /** Fields holding one value. */
  readonly scalars: readonly string[];
  /** Lists of distinct names; each name is an entry. */
  readonly names: readonly string[];
  /** Lists of objects; each object is one entry, identified by its key. */
  readonly keyed: Readonly<Record<string, (item: Record<string, unknown>) => string>>;
  /** Maps from a name to an object; each name is an entry. */
  readonly maps?: readonly string[];
}

const FIELD_MODELS: Readonly<Record<ManagedResourceKind, FieldModel>> = {
  // Each option and each secret is an entry. Secrets are references here, never values.
  SurfaceAccount: {
    scalars: ["provider", "displayName"],
    names: [],
    keyed: {},
    maps: ["configuration", "secrets"],
  },
  Volume: { scalars: ["source", "credential"], names: [], keyed: {} },
  // Selections are one value each, like mounts, so an omitted list stays absent.
  Workspace: {
    scalars: ["source", "ref", "setup", "delivery", "mcp", "skills", "skillCatalog", "mounts"],
    names: [],
    keyed: {},
  },
  ContextSet: { scalars: [], names: [], keyed: { items: (item) => String(item["itemKey"]) } },
  PermissionSet: { scalars: [], names: ["approvers"], keyed: { permissions: permissionKey } },
  // Execution settings are one value: harness, models, and efforts only make sense together.
  Role: {
    scalars: ["purpose", "instructions", "execution"],
    names: ["contextSets", "permissionSets"],
    keyed: {},
  },
  Tag: {
    scalars: ["execution"],
    names: ["roles", "workerHosts", "runsOn"],
    keyed: { locations: locationKey, acceptsMessagesFrom: (grant) => String(grant["tag"]) },
  },
  // Lists are whole values here: runtime actions narrow as a set, and the rest cannot change.
  Objective: {
    scalars: [
      "owner",
      "outcome",
      "ongoing",
      "workspaces",
      "observe",
      "budget",
      "deadline",
      "runtimeActions",
    ],
    names: [],
    keyed: {},
    maps: ["teams"],
  },
};

/** Flattens the fields a spec sets; absent fields contribute nothing. */
export function flattenSpec(kind: ManagedResourceKind, spec: unknown): FlatFields {
  const model = FIELD_MODELS[kind];
  const record = isRecord(spec) ? spec : {};
  const fields = new Map<string, unknown>();
  for (const field of model.scalars)
    if (record[field] !== undefined) fields.set(`spec.${field}`, record[field]);
  for (const field of model.names)
    for (const name of arrayOf(record[field])) fields.set(`spec.${field}[${String(name)}]`, true);
  for (const [field, key] of Object.entries(model.keyed))
    for (const item of arrayOf(record[field]))
      if (isRecord(item)) fields.set(`spec.${field}[${key(item)}]`, item);
  for (const field of model.maps ?? [])
    for (const [name, item] of Object.entries(isRecord(record[field]) ? record[field] : {}))
      if (item !== undefined) fields.set(`spec.${field}[${name}]`, item);
  return fields;
}

/** The complete spec for a set of fields. List fields are always present, possibly empty. */
export function unflattenSpec(
  kind: ManagedResourceKind,
  fields: FlatFields,
): Record<string, unknown> {
  const model = FIELD_MODELS[kind];
  const spec: Record<string, unknown> = {};
  for (const field of model.scalars)
    if (fields.has(`spec.${field}`)) spec[field] = fields.get(`spec.${field}`);
  for (const field of [...model.names, ...Object.keys(model.keyed)]) spec[field] = [];
  for (const field of model.maps ?? []) spec[field] = {};
  for (const [path, value] of fields) {
    const entry = /^spec\.([A-Za-z]+)\[(.*)\]$/su.exec(path);
    if (!entry?.[1] || entry[2] === undefined) continue;
    const map = spec[entry[1]];
    if (isRecord(map)) {
      map[entry[2]] = value;
      continue;
    }
    const list = spec[entry[1]];
    if (!Array.isArray(list)) continue;
    list.push(model.names.includes(entry[1]) ? entry[2] : value);
  }
  return spec;
}

/** Location identity: provider and scope IDs, matching how routes are identified. */
export function locationKey(location: Readonly<Record<string, unknown>>): string {
  const ids = ["teamId", "team", "channelId", "chatId", "repoId", "repo"]
    .map((field) => location[field])
    .filter((value): value is string => typeof value === "string" && value !== "");
  return `${String(location["provider"])}:${ids.join("/")}`;
}

function permissionKey(permission: Record<string, unknown>): string {
  const action = String(permission["action"]);
  if (permission["target"] === "runtime") return `runtime:${action}`;
  if (permission["target"] === "mcp")
    return `mcp:${action}${permission["resource"] === undefined ? "" : `:${String(permission["resource"])}`}`;
  const reference =
    permission["reference"] === undefined ? "" : `:${String(permission["reference"])}`;
  return `surface:${String(permission["surfaceAccountId"])}:${String(permission["scope"])}${reference}:${action}`;
}

export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
