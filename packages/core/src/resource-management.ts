/** Resource kinds that `supertag apply` manages, in the order it applies them. */
export const MANAGED_RESOURCE_KINDS = [
  "SurfaceAccount",
  "Volume",
  "Workspace",
  "ContextSet",
  "PermissionSet",
  "Role",
  "Tag",
  "Objective",
] as const;
export type ManagedResourceKind = (typeof MANAGED_RESOURCE_KINDS)[number];

/**
 * The recorded value of one managed field and the manager that last set it. `manager` is absent
 * for a field nobody set, such as a default the Control Plane filled in.
 */
export interface ManagedFieldEntry {
  readonly manager?: string;
  readonly value: unknown;
}

/** Field path, such as `spec.roles[Engineer]`, to its recorded entry. */
export type ManagedFields = Readonly<Record<string, ManagedFieldEntry>>;

export interface ResourceManagement {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  /** The apply set that last applied this resource, if any. */
  readonly applySet?: string;
  readonly fields: ManagedFields;
  readonly updatedAt: string;
}

export interface SaveResourceManagementInput {
  readonly kind: ManagedResourceKind;
  readonly name: string;
  /** Present: record membership in this set. Absent: keep the current membership. */
  readonly applySet?: string;
  readonly fields: ManagedFields;
}

/**
 * Field ownership and apply-set membership for declaratively managed resources. A resource
 * without a record has never been applied with field managers.
 */
export interface ResourceManagementStore {
  findResourceManagement(
    kind: ManagedResourceKind,
    name: string,
  ): Promise<ResourceManagement | undefined>;
  saveResourceManagement(input: SaveResourceManagementInput): Promise<ResourceManagement>;
  deleteResourceManagement(kind: ManagedResourceKind, name: string): Promise<boolean>;
  listApplySetMembers(applySet: string): Promise<readonly ResourceManagement[]>;
}

const APPLY_SET_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const RESERVED_MANAGERS = new Set(["apply", "cli"]);

/** Set names double as field manager names, so they stay plain and avoid built-in managers. */
export function parseApplySetName(value: unknown): string {
  if (typeof value !== "string" || !APPLY_SET_NAME.test(value))
    throw new Error(
      "Set names must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
    );
  if (RESERVED_MANAGERS.has(value))
    throw new Error(`${value} is a built-in field manager and cannot name a set`);
  return value;
}
