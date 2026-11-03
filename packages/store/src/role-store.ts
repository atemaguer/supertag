// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle operations across both dialects.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ARTIFACT_CONTEXT_TYPE,
  type AssignRoleInput,
  approvalRequirementsFromPermissions,
  type CreateRoleInput,
  type DatabaseProvider,
  type EnsureSystemRoleInput,
  type ExecutionSettings,
  mcpGrantsFromPermissions,
  ORG_ARCHITECT_ROLE_KEY,
  parseExecutionSettings,
  type Role,
  type RoleAssignment,
  type RoleAssignmentListFilter,
  type RoleStore,
  type SystemRoleKey,
  type TagApprovalRequirement,
  type TagAuthorizationResource,
  type TagContextPlan,
  type TagMcpGrant,
  TagMessagingError,
  type TagRoleSnapshot,
  type UpdateRoleInput,
} from "@supertag/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;

export interface TransactionalRoleAdmission {
  readonly roles: readonly TagRoleSnapshot[];
  readonly execution: readonly (ExecutionSettings | undefined)[];
  readonly permissionSets: readonly {
    readonly id: string;
    readonly name: string;
    readonly approvers?: readonly string[];
  }[];
  readonly resources: readonly TagAuthorizationResource[];
  readonly runtimeActions: readonly string[];
  readonly mcp: readonly TagMcpGrant[];
  readonly approvals: readonly TagApprovalRequirement[];
  readonly contextPlan: TagContextPlan;
}

