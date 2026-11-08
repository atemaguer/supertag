import type { ExecutionSettings } from "./execution-settings.js";

export type RoleStatus = "active" | "retired";

export interface CreateRoleInput {
  readonly name: string;
  readonly purpose: string;
  readonly instructions?: string;
  readonly contextSetIds?: readonly string[];
  readonly permissionSetIds?: readonly string[];
  /** Default harness, models, and efforts for the Role's Tags. */
  readonly execution?: ExecutionSettings;
  readonly createdBy?: string;
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  readonly contextSetIds: readonly string[];
  readonly permissionSetIds: readonly string[];
  /** Default harness, models, and efforts for the Role's Tags; absent means any. */
  readonly execution?: ExecutionSettings;
  readonly status: RoleStatus;
  readonly revision: number;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateRoleInput {
  readonly expectedRevision: number;
  readonly purpose?: string;
  readonly instructions?: string;
  readonly contextSetIds?: readonly string[];
  readonly permissionSetIds?: readonly string[];
  /** Replaces the Role's execution settings; null clears them. */
  readonly execution?: ExecutionSettings | null;
  readonly status?: RoleStatus;
}

export interface AssignRoleInput {
  readonly roleId: string;
  readonly tagId: string;
  readonly createdBy?: string;
}

export interface RoleAssignment {
  readonly id: string;
  readonly roleId: string;
  readonly tagId: string;
  readonly status: "active" | "inactive";
  readonly revision: number;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoleAssignmentListFilter {
  readonly roleId?: string;
  readonly tagId?: string;
  readonly status?: RoleAssignment["status"];
}

/** Exact Role and assignment state captured before durable Task admission. */
export interface TagRoleSnapshot {
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly role: {
    readonly id: string;
    readonly name: string;
    readonly purpose: string;
    readonly instructions: string;
    readonly revision: number;
    readonly contextSetIds: readonly string[];
    readonly permissionSetIds: readonly string[];
  };
}

export interface RoleStore {
  createRole(input: CreateRoleInput): Promise<Role>;
  findRoleById(id: string): Promise<Role | undefined>;
  findRoleByName(name: string): Promise<Role | undefined>;
  listRoles(): Promise<readonly Role[]>;
  updateRole(id: string, input: UpdateRoleInput): Promise<Role>;
  assignRole(input: AssignRoleInput): Promise<RoleAssignment>;
  listRoleAssignments(filter?: RoleAssignmentListFilter): Promise<readonly RoleAssignment[]>;
  deactivateRoleAssignment(id: string, expectedRevision: number): Promise<RoleAssignment>;
}
