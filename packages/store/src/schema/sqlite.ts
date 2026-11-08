import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const json = (name: string) => text(name, { mode: "json" });

export const tags = sqliteTable(
  "Tag",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    /** Placement labels a bound Worker Host must carry. */
    runsOn: json("runsOn").notNull().default([]),
    /** Harness, models, and efforts this Tag allows; overrides its Roles' field by field. */
    execution: json("execution"),
    retiredAt: text("retiredAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  // Only active Tags hold a name; retired Tags keep theirs for history, so it can be reused.
  (table) => [
    uniqueIndex("Tag_active_name_key").on(table.name).where(sql`${table.status} = 'active'`),
    index("Tag_name_idx").on(table.name),
    index("Tag_status_idx").on(table.status),
  ],
);

export const surfaceAccounts = sqliteTable(
  "SurfaceAccount",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalAccountId: text("externalAccountId").notNull(),
    displayName: text("displayName").notNull(),
    authMethod: text("authMethod").notNull(),
    credentialId: text("credentialId").notNull(),
    status: text("status").notNull(),
    configuration: json("configuration").notNull(),
    /** The manifest name, for accounts declared with a SurfaceAccount manifest. */
    name: text("name"),
    /** Where each secret came from at the last apply: references only, never values. */
    secretReferences: json("secretReferences"),
    lastVerifiedAt: text("lastVerifiedAt").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("SurfaceAccount_provider_externalAccountId_key").on(
      table.provider,
      table.externalAccountId,
    ),
    uniqueIndex("SurfaceAccount_name_key").on(table.name),
    index("SurfaceAccount_provider_status_idx").on(table.provider, table.status),
  ],
);