/** Capture Role composition inside the same transaction that admits an internal Task. */
export function* captureRoleAdmissionInTransaction(
  tx: any,
  tables: any,
  tagId: string,
  capturedAt: string,
): Flow<TransactionalRoleAdmission> {
  const assignmentRows = (yield tx
    .select()
    .from(tables.roleAssignments)
    .where(
      and(eq(tables.roleAssignments.tagId, tagId), eq(tables.roleAssignments.status, "active")),
    )) as readonly any[];
  const roles: TagRoleSnapshot[] = [];
  const executionByRole = new Map<string, ExecutionSettings | undefined>();
  for (const assignmentRow of assignmentRows) {
    const assignment = roleAssignmentFromRow(assignmentRow);
    const [roleRow] = yield tx
      .select()
      .from(tables.roles)
      .where(and(eq(tables.roles.id, assignment.roleId), eq(tables.roles.status, "active")))
      .limit(1);
    if (!roleRow) continue;
    executionByRole.set(roleRow.id, storedExecution(roleRow.execution).execution);
    const contextRows = yield tx
      .select({ id: tables.roleContextSets.contextSetId })
      .from(tables.roleContextSets)
      .where(eq(tables.roleContextSets.roleId, roleRow.id));
    const permissionRows = yield tx
      .select({ id: tables.rolePermissionSets.permissionSetId })
      .from(tables.rolePermissionSets)
      .where(eq(tables.rolePermissionSets.roleId, roleRow.id));
    roles.push(
      roleSnapshot(
        assignment,
        roleFromRow(
          roleRow,
          contextRows.map((row: any) => row.id).sort(),
          permissionRows.map((row: any) => row.id).sort(),
        ),
      ),
    );
  }
  roles.sort((left, right) => compareRoleSnapshots(left, right));

  const permissionSetIds = uniqueSorted(roles.flatMap((entry) => entry.role.permissionSetIds));
  const permissionSets: { id: string; name: string; approvers?: string[] }[] = [];
  const approvalSets: { id: string; name: string; approvers?: string[] }[] = [];
  const approvalPermissions: any[] = [];
  const runtimeActions = new Set<string>();
  const mcpPermissions: { target: "mcp"; action: string; resource?: string }[] = [];
  const resources = new Map<string, TransactionalResource>();
  for (const permissionSetId of permissionSetIds) {
    const [set] = yield tx
      .select()
      .from(tables.tagPermissionSets)
      .where(eq(tables.tagPermissionSets.id, permissionSetId))
      .limit(1);
    if (!set) throw new Error("A Role references an unavailable Permission Set");
    const approvers: string[] = Array.isArray(set.approvers) ? [...set.approvers] : [];
    const frozenSet = { id: set.id, name: set.name, ...(approvers.length ? { approvers } : {}) };
    permissionSets.push(frozenSet);
    approvalSets.push(frozenSet);
    const permissions = yield tx
      .select()
      .from(tables.tagPermissions)
      .where(eq(tables.tagPermissions.permissionSetId, permissionSetId));
    for (const permission of permissions) {
      if (permission.approval === "required")
        approvalPermissions.push({
          permissionSetId,
          target: permission.target,
          action: permission.action,
          approval: "required",
          ...(permission.target === "surface"
            ? { surfaceAccountId: permission.surfaceAccountId, scope: permission.scope }
            : {}),
          ...(permission.target === "mcp" && permission.scope
            ? { resource: permission.scope }
            : {}),
        });
      if (permission.target === "runtime") {
        runtimeActions.add(permission.action);
        continue;
      }
      if (permission.target === "mcp") {
        mcpPermissions.push({
          target: "mcp",
          action: permission.action,
          ...(permission.scope ? { resource: permission.scope } : {}),
        });
        continue;
      }
      if (permission.target !== "surface")
        throw new Error(`Stored Tag permission ${permission.id} has an invalid target`);
      const [account] = yield tx
        .select()
        .from(tables.surfaceAccounts)
        .where(eq(tables.surfaceAccounts.id, permission.surfaceAccountId))
        .limit(1);
      if (!account)
        throw new Error(`Surface account ${permission.surfaceAccountId} is unavailable`);
      const key = `${account.id}\0${permission.scope}`;
      const existing = resources.get(key);
      if (existing) {
        existing.actions.add(permission.action);
        if (!existing.reference && permission.reference) existing.reference = permission.reference;
      } else {
        resources.set(key, {
          surfaceAccountId: account.id,
          provider: account.provider,
          scope: permission.scope,
          ...(permission.reference === null ? {} : { reference: permission.reference }),
          actions: new Set([permission.action]),
        });
      }
    }
  }

  const contextSets = [];
  for (const contextSetId of uniqueSorted(roles.flatMap((entry) => entry.role.contextSetIds))) {
    const [set] = yield tx
      .select()
      .from(tables.tagContextSets)
      .where(eq(tables.tagContextSets.id, contextSetId))
      .limit(1);
    if (!set) throw new Error("A Role references an unavailable Context Set");
    const items = yield tx
      .select()
      .from(tables.tagContextItems)
      .where(eq(tables.tagContextItems.contextSetId, contextSetId));
    if (items.some((item: any) => item.type === ARTIFACT_CONTEXT_TYPE))
      throw new Error(
        `Role Context Set ${set.name} selects surface history and cannot equip an internal Task`,
      );
    contextSets.push({
      id: set.id,
      name: set.name,
      items: items
        .map((item: any) => ({
          id: item.id,
          itemKey: item.itemKey,
          type: item.type,
          version: item.version,
          required: item.required,
          config: item.config,
        }))
        .sort((left: any, right: any) => left.itemKey.localeCompare(right.itemKey)),
    });
  }
  contextSets.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );

  return {
    roles,
    execution: roles
      .toSorted((a, b) => a.role.name.localeCompare(b.role.name))
      .map((entry) => executionByRole.get(entry.role.id)),
    permissionSets: permissionSets.sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
    resources: [...resources.values()]
      .map((resource) => ({
        surfaceAccountId: resource.surfaceAccountId,
        provider: resource.provider,
        scope: resource.scope,
        ...(resource.reference === undefined ? {} : { reference: resource.reference }),
        actions: [...resource.actions].sort(),
        sources: ["permission-set" as const],
      }))
      .sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.surfaceAccountId.localeCompare(right.surfaceAccountId) ||
          left.scope.localeCompare(right.scope),
      ),
    runtimeActions: [...runtimeActions].sort(),
    mcp: mcpGrantsFromPermissions(mcpPermissions),
    approvals: approvalRequirementsFromPermissions(approvalSets, approvalPermissions),
    contextPlan: { version: 7, capturedAt, sets: contextSets },
  };
}

interface TransactionalResource {
  readonly surfaceAccountId: string;
  readonly provider: TagAuthorizationResource["provider"];
  readonly scope: string;
  reference?: string;
  readonly actions: Set<string>;
}

