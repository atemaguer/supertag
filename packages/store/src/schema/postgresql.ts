import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const json = (name: string) => jsonb(name);

export const tags = pgTable(
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

export const surfaceAccounts = pgTable(
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

export const workerHosts = pgTable(
  "WorkerHost",
  {
    id: text("id").primaryKey(),
    credentialId: text("credentialId").notNull(),
    credentialRevision: integer("credentialRevision").notNull(),
    enrollmentStatus: text("enrollmentStatus").notNull(),
    ephemeral: boolean("ephemeral").notNull().default(false),
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
    ready: boolean("ready").notNull(),
    draining: boolean("draining").notNull(),
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

export const tagWorkerHostBindings = pgTable(
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
export const authKeys = pgTable(
  "AuthKey",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    lookupId: text("lookupId").notNull(),
    secretDigest: text("secretDigest").notNull(),
    tagIds: json("tagIds").notNull(),
    labels: json("labels").notNull().default([]),
    reusable: boolean("reusable").notNull(),
    ephemeral: boolean("ephemeral").notNull(),
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
export const operatorTokens = pgTable(
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
export const auditEntries = pgTable(
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
export const workerHostCredentials = pgTable(
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

export const tagPermissionSets = pgTable(
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

export const tagPermissions = pgTable(
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

export const tagRoutes = pgTable(
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
    enabled: boolean("enabled").notNull(),
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

export const tagPermissionActivations = pgTable(
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

export const tagContextSets = pgTable(
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

export const tagContextItems = pgTable(
  "TagContextItem",
  {
    id: text("id").primaryKey(),
    contextSetId: text("contextSetId")
      .notNull()
      .references(() => tagContextSets.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    required: boolean("required").notNull(),
    itemKey: text("itemKey").notNull(),
    config: json("config").notNull(),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    uniqueIndex("TagContextItem_contextSetId_itemKey_key").on(table.contextSetId, table.itemKey),
  ],
);

export const tagContextActivations = pgTable(
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

export const roles = pgTable(
  "Role",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    instructions: text("instructions").notNull(),
    /** Default harness, models, and efforts for the Role's Tags. */
    execution: json("execution"),
    origin: text("origin").notNull(),
    systemKey: text("systemKey"),
    status: text("status").notNull(),
    revision: integer("revision").notNull(),
    createdBy: text("createdBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("Role_name_key").on(table.name),
    uniqueIndex("Role_systemKey_key").on(table.systemKey),
    index("Role_status_idx").on(table.status),
  ],
);

/**
 * Named storage locations Workspaces attach data from. Stores the credential's name only; each
 * Worker Host maps it to a secret.
 */
export const volumes = pgTable(
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
export const workspaces = pgTable(
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
export const resourceManagement = pgTable(
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

export const roleContextSets = pgTable(
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

export const rolePermissionSets = pgTable(
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

export const roleAssignments = pgTable(
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

export const sessions = pgTable(
  "Session",
  {
    id: text("id").primaryKey(),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    sessionKey: text("sessionKey").notNull(),
    origin: json("origin").notNull(),
    state: text("state").notNull(),
    lastInteractionAt: text("lastInteractionAt").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("Session_tagId_sessionKey_key").on(table.tagId, table.sessionKey),
    index("Session_lastInteractionAt_idx").on(table.lastInteractionAt),
  ],
);

export const tasks = pgTable(
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
    surfaceObjectiveId: text("surfaceObjectiveId"),
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

export const taskAttempts = pgTable(
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

export const attemptChangedPaths = pgTable("AttemptChangedPaths", {
  attemptId: text("attemptId")
    .primaryKey()
    .references(() => taskAttempts.id, { onDelete: "cascade" }),
  paths: json("paths").notNull(),
  truncated: boolean("truncated").notNull(),
  reportedAt: text("reportedAt").notNull(),
});

export const overlapWarnings = pgTable(
  "OverlapWarning",
  {
    teamId: text("teamId").notNull(),
    lowerAttemptId: text("lowerAttemptId").notNull(),
    higherAttemptId: text("higherAttemptId").notNull(),
    path: text("path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.lowerAttemptId, t.higherAttemptId, t.path] })],
);

export const sessionStates = pgTable(
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
    writeVersion: bigint("writeVersion", { mode: "number" }).notNull(),
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

export const taskEvents = pgTable(
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
export const workspacePullRequestTransitions = pgTable(
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

export const artifacts = pgTable(
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

export const taskReferences = pgTable(
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

export const durableInboundEvents = pgTable(
  "DurableInboundEvent",
  {
    id: text("id").primaryKey(),
    surfaceAccountId: text("surfaceAccountId")
      .notNull()
      .references(() => surfaceAccounts.id, { onDelete: "restrict" }),
    tagRouteId: text("tagRouteId").notNull(),
    tagId: text("tagId").notNull(),
    execution: json("execution").notNull().default({}),
    admissionOrder: serial("admissionOrder").notNull(),
    sessionBlocked: boolean("sessionBlocked").notNull().default(false),
    sessionKey: text("sessionKey").notNull(),
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

export const inboundControlDeliveries = pgTable(
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

export const outboundReplies = pgTable(
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

export const tagMessagingGrants = pgTable(
  "TagMessagingGrant",
  {
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    recipientTagId: text("recipientTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    messageTypes: json("messageTypes").notNull(),
  },
  (t) => [uniqueIndex("TagMessagingGrant_pair_key").on(t.senderTagId, t.recipientTagId)],
);
export const tagMailboxCredentials = pgTable(
  "TagMailboxCredential",
  {
    id: text("id").primaryKey(),
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [uniqueIndex("TagMailboxCredential_tokenHash_key").on(t.tokenHash)],
);
export const objectives = pgTable(
  "Objective",
  {
    id: text("id").primaryKey(),
    ongoing: boolean("ongoing").notNull().default(false),
    observations: json("observations").notNull().default([]),
    observationState: json("observationState").notNull().default({ cursors: {} }),
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
    deadline: text("deadline"),
    budgetLimitMinor: integer("budgetLimitMinor"),
    budgetCurrency: text("budgetCurrency"),
    limitState: json("limitState").notNull().default({}),
    spentMinor: integer("spentMinor").notNull().default(0),
    reservedMinor: integer("reservedMinor").notNull().default(0),
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
    uniqueIndex("Objective_surfaceSessionId_key").on(t.surfaceSessionId),
  ],
);
/** Durable Session association; Objective origin remains the reporting anchor. */
export const objectiveSessions = pgTable(
  "ObjectiveSession",
  {
    sessionId: text("sessionId")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    surfaceTaskId: text("surfaceTaskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [index("ObjectiveSession_objectiveId_idx").on(t.objectiveId)],
);
export const teams = pgTable(
  "Team",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    objectiveIds: json("objectiveIds").notNull().default([]),
    context: json("context").notNull().default({}),
    scaling: json("scaling").notNull().default({}),
    name: text("name").notNull(),
    leadTagId: text("leadTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    memberTagIds: json("memberTagIds").notNull(),
    parentTeamId: text("parentTeamId"),
    maxConcurrency: integer("maxConcurrency"),
    status: text("status").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    index("Team_objective_idx").on(t.objectiveId),
    index("Team_parent_idx").on(t.parentTeamId),
  ],
);
/** Durable wake eligibility captured when a Team item is stored, never inferred later. */
export const teamReplyTriggers = pgTable(
  "TeamReplyTrigger",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    recipientTagId: text("recipientTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    itemKind: text("itemKind").notNull(),
    itemId: text("itemId").notNull(),
    itemType: text("itemType").notNull(),
    sourceTaskId: text("sourceTaskId").references(() => tasks.id, { onDelete: "restrict" }),
    taskId: text("taskId").references(() => tasks.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("TeamReplyTrigger_item_recipient_key").on(t.itemKind, t.itemId, t.recipientTagId),
    index("TeamReplyTrigger_status_created_idx").on(t.status, t.createdAt),
    index("TeamReplyTrigger_recipient_objective_idx").on(
      t.recipientTagId,
      t.objectiveId,
      t.createdAt,
    ),
    index("TeamReplyTrigger_task_idx").on(t.taskId),
  ],
);

export const resourceChanges = pgTable(
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
    sourceMessageId: text("sourceMessageId").references(() => tagMessages.id, {
      onDelete: "set null",
    }),
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
    index("ResourceChange_source_message_idx").on(t.sourceMessageId),
  ],
);
/** A Team's channel: one per Team, sharing the Team ID. Everything else is read from the Team. */
export const workstreams = pgTable("Workstream", {
  id: text("id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "restrict" }),
  createdAt: text("createdAt").notNull(),
});

export const workstreamPosts = pgTable(
  "WorkstreamPost",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstreamId")
      .notNull()
      .references(() => workstreams.id, { onDelete: "restrict" }),
    /** Null identifies a store-generated system notice; member posts require a Tag. */
    authorTagId: text("authorTagId").references(() => tags.id, { onDelete: "restrict" }),
    /** The Objective the post was written under; only its readers see the post. */
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    sourceTaskId: text("sourceTaskId").references(() => tasks.id, { onDelete: "restrict" }),
    type: text("type").notNull().default("note"),
    to: json("to").notNull().default([]),
    body: text("body").notNull(),
    references: json("references").notNull(),
    replyTo: text("replyTo"),
    sequence: integer("sequence").notNull(),
    createdAt: text("createdAt").notNull(),
    idempotencyKey: text("idempotencyKey").notNull(),
  },
  (t) => [
    // Each Objective numbers its own posts in a channel, so a sequence reveals nothing about
    // posts written under another Objective.
    uniqueIndex("WorkstreamPost_sequence_key").on(t.workstreamId, t.objectiveId, t.sequence),
    uniqueIndex("WorkstreamPost_idempotency_key").on(
      t.workstreamId,
      t.authorTagId,
      t.idempotencyKey,
    ),
  ],
);

/**
 * The Tag's digest cursor: one row per Team post or direct message delivered in an activation
 * digest, so each item reaches a Tag's activations once per Objective.
 */
export const tagDigestDeliveries = pgTable(
  "TagDigestDelivery",
  {
    tagId: text("tagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    itemKind: text("itemKind").notNull(),
    itemId: text("itemId").notNull(),
    deliveredAt: text("deliveredAt").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.objectiveId, t.itemKind, t.itemId] })],
);

/**
 * Team posts and direct messages injected into a running Task Attempt as live input. One row per
 * recipient Attempt and item, so a shared Team post reaches each running Attempt once; rows of one Attempt and
 * sender bound the pair's injections. `accepted` rows also have a digest delivery.
 */
export const teamLiveDeliveries = pgTable(
  "TeamLiveDelivery",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    recipientTagId: text("recipientTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    itemKind: text("itemKind").notNull(),
    itemId: text("itemId").notNull(),
    itemType: text("itemType").notNull(),
    status: text("status").notNull(),
    dispatchedAt: text("dispatchedAt"),
    truncated: boolean("truncated").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("TeamLiveDelivery_item_key").on(t.attemptId, t.itemKind, t.itemId),
    uniqueIndex("TeamLiveDelivery_message_key")
      .on(t.recipientTagId, t.objectiveId, t.itemId)
      .where(sql`${t.itemKind} = 'direct_message'`),
    index("TeamLiveDelivery_pair_idx").on(t.attemptId, t.senderTagId),
    index("TeamLiveDelivery_objective_idx").on(t.objectiveId, t.createdAt),
  ],
);

export const taskAssignments = pgTable(
  "TaskAssignment",
  {
    taskId: text("taskId")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "restrict" }),
    limitSummaryActivation: boolean("limitSummaryActivation").notNull().default(false),
    activationKind: text("activationKind"),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    workstreamId: text("workstreamId").references(() => workstreams.id, { onDelete: "restrict" }),
    teamId: text("teamId")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    requestedByTagId: text("requestedByTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    assignedTagId: text("assignedTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    parentTaskId: text("parentTaskId"),
    waitState: json("waitState"),
    sourceMessageId: text("sourceMessageId").references(() => tagMessages.id, {
      onDelete: "restrict",
    }),
    instruction: text("instruction").notNull(),
    acceptanceCriteria: json("acceptanceCriteria").notNull(),
    /** Objective statement items this Task serves, such as ["1", "3"]. */
    items: json("items").notNull().default([]),
    dependencies: json("dependencies").notNull(),
    priority: text("priority").notNull().default("normal"),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    approval: text("approval").notNull(),
    leaseOwner: text("leaseOwner"),
    leaseExpiresAt: text("leaseExpiresAt"),
    /** The current Attempt's uncertainty while its Worker Host receipt is `unknown`. */
    uncertainAttempt: json("uncertainAttempt"),
    attemptCount: integer("attemptCount").notNull().default(0),
    availableAt: text("availableAt").notNull(),
    reservedMinor: integer("reservedMinor").notNull().default(0),
    chargedMinor: integer("chargedMinor"),
    result: json("result"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("TaskAssignment_sourceMessageId_key").on(t.sourceMessageId),
    index("TaskAssignment_objective_status_idx").on(t.objectiveId, t.status),
    index("TaskAssignment_team_status_idx").on(t.teamId, t.status),
  ],
);

export const artifactUploads = pgTable(
  "ArtifactUpload",
  {
    attemptId: text("attemptId")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "restrict" }),
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    digest: text("digest").notNull(),
    sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [uniqueIndex("ArtifactUpload_attempt_digest_key").on(t.attemptId, t.digest)],
);

export const workerArtifactInventories = pgTable("WorkerArtifactInventory", {
  workerHostId: text("workerHostId")
    .primaryKey()
    .references(() => workerHosts.id, { onDelete: "cascade" }),
  connectionGeneration: integer("connectionGeneration").notNull(),
  inventoryRevision: integer("inventoryRevision").notNull(),
  transferBaseUrl: text("transferBaseUrl").notNull(),
  observedAt: text("observedAt").notNull(),
});

export const artifactStorageLocations = pgTable(
  "ArtifactStorageLocation",
  {
    workerHostId: text("workerHostId")
      .notNull()
      .references(() => workerHosts.id, { onDelete: "cascade" }),
    digest: text("digest").notNull(),
    sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
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
export const artifactVolumeCopies = pgTable(
  "ArtifactVolumeCopy",
  {
    volumeId: text("volumeId")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    digest: text("digest").notNull(),
    sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
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

export const capturedArtifacts = pgTable(
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
    inputs: json("inputs").notNull().default([]),
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
export const artifactAcquisitions = pgTable(
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

export const artifactPublicationApprovals = pgTable(
  "ArtifactPublicationApproval",
  {
    id: text("id").primaryKey(),
    sourceTaskId: text("sourceTaskId")
      .notNull()
      .references(() => taskAssignments.taskId, { onDelete: "restrict" }),
    sourceObjectiveId: text("sourceObjectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    artifactId: text("artifactId").notNull().default(""),
    paths: jsonb("paths").notNull().default([]),
    entries: jsonb("entries").notNull().default([]),
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

export const artifactConsumptionApprovals = pgTable(
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

export const artifactApprovalAuditEvents = pgTable(
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

export const tagMessages = pgTable(
  "TagMessage",
  {
    id: text("id").primaryKey(),
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    recipientTagId: text("recipientTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    recipientTeamId: text("recipientTeamId"),
    directTeamId: text("directTeamId"),
    operatorId: text("operatorId"),
    objectiveId: text("objectiveId").notNull(),
    type: text("type").notNull(),
    body: json("body").notNull(),
    bodyPrunedAt: text("bodyPrunedAt"),
    idempotencyKey: text("idempotencyKey").notNull(),
    fingerprint: text("fingerprint").notNull(),
    inReplyTo: text("inReplyTo"),
    status: text("status").notNull(),
    attemptCount: integer("attemptCount").notNull().default(0),
    leaseToken: text("leaseToken"),
    leaseCredentialId: text("leaseCredentialId"),
    leaseExpiresAt: text("leaseExpiresAt"),
    processedAt: text("processedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("TagMessage_sender_idempotency_key").on(t.senderTagId, t.idempotencyKey),
    index("TagMessage_recipient_status_created_idx").on(t.recipientTagId, t.status, t.createdAt),
    index("TagMessage_sender_history_idx").on(t.senderTagId, t.createdAt, t.id),
    index("TagMessage_recipient_history_idx").on(t.recipientTagId, t.createdAt, t.id),
    index("TagMessage_retention_idx").on(t.status, t.updatedAt),
    index("TagMessage_objective_idx").on(t.objectiveId),
  ],
);

/** Internal evidence of operator input included in an owner Task Attempt. */
export const operatorInputReceipts = pgTable(
  "OperatorInputReceipt",
  {
    taskId: text("taskId")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attemptCount: integer("attemptCount").notNull(),
    messageId: text("messageId")
      .notNull()
      .references(() => tagMessages.id, { onDelete: "cascade" }),
    seenAt: text("seenAt").notNull(),
    handledAt: text("handledAt"),
    handlingKind: text("handlingKind"),
    handlingId: text("handlingId"),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.attemptCount, t.messageId] }),
    index("OperatorInputReceipt_message_idx").on(t.messageId),
  ],
);

export const objectiveMessages = pgTable(
  "ObjectiveMessage",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objectiveId")
      .notNull()
      .references(() => objectives.id, { onDelete: "restrict" }),
    senderTagId: text("senderTagId")
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    sourceTaskId: text("sourceTaskId")
      .notNull()
      .references(() => taskAssignments.taskId, { onDelete: "restrict" }),
    type: text("type").notNull(),
    needsReply: boolean("needsReply").notNull().default(true),
    body: json("body").notNull(),
    idempotencyKey: text("idempotencyKey").notNull(),
    fingerprint: text("fingerprint").notNull(),
    replyMessageId: text("replyMessageId").references(() => tagMessages.id, {
      onDelete: "restrict",
    }),
    repliedByOperatorId: text("repliedByOperatorId"),
    /** Set when the Objective closed before anyone replied; the message leaves the inbox. */
    resolvedAt: text("resolvedAt"),
    resolutionReason: text("resolutionReason"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("ObjectiveMessage_sender_key").on(t.objectiveId, t.senderTagId, t.idempotencyKey),
    index("ObjectiveMessage_pending_idx").on(t.replyMessageId, t.createdAt, t.id),
    index("ObjectiveMessage_objective_idx").on(t.objectiveId, t.createdAt, t.id),
  ],
);

export const approvalRequests = pgTable(
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
export const operatorNotifications = pgTable(
  "OperatorNotification",
  {
    id: text("id").primaryKey(),
    destination: text("destination").notNull(),
    objectiveId: text("objectiveId").notNull(),
    itemKeys: json("itemKeys").notNull(),
    text: text("text").notNull(),
    immediate: boolean("immediate").notNull().default(false),
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
export const operatorNotificationItems = pgTable(
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

export const postgresqlSchema = {
  attemptChangedPaths,
  overlapWarnings,
  approvalRequests,
  operatorNotifications,
  operatorNotificationItems,
  objectiveMessages,
  operatorInputReceipts,
  artifactUploads,
  capturedArtifacts,
  artifactAcquisitions,
  artifactApprovalAuditEvents,
  artifactConsumptionApprovals,
  artifactPublicationApprovals,
  objectives,
  objectiveSessions,
  inboundControlDeliveries,
  resourceChanges,
  teams,
  taskAssignments,
  workstreams,
  workstreamPosts,
  tagDigestDeliveries,
  teamLiveDeliveries,
  teamReplyTriggers,
  tagMessagingGrants,
  tagMailboxCredentials,
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