export const workerHosts = sqliteTable(
  "WorkerHost",
  {
    id: text("id").primaryKey(),
    credentialId: text("credentialId").notNull(),
    credentialRevision: integer("credentialRevision").notNull(),
    enrollmentStatus: text("enrollmentStatus").notNull(),
    ephemeral: integer("ephemeral", { mode: "boolean" }).notNull().default(false),
    authKey: text("authKey"),
    connectionGeneration: integer("connectionGeneration").notNull(),
    connectionStatus: text("connectionStatus").notNull(),
    workletId: text("workletId"),
    protocolVersion: integer("protocolVersion"),
    durableProtocolVersion: integer("durableProtocolVersion"),
    controlProtocolVersion: integer("controlProtocolVersion"),
    workerSnapshot: json("workerSnapshot").notNull(),
    /** Labels granted by the redeemed Auth Key; advertised labels live in workerSnapshot. */
    grantedLabels: json("grantedLabels").notNull().default([]),
    capacity: integer("capacity").notNull(),
    availableSlots: integer("availableSlots").notNull(),
    activeAttempts: integer("activeAttempts").notNull(),
    ready: integer("ready", { mode: "boolean" }).notNull(),
    draining: integer("draining", { mode: "boolean" }).notNull(),
    lastAuthenticatedAt: text("lastAuthenticatedAt"),
    failedAuthenticationCount: integer("failedAuthenticationCount").notNull().default(0),
    lastAuthenticationFailureAt: text("lastAuthenticationFailureAt"),
    lastSeenAt: text("lastSeenAt"),
    connectedAt: text("connectedAt"),
    disconnectedAt: text("disconnectedAt"),
    revokedAt: text("revokedAt"),
    revocationReason: text("revocationReason"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("WorkerHost_credentialId_key").on(table.credentialId),
    index("WorkerHost_enrollment_connection_idx").on(
      table.enrollmentStatus,
      table.connectionStatus,
    ),
    index("WorkerHost_lastSeenAt_idx").on(table.lastSeenAt),
  ],
);

export const tagWorkerHostBindings = sqliteTable(
  "TagWorkerHostBinding",
  {
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    workerHostId: text("workerHostId").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagWorkerHostBinding_tagId_workerHostId_key").on(table.tagId, table.workerHostId),
    index("TagWorkerHostBinding_workerHostId_idx").on(table.workerHostId),
  ],
);

/** Operator-issued join secrets. Only a SHA-256 digest of each secret is stored. */
export const authKeys = sqliteTable(
  "AuthKey",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    lookupId: text("lookupId").notNull(),
    secretDigest: text("secretDigest").notNull(),
    tagIds: json("tagIds").notNull(),
    labels: json("labels").notNull().default([]),
    reusable: integer("reusable", { mode: "boolean" }).notNull(),
    ephemeral: integer("ephemeral", { mode: "boolean" }).notNull(),
    expiresAt: text("expiresAt").notNull(),
    usedAt: text("usedAt"),
    redemptionCount: integer("redemptionCount").notNull().default(0),
    revokedAt: text("revokedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("AuthKey_name_key").on(table.name),
    uniqueIndex("AuthKey_lookupId_key").on(table.lookupId),
  ],
);

/** Operator-issued management credentials. Only a SHA-256 digest of each secret is stored. */
export const operatorTokens = sqliteTable(
  "OperatorToken",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    lookupId: text("lookupId").notNull(),
    secretDigest: text("secretDigest").notNull(),
    expiresAt: text("expiresAt").notNull(),
    lastUsedAt: text("lastUsedAt"),
    revokedAt: text("revokedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("OperatorToken_name_key").on(table.name),
    uniqueIndex("OperatorToken_lookupId_key").on(table.lookupId),
  ],
);

/** Durable audit trail of operator changes. Rows name actors and targets, never secrets. */
export const auditEntries = sqliteTable(
  "AuditEntry",
  {
    id: text("id").primaryKey(),
    at: text("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    outcome: text("outcome").notNull(),
    status: integer("status"),
    source: text("source").notNull(),
    method: text("method"),
    path: text("path"),
  },
  (table) => [
    index("AuditEntry_at_idx").on(table.at),
    index("AuditEntry_actor_at_idx").on(table.actor, table.at),
  ],
);

/** Internal enrollment history; credentialId is a vault address and never secret material. */
export const workerHostCredentials = sqliteTable(
  "WorkerHostCredential",
  {
    workerHostId: text("workerHostId")
      .notNull()
      .references(() => workerHosts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    credentialId: text("credentialId").notNull(),
    status: text("status").notNull(),
    createdAt: text("createdAt").notNull(),
    retiredAt: text("retiredAt"),
  },
  (table) => [
    uniqueIndex("WorkerHostCredential_host_revision_key").on(table.workerHostId, table.revision),
    uniqueIndex("WorkerHostCredential_credentialId_key").on(table.credentialId),
    index("WorkerHostCredential_host_status_idx").on(table.workerHostId, table.status),
  ],
);

export const tagPermissionSets = sqliteTable(
  "TagPermissionSet",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    approvers: json("approvers").notNull().default([]),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("TagPermissionSet_name_key").on(table.name)],
);

export const tagPermissions = sqliteTable(
  "TagPermission",
  {
    id: text("id").primaryKey(),
    permissionSetId: text("permissionSetId")
      .notNull()
      .references(() => tagPermissionSets.id, { onDelete: "cascade" }),
    target: text("target").notNull().default("surface"),
    surfaceAccountId: text("surfaceAccountId").references(() => surfaceAccounts.id, {
      onDelete: "restrict",
    }),
    scope: text("scope").notNull(),
    reference: text("reference"),
    action: text("action").notNull(),
    approval: text("approval"),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagPermission_surface_target_action_key")
      .on(table.permissionSetId, table.surfaceAccountId, table.scope, table.action)
      .where(sql`${table.target} = 'surface'`),
    uniqueIndex("TagPermission_runtime_target_action_key")
      .on(table.permissionSetId, table.target, table.action)
      .where(sql`${table.target} = 'runtime'`),
    // MCP rows keep their optional resource in scope, empty when the grant covers every resource.
    uniqueIndex("TagPermission_mcp_target_action_key")
      .on(table.permissionSetId, table.action, table.scope)
      .where(sql`${table.target} = 'mcp'`),
    index("TagPermission_permissionSetId_idx").on(table.permissionSetId),
    index("TagPermission_target_idx").on(table.target),
    index("TagPermission_surfaceAccountId_scope_idx").on(table.surfaceAccountId, table.scope),
  ],
);

export const tagRoutes = sqliteTable(
  "TagRoute",
  {
    id: text("id").primaryKey(),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    surfaceAccountId: text("surfaceAccountId")
      .notNull()
      .references(() => surfaceAccounts.id, { onDelete: "restrict" }),
    scope: text("scope").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    workspaces: json("workspaces").notNull().default([]),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagRoute_surfaceAccountId_scope_key").on(table.surfaceAccountId, table.scope),
    index("TagRoute_tagId_idx").on(table.tagId),
  ],
);

export const tagPermissionActivations = sqliteTable(
  "TagPermissionActivation",
  {
    id: text("id").primaryKey(),
    permissionSetId: text("permissionSetId")
      .notNull()
      .references(() => tagPermissionSets.id, { onDelete: "cascade" }),
    tagRouteId: text("tagRouteId")
      .notNull()
      .references(() => tagRoutes.id, { onDelete: "cascade" }),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagPermissionActivation_permissionSetId_tagRouteId_key").on(
      table.permissionSetId,
      table.tagRouteId,
    ),
    index("TagPermissionActivation_tagRouteId_idx").on(table.tagRouteId),
  ],
);

export const tagContextSets = sqliteTable(
  "TagContextSet",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("TagContextSet_name_key").on(table.name)],
);