export class DrizzleRoleStore implements RoleStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  private transaction<T>(work: (tx: any) => Flow<T>): Promise<T> {
    return runDialectTransaction(this.db, this.provider, work);
  }

  private *refs(
    tx: any,
    table: any,
    ids: readonly string[],
    label: string,
  ): Flow<readonly string[]> {
    const normalized = stringIds(ids, label);
    for (const id of normalized) {
      const [row] = yield tx.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
      if (!row) throw new TagMessagingError(404, `${label} not found: ${id}`);
    }
    return normalized;
  }

  private *load(tx: any, row: any): Flow<Role> {
    const contextRows = yield tx
      .select({ id: this.tables.roleContextSets.contextSetId })
      .from(this.tables.roleContextSets)
      .where(eq(this.tables.roleContextSets.roleId, row.id))
      .orderBy(asc(this.tables.roleContextSets.contextSetId));
    const permissionRows = yield tx
      .select({ id: this.tables.rolePermissionSets.permissionSetId })
      .from(this.tables.rolePermissionSets)
      .where(eq(this.tables.rolePermissionSets.roleId, row.id))
      .orderBy(asc(this.tables.rolePermissionSets.permissionSetId));
    return roleFromRow(
      row,
      contextRows.map((entry: any) => entry.id),
      permissionRows.map((entry: any) => entry.id),
    );
  }

  private *find(tx: any, column: any, value: string): Flow<Role | undefined> {
    const [row] = yield tx.select().from(this.tables.roles).where(eq(column, value)).limit(1);
    return row ? yield* this.load(tx, row) : undefined;
  }

  private *create(
    tx: any,
    input: CreateRoleInput,
    origin: "system" | "user",
    systemKey?: SystemRoleKey,
  ): Flow<Role> {
    const definition = roleDefinition(input);
    const existing = yield* this.find(tx, this.tables.roles.name, definition.name);
    if (existing) {
      if (
        existing.origin === origin &&
        existing.systemKey === systemKey &&
        sameDefinition(existing, definition)
      )
        return existing;
      throw new TagMessagingError(409, `A different Role named ${definition.name} already exists`);
    }
    const contextSetIds = yield* this.refs(
      tx,
      this.tables.tagContextSets,
      definition.contextSetIds,
      "Context Set",
    );
    const permissionSetIds = yield* this.refs(
      tx,
      this.tables.tagPermissionSets,
      definition.permissionSetIds,
      "Permission Set",
    );
    const at = new Date().toISOString();
    const id = randomUUID();
    const [row] = yield tx
      .insert(this.tables.roles)
      .values({
        id,
        name: definition.name,
        purpose: definition.purpose,
        instructions: definition.instructions,
        execution: definition.execution ?? null,
        origin,
        systemKey: systemKey ?? null,
        status: "active",
        revision: 1,
        createdBy: definition.createdBy ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    yield* replaceRefs(tx, this.tables.roleContextSets, "contextSetId", id, contextSetIds);
    yield* replaceRefs(tx, this.tables.rolePermissionSets, "permissionSetId", id, permissionSetIds);
    return yield* this.load(tx, row);
  }

  createRole(input: CreateRoleInput): Promise<Role> {
    return this.transaction((tx) => this.create(tx, input, "user"));
  }

  ensureSystemRole(input: EnsureSystemRoleInput): Promise<Role> {
    systemRoleKey(input.systemKey);
    const self = this;
    return this.transaction(function* (tx: any): Flow<Role> {
      const existing = yield* self.find(tx, self.tables.roles.systemKey, input.systemKey);
      if (existing) return existing;
      const definition = roleDefinition(input);
      const nameCollision = yield* self.find(tx, self.tables.roles.name, definition.name);
      // At READ COMMITTED, another bootstrap can commit between the two reads.
      // Its matching identity is already ensured, including any customized policy.
      if (nameCollision?.origin === "system" && nameCollision.systemKey === input.systemKey)
        return nameCollision;
      if (nameCollision)
        throw new TagMessagingError(
          409,
          `A different Role named ${definition.name} already exists`,
        );
      const contextSetIds = yield* self.refs(
        tx,
        self.tables.tagContextSets,
        definition.contextSetIds,
        "Context Set",
      );
      const permissionSetIds = yield* self.refs(
        tx,
        self.tables.tagPermissionSets,
        definition.permissionSetIds,
        "Permission Set",
      );
      const at = new Date().toISOString();
      const [created] = yield tx
        .insert(self.tables.roles)
        .values({
          id: randomUUID(),
          name: definition.name,
          purpose: definition.purpose,
          instructions: definition.instructions,
          origin: "system",
          systemKey: input.systemKey,
          status: "active",
          revision: 1,
          createdBy: definition.createdBy ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing({ target: self.tables.roles.systemKey })
        .returning();
      if (created) {
        yield* replaceRefs(
          tx,
          self.tables.roleContextSets,
          "contextSetId",
          created.id,
          contextSetIds,
        );
        yield* replaceRefs(
          tx,
          self.tables.rolePermissionSets,
          "permissionSetId",
          created.id,
          permissionSetIds,
        );
        return yield* self.load(tx, created);
      }
      const concurrent = yield* self.find(tx, self.tables.roles.systemKey, input.systemKey);
      if (concurrent) return concurrent;
      throw new TagMessagingError(409, `A different Role named ${definition.name} already exists`);
    });
  }

  findRoleById(id: string): Promise<Role | undefined> {
    return this.transaction((tx) => this.find(tx, this.tables.roles.id, required(id, "Role id")));
  }

  findRoleByName(name: string): Promise<Role | undefined> {
    return this.transaction((tx) =>
      this.find(tx, this.tables.roles.name, required(name, "Role name")),
    );
  }

  findRoleBySystemKey(systemKey: SystemRoleKey): Promise<Role | undefined> {
    systemRoleKey(systemKey);
    return this.transaction((tx) => this.find(tx, this.tables.roles.systemKey, systemKey));
  }

  listRoles(): Promise<readonly Role[]> {
    const self = this;
    return this.transaction(function* (tx): Flow<readonly Role[]> {
      const rows = yield tx
        .select()
        .from(self.tables.roles)
        .orderBy(asc(self.tables.roles.name), asc(self.tables.roles.id));
      const roles: Role[] = [];
      for (const row of rows) roles.push(yield* self.load(tx, row));
      return roles;
    });
  }

  updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    const self = this;
    return this.transaction(function* (tx): Flow<Role> {
      const roleId = required(id, "Role id");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
        throw new TagMessagingError(400, "A positive expectedRevision is required");
      const prior = yield* self.find(tx, self.tables.roles.id, roleId);
      if (!prior) throw new TagMessagingError(404, "Role not found");
      if (prior.revision !== input.expectedRevision)
        throw new TagMessagingError(409, "Role revision changed; reload before updating");
      if (prior.origin === "system" && input.status === "retired")
        throw new TagMessagingError(403, "Built-in Roles cannot be retired");
      const next = {
        purpose: input.purpose === undefined ? prior.purpose : purpose(input.purpose),
        instructions:
          input.instructions === undefined ? prior.instructions : instructions(input.instructions),
        contextSetIds:
          input.contextSetIds === undefined
            ? prior.contextSetIds
            : yield* self.refs(tx, self.tables.tagContextSets, input.contextSetIds, "Context Set"),
        permissionSetIds:
          input.permissionSetIds === undefined
            ? prior.permissionSetIds
            : yield* self.refs(
                tx,
                self.tables.tagPermissionSets,
                input.permissionSetIds,
                "Permission Set",
              ),
        execution:
          input.execution === undefined
            ? prior.execution
            : executionField(input.execution ?? undefined).execution,
        status: input.status ?? prior.status,
      };
      if (
        isDeepStrictEqual(
          {
            purpose: prior.purpose,
            instructions: prior.instructions,
            contextSetIds: prior.contextSetIds,
            permissionSetIds: prior.permissionSetIds,
            execution: prior.execution,
            status: prior.status,
          },
          next,
        )
      )
        return prior;
      const at = new Date().toISOString();
      const [row] = yield tx
        .update(self.tables.roles)
        .set({
          purpose: next.purpose,
          instructions: next.instructions,
          execution: next.execution ?? null,
          status: next.status,
          revision: prior.revision + 1,
          updatedAt: at,
        })
        .where(
          and(
            eq(self.tables.roles.id, roleId),
            eq(self.tables.roles.revision, input.expectedRevision),
          ),
        )
        .returning();
      if (!row) throw new TagMessagingError(409, "Role revision changed; reload before updating");
      yield* replaceRefs(
        tx,
        self.tables.roleContextSets,
        "contextSetId",
        roleId,
        next.contextSetIds,
      );
      yield* replaceRefs(
        tx,
        self.tables.rolePermissionSets,
        "permissionSetId",
        roleId,
        next.permissionSetIds,
      );
      if (next.status === "retired")
        yield tx
          .update(self.tables.roleAssignments)
          .set({
            status: "inactive",
            revision: sql`${self.tables.roleAssignments.revision} + 1`,
            updatedAt: at,
          })
          .where(
            and(
              eq(self.tables.roleAssignments.roleId, roleId),
              eq(self.tables.roleAssignments.status, "active"),
            ),
          )
          .returning();
      return yield* self.load(tx, row);
    });
  }

  assignRole(input: AssignRoleInput): Promise<RoleAssignment> {
    const self = this;
    return this.transaction(function* (tx): Flow<RoleAssignment> {
      const roleId = required(input.roleId, "Role id");
      const tagId = required(input.tagId, "Tag id");
      const role = yield* self.find(tx, self.tables.roles.id, roleId);
      if (role?.status !== "active") throw new TagMessagingError(404, "Active Role not found");
      const [tag] = yield tx
        .select()
        .from(self.tables.tags)
        .where(and(eq(self.tables.tags.id, tagId), eq(self.tables.tags.status, "active")))
        .limit(1);
      if (!tag) throw new TagMessagingError(404, "Active Tag not found");
      const a = self.tables.roleAssignments;
      const [existing] = yield tx
        .select()
        .from(a)
        .where(and(eq(a.roleId, roleId), eq(a.tagId, tagId)))
        .limit(1);
      if (existing?.status === "active") return roleAssignmentFromRow(existing);
      const at = new Date().toISOString();
      if (existing) {
        const [reactivated] = yield tx
          .update(a)
          .set({ status: "active", revision: existing.revision + 1, updatedAt: at })
          .where(and(eq(a.id, existing.id), eq(a.revision, existing.revision)))
          .returning();
        if (!reactivated)
          throw new TagMessagingError(409, "Role assignment changed; reload before updating");
        return roleAssignmentFromRow(reactivated);
      }
      const [created] = yield tx
        .insert(a)
        .values({
          id: randomUUID(),
          roleId,
          tagId,
          status: "active",
          revision: 1,
          createdBy: input.createdBy ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      return roleAssignmentFromRow(created);
    });
  }

  listRoleAssignments(filter: RoleAssignmentListFilter = {}): Promise<readonly RoleAssignment[]> {
    const a = this.tables.roleAssignments;
    const conditions = [
      filter.roleId === undefined ? undefined : eq(a.roleId, required(filter.roleId, "Role id")),
      filter.tagId === undefined ? undefined : eq(a.tagId, required(filter.tagId, "Tag id")),
      filter.status === undefined ? undefined : eq(a.status, filter.status),
    ].filter(Boolean);
    return this.db
      .select()
      .from(a)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(a.createdAt), asc(a.id))
      .then((rows: readonly any[]) => rows.map(roleAssignmentFromRow));
  }

  deactivateRoleAssignment(id: string, expectedRevision: number): Promise<RoleAssignment> {
    const self = this;
    return this.transaction(function* (tx): Flow<RoleAssignment> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
        throw new TagMessagingError(400, "A positive expectedRevision is required");
      const assignmentId = required(id, "Role assignment id");
      const a = self.tables.roleAssignments;
      const [prior] = yield tx.select().from(a).where(eq(a.id, assignmentId)).limit(1);
      if (!prior) throw new TagMessagingError(404, "Role assignment not found");
      if (prior.revision !== expectedRevision)
        throw new TagMessagingError(409, "Role assignment changed; reload before updating");
      if (prior.status === "inactive") return roleAssignmentFromRow(prior);
      const [updated] = yield tx
        .update(a)
        .set({
          status: "inactive",
          revision: prior.revision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(a.id, assignmentId), eq(a.revision, expectedRevision)))
        .returning();
      if (!updated)
        throw new TagMessagingError(409, "Role assignment changed; reload before updating");
      return roleAssignmentFromRow(updated);
    });
  }
}

function roleDefinition(input: CreateRoleInput) {
  return {
    name: roleName(input.name),
    purpose: purpose(input.purpose),
    instructions: instructions(input.instructions ?? ""),
    contextSetIds: stringIds(input.contextSetIds ?? [], "Context Set"),
    permissionSetIds: stringIds(input.permissionSetIds ?? [], "Permission Set"),
    ...executionField(input.execution),
    ...(input.createdBy === undefined ? {} : { createdBy: required(input.createdBy, "createdBy") }),
  };
}

function sameDefinition(role: Role, input: ReturnType<typeof roleDefinition>): boolean {
  return (
    role.purpose === input.purpose &&
    role.instructions === input.instructions &&
    isDeepStrictEqual(role.contextSetIds, input.contextSetIds) &&
    isDeepStrictEqual(role.permissionSetIds, input.permissionSetIds) &&
    isDeepStrictEqual(role.execution, input.execution)
  );
}

function executionField(value: ExecutionSettings | null | undefined): {
  execution?: ExecutionSettings;
} {
  try {
    const execution = parseExecutionSettings(value, "Role execution");
    return execution === undefined ? {} : { execution };
  } catch (error) {
    throw new TagMessagingError(400, error instanceof Error ? error.message : String(error));
  }
}

/** Stored execution settings, or nothing when the column is empty or unreadable. */
export function storedExecution(value: unknown): { execution?: ExecutionSettings } {
  try {
    const execution = parseExecutionSettings(value);
    return execution === undefined ? {} : { execution };
  } catch {
    return {};
  }
}

function* replaceRefs(
  tx: any,
  table: any,
  referenceColumn: "contextSetId" | "permissionSetId",
  roleId: string,
  ids: readonly string[],
): Flow<void> {
  yield tx.delete(table).where(eq(table.roleId, roleId)).returning();
  if (ids.length)
    yield tx
      .insert(table)
      .values(ids.map((id) => ({ roleId, [referenceColumn]: id })))
      .returning();
}

function roleFromRow(
  row: any,
  contextSetIds: readonly string[],
  permissionSetIds: readonly string[],
): Role {
  const origin = row.origin;
  if (origin !== "system" && origin !== "user") throw new Error(`Invalid Role origin: ${origin}`);
  const status = row.status;
  if (status !== "active" && status !== "retired")
    throw new Error(`Invalid Role status: ${status}`);
  const key = row.systemKey === null ? undefined : systemRoleKey(row.systemKey);
  if ((origin === "system") !== (key !== undefined))
    throw new Error(`Role ${row.id} has inconsistent system provenance`);
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    instructions: row.instructions,
    contextSetIds,
    permissionSetIds,
    ...storedExecution(row.execution),
    origin,
    ...(key === undefined ? {} : { systemKey: key }),
    status,
    revision: row.revision,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function roleAssignmentFromRow(row: any): RoleAssignment {
  const status = row.status;
  if (status !== "active" && status !== "inactive")
    throw new Error(`Invalid Role assignment status: ${status}`);
  return {
    id: row.id,
    roleId: row.roleId,
    tagId: row.tagId,
    status,
    revision: row.revision,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function roleSnapshot(assignment: RoleAssignment, role: Role): TagRoleSnapshot {
  return {
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    role: {
      id: role.id,
      name: role.name,
      purpose: role.purpose,
      instructions: role.instructions,
      origin: role.origin,
      ...(role.systemKey === undefined ? {} : { systemKey: role.systemKey }),
      revision: role.revision,
      contextSetIds: [...role.contextSetIds],
      permissionSetIds: [...role.permissionSetIds],
    },
  };
}

function compareRoleSnapshots(left: TagRoleSnapshot, right: TagRoleSnapshot): number {
  return (
    left.role.id.localeCompare(right.role.id) || left.assignmentId.localeCompare(right.assignmentId)
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function roleName(value: unknown): string {
  const normalized = required(value, "Role name");
  if (normalized.length > 100) throw new TagMessagingError(400, "Role name exceeds 100 characters");
  return normalized;
}

function purpose(value: unknown): string {
  const normalized = required(value, "Role purpose");
  if (normalized.length > 1000)
    throw new TagMessagingError(400, "Role purpose exceeds 1000 characters");
  return normalized;
}

function instructions(value: unknown): string {
  if (typeof value !== "string") throw new TagMessagingError(400, "Role instructions must be text");
  const normalized = value.trim();
  if (new TextEncoder().encode(normalized).length > 32_768)
    throw new TagMessagingError(413, "Role instructions exceed 32 KiB");
  return normalized;
}

function stringIds(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 64)
    throw new TagMessagingError(400, `A Role may reference at most 64 ${label}s`);
  return [...new Set(values.map((value) => required(value, `${label} id`)))].sort();
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TagMessagingError(400, `${label} is required`);
  return value.trim();
}

function systemRoleKey(value: unknown): SystemRoleKey {
  if (value !== ORG_ARCHITECT_ROLE_KEY)
    throw new Error(`Unsupported system Role key: ${String(value)}`);
  return value;
}