export const tagContextItems = sqliteTable(
  "TagContextItem",
  {
    id: text("id").primaryKey(),
    contextSetId: text("contextSetId")
      .notNull()
      .references(() => tagContextSets.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    required: integer("required", { mode: "boolean" }).notNull(),
    itemKey: text("itemKey").notNull(),
    config: json("config").notNull(),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagContextItem_contextSetId_itemKey_key").on(table.contextSetId, table.itemKey),
  ],
);

export const tagContextActivations = sqliteTable(
  "TagContextActivation",
  {
    id: text("id").primaryKey(),
    contextSetId: text("contextSetId")
      .notNull()
      .references(() => tagContextSets.id, { onDelete: "cascade" }),
    tagRouteId: text("tagRouteId")
      .notNull()
      .references(() => tagRoutes.id, { onDelete: "cascade" }),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagContextActivation_contextSetId_tagRouteId_key").on(
      table.contextSetId,
      table.tagRouteId,
    ),
    index("TagContextActivation_tagRouteId_idx").on(table.tagRouteId),
  ],
);

export const roles = sqliteTable(
  "Role",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    instructions: text("instructions").notNull(),
    /** Default harness, models, and efforts for the Role's Tags. */
    execution: json("execution"),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("Role_name_key").on(table.name),
    index("Role_status_idx").on(table.status),
  ],
);

/**
 * Named storage locations Workspaces attach data from. Stores the credential's name only; each
 * Worker Host maps it to a secret.
 */
export const volumes = sqliteTable(
  "Volume",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    source: text("source").notNull(),
    credential: text("credential"),
    revision: integer("revision").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("Volume_name_key").on(table.name)],
);

/** Named repository Objectives may work in; checkout paths stay on Worker Hosts. */
export const workspaces = sqliteTable(
  "Workspace",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    source: text("source"),
    ref: text("ref"),
    setup: text("setup"),
    mcp: json("mcp"),
    skills: json("skills"),
    skillCatalog: json("skillCatalog"),
    mounts: json("mounts"),
    delivery: text("delivery").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("Workspace_name_key").on(table.name)],
);

/** Field managers and apply-set membership for one declaratively managed resource. */
export const resourceManagement = sqliteTable(
  "ResourceManagement",
  {
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    applySet: text("applySet"),
    fields: json("fields").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.name] }),
    index("ResourceManagement_applySet_idx").on(table.applySet),
  ],
);

export const roleContextSets = sqliteTable(
  "RoleContextSet",
  {
    roleId: text("roleId")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    contextSetId: text("contextSetId")
      .notNull()
      .references(() => tagContextSets.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("RoleContextSet_roleId_contextSetId_key").on(table.roleId, table.contextSetId),
    index("RoleContextSet_contextSetId_idx").on(table.contextSetId),
  ],
);

export const rolePermissionSets = sqliteTable(
  "RolePermissionSet",
  {
    roleId: text("roleId")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionSetId: text("permissionSetId")
      .notNull()
      .references(() => tagPermissionSets.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("RolePermissionSet_roleId_permissionSetId_key").on(
      table.roleId,
      table.permissionSetId,
    ),
    index("RolePermissionSet_permissionSetId_idx").on(table.permissionSetId),
  ],
);

export const roleAssignments = sqliteTable(
  "RoleAssignment",
  {
    id: text("id").primaryKey(),
    roleId: text("roleId")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("RoleAssignment_roleId_tagId_key").on(table.roleId, table.tagId),
    index("RoleAssignment_tagId_status_idx").on(table.tagId, table.status),
    index("RoleAssignment_roleId_status_idx").on(table.roleId, table.status),
  ],
);

export const sessions = sqliteTable(
  "Session",
  {
    id: text("id").primaryKey(),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    sessionKey: text("sessionKey").notNull(),
    origin: json("origin").notNull(),
    state: text("state").notNull(),
    audience: text("audience").notNull().default("shared"),
    audienceActorKey: text("audienceActorKey"),
    /** The conversation Session that started this work Session; null for a conversation. */
    parentSessionId: text("parentSessionId").references((): AnySQLiteColumn => sessions.id, {
      onDelete: "cascade",
    }),
    /** The Objective this Session works for; a work Session takes its parent's. Never changes. */
    objectiveId: text("objectiveId").references((): AnySQLiteColumn => objectives.id, {
      onDelete: "restrict",
    }),
    lastInteractionAt: text("lastInteractionAt").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("Session_tagId_sessionKey_key").on(table.tagId, table.sessionKey),
    index("Session_lastInteractionAt_idx").on(table.lastInteractionAt),
    index("Session_parentSessionId_idx").on(table.parentSessionId),
    index("Session_objectiveId_idx").on(table.objectiveId),
  ],
);

export const tasks = sqliteTable(
  "Task",
  {
    id: text("id").primaryKey(),
    inboundEventId: text("inboundEventId"),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    objectiveId: text("objectiveId"),
    execution: json("execution").notNull().default({}),
    actor: json("actor").notNull(),
    trigger: json("trigger").notNull(),
    requestText: text("requestText"),
    responseText: text("responseText"),
    result: json("result"),
    workspacePlan: json("workspacePlan").notNull().default({ version: 1, status: "none" }),
    sessionHistory: json("sessionHistory").notNull(),
    authorizationSnapshot: json("authorizationSnapshot").notNull(),
    contextPlan: json("contextPlan").notNull(),
    status: text("status").notNull(),
    startedAt: text("startedAt"),
    endedAt: text("endedAt"),
    outcome: json("outcome"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("Task_inboundEventId_key").on(table.inboundEventId),
    index("Task_tagId_createdAt_idx").on(table.tagId, table.createdAt),
    index("Task_sessionId_createdAt_idx").on(table.sessionId, table.createdAt),
    index("Task_status_idx").on(table.status),
  ],
);

export const taskAttempts = sqliteTable(
  "TaskAttempt",
  {
    id: text("id").primaryKey(),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attemptNumber: integer("attemptNumber").notNull(),
    workerProfileId: text("workerProfileId").notNull(),
    workerProfileRevision: text("workerProfileRevision").notNull(),
    workerSnapshot: json("workerSnapshot").notNull(),
    mcpServersDigest: text("mcpServersDigest"),
    mountManifests: json("mountManifests"),
    mountOutputManifests: json("mountOutputManifests"),
    liveMounts: json("liveMounts"),
    status: text("status").notNull(),
    startedAt: text("startedAt").notNull(),
    endedAt: text("endedAt"),
    outcome: json("outcome"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("TaskAttempt_taskId_attemptNumber_key").on(table.taskId, table.attemptNumber),
    index("TaskAttempt_taskId_createdAt_idx").on(table.taskId, table.createdAt),
    index("TaskAttempt_status_idx").on(table.status),
  ],
);

export const attemptChangedPaths = sqliteTable("AttemptChangedPaths", {
  attemptId: text("attemptId")
    .primaryKey()
    .references(() => taskAttempts.id, { onDelete: "cascade" }),
  paths: json("paths").notNull(),
  truncated: integer("truncated", { mode: "boolean" }).notNull(),
  reportedAt: text("reportedAt").notNull(),
});

export const overlapWarnings = sqliteTable(
  "OverlapWarning",
  {
    objectiveId: text("objectiveId").notNull(),
    lowerAttemptId: text("lowerAttemptId").notNull(),
    higherAttemptId: text("higherAttemptId").notNull(),
    path: text("path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.objectiveId, t.lowerAttemptId, t.higherAttemptId, t.path] })],
);

export const sessionStates = sqliteTable(
  "SessionState",
  {
    id: text("id").primaryKey(),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "cascade" }),
    harnessId: text("harnessId").notNull(),
    nativeId: text("nativeId"),
    ref: json("ref").notNull(),
    data: json("data").notNull(),
    status: text("status").notNull(),
    writeVersion: integer("writeVersion").notNull(),
    compatibility: text("compatibility"),
    workerProfile: json("workerProfile"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    index("SessionState_sessionId_createdAt_idx").on(table.sessionId, table.createdAt),
    index("SessionState_taskId_createdAt_idx").on(table.taskId, table.createdAt),
    index("SessionState_attemptId_idx").on(table.attemptId),
  ],
);

export const taskEvents = sqliteTable(
  "TaskEvent",
  {
    id: text("id").primaryKey(),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attemptId: text("attemptId").references(() => taskAttempts.id, { onDelete: "set null" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: json("payload"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TaskEvent_taskId_sequence_key").on(table.taskId, table.sequence),
    // Latest usage report per Attempt, for spend reports.
    index("TaskEvent_attemptId_type_sequence_idx").on(table.attemptId, table.type, table.sequence),
  ],
);

/** Pending Workspace pull-request transitions the Control Plane retries after provider failures. */
export const workspacePullRequestTransitions = sqliteTable(
  "WorkspacePullRequestTransition",
  {
    taskId: text("taskId")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    action: text("action").notNull(),
    attemptCount: integer("attemptCount").notNull(),
    nextAttemptAt: text("nextAttemptAt").notNull(),
    lastError: text("lastError"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("WorkspacePullRequestTransition_nextAttemptAt_idx").on(table.nextAttemptAt)],
);

export const artifacts = sqliteTable(
  "Artifact",
  {
    id: text("id").primaryKey(),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    location: text("location").notNull(),
    contentHash: text("contentHash"),
    sourceReferences: json("sourceReferences"),
    metadata: json("metadata"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [index("Artifact_taskId_kind_idx").on(table.taskId, table.kind)],
);

export const taskReferences = sqliteTable(
  "TaskReference",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    surfaceAccountId: text("surfaceAccountId"),
    resourceType: text("resourceType").notNull(),
    resourceId: text("resourceId"),
    reference: text("reference").notNull(),
    relationship: text("relationship").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TaskReference_artifactId_provider_resourceType_reference_relationship_key").on(
      table.artifactId,
      table.provider,
      table.resourceType,
      table.reference,
      table.relationship,
    ),
    index("TaskReference_provider_resourceType_resourceId_idx").on(
      table.provider,
      table.resourceType,
      table.resourceId,
    ),
    index("TaskReference_provider_resourceType_reference_idx").on(
      table.provider,
      table.resourceType,
      table.reference,
    ),
    index("TaskReference_artifactId_relationship_idx").on(table.artifactId, table.relationship),
  ],
);

export const durableInboundEvents = sqliteTable(
  "DurableInboundEvent",
  {
    id: text("id").primaryKey(),
    surfaceAccountId: text("surfaceAccountId")
      .notNull()
      .references(() => surfaceAccounts.id, { onDelete: "restrict" }),
    tagRouteId: text("tagRouteId").notNull(),
    tagId: text("tagId").notNull(),
    execution: json("execution").notNull().default({}),
    admissionOrder: integer("admissionOrder").notNull().default(0),
    sessionBlocked: integer("sessionBlocked", { mode: "boolean" }).notNull().default(false),
    sessionKey: text("sessionKey").notNull().default(""),
    authorization: json("authorization").notNull(),
    contextPlan: json("contextPlan").notNull(),
    deliveryId: text("deliveryId").notNull(),
    logicalEventId: text("logicalEventId").notNull(),
    event: json("event").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attemptCount").notNull(),
    maxAttempts: integer("maxAttempts").notNull(),
    availableAt: text("availableAt").notNull(),
    leaseOwner: text("leaseOwner"),
    leaseExpiresAt: text("leaseExpiresAt"),
    lastError: text("lastError"),
    completedAt: text("completedAt"),
    failedAt: text("failedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("DurableInboundEvent_session_processing_key")
      .on(table.tagId, table.sessionKey)
      .where(sql`${table.status} = 'processing'`),
    index("DurableInboundEvent_session_queue_idx").on(
      table.tagId,
      table.sessionKey,
      table.admissionOrder,
    ),
    uniqueIndex("DurableInboundEvent_admissionOrder_key").on(table.admissionOrder),
    uniqueIndex("DurableInboundEvent_surfaceAccountId_deliveryId_key").on(
      table.surfaceAccountId,
      table.deliveryId,
    ),
    uniqueIndex("DurableInboundEvent_surfaceAccountId_logicalEventId_key").on(
      table.surfaceAccountId,
      table.logicalEventId,
    ),
    index("DurableInboundEvent_status_availableAt_idx").on(table.status, table.availableAt),
    index("DurableInboundEvent_status_leaseExpiresAt_idx").on(table.status, table.leaseExpiresAt),
  ],
);

export const inboundControlDeliveries = sqliteTable(
  "InboundControlDelivery",
  {
    inboundEventId: text("inboundEventId")
      .primaryKey()
      .references(() => durableInboundEvents.id, { onDelete: "cascade" }),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    command: json("command").notNull(),
    workerHostId: text("workerHostId"),
    workerId: text("workerId"),
    status: text("status").notNull(),
    detail: json("detail"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [index("InboundControlDelivery_attempt_idx").on(t.attemptId)],
);

export const outboundReplies = sqliteTable(
  "OutboundReply",
  {
    id: text("id").primaryKey(),
    inboundEventId: text("inboundEventId")
      .notNull()
      .references(() => durableInboundEvents.id, { onDelete: "cascade" }),
    surfaceAccountId: text("surfaceAccountId")
      .notNull()
      .references(() => surfaceAccounts.id, { onDelete: "restrict" }),
    workerId: text("workerId").notNull(),
    callback: json("callback").notNull(),
    presentation: text("presentation").notNull().default("final-result"),
    deliveryKey: text("deliveryKey").notNull().default("final"),
    text: text("text").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull(),
    attemptCount: integer("attemptCount").notNull(),
    maxAttempts: integer("maxAttempts").notNull(),
    availableAt: text("availableAt").notNull(),
    leaseOwner: text("leaseOwner"),
    leaseExpiresAt: text("leaseExpiresAt"),
    lastError: text("lastError"),
    externalMessageId: text("externalMessageId"),
    deliveredAt: text("deliveredAt"),
    failedAt: text("failedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("OutboundReply_inboundEventId_deliveryKey_key").on(
      table.inboundEventId,
      table.deliveryKey,
    ),
    index("OutboundReply_status_availableAt_idx").on(table.status, table.availableAt),
    index("OutboundReply_status_leaseExpiresAt_idx").on(table.status, table.leaseExpiresAt),
  ],
);

export const tagMessagingGrants = sqliteTable(
  "TagMessagingGrant",
  {
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    recipientTagId: text("recipientTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("TagMessagingGrant_pair_key").on(t.senderTagId, t.recipientTagId)],
);
export const objectives = sqliteTable(
  "Objective",
  {
    id: text("id").primaryKey(),
    ongoing: integer("ongoing", { mode: "boolean" }).notNull().default(false),
    outcome: text("outcome").notNull(),
    ownerTagId: text("ownerTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    revision: integer("revision").notNull().default(1),
    lockRevision: integer("lockRevision").notNull().default(0),
    executionStartedAt: text("executionStartedAt"),
    surfaceTaskId: text("surfaceTaskId").references(() => tasks.id, { onDelete: "restrict" }),
    notificationTaskId: text("notificationTaskId").references(() => tasks.id, {
      onDelete: "restrict",
    }),
    surfaceSessionId: text("surfaceSessionId").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    /** The Team the owner may delegate to; several Objectives may name one Team. */
    teamId: text("teamId").references((): AnySQLiteColumn => teams.id, { onDelete: "restrict" }),
    deadline: text("deadline"),
    budgetLimitMinor: integer("budgetLimitMinor"),
    budgetCurrency: text("budgetCurrency"),
    limitState: json("limitState").notNull().default({}),
    runtimeActions: json("runtimeActions").notNull().default([]),
    workspaces: json("workspaces").notNull().default([]),
    completionSummary: text("completionSummary"),
    cancelledAt: text("cancelledAt"),
    cancellationReason: text("cancellationReason"),
    pausedAt: text("pausedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    index("Objective_owner_idx").on(t.ownerTagId),
    index("Objective_teamId_idx").on(t.teamId),
    uniqueIndex("Objective_surfaceSessionId_key").on(t.surfaceSessionId),
  ],
);
export const teams = sqliteTable(
  "Team",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    memberTagIds: json("memberTagIds").notNull(),
    maxConcurrency: integer("maxConcurrency"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("Team_name_key").on(t.name)],
);

export const resourceChanges = sqliteTable(
  "ResourceChange",
  {
    id: text("id").primaryKey(),
    resourceType: text("resourceType").notNull(),
    resourceId: text("resourceId").notNull(),
    fromRevision: integer("fromRevision").notNull(),
    toRevision: integer("toRevision").notNull(),
    actorTagId: text("actorTagId").references(() => tags.id, { onDelete: "set null" }),
    operatorId: text("operatorId"),
    sourceTaskId: text("sourceTaskId").references(() => tasks.id, { onDelete: "set null" }),
    changes: json("changes").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("ResourceChange_resource_revision_key").on(
      t.resourceType,
      t.resourceId,
      t.toRevision,
    ),
    index("ResourceChange_resource_created_idx").on(t.resourceType, t.resourceId, t.createdAt),
    index("ResourceChange_source_task_idx").on(t.sourceTaskId),
  ],
);

export const workstreamPosts = sqliteTable(
  "WorkstreamPost",
  {
    id: text("id").primaryKey(),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    authorTagId: text("authorTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    sourceTaskId: text("sourceTaskId").references(() => tasks.id, { onDelete: "restrict" }),
    to: json("to").notNull().default([]),
    body: text("body").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: text("createdAt").notNull(),
    /** `<sourceTaskId>:<sha256 of to and body>`, derived by the store. */
    idempotencyKey: text("idempotencyKey").notNull(),
  },
  (t) => [
    uniqueIndex("WorkstreamPost_sequence_key").on(t.teamId, t.sequence),
    uniqueIndex("WorkstreamPost_idempotency_key").on(t.teamId, t.authorTagId, t.idempotencyKey),
  ],
);
export const artifactUploads = sqliteTable(
  "ArtifactUpload",
  {
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    digest: text("digest").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [uniqueIndex("ArtifactUpload_attempt_digest_key").on(t.attemptId, t.digest)],
);

export const workerArtifactInventories = sqliteTable("WorkerArtifactInventory", {
  workerHostId: text("workerHostId")
    .primaryKey()
    .references(() => workerHosts.id, { onDelete: "cascade" }),
  connectionGeneration: integer("connectionGeneration").notNull(),
  inventoryRevision: integer("inventoryRevision").notNull(),
  transferBaseUrl: text("transferBaseUrl").notNull(),
  observedAt: text("observedAt").notNull(),
});

export const artifactStorageLocations = sqliteTable(
  "ArtifactStorageLocation",
  {
    workerHostId: text("workerHostId")
      .notNull()
      .references(() => workerHosts.id, { onDelete: "cascade" }),
    digest: text("digest").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    connectionGeneration: integer("connectionGeneration").notNull(),
    inventoryRevision: integer("inventoryRevision").notNull(),
    transferBaseUrl: text("transferBaseUrl").notNull(),
    status: text("status").notNull(),
    observedAt: text("observedAt").notNull(),
    unavailableAt: text("unavailableAt"),
  },
  (t) => [
    uniqueIndex("ArtifactStorageLocation_host_digest_key").on(t.workerHostId, t.digest),
    index("ArtifactStorageLocation_digest_status_idx").on(t.digest, t.status),
  ],
);

/**
 * A content-addressed copy kept on a Volume. Any Worker Host mapped to that Volume can read it, so
 * hosts that cannot reach each other share artifacts through it. `key` is the object key or path
 * beneath the Volume's source; the writing host is provenance, not a transfer endpoint.
 */
export const artifactVolumeCopies = sqliteTable(
  "ArtifactVolumeCopy",
  {
    volumeId: text("volumeId")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    digest: text("digest").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    workerHostId: text("workerHostId").references(() => workerHosts.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    observedAt: text("observedAt").notNull(),
    unavailableAt: text("unavailableAt"),
  },
  (t) => [
    uniqueIndex("ArtifactVolumeCopy_volume_key_key").on(t.volumeId, t.key),
    index("ArtifactVolumeCopy_digest_status_idx").on(t.digest, t.status),
  ],
);

export const capturedArtifacts = sqliteTable(
  "CapturedArtifact",
  {
    id: text("id").primaryKey(),
    operationId: text("operationId").notNull(),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    objectiveId: text("objectiveId").references(() => objectives.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary"),
    kind: text("kind").notNull(),
    entries: json("entries").notNull(),
    inputs: json("inputs").notNull().default(sql`'[]'`),
    harnessSession: json("harnessSession"),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("CapturedArtifact_attempt_operation_key").on(t.attemptId, t.operationId),
    index("CapturedArtifact_objective_created_idx").on(t.objectiveId, t.createdAt, t.id),
    index("CapturedArtifact_session_created_idx").on(t.sessionId, t.createdAt, t.id),
    index("CapturedArtifact_task_created_idx").on(t.taskId, t.createdAt, t.id),
  ],
);
export const artifactAcquisitions = sqliteTable(
  "ArtifactAcquisition",
  {
    id: text("id").primaryKey(),
    operationId: text("operationId").notNull(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => capturedArtifacts.id, { onDelete: "restrict" }),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    paths: json("paths").notNull(),
    delivery: text("delivery").notNull(),
    destination: text("destination"),
    status: text("status").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("ArtifactAcquisition_attempt_operation_key").on(t.attemptId, t.operationId),
    index("ArtifactAcquisition_attempt_created_idx").on(t.attemptId, t.createdAt, t.id),
    index("ArtifactAcquisition_artifact_idx").on(t.artifactId),
  ],
);

export const artifactPublicationApprovals = sqliteTable(
  "ArtifactPublicationApproval",
  {
    id: text("id").primaryKey(),
    sourceTaskId: text("sourceTaskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    sourceObjectiveId: text("sourceObjectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    artifactId: text("artifactId").notNull().default(""),
    paths: json("paths").notNull().default(sql`'[]'`),
    entries: json("entries").notNull().default(sql`'[]'`),
    sourceAttemptId: text("sourceAttemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    sourceAttemptCount: integer("sourceAttemptCount").notNull(),
    reviewedByTagId: text("reviewedByTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    assessment: text("assessment").notNull(),
    acceptedAt: text("acceptedAt").notNull(),
    audienceObjectiveIds: json("audienceObjectiveIds").notNull(),
    approvedByKind: text("approvedByKind").notNull(),
    approvedById: text("approvedById").notNull(),
    approvedAt: text("approvedAt").notNull(),
    supersedesPublicationId: text("supersedesPublicationId"),
    status: text("status").notNull(),
    revision: integer("revision").notNull().default(1),
    withdrawnByKind: text("withdrawnByKind"),
    withdrawnById: text("withdrawnById"),
    withdrawnAt: text("withdrawnAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    index("ArtifactPublicationApproval_source_idx").on(t.sourceObjectiveId, t.sourceTaskId),
    index("ArtifactPublicationApproval_status_idx").on(t.status, t.updatedAt),
  ],
);

export const artifactConsumptionApprovals = sqliteTable(
  "ArtifactConsumptionApproval",
  {
    id: text("id").primaryKey(),
    publicationApprovalId: text("publicationApprovalId")
      .notNull()
      .references(() => artifactPublicationApprovals.id, { onDelete: "restrict" }),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    approvedByKind: text("approvedByKind").notNull(),
    approvedById: text("approvedById").notNull(),
    approvedAt: text("approvedAt").notNull(),
    status: text("status").notNull(),
    revision: integer("revision").notNull().default(1),
    withdrawnByKind: text("withdrawnByKind"),
    withdrawnById: text("withdrawnById"),
    withdrawnAt: text("withdrawnAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("ArtifactConsumptionApproval_publication_objective_key").on(
      t.publicationApprovalId,
      t.objectiveId,
    ),
    index("ArtifactConsumptionApproval_objective_status_idx").on(t.objectiveId, t.status),
  ],
);

export const artifactApprovalAuditEvents = sqliteTable(
  "ArtifactApprovalAuditEvent",
  {
    id: text("id").primaryKey(),
    approvalType: text("approvalType").notNull(),
    approvalId: text("approvalId").notNull(),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    actorKind: text("actorKind").notNull(),
    actorId: text("actorId").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("ArtifactApprovalAuditEvent_approval_revision_key").on(
      t.approvalType,
      t.approvalId,
      t.revision,
    ),
    index("ArtifactApprovalAuditEvent_objective_idx").on(t.objectiveId, t.createdAt),
  ],
);

/** A Mailbox message. Its status is the status of the inbox Task it is bound to. */
export const tagMessages = sqliteTable(
  "TagMessage",
  {
    id: text("id").primaryKey(),
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    recipientTagId: text("recipientTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    objectiveId: text("objectiveId").references(() => objectives.id, { onDelete: "restrict" }),
    sourceTaskId: text("sourceTaskId").references(() => tasks.id, { onDelete: "restrict" }),
    workstreamPostId: text("workstreamPostId").references(() => workstreamPosts.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    hops: integer("hops").notNull().default(0),
    /** The inbox Task that handles the message; null until a turn claims it. */
    taskId: text("taskId").references(() => tasks.id, { onDelete: "restrict" }),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [
    index("TagMessage_recipient_task_created_idx").on(t.recipientTagId, t.taskId, t.createdAt),
    index("TagMessage_task_idx").on(t.taskId),
    index("TagMessage_sender_history_idx").on(t.senderTagId, t.createdAt, t.id),
    index("TagMessage_recipient_history_idx").on(t.recipientTagId, t.createdAt, t.id),
  ],
);
export const approvalRequests = sqliteTable(
  "ApprovalRequest",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objectiveId"),
    taskId: text("taskId").notNull(),
    attemptId: text("attemptId"),
    requestingTagId: text("requestingTagId").notNull(),
    kind: text("kind").notNull(),
    actions: json("actions").notNull(),
    argumentsDigest: text("argumentsDigest"),
    summary: text("summary").notNull(),
    ruleSources: json("ruleSources").notNull().default([]),
    approvers: json("approvers").notNull().default([]),
    status: text("status").notNull(),
    scope: text("scope"),
    validUntil: text("validUntil"),
    decidedBy: text("decidedBy"),
    decidedByKind: text("decidedByKind"),
    decidedAt: text("decidedAt"),
    reason: text("reason"),
    consumedAt: text("consumedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    index("ApprovalRequest_objective_status_idx").on(t.objectiveId, t.status, t.scope),
    index("ApprovalRequest_task_status_idx").on(t.taskId, t.status),
    index("ApprovalRequest_status_created_idx").on(t.status, t.createdAt, t.id),
  ],
);

/** Durable outbox for operator channel messages that are not replies to an inbound event. */
export const operatorNotifications = sqliteTable(
  "OperatorNotification",
  {
    id: text("id").primaryKey(),
    destination: text("destination").notNull(),
    objectiveId: text("objectiveId").notNull(),
    itemKeys: json("itemKeys").notNull(),
    text: text("text").notNull(),
    immediate: integer("immediate", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull(),
    attemptCount: integer("attemptCount").notNull(),
    maxAttempts: integer("maxAttempts").notNull(),
    availableAt: text("availableAt").notNull(),
    leaseOwner: text("leaseOwner"),
    leaseExpiresAt: text("leaseExpiresAt"),
    lastError: text("lastError"),
    externalMessageId: text("externalMessageId"),
    deliveredAt: text("deliveredAt"),
    failedAt: text("failedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    index("OperatorNotification_destination_objective_idx").on(
      t.destination,
      t.objectiveId,
      t.createdAt,
    ),
    index("OperatorNotification_status_availableAt_idx").on(t.status, t.availableAt),
    index("OperatorNotification_status_leaseExpiresAt_idx").on(t.status, t.leaseExpiresAt),
  ],
);

/** Each inbox item occurrence reaches one operator destination at most once. */
export const operatorNotificationItems = sqliteTable(
  "OperatorNotificationItem",
  {
    destination: text("destination").notNull(),
    itemKey: text("itemKey").notNull(),
    notificationId: text("notificationId")
      .notNull()
      .references(() => operatorNotifications.id, { onDelete: "cascade" }),
    objectiveId: text("objectiveId").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.destination, t.itemKey] }),
    index("OperatorNotificationItem_notification_idx").on(t.notificationId),
  ],
);

export const sqliteSchema = {
  attemptChangedPaths,
  overlapWarnings,
  approvalRequests,
  operatorNotifications,
  operatorNotificationItems,
  artifactUploads,
  capturedArtifacts,
  artifactAcquisitions,
  artifactApprovalAuditEvents,
  artifactConsumptionApprovals,
  artifactPublicationApprovals,
  objectives,
  inboundControlDeliveries,
  resourceChanges,
  teams,
  workstreamPosts,
  tagMessagingGrants,
  tagMessages,
  artifacts,
  surfaceAccounts,
  workerHosts,
  tagWorkerHostBindings,
  workerHostCredentials,
  authKeys,
  operatorTokens,
  auditEntries,
  durableInboundEvents,
  outboundReplies,
  taskAttempts,
  taskEvents,
  tasks,
  sessions,
  tagContextActivations,
  tagContextItems,
  tagContextSets,
  roleAssignments,
  roleContextSets,
  rolePermissionSets,
  roles,
  tagPermissionActivations,
  tagPermissions,
  tagPermissionSets,
  tagRoutes,
  tags,
  taskReferences,
};
