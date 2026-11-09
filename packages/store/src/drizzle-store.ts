// biome-ignore-all lint/suspicious/noExplicitAny: This adapter intentionally presents one
// implementation over Drizzle's dialect-specific fluent builder types. Runtime values remain
// schema-backed and all data crossing the Store boundary is validated below.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ActivateTagContextSetInput,
  ActivateTagPermissionSetInput,
  AddTagContextItemInput,
  AddTagPermissionInput,
  AddTagRouteInput,
  AdmitInboundEventInput,
  AdmitInboundEventResult,
  AppendTaskEventInput,
  ApprovalRequestStore,
  Artifact,
  ArtifactCatalogStore,
  ArtifactListFilter,
  ArtifactPublicationStore,
  AuditStore,
  AuthKeyStore,
  CallbackRoute,
  CancelPendingSurfaceTaskInput,
  ClaimDueInboundEventInput,
  ClaimDueWorkInput,
  CloseTaskAttemptInput,
  CloseTaskInput,
  CompleteInboundEventInput,
  CompleteOutboundReplyInput,
  CoordinationInboxStore,
  CoordinationMetricsStore,
  CreateArtifactInput,
  CreateTagContextSetInput,
  CreateTagInput,
  CreateTagPermissionSetInput,
  CreateTaskAttemptInput,
  DatabaseProvider,
  DeferOutboundReplyInput,
  DurableInboundEvent,
  DurableInboundEventStatus,
  EnqueueOutboundReplyInput,
  ExecutionSettings,
  FindTagByNameOptions,
  InboundControlDelivery,
  InboundEventActor,
  InboundSurfaceEvent,
  JsonRecord,
  ListDueWorkInput,
  LiveMount,
  MountManifest,
  MountOutputManifest,
  ObjectiveSessionStore,
  ObjectiveStore,
  OpenSessionInput,
  OpenSurfaceTaskAttemptInput,
  OpenTaskInput,
  OperatorNotificationStore,
  OperatorTokenStore,
  OutboundPresentation,
  OutboundReply,
  OutboundReplyStatus,
  RecordTaskAttemptWorkerInput,
  RenewInboundEventLeaseInput,
  ResourceManagementStore,
  RetryInboundEventInput,
  RetryOutboundReplyInput,
  RoleStore,
  Session,
  SessionAudienceStore,
  SessionInputStore,
  SessionListFilter,
  SessionStatePersistence,
  SettleSurfaceAttemptInput,
  SettleSurfaceFailureInput,
  StartTaskInput,
  Store,
  SurfaceAccount,
  SurfaceAccountInput,
  SurfaceProvider,
  Tag,
  TagArtifactSelectionPolicy,
  TagAuthorizationSnapshot,
  TagContextActivation,
  TagContextActivationListFilter,
  TagContextItem,
  TagContextItemListFilter,
  TagContextPlan,
  TagContextSet,
  TagContextSetListFilter,
  TagListFilter,
  TagMailboxStore,
  TagPermission,
  TagPermissionActivation,
  TagPermissionActivationListFilter,
  TagPermissionListFilter,
  TagPermissionSet,
  TagPermissionSetListFilter,
  TagRoute,
  TagRouteListFilter,
  TagWorkerHostBinding,
  Task,
  TaskAttempt,
  TaskAttemptStatus,
  TaskEvent,
  TaskHistoryEntry,
  TaskHistoryFilter,
  TaskListFilter,
  TaskReference,
  TaskResult,
  TaskStatus,
  TaskWorkspacePlan,
  TeamStore,
  VolumeStore,
  WorkerHostStore,
  WorkerProfileRef,
  WorkspaceStore,
  WorkstreamStore,
} from "@supertag/core";
import {
  ARTIFACT_CONTEXT_TYPE,
  ATTEMPT_CLEANUP_BLOCK_REASONS,
  normalizeApprovers,
  parseExecutionSettings,
  parseLiveMounts,
  parseMcpGrantAction,
  parseMcpGrantResource,
  parseMountManifests,
  parseMountOutputManifests,
  parseTaskExecutionRequirements,
  parseTaskFindings,
  parseWorkerHostLabels,
  parseWorkspaceNames,
  recordTaskFindings,
  SESSION_INPUT_ACK_TIMEOUT_MS,
  SKILL_CONTEXT_TYPE,
  WORK_SESSION_MAX_RUNNING,
} from "@supertag/core";
import type Database from "better-sqlite3";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { DrizzleApprovalRequestStore } from "./approval-store.js";
import { DrizzleArtifactCatalogStore } from "./artifact-catalog-store.js";
import { DrizzleArtifactPublicationStore } from "./artifact-publication-store.js";
import { validateSubmittedArtifacts } from "./artifact-selection.js";
import { DrizzleAuditStore } from "./audit-store.js";
import { DrizzleAuthKeyStore } from "./auth-key-store.js";
import { DrizzleCoordinationInboxStore } from "./coordination-inbox-store.js";
import { DrizzleCoordinationMetricsStore } from "./coordination-metrics-store.js";
import { runDialectTransaction } from "./dialect-transaction.js";
import { DrizzleMailboxStore } from "./mailbox-store.js";
import { DrizzleOperatorNotificationStore } from "./operator-notification-store.js";
import { DrizzleOperatorTokenStore } from "./operator-token-store.js";
import { defaultSqliteUrl } from "./paths.js";
import type { ResourceChangeStore } from "./resource-change.js";
import { DrizzleResourceChangeStore } from "./resource-change-store.js";
import { DrizzleResourceManagementStore } from "./resource-management-store.js";
import { DrizzleRoleStore, storedExecution } from "./role-store.js";
import * as postgresql from "./schema/postgresql.js";
import * as sqlite from "./schema/sqlite.js";
import { DrizzleSessionAudienceStore, sessionFromRow } from "./session-audience-store.js";
import { DrizzleSessionStateStore } from "./session-state-store.js";
import { DrizzleSpendStore } from "./spend-store.js";
import { openSqliteDatabase } from "./sqlite-connection.js";
import { nextTaskEventSequence } from "./task-event-sequence.js";
import { DrizzleTeamStore } from "./team-store.js";
import { DrizzleVolumeStore } from "./volume-store.js";
import { DrizzleWorkerHostStore, storedLabels } from "./worker-host-store.js";
import { DrizzleWorkspaceStore } from "./workspace-store.js";

export interface StoreOptions {
  readonly url?: string;
}

type DynamicDatabase = any;
type DynamicTable = any;

export class DrizzleStore implements Store {
  readonly provider: DatabaseProvider;
  #db: DynamicDatabase;
  readonly #tables: any;
  #sqliteConnection: Database.Database | undefined;
  #postgresqlPool: Pool | undefined;
  readonly #url: string;

  constructor(options: StoreOptions = {}) {
    const url = options.url ?? process.env["SUPERTAG_DATABASE_URL"] ?? defaultSqliteUrl();
    this.#url = url;
    if (url.startsWith("file:")) {
      this.provider = "sqlite";
      const path = sqlitePathFromUrl(url);
      this.#sqliteConnection = openSqliteDatabase(path);
      this.#sqliteConnection.pragma("foreign_keys = ON");
      this.#db = drizzleSqlite(this.#sqliteConnection, { schema: sqlite.sqliteSchema });
      this.#tables = sqlite;
      return;
    }
    if (url.startsWith("postgresql:") || url.startsWith("postgres:")) {
      this.provider = "postgresql";
      this.#postgresqlPool = new Pool({ connectionString: url });
      this.#db = drizzlePostgresql(this.#postgresqlPool, { schema: postgresql.postgresqlSchema });
      this.#tables = postgresql;
      return;
    }
    throw new Error("SUPERTAG_DATABASE_URL must use file:, postgresql:, or postgres:");
  }

  enrollWorkerHost(
    ...args: Parameters<WorkerHostStore["enrollWorkerHost"]>
  ): ReturnType<WorkerHostStore["enrollWorkerHost"]> {
    return new DrizzleWorkerHostStore(this.#db, this.#tables, this.provider).enrollWorkerHost(
      ...args,
    );
  }
  findWorkerHostById(
    ...args: Parameters<WorkerHostStore["findWorkerHostById"]>
  ): ReturnType<WorkerHostStore["findWorkerHostById"]> {
    return new DrizzleWorkerHostStore(this.#db, this.#tables, this.provider).findWorkerHostById(
      ...args,
    );
  }
  listWorkerHosts(
    ...args: Parameters<WorkerHostStore["listWorkerHosts"]>
  ): ReturnType<WorkerHostStore["listWorkerHosts"]> {
    return new DrizzleWorkerHostStore(this.#db, this.#tables, this.provider).listWorkerHosts(
      ...args,
    );
  }
  rotateWorkerHostCredential(
    ...args: Parameters<WorkerHostStore["rotateWorkerHostCredential"]>
  ): ReturnType<WorkerHostStore["rotateWorkerHostCredential"]> {
    return new DrizzleWorkerHostStore(
      this.#db,
      this.#tables,
      this.provider,
    ).rotateWorkerHostCredential(...args);
  }
  revokeWorkerHost(
    ...args: Parameters<WorkerHostStore["revokeWorkerHost"]>
  ): ReturnType<WorkerHostStore["revokeWorkerHost"]> {
    return new DrizzleWorkerHostStore(this.#db, this.#tables, this.provider).revokeWorkerHost(
      ...args,
    );
  }
  setWorkerHostDraining(
    ...args: Parameters<WorkerHostStore["setWorkerHostDraining"]>
  ): ReturnType<WorkerHostStore["setWorkerHostDraining"]> {
    return new DrizzleWorkerHostStore(this.#db, this.#tables, this.provider).setWorkerHostDraining(
      ...args,
    );
  }
  claimWorkerHostConnection(
    ...args: Parameters<WorkerHostStore["claimWorkerHostConnection"]>
  ): ReturnType<WorkerHostStore["claimWorkerHostConnection"]> {
    return new DrizzleWorkerHostStore(
      this.#db,
      this.#tables,
      this.provider,
    ).claimWorkerHostConnection(...args);
  }
  recordWorkerHostAuthenticationFailure(
    ...args: Parameters<WorkerHostStore["recordWorkerHostAuthenticationFailure"]>
  ): ReturnType<WorkerHostStore["recordWorkerHostAuthenticationFailure"]> {
    return new DrizzleWorkerHostStore(
      this.#db,
      this.#tables,
      this.provider,
    ).recordWorkerHostAuthenticationFailure(...args);
  }
  updateWorkerHostObservation(
    ...args: Parameters<WorkerHostStore["updateWorkerHostObservation"]>
  ): ReturnType<WorkerHostStore["updateWorkerHostObservation"]> {
    return new DrizzleWorkerHostStore(
      this.#db,
      this.#tables,
      this.provider,
    ).updateWorkerHostObservation(...args);
  }
  releaseWorkerHostConnection(
    ...args: Parameters<WorkerHostStore["releaseWorkerHostConnection"]>
  ): ReturnType<WorkerHostStore["releaseWorkerHostConnection"]> {
    return new DrizzleWorkerHostStore(
      this.#db,
      this.#tables,
      this.provider,
    ).releaseWorkerHostConnection(...args);
  }

  requestActionApproval(
    ...args: Parameters<ApprovalRequestStore["requestActionApproval"]>
  ): ReturnType<ApprovalRequestStore["requestActionApproval"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).requestActionApproval(...args);
  }
  findObjectiveApprovalGrant(
    ...args: Parameters<ApprovalRequestStore["findObjectiveApprovalGrant"]>
  ): ReturnType<ApprovalRequestStore["findObjectiveApprovalGrant"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).findObjectiveApprovalGrant(...args);
  }
  createApprovalRequest(
    ...args: Parameters<ApprovalRequestStore["createApprovalRequest"]>
  ): ReturnType<ApprovalRequestStore["createApprovalRequest"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).createApprovalRequest(...args);
  }
  getApprovalRequest(
    ...args: Parameters<ApprovalRequestStore["getApprovalRequest"]>
  ): ReturnType<ApprovalRequestStore["getApprovalRequest"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).getApprovalRequest(...args);
  }
  listApprovalRequests(
    ...args: Parameters<ApprovalRequestStore["listApprovalRequests"]>
  ): ReturnType<ApprovalRequestStore["listApprovalRequests"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listApprovalRequests(...args);
  }
  decideApprovalRequest(
    ...args: Parameters<ApprovalRequestStore["decideApprovalRequest"]>
  ): ReturnType<ApprovalRequestStore["decideApprovalRequest"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).decideApprovalRequest(...args);
  }
  expireApprovalRequest(
    ...args: Parameters<ApprovalRequestStore["expireApprovalRequest"]>
  ): ReturnType<ApprovalRequestStore["expireApprovalRequest"]> {
    return new DrizzleApprovalRequestStore(
      this.#db,
      this.#tables,
      this.provider,
    ).expireApprovalRequest(...args);
  }

  readCoordinationInbox(
    ...args: Parameters<CoordinationInboxStore["readCoordinationInbox"]>
  ): ReturnType<CoordinationInboxStore["readCoordinationInbox"]> {
    return new DrizzleCoordinationInboxStore(this.#db, this.#tables).readCoordinationInbox(...args);
  }

  #operatorNotifications(): DrizzleOperatorNotificationStore {
    return new DrizzleOperatorNotificationStore(this.#db, this.#tables, this.provider);
  }

  listOperatorNotificationsForItems(
    ...args: Parameters<OperatorNotificationStore["listOperatorNotificationsForItems"]>
  ) {
    return this.#operatorNotifications().listOperatorNotificationsForItems(...args);
  }
  listNotifiedInboxItems(
    ...args: Parameters<OperatorNotificationStore["listNotifiedInboxItems"]>
  ): ReturnType<OperatorNotificationStore["listNotifiedInboxItems"]> {
    return this.#operatorNotifications().listNotifiedInboxItems(...args);
  }
  latestOperatorNotification(
    ...args: Parameters<OperatorNotificationStore["latestOperatorNotification"]>
  ): ReturnType<OperatorNotificationStore["latestOperatorNotification"]> {
    return this.#operatorNotifications().latestOperatorNotification(...args);
  }
  recordOperatorNotification(
    ...args: Parameters<OperatorNotificationStore["recordOperatorNotification"]>
  ): ReturnType<OperatorNotificationStore["recordOperatorNotification"]> {
    return this.#operatorNotifications().recordOperatorNotification(...args);
  }
  claimNextOperatorNotification(
    ...args: Parameters<OperatorNotificationStore["claimNextOperatorNotification"]>
  ): ReturnType<OperatorNotificationStore["claimNextOperatorNotification"]> {
    return this.#operatorNotifications().claimNextOperatorNotification(...args);
  }
  completeOperatorNotification(
    ...args: Parameters<OperatorNotificationStore["completeOperatorNotification"]>
  ): ReturnType<OperatorNotificationStore["completeOperatorNotification"]> {
    return this.#operatorNotifications().completeOperatorNotification(...args);
  }
  retryOperatorNotification(
    ...args: Parameters<OperatorNotificationStore["retryOperatorNotification"]>
  ): ReturnType<OperatorNotificationStore["retryOperatorNotification"]> {
    return this.#operatorNotifications().retryOperatorNotification(...args);
  }
  getOperatorNotification(
    ...args: Parameters<OperatorNotificationStore["getOperatorNotification"]>
  ): ReturnType<OperatorNotificationStore["getOperatorNotification"]> {
    return this.#operatorNotifications().getOperatorNotification(...args);
  }

  listResourceChanges(
    ...args: Parameters<ResourceChangeStore["listResourceChanges"]>
  ): ReturnType<ResourceChangeStore["listResourceChanges"]> {
    return new DrizzleResourceChangeStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listResourceChanges(...args);
  }

  readCoordinationMetrics(
    ...args: Parameters<CoordinationMetricsStore["readCoordinationMetrics"]>
  ): ReturnType<CoordinationMetricsStore["readCoordinationMetrics"]> {
    return new DrizzleCoordinationMetricsStore(
      this.provider,
      async (statement, parameters = []) => {
        if (this.#sqliteConnection)
          return this.#sqliteConnection.prepare(statement).all(...parameters) as readonly Record<
            string,
            unknown
          >[];
        if (this.#postgresqlPool)
          return (await this.#postgresqlPool.query(statement, [...parameters])).rows;
        throw new Error("Store is disconnected");
      },
    ).readCoordinationMetrics(...args);
  }

  readSpend(input: Parameters<DrizzleSpendStore["readSpend"]>[0] = {}) {
    return new DrizzleSpendStore(this.provider, async (statement, parameters = []) => {
      if (this.#sqliteConnection)
        return this.#sqliteConnection.prepare(statement).all(...parameters) as readonly Record<
          string,
          unknown
        >[];
      if (this.#postgresqlPool)
        return (await this.#postgresqlPool.query(statement, [...parameters])).rows;
      throw new Error("Store is disconnected");
    }).readSpend(input);
  }

  putSessionState(
    ...args: Parameters<SessionStatePersistence["putSessionState"]>
  ): ReturnType<SessionStatePersistence["putSessionState"]> {
    return new DrizzleSessionStateStore(this.#db, this.#tables, this.provider).putSessionState(
      ...args,
    );
  }
  findSessionState(
    ...args: Parameters<SessionStatePersistence["findSessionState"]>
  ): ReturnType<SessionStatePersistence["findSessionState"]> {
    return new DrizzleSessionStateStore(this.#db, this.#tables, this.provider).findSessionState(
      ...args,
    );
  }
  listSessionStates(
    ...args: Parameters<SessionStatePersistence["listSessionStates"]>
  ): ReturnType<SessionStatePersistence["listSessionStates"]> {
    return new DrizzleSessionStateStore(this.#db, this.#tables, this.provider).listSessionStates(
      ...args,
    );
  }
  promoteSessionState(
    ...args: Parameters<SessionStatePersistence["promoteSessionState"]>
  ): ReturnType<SessionStatePersistence["promoteSessionState"]> {
    return new DrizzleSessionStateStore(this.#db, this.#tables, this.provider).promoteSessionState(
      ...args,
    );
  }

  recordArtifactUpload(
    ...args: Parameters<ArtifactCatalogStore["recordArtifactUpload"]>
  ): ReturnType<ArtifactCatalogStore["recordArtifactUpload"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).recordArtifactUpload(...args);
  }
  hasArtifactUpload(
    ...args: Parameters<ArtifactCatalogStore["hasArtifactUpload"]>
  ): ReturnType<ArtifactCatalogStore["hasArtifactUpload"]> {
    return new DrizzleArtifactCatalogStore(this.#db, this.#tables, this.provider).hasArtifactUpload(
      ...args,
    );
  }
  commitCapturedArtifact(
    ...args: Parameters<ArtifactCatalogStore["commitCapturedArtifact"]>
  ): ReturnType<ArtifactCatalogStore["commitCapturedArtifact"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).commitCapturedArtifact(...args);
  }
  findCapturedArtifact(
    ...args: Parameters<ArtifactCatalogStore["findCapturedArtifact"]>
  ): ReturnType<ArtifactCatalogStore["findCapturedArtifact"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).findCapturedArtifact(...args);
  }
  listCapturedArtifacts(
    ...args: Parameters<ArtifactCatalogStore["listCapturedArtifacts"]>
  ): ReturnType<ArtifactCatalogStore["listCapturedArtifacts"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listCapturedArtifacts(...args);
  }
  acquireCapturedArtifact(
    ...args: Parameters<ArtifactCatalogStore["acquireCapturedArtifact"]>
  ): ReturnType<ArtifactCatalogStore["acquireCapturedArtifact"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).acquireCapturedArtifact(...args);
  }
  settleArtifactAcquisition(
    ...args: Parameters<ArtifactCatalogStore["settleArtifactAcquisition"]>
  ): ReturnType<ArtifactCatalogStore["settleArtifactAcquisition"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).settleArtifactAcquisition(...args);
  }
  getArtifactAcquisition(
    ...args: Parameters<ArtifactCatalogStore["getArtifactAcquisition"]>
  ): ReturnType<ArtifactCatalogStore["getArtifactAcquisition"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).getArtifactAcquisition(...args);
  }
  listArtifactAcquisitions(
    ...args: Parameters<ArtifactCatalogStore["listArtifactAcquisitions"]>
  ): ReturnType<ArtifactCatalogStore["listArtifactAcquisitions"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listArtifactAcquisitions(...args);
  }
  registerWorkerArtifactCopies(
    ...args: Parameters<ArtifactCatalogStore["registerWorkerArtifactCopies"]>
  ): ReturnType<ArtifactCatalogStore["registerWorkerArtifactCopies"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).registerWorkerArtifactCopies(...args);
  }
  listArtifactStorageLocations(
    ...args: Parameters<ArtifactCatalogStore["listArtifactStorageLocations"]>
  ): ReturnType<ArtifactCatalogStore["listArtifactStorageLocations"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listArtifactStorageLocations(...args);
  }
  recordArtifactVolumeCopy(
    ...args: Parameters<ArtifactCatalogStore["recordArtifactVolumeCopy"]>
  ): ReturnType<ArtifactCatalogStore["recordArtifactVolumeCopy"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).recordArtifactVolumeCopy(...args);
  }
  listArtifactVolumeLocations(
    ...args: Parameters<ArtifactCatalogStore["listArtifactVolumeLocations"]>
  ): ReturnType<ArtifactCatalogStore["listArtifactVolumeLocations"]> {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listArtifactVolumeLocations(...args);
  }
  listVolumeIdsHoldingArtifacts(): ReturnType<
    ArtifactCatalogStore["listVolumeIdsHoldingArtifacts"]
  > {
    return new DrizzleArtifactCatalogStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listVolumeIdsHoldingArtifacts();
  }

  approveArtifactPublication(
    ...args: Parameters<ArtifactPublicationStore["approveArtifactPublication"]>
  ): ReturnType<ArtifactPublicationStore["approveArtifactPublication"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).approveArtifactPublication(...args);
  }
  approveArtifactConsumption(
    ...args: Parameters<ArtifactPublicationStore["approveArtifactConsumption"]>
  ): ReturnType<ArtifactPublicationStore["approveArtifactConsumption"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).approveArtifactConsumption(...args);
  }
  withdrawArtifactPublication(
    ...args: Parameters<ArtifactPublicationStore["withdrawArtifactPublication"]>
  ): ReturnType<ArtifactPublicationStore["withdrawArtifactPublication"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).withdrawArtifactPublication(...args);
  }
  withdrawArtifactConsumption(
    ...args: Parameters<ArtifactPublicationStore["withdrawArtifactConsumption"]>
  ): ReturnType<ArtifactPublicationStore["withdrawArtifactConsumption"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).withdrawArtifactConsumption(...args);
  }
  getArtifactPublication(
    ...args: Parameters<ArtifactPublicationStore["getArtifactPublication"]>
  ): ReturnType<ArtifactPublicationStore["getArtifactPublication"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).getArtifactPublication(...args);
  }
  getArtifactConsumptionApproval(
    ...args: Parameters<ArtifactPublicationStore["getArtifactConsumptionApproval"]>
  ): ReturnType<ArtifactPublicationStore["getArtifactConsumptionApproval"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).getArtifactConsumptionApproval(...args);
  }
  listArtifactPublicationsForObjective(
    ...args: Parameters<ArtifactPublicationStore["listArtifactPublicationsForObjective"]>
  ): ReturnType<ArtifactPublicationStore["listArtifactPublicationsForObjective"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listArtifactPublicationsForObjective(...args);
  }
  listArtifactConsumptionApprovals(
    ...args: Parameters<ArtifactPublicationStore["listArtifactConsumptionApprovals"]>
  ): ReturnType<ArtifactPublicationStore["listArtifactConsumptionApprovals"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listArtifactConsumptionApprovals(...args);
  }
  listArtifactApprovalAuditEvents(
    ...args: Parameters<ArtifactPublicationStore["listArtifactApprovalAuditEvents"]>
  ): ReturnType<ArtifactPublicationStore["listArtifactApprovalAuditEvents"]> {
    return new DrizzleArtifactPublicationStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listArtifactApprovalAuditEvents(...args);
  }

  createTeam(...args: Parameters<TeamStore["createTeam"]>): ReturnType<TeamStore["createTeam"]> {
    return new DrizzleTeamStore(this.#db, this.#tables, this.provider).createTeam(...args);
  }
  getTeam(...args: Parameters<TeamStore["getTeam"]>): ReturnType<TeamStore["getTeam"]> {
    return new DrizzleTeamStore(this.#db, this.#tables, this.provider).getTeam(...args);
  }
  listTeams(...args: Parameters<TeamStore["listTeams"]>): ReturnType<TeamStore["listTeams"]> {
    return new DrizzleTeamStore(this.#db, this.#tables, this.provider).listTeams(...args);
  }
  updateTeam(...args: Parameters<TeamStore["updateTeam"]>): ReturnType<TeamStore["updateTeam"]> {
    return new DrizzleTeamStore(this.#db, this.#tables, this.provider).updateTeam(...args);
  }
  listTeamsOfTag(
    ...args: Parameters<TeamStore["listTeamsOfTag"]>
  ): ReturnType<TeamStore["listTeamsOfTag"]> {
    return new DrizzleTeamStore(this.#db, this.#tables, this.provider).listTeamsOfTag(...args);
  }
  deleteTeam(...args: Parameters<TeamStore["deleteTeam"]>): ReturnType<TeamStore["deleteTeam"]> {
    return new DrizzleTeamStore(this.#db, this.#tables, this.provider).deleteTeam(...args);
  }
  applyVolume(
    ...args: Parameters<VolumeStore["applyVolume"]>
  ): ReturnType<VolumeStore["applyVolume"]> {
    return new DrizzleVolumeStore(this.#db, this.#tables, this.provider).applyVolume(...args);
  }
  findVolumeByName(
    ...args: Parameters<VolumeStore["findVolumeByName"]>
  ): ReturnType<VolumeStore["findVolumeByName"]> {
    return new DrizzleVolumeStore(this.#db, this.#tables, this.provider).findVolumeByName(...args);
  }
  listVolumes(
    ...args: Parameters<VolumeStore["listVolumes"]>
  ): ReturnType<VolumeStore["listVolumes"]> {
    return new DrizzleVolumeStore(this.#db, this.#tables, this.provider).listVolumes(...args);
  }
  deleteVolume(
    ...args: Parameters<VolumeStore["deleteVolume"]>
  ): ReturnType<VolumeStore["deleteVolume"]> {
    return new DrizzleVolumeStore(this.#db, this.#tables, this.provider).deleteVolume(...args);
  }

  countVolumeArtifactCopies(volumeId: string): Promise<number> {
    return new DrizzleVolumeStore(this.#db, this.#tables, this.provider).countVolumeArtifactCopies(
      volumeId,
    );
  }
  applyWorkspace(
    ...args: Parameters<WorkspaceStore["applyWorkspace"]>
  ): ReturnType<WorkspaceStore["applyWorkspace"]> {
    return new DrizzleWorkspaceStore(this.#db, this.#tables, this.provider).applyWorkspace(...args);
  }
  findWorkspaceByName(
    ...args: Parameters<WorkspaceStore["findWorkspaceByName"]>
  ): ReturnType<WorkspaceStore["findWorkspaceByName"]> {
    return new DrizzleWorkspaceStore(this.#db, this.#tables, this.provider).findWorkspaceByName(
      ...args,
    );
  }
  listWorkspaces(
    ...args: Parameters<WorkspaceStore["listWorkspaces"]>
  ): ReturnType<WorkspaceStore["listWorkspaces"]> {
    return new DrizzleWorkspaceStore(this.#db, this.#tables, this.provider).listWorkspaces(...args);
  }
  deleteWorkspace(
    ...args: Parameters<WorkspaceStore["deleteWorkspace"]>
  ): ReturnType<WorkspaceStore["deleteWorkspace"]> {
    return new DrizzleWorkspaceStore(this.#db, this.#tables, this.provider).deleteWorkspace(
      ...args,
    );
  }
  saveWorkspacePullRequestTransition(
    ...args: Parameters<WorkspaceStore["saveWorkspacePullRequestTransition"]>
  ): ReturnType<WorkspaceStore["saveWorkspacePullRequestTransition"]> {
    return new DrizzleWorkspaceStore(
      this.#db,
      this.#tables,
      this.provider,
    ).saveWorkspacePullRequestTransition(...args);
  }
  listDueWorkspacePullRequestTransitions(
    ...args: Parameters<WorkspaceStore["listDueWorkspacePullRequestTransitions"]>
  ): ReturnType<WorkspaceStore["listDueWorkspacePullRequestTransitions"]> {
    return new DrizzleWorkspaceStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listDueWorkspacePullRequestTransitions(...args);
  }
  deleteWorkspacePullRequestTransition(
    ...args: Parameters<WorkspaceStore["deleteWorkspacePullRequestTransition"]>
  ): ReturnType<WorkspaceStore["deleteWorkspacePullRequestTransition"]> {
    return new DrizzleWorkspaceStore(
      this.#db,
      this.#tables,
      this.provider,
    ).deleteWorkspacePullRequestTransition(...args);
  }
  findResourceManagement(
    ...args: Parameters<ResourceManagementStore["findResourceManagement"]>
  ): ReturnType<ResourceManagementStore["findResourceManagement"]> {
    return this.#resourceManagement().findResourceManagement(...args);
  }
  saveResourceManagement(
    ...args: Parameters<ResourceManagementStore["saveResourceManagement"]>
  ): ReturnType<ResourceManagementStore["saveResourceManagement"]> {
    return this.#resourceManagement().saveResourceManagement(...args);
  }
  deleteResourceManagement(
    ...args: Parameters<ResourceManagementStore["deleteResourceManagement"]>
  ): ReturnType<ResourceManagementStore["deleteResourceManagement"]> {
    return this.#resourceManagement().deleteResourceManagement(...args);
  }
  listApplySetMembers(
    ...args: Parameters<ResourceManagementStore["listApplySetMembers"]>
  ): ReturnType<ResourceManagementStore["listApplySetMembers"]> {
    return this.#resourceManagement().listApplySetMembers(...args);
  }
  #resourceManagement(): DrizzleResourceManagementStore {
    return new DrizzleResourceManagementStore(this.#db, this.#tables, this.provider);
  }
  createRole(...args: Parameters<RoleStore["createRole"]>): ReturnType<RoleStore["createRole"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).createRole(...args);
  }
  findRoleById(
    ...args: Parameters<RoleStore["findRoleById"]>
  ): ReturnType<RoleStore["findRoleById"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).findRoleById(...args);
  }
  findRoleByName(
    ...args: Parameters<RoleStore["findRoleByName"]>
  ): ReturnType<RoleStore["findRoleByName"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).findRoleByName(...args);
  }
  listRoles(...args: Parameters<RoleStore["listRoles"]>): ReturnType<RoleStore["listRoles"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).listRoles(...args);
  }
  updateRole(...args: Parameters<RoleStore["updateRole"]>): ReturnType<RoleStore["updateRole"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).updateRole(...args);
  }
  assignRole(...args: Parameters<RoleStore["assignRole"]>): ReturnType<RoleStore["assignRole"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).assignRole(...args);
  }
  listRoleAssignments(
    ...args: Parameters<RoleStore["listRoleAssignments"]>
  ): ReturnType<RoleStore["listRoleAssignments"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).listRoleAssignments(...args);
  }
  deactivateRoleAssignment(
    ...args: Parameters<RoleStore["deactivateRoleAssignment"]>
  ): ReturnType<RoleStore["deactivateRoleAssignment"]> {
    return new DrizzleRoleStore(this.#db, this.#tables, this.provider).deactivateRoleAssignment(
      ...args,
    );
  }
  createAuthKey(
    ...args: Parameters<AuthKeyStore["createAuthKey"]>
  ): ReturnType<AuthKeyStore["createAuthKey"]> {
    return new DrizzleAuthKeyStore(this.#db, this.#tables, this.provider).createAuthKey(...args);
  }
  findAuthKeyByName(
    ...args: Parameters<AuthKeyStore["findAuthKeyByName"]>
  ): ReturnType<AuthKeyStore["findAuthKeyByName"]> {
    return new DrizzleAuthKeyStore(this.#db, this.#tables, this.provider).findAuthKeyByName(
      ...args,
    );
  }
  findAuthKeyBySecret(
    ...args: Parameters<AuthKeyStore["findAuthKeyBySecret"]>
  ): ReturnType<AuthKeyStore["findAuthKeyBySecret"]> {
    return new DrizzleAuthKeyStore(this.#db, this.#tables, this.provider).findAuthKeyBySecret(
      ...args,
    );
  }
  listAuthKeys(
    ...args: Parameters<AuthKeyStore["listAuthKeys"]>
  ): ReturnType<AuthKeyStore["listAuthKeys"]> {
    return new DrizzleAuthKeyStore(this.#db, this.#tables, this.provider).listAuthKeys(...args);
  }
  revokeAuthKey(
    ...args: Parameters<AuthKeyStore["revokeAuthKey"]>
  ): ReturnType<AuthKeyStore["revokeAuthKey"]> {
    return new DrizzleAuthKeyStore(this.#db, this.#tables, this.provider).revokeAuthKey(...args);
  }
  redeemAuthKey(
    ...args: Parameters<AuthKeyStore["redeemAuthKey"]>
  ): ReturnType<AuthKeyStore["redeemAuthKey"]> {
    return new DrizzleAuthKeyStore(this.#db, this.#tables, this.provider).redeemAuthKey(...args);
  }
  recordAuditEntry(
    ...args: Parameters<AuditStore["recordAuditEntry"]>
  ): ReturnType<AuditStore["recordAuditEntry"]> {
    return new DrizzleAuditStore(this.#db, this.#tables).recordAuditEntry(...args);
  }
  listAuditEntries(
    ...args: Parameters<AuditStore["listAuditEntries"]>
  ): ReturnType<AuditStore["listAuditEntries"]> {
    return new DrizzleAuditStore(this.#db, this.#tables).listAuditEntries(...args);
  }
  createOperatorToken(
    ...args: Parameters<OperatorTokenStore["createOperatorToken"]>
  ): ReturnType<OperatorTokenStore["createOperatorToken"]> {
    return new DrizzleOperatorTokenStore(this.#db, this.#tables, this.provider).createOperatorToken(
      ...args,
    );
  }
  findOperatorTokenByName(
    ...args: Parameters<OperatorTokenStore["findOperatorTokenByName"]>
  ): ReturnType<OperatorTokenStore["findOperatorTokenByName"]> {
    return new DrizzleOperatorTokenStore(
      this.#db,
      this.#tables,
      this.provider,
    ).findOperatorTokenByName(...args);
  }
  listOperatorTokens(
    ...args: Parameters<OperatorTokenStore["listOperatorTokens"]>
  ): ReturnType<OperatorTokenStore["listOperatorTokens"]> {
    return new DrizzleOperatorTokenStore(this.#db, this.#tables, this.provider).listOperatorTokens(
      ...args,
    );
  }
  revokeOperatorToken(
    ...args: Parameters<OperatorTokenStore["revokeOperatorToken"]>
  ): ReturnType<OperatorTokenStore["revokeOperatorToken"]> {
    return new DrizzleOperatorTokenStore(this.#db, this.#tables, this.provider).revokeOperatorToken(
      ...args,
    );
  }
  authenticateOperatorToken(
    ...args: Parameters<OperatorTokenStore["authenticateOperatorToken"]>
  ): ReturnType<OperatorTokenStore["authenticateOperatorToken"]> {
    return new DrizzleOperatorTokenStore(
      this.#db,
      this.#tables,
      this.provider,
    ).authenticateOperatorToken(...args);
  }
  createSurfaceObjective(
    ...args: Parameters<ObjectiveStore["createSurfaceObjective"]>
  ): ReturnType<ObjectiveStore["createSurfaceObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).createSurfaceObjective(
      ...args,
    );
  }
  getSurfaceObjective(
    ...args: Parameters<ObjectiveStore["getSurfaceObjective"]>
  ): ReturnType<ObjectiveStore["getSurfaceObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).getSurfaceObjective(
      ...args,
    );
  }
  async getObjectiveSurfaceTask(
    objectiveId: string,
  ): ReturnType<ObjectiveStore["getObjectiveSurfaceTask"]> {
    const o = this.#tables.objectives;
    const objective = await this.#first(o, eq(o.id, required(objectiveId, "Objective id")));
    return objective?.surfaceTaskId ? this.findTaskById(objective.surfaceTaskId) : undefined;
  }
  async findObjectiveByHomeSession(
    sessionId: string,
  ): ReturnType<ObjectiveStore["findObjectiveByHomeSession"]> {
    const o = this.#tables.objectives;
    const [objective] = await this.#db
      .select()
      .from(o)
      .where(
        and(
          notInArray(o.status, ["completed", "cancelled"]),
          sql`exists (select 1 from "Task" t where t."id" = coalesce(${o.notificationTaskId}, ${o.surfaceTaskId}) and t."sessionId" = ${required(sessionId, "Session id")})`,
        ),
      )
      .orderBy(desc(o.updatedAt), desc(o.id))
      .limit(1);
    return objective ? this.getObjective(objective.id) : undefined;
  }
  getVerifiedSurfaceTask(taskId: string): ReturnType<ObjectiveStore["getVerifiedSurfaceTask"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).getVerifiedSurfaceTask(
      taskId,
    );
  }
  createObjective(
    ...args: Parameters<ObjectiveStore["createObjective"]>
  ): ReturnType<ObjectiveStore["createObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).createObjective(...args);
  }
  getObjective(
    ...args: Parameters<ObjectiveStore["getObjective"]>
  ): ReturnType<ObjectiveStore["getObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).getObjective(...args);
  }
  listObjectives(
    ...args: Parameters<ObjectiveStore["listObjectives"]>
  ): ReturnType<ObjectiveStore["listObjectives"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listObjectives(...args);
  }
  listVisibleObjectives(
    ...args: Parameters<ObjectiveStore["listVisibleObjectives"]>
  ): ReturnType<ObjectiveStore["listVisibleObjectives"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listVisibleObjectives(
      ...args,
    );
  }
  listExecutingObjectives(
    ...args: Parameters<ObjectiveStore["listExecutingObjectives"]>
  ): ReturnType<ObjectiveStore["listExecutingObjectives"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listExecutingObjectives(
      ...args,
    );
  }
  listOpenObjectives(
    ...args: Parameters<ObjectiveStore["listOpenObjectives"]>
  ): ReturnType<ObjectiveStore["listOpenObjectives"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listOpenObjectives(
      ...args,
    );
  }
  recordObjectiveLimitState(
    ...args: Parameters<ObjectiveStore["recordObjectiveLimitState"]>
  ): ReturnType<ObjectiveStore["recordObjectiveLimitState"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).recordObjectiveLimitState(
      ...args,
    );
  }
  updateObjectiveStatus(
    ...args: Parameters<ObjectiveStore["updateObjectiveStatus"]>
  ): ReturnType<ObjectiveStore["updateObjectiveStatus"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).updateObjectiveStatus(
      ...args,
    );
  }
  cancelObjective(
    ...args: Parameters<ObjectiveStore["cancelObjective"]>
  ): ReturnType<ObjectiveStore["cancelObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).cancelObjective(...args);
  }
  pauseObjective(
    ...args: Parameters<ObjectiveStore["pauseObjective"]>
  ): ReturnType<ObjectiveStore["pauseObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).pauseObjective(...args);
  }
  resumeObjective(
    ...args: Parameters<ObjectiveStore["resumeObjective"]>
  ): ReturnType<ObjectiveStore["resumeObjective"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).resumeObjective(...args);
  }
  post(...args: Parameters<WorkstreamStore["post"]>): ReturnType<WorkstreamStore["post"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).post(...args);
  }
  listTeamPosts(
    ...args: Parameters<WorkstreamStore["listTeamPosts"]>
  ): ReturnType<WorkstreamStore["listTeamPosts"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listTeamPosts(...args);
  }
  setTagMessagingGrants(
    ...args: Parameters<TagMailboxStore["setTagMessagingGrants"]>
  ): ReturnType<TagMailboxStore["setTagMessagingGrants"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).setTagMessagingGrants(
      ...args,
    );
  }
  changeTagMessagingGrant(
    ...args: Parameters<TagMailboxStore["changeTagMessagingGrant"]>
  ): ReturnType<TagMailboxStore["changeTagMessagingGrant"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).changeTagMessagingGrant(
      ...args,
    );
  }
  listTagMessagingGrants(
    ...args: Parameters<TagMailboxStore["listTagMessagingGrants"]>
  ): ReturnType<TagMailboxStore["listTagMessagingGrants"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listTagMessagingGrants(
      ...args,
    );
  }
  mayMessage(
    ...args: Parameters<TagMailboxStore["mayMessage"]>
  ): ReturnType<TagMailboxStore["mayMessage"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).mayMessage(...args);
  }
  deliverTagMessage(
    ...args: Parameters<TagMailboxStore["deliverTagMessage"]>
  ): ReturnType<TagMailboxStore["deliverTagMessage"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).deliverTagMessage(
      ...args,
    );
  }
  bindInboxMessages(
    ...args: Parameters<TagMailboxStore["bindInboxMessages"]>
  ): ReturnType<TagMailboxStore["bindInboxMessages"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).bindInboxMessages(
      ...args,
    );
  }
  listTagsWithUnboundMessages(
    ...args: Parameters<TagMailboxStore["listTagsWithUnboundMessages"]>
  ): ReturnType<TagMailboxStore["listTagsWithUnboundMessages"]> {
    return new DrizzleMailboxStore(
      this.#db,
      this.#tables,
      this.provider,
    ).listTagsWithUnboundMessages(...args);
  }
  listTagMessageHistory(
    ...args: Parameters<TagMailboxStore["listTagMessageHistory"]>
  ): ReturnType<TagMailboxStore["listTagMessageHistory"]> {
    return new DrizzleMailboxStore(this.#db, this.#tables, this.provider).listTagMessageHistory(
      ...args,
    );
  }

  // Resolve the adapter against the current database connection after reconnect.

  async connect(): Promise<void> {
    if (this.provider === "sqlite") {
      if (this.#sqliteConnection?.open !== true) {
        this.#sqliteConnection = openSqliteDatabase(sqlitePathFromUrl(this.#url));
        this.#sqliteConnection.pragma("foreign_keys = ON");
        this.#db = drizzleSqlite(this.#sqliteConnection, { schema: sqlite.sqliteSchema });
      }
      return;
    }
    if (this.#postgresqlPool === undefined || this.#postgresqlPool.ended) {
      this.#postgresqlPool = new Pool({ connectionString: this.#url });
      this.#db = drizzlePostgresql(this.#postgresqlPool, { schema: postgresql.postgresqlSchema });
    }
    await this.#postgresqlPool.query("select 1");
  }

  async disconnect(): Promise<void> {
    if (this.#postgresqlPool !== undefined) {
      await this.#postgresqlPool.end();
      this.#postgresqlPool = undefined;
    }
    if (this.#sqliteConnection?.open === true) this.#sqliteConnection.close();
    this.#sqliteConnection = undefined;
  }

  async createTag(input: CreateTagInput): Promise<Tag> {
    const name = required(input.name, "Tag name");
    if (name.toLowerCase() === "system")
      throw new Error('Tag name "system" is reserved for system notices');
    const now = new Date().toISOString();
    try {
      const row = await this.#insert(this.#tables.tags, {
        id: randomUUID(),
        name,
        status: "active",
        runsOn: [],
        createdAt: now,
        updatedAt: now,
      });
      return tagFromRow(row);
    } catch (error) {
      if (isUnique(error))
        throw new Error(`A Tag named ${JSON.stringify(name)} already exists`, { cause: error });
      throw error;
    }
  }

  async findTagById(id: string): Promise<Tag | undefined> {
    return this.#mappedFirst(
      this.#tables.tags,
      eq(this.#tables.tags.id, required(id, "Tag id")),
      tagFromRow,
    );
  }

  async findTagByName(name: string, options: FindTagByNameOptions = {}): Promise<Tag | undefined> {
    const t = this.#tables.tags;
    const tagName = required(name, "Tag name");
    const active = await this.#mappedFirst(
      t,
      and(eq(t.name, tagName), eq(t.status, "active")),
      tagFromRow,
    );
    if (active !== undefined || options.includeRetired !== true) return active;
    const [retired] = await this.#db
      .select()
      .from(t)
      .where(and(eq(t.name, tagName), eq(t.status, "retired")))
      .orderBy(desc(t.retiredAt), desc(t.id))
      .limit(1);
    return retired === undefined ? undefined : tagFromRow(retired);
  }

  async listTags(filter: TagListFilter = {}): Promise<readonly Tag[]> {
    const t = this.#tables.tags;
    return (
      await this.#db
        .select()
        .from(t)
        .where(filter.includeRetired === true ? undefined : eq(t.status, "active"))
        .orderBy(asc(t.name), asc(t.id))
    ).map(tagFromRow);
  }

  async retireTag(id: string): Promise<Tag> {
    const tagId = required(id, "Tag id");
    const tables = this.#tables;
    return runDialectTransaction(this.#db, this.provider, function* (tx: any) {
      const at = new Date().toISOString();
      const [tag] = yield tx.select().from(tables.tags).where(eq(tables.tags.id, tagId)).limit(1);
      if (!tag) throw new Error(`Tag ${JSON.stringify(tagId)} does not exist`);
      if (tag.status !== "active") return tagFromRow(tag);
      // Work accepted after the caller's protection check still blocks retirement.
      const [open] = yield tx
        .select({ id: tables.tasks.id })
        .from(tables.tasks)
        .where(
          and(eq(tables.tasks.tagId, tagId), inArray(tables.tasks.status, ["pending", "running"])),
        )
        .limit(1);
      if (open)
        throw new Error(`Tag ${tag.name} has open Task ${open.id}; cancel or finish it first`);
      // Deleting routes cascades to their Context and Permission Set activations.
      yield tx.delete(tables.tagRoutes).where(eq(tables.tagRoutes.tagId, tagId)).returning();
      yield tx
        .delete(tables.tagWorkerHostBindings)
        .where(eq(tables.tagWorkerHostBindings.tagId, tagId))
        .returning();
      yield tx
        .delete(tables.tagMessagingGrants)
        .where(
          or(
            eq(tables.tagMessagingGrants.senderTagId, tagId),
            eq(tables.tagMessagingGrants.recipientTagId, tagId),
          ),
        )
        .returning();
      // Assignments stay as inactive history rather than disappearing.
      yield tx
        .update(tables.roleAssignments)
        .set({
          status: "inactive",
          revision: sql`${tables.roleAssignments.revision} + 1`,
          updatedAt: at,
        })
        .where(
          and(eq(tables.roleAssignments.tagId, tagId), eq(tables.roleAssignments.status, "active")),
        )
        .returning();
      const [retired] = yield tx
        .update(tables.tags)
        .set({ status: "retired", retiredAt: at, updatedAt: at })
        .where(and(eq(tables.tags.id, tagId), eq(tables.tags.status, "active")))
        .returning();
      return tagFromRow(retired ?? tag);
    });
  }

  async deleteTag(id: string): Promise<boolean> {
    const tagId = required(id, "Tag id");
    const tables = this.#tables;
    // Role assignments restrict Tag deletion so assignment history is not lost by accident.
    return runDialectTransaction(this.#db, this.provider, function* (tx: any) {
      yield tx
        .delete(tables.roleAssignments)
        .where(eq(tables.roleAssignments.tagId, tagId))
        .returning();
      const rows = yield tx.delete(tables.tags).where(eq(tables.tags.id, tagId)).returning();
      return rows.length === 1;
    });
  }

  async setTagRunsOn(tagIdValue: string, runsOnValue: readonly string[]): Promise<Tag> {
    const tagId = required(tagIdValue, "Tag id");
    const runsOn = parseWorkerHostLabels(runsOnValue, "Tag runsOn");
    const t = this.#tables.tags;
    const [row] = await this.#db
      .update(t)
      .set({ runsOn, updatedAt: new Date().toISOString() })
      .where(eq(t.id, tagId))
      .returning();
    if (!row) throw new Error(`Tag ${JSON.stringify(tagId)} does not exist`);
    return tagFromRow(row);
  }

  async setTagExecution(tagIdValue: string, value: ExecutionSettings | undefined): Promise<Tag> {
    const tagId = required(tagIdValue, "Tag id");
    const execution = parseExecutionSettings(value, "Tag execution") ?? null;
    const t = this.#tables.tags;
    const [row] = await this.#db
      .update(t)
      .set({ execution, updatedAt: new Date().toISOString() })
      .where(eq(t.id, tagId))
      .returning();
    if (!row) throw new Error(`Tag ${JSON.stringify(tagId)} does not exist`);
    return tagFromRow(row);
  }

  async bindTagWorkerHost(
    tagIdValue: string,
    workerHostIdValue: string,
  ): Promise<TagWorkerHostBinding> {
    const tagId = required(tagIdValue, "Tag id");
    const workerHostId = required(workerHostIdValue, "Worker Host id");
    const tag = await this.findTagById(tagId);
    if (tag === undefined) throw new Error(`Tag ${JSON.stringify(tagId)} does not exist`);
    if (tag.status !== "active") throw new Error(`Tag ${tag.name} is retired`);
    const createdAt = new Date().toISOString();
    const table = this.#tables.tagWorkerHostBindings;
    await this.#db
      .insert(table)
      .values({ tagId, workerHostId, createdAt })
      .onConflictDoNothing({ target: [table.tagId, table.workerHostId] });
    const [binding] = await this.#db
      .select()
      .from(table)
      .where(and(eq(table.tagId, tagId), eq(table.workerHostId, workerHostId)))
      .limit(1);
    if (!binding) throw new Error("Tag Worker Host binding could not be stored");
    return tagWorkerHostBindingFromRow(binding);
  }

  async unbindTagWorkerHost(tagIdValue: string, workerHostIdValue: string): Promise<boolean> {
    const tagId = required(tagIdValue, "Tag id");
    const workerHostId = required(workerHostIdValue, "Worker Host id");
    const removed = await this.#db
      .delete(this.#tables.tagWorkerHostBindings)
      .where(
        and(
          eq(this.#tables.tagWorkerHostBindings.tagId, tagId),
          eq(this.#tables.tagWorkerHostBindings.workerHostId, workerHostId),
        ),
      )
      .returning();
    return removed.length > 0;
  }

  async listTagWorkerHostBindings(tagIdValue: string): Promise<readonly TagWorkerHostBinding[]> {
    const tagId = required(tagIdValue, "Tag id");
    const table = this.#tables.tagWorkerHostBindings;
    return (
      await this.#db
        .select()
        .from(table)
        .where(eq(table.tagId, tagId))
        .orderBy(asc(table.workerHostId))
    ).map(tagWorkerHostBindingFromRow);
  }

  async addTagRoute(input: AddTagRouteInput): Promise<TagRoute> {
    const tagId = required(input.tagId, "Tag id");
    const surfaceAccountId = required(input.surfaceAccountId, "Surface account id");
    const scope = required(input.scope, "Tag route scope");
    const tag = await this.findTagById(tagId);
    if (tag === undefined) throw new Error(`Tag ${JSON.stringify(tagId)} does not exist`);
    if (tag.status !== "active") throw new Error(`Tag ${tag.name} is retired`);
    if ((await this.findSurfaceAccountById(surfaceAccountId)) === undefined)
      throw new Error(`Surface account ${JSON.stringify(surfaceAccountId)} does not exist`);
    const now = new Date().toISOString();
    try {
      return tagRouteFromRow(
        await this.#insert(this.#tables.tagRoutes, {
          id: randomUUID(),
          tagId,
          surfaceAccountId,
          scope,
          enabled: input.enabled ?? true,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      if (isUnique(error))
        throw new Error(
          `Surface account ${JSON.stringify(surfaceAccountId)} already has a Tag on ${JSON.stringify(scope)}`,
          { cause: error },
        );
      throw error;
    }
  }

  async findTagRouteById(id: string): Promise<TagRoute | undefined> {
    const t = this.#tables.tagRoutes;
    return this.#mappedFirst(t, eq(t.id, required(id, "Tag route id")), tagRouteFromRow);
  }

  async listTagRoutes(filter: TagRouteListFilter = {}): Promise<readonly TagRoute[]> {
    const t = this.#tables.tagRoutes;
    const conditions = compact([
      filter.tagId === undefined ? undefined : eq(t.tagId, required(filter.tagId, "Tag id")),
      filter.surfaceAccountId === undefined
        ? undefined
        : eq(t.surfaceAccountId, required(filter.surfaceAccountId, "Surface account id")),
      filter.enabled === undefined ? undefined : eq(t.enabled, filter.enabled),
    ]);
    return (
      await this.#db
        .select()
        .from(t)
        .where(combine(conditions))
        .orderBy(asc(t.createdAt), asc(t.id))
    ).map(tagRouteFromRow);
  }

  async removeTagRoute(id: string): Promise<boolean> {
    return this.#delete(
      this.#tables.tagRoutes,
      eq(this.#tables.tagRoutes.id, required(id, "Tag route id")),
    );
  }

  async setTagRouteWorkspaces(id: string, value: readonly string[]): Promise<TagRoute> {
    const routeId = required(id, "Tag route id");
    const workspaces = parseWorkspaceNames(value, "Tag location workspaces");
    if (workspaces.length > 0) {
      const table = this.#tables.workspaces;
      const known = new Set(
        (
          await this.#db
            .select({ name: table.name })
            .from(table)
            .where(inArray(table.name, [...workspaces]))
        ).map((row: { name: string }) => row.name),
      );
      const missing = workspaces.filter((name) => !known.has(name));
      if (missing.length > 0)
        throw new Error(
          `Workspace ${missing.join(", ")} does not exist; apply a Workspace manifest before naming it`,
        );
    }
    const t = this.#tables.tagRoutes;
    const [row] = await this.#db
      .update(t)
      .set({ workspaces, updatedAt: new Date().toISOString() })
      .where(eq(t.id, routeId))
      .returning();
    if (!row) throw new Error(`Tag route ${JSON.stringify(routeId)} does not exist`);
    return tagRouteFromRow(row);
  }

  async listLocationsReferencingWorkspace(name: string): Promise<readonly TagRoute[]> {
    const workspace = required(name, "Workspace name");
    const t = this.#tables.tagRoutes;
    const references =
      this.provider === "sqlite"
        ? sql`exists (select 1 from json_each(${t.workspaces}) where value = ${workspace})`
        : sql`${t.workspaces} @> ${JSON.stringify([workspace])}::jsonb`;
    return (
      await this.#db.select().from(t).where(references).orderBy(asc(t.createdAt), asc(t.id))
    ).map(tagRouteFromRow);
  }

  async resolveTagRoute(surfaceAccountId: string, scope: string): Promise<TagRoute | undefined> {
    const t = this.#tables.tagRoutes;
    return this.#mappedFirst(
      t,
      and(
        eq(t.surfaceAccountId, required(surfaceAccountId, "Surface account id")),
        eq(t.scope, required(scope, "Tag route scope")),
        eq(t.enabled, true),
      ),
      tagRouteFromRow,
    );
  }

  async createTagPermissionSet(input: CreateTagPermissionSetInput): Promise<TagPermissionSet> {
    const name = required(input.name, "Permission Set name");
    const approvers = normalizeApprovers(input.approvers);
    const existing = await this.findTagPermissionSetByName(name);
    if (existing) return existing;
    const now = new Date().toISOString();
    try {
      return tagPermissionSetFromRow(
        await this.#insert(this.#tables.tagPermissionSets, {
          id: randomUUID(),
          name,
          approvers,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = await this.findTagPermissionSetByName(name);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  async findTagPermissionSetById(id: string): Promise<TagPermissionSet | undefined> {
    const t = this.#tables.tagPermissionSets;
    return this.#mappedFirst(
      t,
      eq(t.id, required(id, "Permission Set id")),
      tagPermissionSetFromRow,
    );
  }
  async findTagPermissionSetByName(name: string): Promise<TagPermissionSet | undefined> {
    const t = this.#tables.tagPermissionSets;
    return this.#mappedFirst(
      t,
      eq(t.name, required(name, "Permission Set name")),
      tagPermissionSetFromRow,
    );
  }
  async listTagPermissionSets(
    filter: TagPermissionSetListFilter = {},
  ): Promise<readonly TagPermissionSet[]> {
    const t = this.#tables.tagPermissionSets;
    return (
      await this.#db
        .select()
        .from(t)
        .where(
          filter.name === undefined
            ? undefined
            : eq(t.name, required(filter.name, "Permission Set name")),
        )
        .orderBy(asc(t.name), asc(t.id))
    ).map(tagPermissionSetFromRow);
  }
  async setTagPermissionSetApprovers(
    id: string,
    approvers: readonly string[],
  ): Promise<TagPermissionSet> {
    const t = this.#tables.tagPermissionSets;
    const normalized = normalizeApprovers(approvers);
    const [row] = await this.#db
      .update(t)
      .set({ approvers: normalized, updatedAt: new Date().toISOString() })
      .where(eq(t.id, required(id, "Permission Set id")))
      .returning();
    if (!row) throw new Error(`Permission Set ${JSON.stringify(id)} does not exist`);
    return tagPermissionSetFromRow(row);
  }
  async setTagPermissionApproval(
    id: string,
    approval: TagPermission["approval"],
  ): Promise<TagPermission> {
    if (approval !== undefined && approval !== "required")
      throw new Error("Tag permission approval must be required when set");
    const t = this.#tables.tagPermissions;
    const [row] = await this.#db
      .update(t)
      .set({ approval: approval ?? null })
      .where(eq(t.id, required(id, "Tag permission id")))
      .returning();
    if (!row) throw new Error(`Tag permission ${JSON.stringify(id)} does not exist`);
    return tagPermissionFromRow(row);
  }
  async removeTagPermissionSet(id: string): Promise<boolean> {
    const t = this.#tables.tagPermissionSets;
    return this.#delete(t, eq(t.id, required(id, "Permission Set id")));
  }

  async addTagPermission(input: AddTagPermissionInput): Promise<TagPermission> {
    const permissionSetId = required(input.permissionSetId, "Permission Set id");
    const action = required(input.action, "Tag permission action");
    const approval = input.approval;
    if (approval !== undefined && approval !== "required")
      throw new Error("Tag permission approval must be required when set");
    if ((await this.findTagPermissionSetById(permissionSetId)) === undefined)
      throw new Error(`Permission Set ${JSON.stringify(permissionSetId)} does not exist`);
    if (input.target !== "surface" && input.target !== "runtime" && input.target !== "mcp") {
      throw new Error("Tag permission target must be surface, runtime, or mcp");
    }
    if (input.target === "mcp") return this.#addMcpPermission(input, permissionSetId, action);
    const surfaceAccountId =
      input.target === "surface"
        ? required(input.surfaceAccountId, "Surface account id")
        : undefined;
    const scope =
      input.target === "surface" ? required(input.scope, "Tag permission scope") : "runtime";
    if (
      surfaceAccountId !== undefined &&
      (await this.findSurfaceAccountById(surfaceAccountId)) === undefined
    ) {
      throw new Error(`Surface account ${JSON.stringify(surfaceAccountId)} does not exist`);
    }
    try {
      return tagPermissionFromRow(
        await this.#insert(this.#tables.tagPermissions, {
          id: randomUUID(),
          permissionSetId,
          target: input.target,
          surfaceAccountId: surfaceAccountId ?? null,
          scope,
          reference: input.target === "surface" ? (optional(input.reference) ?? null) : null,
          action,
          approval: approval ?? null,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = (
          await this.listTagPermissions({
            permissionSetId,
            target: input.target,
            ...(surfaceAccountId === undefined ? {} : { surfaceAccountId }),
            scope,
          })
        ).find((permission) => permission.action === action);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  /** MCP grants keep their optional resource in `scope`; empty covers every resource. */
  async #addMcpPermission(
    input: Extract<AddTagPermissionInput, { target: "mcp" }>,
    permissionSetId: string,
    action: string,
  ): Promise<TagPermission> {
    parseMcpGrantAction(action);
    const resource = optional(input.resource);
    if (resource !== undefined) parseMcpGrantResource(resource);
    const existing = async () =>
      (await this.listTagPermissions({ permissionSetId, target: "mcp" })).find(
        (permission) =>
          permission.target === "mcp" &&
          permission.action === action &&
          permission.resource === resource,
      );
    try {
      return tagPermissionFromRow(
        await this.#insert(this.#tables.tagPermissions, {
          id: randomUUID(),
          permissionSetId,
          target: "mcp",
          surfaceAccountId: null,
          scope: resource ?? "",
          reference: null,
          action,
          approval: input.approval ?? null,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = await existing();
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  async listTagPermissions(
    filter: TagPermissionListFilter = {},
  ): Promise<readonly TagPermission[]> {
    const g = this.#tables.tagPermissions;
    const conditions = compact([
      filter.permissionSetId === undefined
        ? undefined
        : eq(g.permissionSetId, required(filter.permissionSetId, "Permission Set id")),
      filter.target === undefined ? undefined : eq(g.target, filter.target),
      filter.surfaceAccountId === undefined
        ? undefined
        : eq(g.surfaceAccountId, required(filter.surfaceAccountId, "Surface account id")),
      filter.scope === undefined
        ? undefined
        : eq(g.scope, required(filter.scope, "Tag permission scope")),
    ]);
    return (
      await this.#db
        .select({ permission: g })
        .from(g)
        .where(combine(conditions))
        .orderBy(
          asc(g.permissionSetId),
          asc(g.target),
          asc(g.surfaceAccountId),
          asc(g.scope),
          asc(g.action),
        )
    ).map((row: any) => tagPermissionFromRow(row.permission));
  }
  async removeTagPermission(id: string): Promise<boolean> {
    const t = this.#tables.tagPermissions;
    return this.#delete(t, eq(t.id, required(id, "Tag permission id")));
  }

  async activateTagPermissionSet(
    input: ActivateTagPermissionSetInput,
  ): Promise<TagPermissionActivation> {
    const permissionSetId = required(input.permissionSetId, "Permission Set id");
    const tagRouteId = required(input.tagRouteId, "Tag route id");
    const [set, route] = await Promise.all([
      this.findTagPermissionSetById(permissionSetId),
      this.findTagRouteById(tagRouteId),
    ]);
    if (!set) throw new Error(`Permission Set ${JSON.stringify(permissionSetId)} does not exist`);
    if (!route) throw new Error(`Tag route ${JSON.stringify(tagRouteId)} does not exist`);
    try {
      return tagPermissionActivationFromRow(
        await this.#insert(this.#tables.tagPermissionActivations, {
          id: randomUUID(),
          permissionSetId,
          tagRouteId,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = (
          await this.listTagPermissionActivations({ permissionSetId, tagRouteId })
        )[0];
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  async listTagPermissionActivations(
    filter: TagPermissionActivationListFilter = {},
  ): Promise<readonly TagPermissionActivation[]> {
    const t = this.#tables.tagPermissionActivations;
    const conditions = compact([
      filter.permissionSetId === undefined
        ? undefined
        : eq(t.permissionSetId, required(filter.permissionSetId, "Permission Set id")),
      filter.tagRouteId === undefined
        ? undefined
        : eq(t.tagRouteId, required(filter.tagRouteId, "Tag route id")),
    ]);
    return (
      await this.#db
        .select()
        .from(t)
        .where(combine(conditions))
        .orderBy(asc(t.createdAt), asc(t.id))
    ).map(tagPermissionActivationFromRow);
  }
  async deactivateTagPermissionSet(permissionSetId: string, tagRouteId: string): Promise<boolean> {
    const t = this.#tables.tagPermissionActivations;
    return this.#delete(
      t,
      and(
        eq(t.permissionSetId, required(permissionSetId, "Permission Set id")),
        eq(t.tagRouteId, required(tagRouteId, "Tag route id")),
      ),
    );
  }

  async createTagContextSet(input: CreateTagContextSetInput): Promise<TagContextSet> {
    const name = required(input.name, "Context Set name");
    const existing = await this.findTagContextSetByName(name);
    if (existing) return existing;
    const now = new Date().toISOString();
    try {
      return tagContextSetFromRow(
        await this.#insert(this.#tables.tagContextSets, {
          id: randomUUID(),
          name,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = await this.findTagContextSetByName(name);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }
  async findTagContextSetById(id: string): Promise<TagContextSet | undefined> {
    const t = this.#tables.tagContextSets;
    return this.#mappedFirst(t, eq(t.id, required(id, "Context Set id")), tagContextSetFromRow);
  }
  async findTagContextSetByName(name: string): Promise<TagContextSet | undefined> {
    const t = this.#tables.tagContextSets;
    return this.#mappedFirst(
      t,
      eq(t.name, required(name, "Context Set name")),
      tagContextSetFromRow,
    );
  }
  async listTagContextSets(
    filter: TagContextSetListFilter = {},
  ): Promise<readonly TagContextSet[]> {
    const t = this.#tables.tagContextSets;
    return (
      await this.#db
        .select()
        .from(t)
        .where(
          filter.name === undefined
            ? undefined
            : eq(t.name, required(filter.name, "Context Set name")),
        )
        .orderBy(asc(t.name), asc(t.id))
    ).map(tagContextSetFromRow);
  }
  async removeTagContextSet(id: string): Promise<boolean> {
    const t = this.#tables.tagContextSets;
    return this.#delete(t, eq(t.id, required(id, "Context Set id")));
  }

  async addTagContextItem(input: AddTagContextItemInput): Promise<TagContextItem> {
    const contextSetId = required(input.contextSetId, "Context Set id");
    const type = parseContextType(input.type);
    const version = parseContextTypeVersion(input.version);
    if (typeof input.required !== "boolean")
      throw new Error("Context entry required must be boolean");
    const itemKey = required(input.itemKey, "Context entry key");
    const contextSet = await this.findTagContextSetById(contextSetId);
    if (contextSet === undefined)
      throw new Error(`Context Set ${JSON.stringify(contextSetId)} does not exist`);
    const config = validateContextConfig(type, version, input.config);
    if (type === ARTIFACT_CONTEXT_TYPE) {
      const sourceRouteId = requiredTextProperty(config, "sourceRouteId");
      const sourceRoute = await this.findTagRouteById(sourceRouteId);
      if (sourceRoute === undefined)
        throw new Error("Artifact selections must reference an existing source route");
    }
    try {
      return tagContextItemFromRow(
        await this.#insert(this.#tables.tagContextItems, {
          id: randomUUID(),
          contextSetId,
          type,
          version,
          required: input.required,
          itemKey,
          config,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = (await this.listTagContextItems({ contextSetId })).find(
          (item) => item.itemKey === itemKey,
        );
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }
  async listTagContextItems(
    filter: TagContextItemListFilter = {},
  ): Promise<readonly TagContextItem[]> {
    const t = this.#tables.tagContextItems;
    return (
      await this.#db
        .select()
        .from(t)
        .where(
          filter.contextSetId === undefined
            ? undefined
            : eq(t.contextSetId, required(filter.contextSetId, "Context Set id")),
        )
        .orderBy(asc(t.type), asc(t.version), asc(t.itemKey), asc(t.id))
    ).map(tagContextItemFromRow);
  }
  async removeTagContextItem(id: string): Promise<boolean> {
    const t = this.#tables.tagContextItems;
    return this.#delete(t, eq(t.id, required(id, "Context entry id")));
  }

  async activateTagContextSet(input: ActivateTagContextSetInput): Promise<TagContextActivation> {
    const contextSetId = required(input.contextSetId, "Context Set id");
    const tagRouteId = required(input.tagRouteId, "Tag route id");
    const [set, route] = await Promise.all([
      this.findTagContextSetById(contextSetId),
      this.findTagRouteById(tagRouteId),
    ]);
    if (!set) throw new Error(`Context Set ${JSON.stringify(contextSetId)} does not exist`);
    if (!route) throw new Error(`Tag route ${JSON.stringify(tagRouteId)} does not exist`);
    try {
      return tagContextActivationFromRow(
        await this.#insert(this.#tables.tagContextActivations, {
          id: randomUUID(),
          contextSetId,
          tagRouteId,
          createdBy: optional(input.createdBy) ?? null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isUnique(error)) {
        const duplicate = (await this.listTagContextActivations({ contextSetId, tagRouteId }))[0];
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }
  async listTagContextActivations(
    filter: TagContextActivationListFilter = {},
  ): Promise<readonly TagContextActivation[]> {
    const t = this.#tables.tagContextActivations;
    const conditions = compact([
      filter.contextSetId === undefined
        ? undefined
        : eq(t.contextSetId, required(filter.contextSetId, "Context Set id")),
      filter.tagRouteId === undefined
        ? undefined
        : eq(t.tagRouteId, required(filter.tagRouteId, "Tag route id")),
    ]);
    return (
      await this.#db
        .select()
        .from(t)
        .where(combine(conditions))
        .orderBy(asc(t.createdAt), asc(t.id))
    ).map(tagContextActivationFromRow);
  }
  async deactivateTagContextSet(contextSetId: string, tagRouteId: string): Promise<boolean> {
    const t = this.#tables.tagContextActivations;
    return this.#delete(
      t,
      and(
        eq(t.contextSetId, required(contextSetId, "Context Set id")),
        eq(t.tagRouteId, required(tagRouteId, "Tag route id")),
      ),
    );
  }

  async openSession(input: OpenSessionInput): Promise<Session> {
    const t = this.#tables.sessions;
    const tagId = required(input.tagId, "Tag id");
    const sessionKey = required(input.sessionKey, "Session key");
    const values = {
      id: randomUUID(),
      tagId,
      sessionKey,
      origin: input.origin,
      state: "open",
      ...(input.audienceActorKey === undefined
        ? { audience: "shared" }
        : {
            audience: "private",
            audienceActorKey: required(input.audienceActorKey, "Session audience key"),
          }),
      ...(input.parentSessionId === undefined
        ? {}
        : { parentSessionId: required(input.parentSessionId, "Parent Session id") }),
      ...(input.objectiveId !== undefined
        ? { objectiveId: required(input.objectiveId, "Objective id") }
        : input.parentSessionId === undefined
          ? {}
          : {
              objectiveId: sql`(select p."objectiveId" from "Session" p where p."id" = ${input.parentSessionId})`,
            }),
      lastInteractionAt: input.at,
      createdAt: input.at,
      updatedAt: input.at,
    };
    const rows = await this.#db
      .insert(t)
      .values(values)
      .onConflictDoUpdate({
        target: [t.tagId, t.sessionKey],
        set: { lastInteractionAt: input.at, updatedAt: input.at },
      })
      .returning();
    return sessionFromRow(rows[0]);
  }
  async findSessionById(id: string): Promise<Session | undefined> {
    const t = this.#tables.sessions;
    return this.#mappedFirst(t, eq(t.id, required(id, "Session id")), sessionFromRow);
  }
  async findSessionByTagAndKey(tagId: string, sessionKey: string): Promise<Session | undefined> {
    const t = this.#tables.sessions;
    return this.#mappedFirst(
      t,
      and(
        eq(t.tagId, required(tagId, "Tag id")),
        eq(t.sessionKey, required(sessionKey, "Session key")),
      ),
      sessionFromRow,
    );
  }
  async listSessions(filter: SessionListFilter = {}): Promise<readonly Session[]> {
    const t = this.#tables.sessions;
    return (
      await this.#db
        .select()
        .from(t)
        .where(
          filter.tagId === undefined ? undefined : eq(t.tagId, required(filter.tagId, "Tag id")),
        )
        .orderBy(desc(t.lastInteractionAt), asc(t.id))
    ).map(sessionFromRow);
  }

  listVisibleSessions(
    ...args: Parameters<SessionAudienceStore["listVisibleSessions"]>
  ): ReturnType<SessionAudienceStore["listVisibleSessions"]> {
    return this.#sessionAudience().listVisibleSessions(...args);
  }
  findVisibleSession(
    ...args: Parameters<SessionAudienceStore["findVisibleSession"]>
  ): ReturnType<SessionAudienceStore["findVisibleSession"]> {
    return this.#sessionAudience().findVisibleSession(...args);
  }
  searchVisibleSessions(
    ...args: Parameters<SessionAudienceStore["searchVisibleSessions"]>
  ): ReturnType<SessionAudienceStore["searchVisibleSessions"]> {
    return this.#sessionAudience().searchVisibleSessions(...args);
  }
  listVisibleOpenObjectives(
    ...args: Parameters<SessionAudienceStore["listVisibleOpenObjectives"]>
  ): ReturnType<SessionAudienceStore["listVisibleOpenObjectives"]> {
    return this.#sessionAudience().listVisibleOpenObjectives(...args);
  }
  findVisibleObjective(
    ...args: Parameters<SessionAudienceStore["findVisibleObjective"]>
  ): ReturnType<SessionAudienceStore["findVisibleObjective"]> {
    return this.#sessionAudience().findVisibleObjective(...args);
  }
  findObjectiveOwnerSession(
    ...args: Parameters<ObjectiveSessionStore["findObjectiveOwnerSession"]>
  ): ReturnType<ObjectiveSessionStore["findObjectiveOwnerSession"]> {
    return this.#sessionAudience().findObjectiveOwnerSession(...args);
  }
  listObjectiveSessions(
    ...args: Parameters<ObjectiveSessionStore["listObjectiveSessions"]>
  ): ReturnType<ObjectiveSessionStore["listObjectiveSessions"]> {
    return this.#sessionAudience().listObjectiveSessions(...args);
  }
  listIdleObjectives(
    ...args: Parameters<ObjectiveSessionStore["listIdleObjectives"]>
  ): ReturnType<ObjectiveSessionStore["listIdleObjectives"]> {
    return this.#sessionAudience().listIdleObjectives(...args);
  }
  listOpenObjectiveTaskIds(
    ...args: Parameters<ObjectiveSessionStore["listOpenObjectiveTaskIds"]>
  ): ReturnType<ObjectiveSessionStore["listOpenObjectiveTaskIds"]> {
    return this.#sessionAudience().listOpenObjectiveTaskIds(...args);
  }
  listDecidedSessionWaits(
    ...args: Parameters<ObjectiveSessionStore["listDecidedSessionWaits"]>
  ): ReturnType<ObjectiveSessionStore["listDecidedSessionWaits"]> {
    return this.#sessionAudience().listDecidedSessionWaits(...args);
  }
  listWorkSessions(
    ...args: Parameters<SessionAudienceStore["listWorkSessions"]>
  ): ReturnType<SessionAudienceStore["listWorkSessions"]> {
    return this.#sessionAudience().listWorkSessions(...args);
  }
  listSessionTaskIds(
    ...args: Parameters<SessionAudienceStore["listSessionTaskIds"]>
  ): ReturnType<SessionAudienceStore["listSessionTaskIds"]> {
    return this.#sessionAudience().listSessionTaskIds(...args);
  }
  sessionTaskSummaries(
    ...args: Parameters<SessionAudienceStore["sessionTaskSummaries"]>
  ): ReturnType<SessionAudienceStore["sessionTaskSummaries"]> {
    return this.#sessionAudience().sessionTaskSummaries(...args);
  }
  listUnreportedWorkTasks(
    ...args: Parameters<SessionAudienceStore["listUnreportedWorkTasks"]>
  ): ReturnType<SessionAudienceStore["listUnreportedWorkTasks"]> {
    return this.#sessionAudience().listUnreportedWorkTasks(...args);
  }
  findWorkSessionReport(
    ...args: Parameters<SessionAudienceStore["findWorkSessionReport"]>
  ): ReturnType<SessionAudienceStore["findWorkSessionReport"]> {
    return this.#sessionAudience().findWorkSessionReport(...args);
  }
  #sessionAudience(): DrizzleSessionAudienceStore {
    return new DrizzleSessionAudienceStore(this.#db, this.#tables, this.provider);
  }

  async openTask(input: OpenTaskInput): Promise<Task> {
    const t = this.#tables.tasks;
    const rows = await this.#db
      .insert(t)
      .values({
        id: randomUUID(),
        inboundEventId: required(input.inboundEventId, "Inbound event id"),
        tagId: required(input.tagId, "Tag id"),
        sessionId: required(input.sessionId, "Session id"),
        objectiveId: sql`(select s."objectiveId" from "Session" s where s."id" = ${input.sessionId})`,
        execution: parseTaskExecutionRequirements(input.execution),
        actor: input.actor,
        trigger: input.trigger,
        requestText:
          input.requestText ??
          (typeof input.trigger["text"] === "string"
            ? input.trigger["text"]
            : typeof input.trigger["instruction"] === "string"
              ? input.trigger["instruction"]
              : null),
        workspacePlan: input.workspacePlan,
        sessionHistory: input.sessionHistory,
        authorizationSnapshot: input.authorizationSnapshot,
        contextPlan: input.contextPlan,
        status: "pending",
        startedAt: null,
        endedAt: null,
        outcome: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .onConflictDoNothing({ target: t.inboundEventId })
      .returning();
    if (rows[0] !== undefined) {
      const task = taskFromRow(rows[0]);
      if (task.objectiveId !== undefined) {
        // The Objective's first Task marks it started.
        const o = this.#tables.objectives;
        await this.#db
          .update(o)
          .set({ executionStartedAt: input.createdAt })
          .where(and(eq(o.id, task.objectiveId), isNull(o.executionStartedAt)));
      }
      return task;
    }
    const existing = await this.#first(t, eq(t.inboundEventId, input.inboundEventId));
    if (existing === undefined) throw new Error("Task was not persisted");
    return taskFromRow(existing);
  }
  async startTask(input: StartTaskInput): Promise<Task> {
    const t = this.#tables.tasks;
    const rows = await this.#db
      .update(t)
      .set({
        status: "running",
        startedAt: sql`coalesce(${t.startedAt}, ${input.startedAt})`,
        updatedAt: input.startedAt,
      })
      .where(
        and(
          eq(t.id, required(input.taskId, "Task id")),
          or(eq(t.status, "pending"), eq(t.status, "running")),
        ),
      )
      .returning();
    if (rows[0] === undefined)
      throw new Error(`Task ${JSON.stringify(input.taskId)} cannot be started`);
    return taskFromRow(rows[0]);
  }
  async closeTask(input: CloseTaskInput): Promise<Task> {
    const t = this.#tables.tasks;
    const self = this;
    return runDialectTransaction(this.#db, this.provider, function* (tx) {
      const [task] = yield tx
        .update(t)
        .set({ updatedAt: sql`${t.updatedAt}` })
        .where(eq(t.id, required(input.taskId, "Task id")))
        .returning();
      if (!task) throw new Error(`Task ${JSON.stringify(input.taskId)} does not exist`);
      if (input.result !== undefined) {
        const attempts = self.#tables.taskAttempts;
        const [attempt] = yield tx
          .select()
          .from(attempts)
          .where(eq(attempts.taskId, task.id))
          .orderBy(desc(attempts.attemptNumber))
          .limit(1);
        yield* validateSubmittedArtifacts(tx, self.#tables, task.id, attempt?.attemptNumber ?? 0, {
          taskResult: input.result,
        });
      }
      const [row] = yield tx
        .update(t)
        .set({
          status: input.status,
          ...(input.result === undefined ? {} : { result: submittedTaskResult(input.result) }),
          ...(input.responseText === undefined ? {} : { responseText: input.responseText }),
          endedAt: input.endedAt,
          updatedAt: input.endedAt,
          ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        })
        .where(eq(t.id, task.id))
        .returning();
      return taskFromRow(row);
    });
  }
  async listTaskHistory(filter: TaskHistoryFilter = {}): Promise<readonly TaskHistoryEntry[]> {
    const t = this.#tables.tasks;
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Task history limit must be an integer between 1 and 100");
    const conditions: unknown[] = [sql`${t.result} is not null`, sql`${t.endedAt} is not null`];
    if (filter.sessionId !== undefined)
      conditions.push(eq(t.sessionId, required(filter.sessionId, "Session id")));
    if (filter.tagId !== undefined) conditions.push(eq(t.tagId, required(filter.tagId, "Tag id")));
    if (filter.excludeTaskId !== undefined)
      conditions.push(sql`${t.id} <> ${required(filter.excludeTaskId, "Excluded Task id")}`);
    if (filter.createdAfter !== undefined)
      conditions.push(gte(t.endedAt, required(filter.createdAfter, "Task history start time")));
    if (filter.completedBefore !== undefined)
      conditions.push(lt(t.endedAt, required(filter.completedBefore, "Task history end time")));
    const pg = this.provider === "postgresql";
    const references = pg
      ? sql`jsonb_array_elements(coalesce(${t.result}->'references', '[]'::jsonb)) as r(value)`
      : sql`json_each(${t.result}, '$.references') as r`;
    const field = (name: string) =>
      pg ? sql`r.value->>${name}` : sql`json_extract(r.value, ${`$.${name}`})`;
    const related = (filter.relatedTo ?? []).map((reference) => ({
      provider: parseSurfaceProvider(reference.provider),
      resourceType: parseTaskResourceType(reference.resourceType),
      reference: required(reference.reference, "Work reference"),
      ...(reference.resourceId === undefined
        ? {}
        : { resourceId: required(reference.resourceId, "Reference resource id") }),
      ...(reference.surfaceAccountId === undefined
        ? {}
        : { surfaceAccountId: required(reference.surfaceAccountId, "Reference account id") }),
    }));
    if (related.length)
      conditions.push(
        sql`exists (select 1 from ${references} where ${or(...related.map((ref) => and(eq(field("provider"), ref.provider), eq(field("resourceType"), ref.resourceType), ref.surfaceAccountId === undefined ? undefined : eq(field("surfaceAccountId"), ref.surfaceAccountId), ref.resourceId === undefined ? eq(field("reference"), ref.reference) : eq(field("resourceId"), ref.resourceId))))})`,
      );
    const origins = (filter.originSurfaces ?? []).map((origin) => ({
      provider: parseSurfaceProvider(origin.provider),
      surfaceAccountId: required(origin.surfaceAccountId, "Origin account id"),
      scope: required(origin.scope, "Origin scope"),
    }));
    // Result references can be supplied by a model. Only captured admission data
    // can authorize cross-Session discovery; a claimed origin is not authority.
    const originField = (name: string) =>
      pg
        ? sql`coalesce(${t.trigger}->'origin', ${t.authorizationSnapshot}->'origin')->>${name}`
        : sql`json_extract(coalesce(json_extract(${t.trigger}, '$.origin'), json_extract(${t.authorizationSnapshot}, '$.origin')), ${`$.${name}`})`;
    if (origins.length)
      conditions.push(
        or(
          ...origins.map((origin) =>
            and(
              eq(originField("provider"), origin.provider),
              eq(originField("surfaceAccountId"), origin.surfaceAccountId),
              eq(originField("scope"), origin.scope),
            ),
          ),
        ),
      );
    const rows = await this.#db
      .select()
      .from(t)
      .where(combine(conditions))
      .orderBy(desc(t.endedAt), desc(t.id))
      .limit(limit);
    return rows.map((row: any) => ({
      taskId: row.id,
      sessionId: row.sessionId,
      tagId: row.tagId,
      ...(row.requestText == null ? {} : { requestText: row.requestText }),
      result: taskResultFromJson(row.result),
      completedAt: row.endedAt,
    }));
  }

  async findTaskById(id: string): Promise<Task | undefined> {
    const t = this.#tables.tasks;
    return this.#mappedFirst(t, eq(t.id, required(id, "Task id")), taskFromRow);
  }
  async listTasks(filter: TaskListFilter = {}): Promise<readonly Task[]> {
    const t = this.#tables.tasks;
    const limit = positiveLimit(filter.limit ?? 100);
    const conditions = compact([
      filter.tagId === undefined ? undefined : eq(t.tagId, required(filter.tagId, "Tag id")),
      filter.sessionId === undefined
        ? undefined
        : eq(t.sessionId, required(filter.sessionId, "Session id")),
      filter.objectiveId === undefined
        ? undefined
        : eq(t.objectiveId, required(filter.objectiveId, "Objective id")),
      filter.status === undefined ? undefined : eq(t.status, filter.status),
      filter.before === undefined
        ? undefined
        : or(
            lt(t.createdAt, filter.before.createdAt),
            and(eq(t.createdAt, filter.before.createdAt), gt(t.id, filter.before.id)),
          ),
    ]);
    return (
      await this.#db
        .select()
        .from(t)
        .where(combine(conditions))
        .orderBy(desc(t.createdAt), asc(t.id))
        .limit(limit)
    ).map(taskFromRow);
  }

  async cancelPendingSurfaceTask(input: CancelPendingSurfaceTaskInput): Promise<Task | undefined> {
    if (!Number.isFinite(Date.parse(input.cancelledAt)))
      throw new Error("Surface cancellation requires a valid timestamp");
    const self = this;
    return runDialectTransaction(this.#db, this.provider, function* (tx) {
      const tasks = self.#tables.tasks,
        inbound = self.#tables.durableInboundEvents,
        attempts = self.#tables.taskAttempts;
      const [initial] = yield tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, required(input.taskId, "Task id")))
        .limit(1);
      if (!initial?.inboundEventId) return undefined;
      const { work, task } = yield* lockSurfaceTask(tx, self.#tables, {
        taskId: initial.id,
        inboundEventId: initial.inboundEventId,
      });
      if (task.status !== "pending" || (work.status !== "pending" && work.status !== "processing"))
        return undefined;
      const [attempt] = yield tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(eq(attempts.taskId, task.id))
        .limit(1);
      if (attempt || (yield* pendingSurfaceIntent(tx, self.#tables, task.id))) return undefined;
      const [cancelled] = yield tx
        .update(tasks)
        .set({
          status: "cancelled",
          outcome: { reason: "operator-request" },
          endedAt: input.cancelledAt,
          updatedAt: input.cancelledAt,
        })
        .where(eq(tasks.id, task.id))
        .returning();
      yield tx
        .update(inbound)
        .set({
          status: "completed",
          completedAt: input.cancelledAt,
          updatedAt: input.cancelledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          failedAt: null,
        })
        .where(eq(inbound.id, work.id))
        .returning();
      yield tx
        .insert(self.#tables.outboundReplies)
        .values(
          outboundValues(work, {
            workerId: "control-plane",
            responseText: "I stopped working on this.",
            completedAt: input.cancelledAt,
          }),
        )
        .returning();
      return taskFromRow(cancelled);
    });
  }

  async openSurfaceTaskAttempt(input: OpenSurfaceTaskAttemptInput): Promise<TaskAttempt> {
    const workerProfile = profile(input.workerProfile);
    if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1)
      throw new Error("Task attempt number must be a positive integer");
    if (!Number.isFinite(Date.parse(input.now)) || !Number.isFinite(Date.parse(input.startedAt)))
      throw new Error("Surface Attempt admission requires valid timestamps");
    const self = this;
    return runDialectTransaction(this.#db, this.provider, function* (tx) {
      const { work, task } = yield* lockSurfaceTask(tx, self.#tables, input);
      if (yield* pendingSurfaceIntent(tx, self.#tables, task.id))
        throw new Error("Prepared surface outcome must be settled before another Attempt");
      const tasks = self.#tables.tasks,
        attempts = self.#tables.taskAttempts;
      if (
        work.status !== "processing" ||
        work.leaseOwner !== input.leaseOwner ||
        !work.leaseExpiresAt ||
        Date.parse(work.leaseExpiresAt) <= Date.parse(input.now) ||
        work.attemptCount !== input.attemptNumber ||
        (task.status !== "pending" && task.status !== "running")
      )
        throw staleLeaseError("surface Attempt admission", input.taskId);
      yield tx
        .update(tasks)
        .set({
          status: "running",
          startedAt: sql`coalesce(${tasks.startedAt}, ${input.startedAt})`,
          updatedAt: input.startedAt,
        })
        .where(eq(tasks.id, task.id))
        .returning();
      yield tx
        .update(attempts)
        .set({
          status: "failed",
          endedAt: input.startedAt,
          outcome: { reason: "superseded-by-retry" },
          updatedAt: input.startedAt,
        })
        .where(and(eq(attempts.taskId, task.id), eq(attempts.status, "running")))
        .returning();
      const [attempt] = yield tx
        .insert(attempts)
        .values(taskAttemptValues(input, workerProfile))
        .returning();
      return taskAttemptFromRow(attempt);
    });
  }

  async createTaskAttempt(input: CreateTaskAttemptInput): Promise<TaskAttempt> {
    const workerProfile = profile(input.workerProfile);
    const t = this.#tables.taskAttempts;
    const taskId = required(input.taskId, "Task id");
    if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1)
      throw new Error("Task attempt number must be a positive integer");
    const tasks = this.#tables.tasks;
    return runDialectTransaction(this.#db, this.provider, function* (tx) {
      // Serialize retry admission with recording the accepted Worker's identity.
      const [task] = yield tx
        .update(tasks)
        .set({ updatedAt: sql`${tasks.updatedAt}` })
        .where(eq(tasks.id, taskId))
        .returning();
      if (!task) throw new Error(`Task ${JSON.stringify(taskId)} does not exist`);
      yield tx
        .update(t)
        .set({
          status: "failed",
          endedAt: input.startedAt,
          outcome: { reason: "superseded-by-retry" },
          updatedAt: input.startedAt,
        })
        .where(and(eq(t.taskId, taskId), eq(t.status, "running")))
        .returning();
      const [attempt] = yield tx
        .insert(t)
        .values(taskAttemptValues({ ...input, taskId }, workerProfile))
        .returning();
      return taskAttemptFromRow(attempt);
    });
  }

  async recordTaskAttemptMcpDigest(
    taskId: string,
    attemptId: string,
    digest: string,
  ): Promise<TaskAttempt> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid MCP servers digest");
    const table = this.#tables.taskAttempts;
    // The first Attempt to record a digest pins the Task's Workspace MCP configuration.
    const [pinned] = await this.#db
      .select()
      .from(table)
      .where(
        and(eq(table.taskId, taskId), isNotNull(table.mcpServersDigest), ne(table.id, attemptId)),
      )
      .orderBy(asc(table.attemptNumber))
      .limit(1);
    if (pinned && pinned.mcpServersDigest !== digest)
      throw new Error(
        "Task Attempt MCP servers digest differs from the one this Task's first Task Attempt pinned",
      );
    const [updated] = await this.#db
      .update(table)
      .set({ mcpServersDigest: digest })
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId), isNull(table.mcpServersDigest)))
      .returning();
    if (updated) return taskAttemptFromRow(updated);
    const [existing] = await this.#db
      .select()
      .from(table)
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId)))
      .limit(1);
    if (!existing || existing.mcpServersDigest !== digest)
      throw new Error("Task Attempt MCP servers digest conflict");
    return taskAttemptFromRow(existing);
  }

  async recordTaskAttemptMountManifests(
    taskId: string,
    attemptId: string,
    manifests: readonly MountManifest[],
  ): Promise<TaskAttempt> {
    const parsed = parseMountManifests(manifests);
    const table = this.#tables.taskAttempts;
    // Manifests are write-once: they record what one Attempt's environment held.
    const [updated] = await this.#db
      .update(table)
      .set({ mountManifests: parsed })
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId), isNull(table.mountManifests)))
      .returning();
    if (updated) return taskAttemptFromRow(updated);
    const [existing] = await this.#db
      .select()
      .from(table)
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId)))
      .limit(1);
    if (!existing) throw new Error("Task Attempt not found");
    if (!isDeepStrictEqual(existing.mountManifests, parsed))
      throw new Error("Task Attempt mount manifests conflict");
    return taskAttemptFromRow(existing);
  }

  async recordTaskAttemptMountOutputManifests(
    taskId: string,
    attemptId: string,
    manifests: readonly MountOutputManifest[],
  ): Promise<TaskAttempt> {
    const parsed = parseMountOutputManifests(manifests);
    const table = this.#tables.taskAttempts;
    const [updated] = await this.#db
      .update(table)
      .set({ mountOutputManifests: parsed })
      .where(
        and(eq(table.id, attemptId), eq(table.taskId, taskId), isNull(table.mountOutputManifests)),
      )
      .returning();
    if (updated) return taskAttemptFromRow(updated);
    const [existing] = await this.#db
      .select()
      .from(table)
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId)))
      .limit(1);
    if (!existing) throw new Error("Task Attempt not found");
    if (!isDeepStrictEqual(existing.mountOutputManifests, parsed))
      throw new Error("Task Attempt mount output manifests conflict");
    return taskAttemptFromRow(existing);
  }

  async recordTaskAttemptLiveMounts(
    taskId: string,
    attemptId: string,
    mounts: readonly LiveMount[],
  ): Promise<TaskAttempt> {
    const parsed = parseLiveMounts(mounts);
    const table = this.#tables.taskAttempts;
    // Live attachment records are immutable, including across journal replay.
    const [updated] = await this.#db
      .update(table)
      .set({ liveMounts: parsed })
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId), isNull(table.liveMounts)))
      .returning();
    if (updated) return taskAttemptFromRow(updated);
    const [existing] = await this.#db
      .select()
      .from(table)
      .where(and(eq(table.id, attemptId), eq(table.taskId, taskId)))
      .limit(1);
    if (!existing) throw new Error("Task Attempt not found");
    if (!isDeepStrictEqual(existing.liveMounts, parsed))
      throw new Error("Task Attempt live mounts conflict");
    return taskAttemptFromRow(existing);
  }

  async recordTaskAttemptWorker(input: RecordTaskAttemptWorkerInput): Promise<TaskAttempt> {
    const taskId = required(input.taskId, "Task id");
    const attemptId = required(input.attemptId, "Task attempt id");
    if (
      input.connectionGeneration !== undefined &&
      (!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1)
    )
      throw new Error("Worker Host connection generation must be a positive integer");
    const stableIdentity = {
      workerHostId: required(input.workerHostId, "Worker Host id"),
      workletId: required(input.workletId, "Worklet id"),
      ...(input.workerId === undefined ? {} : { workerId: required(input.workerId, "Worker id") }),
    };
    const tasks = this.#tables.tasks,
      attempts = this.#tables.taskAttempts;
    const self = this;
    return runDialectTransaction(this.#db, this.provider, function* (tx) {
      const [task] = yield tx
        .update(tasks)
        .set({ updatedAt: sql`${tasks.updatedAt}` })
        .where(eq(tasks.id, taskId))
        .returning();
      if (!task) throw new Error(`Task ${JSON.stringify(taskId)} does not exist`);
      const latest = yield* lockLatestTaskAttempt(tx, self.#tables, taskId);
      if (!latest || latest.id !== attemptId)
        throw new Error("Worker acceptance must match the latest Task Attempt");
      const snapshot = record(latest.workerSnapshot, "task attempt worker snapshot");
      for (const [key, value] of Object.entries(stableIdentity)) {
        if (snapshot[key] !== undefined && snapshot[key] !== value)
          throw new Error(`Task Attempt ${key} conflicts with its recorded Worker identity`);
      }
      const recordedGeneration = snapshot["connectionGeneration"];
      if (
        recordedGeneration !== undefined &&
        (typeof recordedGeneration !== "number" ||
          !Number.isSafeInteger(recordedGeneration) ||
          recordedGeneration < 1)
      )
        throw new Error("Task Attempt has an invalid Worker Host connection generation");
      const connectionGeneration =
        input.connectionGeneration === undefined ||
        (typeof recordedGeneration === "number" && recordedGeneration > input.connectionGeneration)
          ? recordedGeneration
          : input.connectionGeneration;
      const identity = {
        ...stableIdentity,
        ...(connectionGeneration === undefined ? {} : { connectionGeneration }),
      };
      if (Object.entries(identity).every(([key, value]) => snapshot[key] === value))
        return taskAttemptFromRow(latest);
      // Terminal latest Attempts are valid: completion can arrive before a recovered receipt.
      const [updated] = yield tx
        .update(attempts)
        .set({
          workerSnapshot: { ...snapshot, ...identity },
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(attempts.id, attemptId), eq(attempts.taskId, taskId)))
        .returning();
      return taskAttemptFromRow(updated);
    });
  }

  async closeTaskAttempt(input: CloseTaskAttemptInput): Promise<TaskAttempt> {
    const t = this.#tables.taskAttempts;
    const rows = await this.#db
      .update(t)
      .set({
        status: input.status,
        endedAt: input.endedAt,
        updatedAt: input.endedAt,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      })
      .where(eq(t.id, required(input.attemptId, "Task attempt id")))
      .returning();
    if (rows[0] === undefined)
      throw new Error(`Task attempt ${JSON.stringify(input.attemptId)} does not exist`);
    return taskAttemptFromRow(rows[0]);
  }

  async listTaskAttempts(taskId: string | readonly string[]): Promise<readonly TaskAttempt[]> {
    const t = this.#tables.taskAttempts;
    const taskIds = [...new Set(typeof taskId === "string" ? [taskId] : taskId)].map((id) =>
      required(id, "Task id"),
    );
    if (taskIds.length === 0) return [];
    return (
      await this.#db
        .select()
        .from(t)
        .where(inArray(t.taskId, taskIds))
        .orderBy(asc(t.attemptNumber))
    ).map(taskAttemptFromRow);
  }

  async listRunningTaskAttempts(): Promise<readonly TaskAttempt[]> {
    const t = this.#tables.taskAttempts;
    return (
      await this.#db
        .select()
        .from(t)
        .where(eq(t.status, "running"))
        .orderBy(asc(t.startedAt), asc(t.id))
    ).map(taskAttemptFromRow);
  }

  async recordTaskAttemptChangedPaths(input: {
    readonly attemptId: string;
    readonly paths: readonly string[];
    readonly truncated: boolean;
  }): Promise<void> {
    const attemptId = required(input.attemptId, "Task Attempt id");
    const paths = validChangedPaths(input.paths);
    if (typeof input.truncated !== "boolean") throw new Error("truncated must be a boolean");
    const reports = this.#tables.attemptChangedPaths;
    const attempts = this.#tables.taskAttempts;
    await runDialectTransaction(this.#db, this.provider, function* (tx: any) {
      const [attempt] = yield tx
        .select({ status: attempts.status })
        .from(attempts)
        .where(eq(attempts.id, attemptId))
        .limit(1);
      if (attempt?.status !== "running") return;
      const reportedAt = new Date().toISOString();
      yield tx
        .insert(reports)
        .values({ attemptId, paths, truncated: input.truncated, reportedAt })
        .onConflictDoUpdate({
          target: reports.attemptId,
          set: { paths, truncated: input.truncated, reportedAt },
        })
        .returning();
    });
  }

  async listRunningTaskAttemptChangedPaths(): ReturnType<
    Store["listRunningTaskAttemptChangedPaths"]
  > {
    const reports = this.#tables.attemptChangedPaths;
    const attempts = this.#tables.taskAttempts;
    const tasks = this.#tables.tasks;
    const rows = await this.#db
      .select({
        attemptId: reports.attemptId,
        taskId: attempts.taskId,
        objectiveId: tasks.objectiveId,
        tagId: tasks.tagId,
        workspacePlan: tasks.workspacePlan,
        paths: reports.paths,
        truncated: reports.truncated,
        reportedAt: reports.reportedAt,
      })
      .from(reports)
      .innerJoin(attempts, eq(attempts.id, reports.attemptId))
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .where(and(eq(attempts.status, "running"), isNotNull(tasks.objectiveId)))
      .orderBy(asc(attempts.id));
    return rows.map((row: any) => ({
      ...row,
      paths: validChangedPaths(row.paths),
      workspacePlan: row.workspacePlan as TaskWorkspacePlan,
    }));
  }

  async recordOverlaps(input: {
    readonly objectiveId: string;
    readonly firstAttemptId: string;
    readonly secondAttemptId: string;
    readonly paths: readonly string[];
  }): ReturnType<Store["recordOverlaps"]> {
    const objectiveId = required(input.objectiveId, "Objective id");
    const first = required(input.firstAttemptId, "First Task Attempt id");
    const second = required(input.secondAttemptId, "Second Task Attempt id");
    if (first === second) throw new Error("Overlap requires two distinct Task Attempts");
    const [lowerAttemptId, higherAttemptId] = first < second ? [first, second] : [second, first];
    const paths = validChangedPaths(input.paths);
    const table = this.#tables.overlapWarnings;
    return runDialectTransaction(this.#db, this.provider, function* (tx: any) {
      const added = [];
      for (const path of paths) {
        const [row] = yield tx
          .insert(table)
          .values({ objectiveId, lowerAttemptId, higherAttemptId, path })
          .onConflictDoNothing()
          .returning();
        if (row) added.push({ objectiveId, lowerAttemptId, higherAttemptId, path });
      }
      return added;
    });
  }

  async appendTaskEvent(input: AppendTaskEventInput): Promise<TaskEvent> {
    const taskId = required(input.taskId, "Task id");
    const type = required(input.type, "Task event type");
    const createdAt = input.createdAt ?? new Date().toISOString();
    const t = this.#tables.taskEvents;
    // Allocate under the Task row lock, like writers inside other transactions, so a concurrent
    // transaction never picks the same sequence. The unique constraint and a short retry remain
    // as a backstop.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runDialectTransaction(this.#db, this.provider, function* (tx: any) {
          const sequence = yield* nextTaskEventSequence(tx, t, taskId, createdAt);
          const [row] = yield tx
            .insert(t)
            .values({
              id: randomUUID(),
              taskId,
              attemptId: input.attemptId ?? null,
              sequence,
              type,
              payload: input.payload ?? null,
              createdAt,
            })
            .returning();
          return taskEventFromRow(row);
        });
      } catch (error) {
        if (!isUnique(error) || attempt === 4) throw error;
      }
    }
    throw new Error("Unable to allocate a Task event sequence");
  }
  async listTaskEvents(taskId: string): Promise<readonly TaskEvent[]> {
    const t = this.#tables.taskEvents;
    return (
      await this.#db
        .select()
        .from(t)
        .where(eq(t.taskId, required(taskId, "Task id")))
        .orderBy(asc(t.sequence))
    ).map(taskEventFromRow);
  }

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const references = normalizeTaskReferences(input.references ?? []);
    const artifactId = randomUUID();
    const create = async (db: DynamicDatabase): Promise<void> => {
      await db.insert(this.#tables.artifacts).values({
        id: artifactId,
        taskId: required(input.taskId, "Artifact task id"),
        kind: required(input.kind, "Artifact kind"),
        location: required(input.location, "Artifact location"),
        contentHash: input.contentHash ?? null,
        sourceReferences: input.sourceReferences ?? null,
        metadata: input.metadata ?? null,
        createdAt: input.createdAt,
      });
      if (references.length > 0)
        await db.insert(this.#tables.taskReferences).values(
          references.map((reference) => ({
            id: randomUUID(),
            artifactId,
            ...reference,
            surfaceAccountId: reference.surfaceAccountId ?? null,
            resourceId: reference.resourceId ?? null,
            createdAt: input.createdAt,
          })),
        );
    };
    if (this.provider === "postgresql")
      await this.#db.transaction(async (tx: DynamicDatabase) => create(tx));
    else
      this.#db.transaction((tx: DynamicDatabase) => {
        createSynchronously(tx, this.#tables, artifactId, input, references);
      });
    const artifact = await this.findArtifactById(artifactId);
    if (!artifact) throw new Error("Artifact was not persisted");
    return artifact;
  }

  async findArtifactById(id: string): Promise<Artifact | undefined> {
    const a = this.#tables.artifacts;
    const row = await this.#first(a, eq(a.id, required(id, "Artifact id")));
    if (!row) return undefined;
    return artifactFromRow(row, await this.#artifactReferences(row.id));
  }

  async listArtifacts(filter: ArtifactListFilter = {}): Promise<readonly Artifact[]> {
    const limit = filter.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
      throw new Error("Artifact list limit must be an integer between 1 and 100");
    const a = this.#tables.artifacts,
      t = this.#tables.tasks,
      w = this.#tables.taskReferences;
    const conditions: unknown[] = [];
    if (filter.taskId !== undefined)
      conditions.push(eq(a.taskId, required(filter.taskId, "Artifact task id")));
    if (filter.kind !== undefined)
      conditions.push(eq(a.kind, required(filter.kind, "Artifact kind")));
    if (filter.createdAfter !== undefined)
      conditions.push(gte(a.createdAt, required(filter.createdAfter, "Artifact start time")));
    if (filter.sessionId !== undefined)
      conditions.push(eq(t.sessionId, required(filter.sessionId, "Artifact session id")));
    if (filter.tagId !== undefined)
      conditions.push(eq(t.tagId, required(filter.tagId, "Artifact Tag id")));
    const related = normalizeTaskReferencesForMatch(filter.relatedTo ?? []);
    if (related.length > 0)
      conditions.push(
        sql`exists (select 1 from ${w} where ${w.artifactId} = ${a.id} and ${or(...related.map((reference) => and(eq(w.provider, reference.provider), eq(w.resourceType, reference.resourceType), reference.resourceId === undefined ? eq(w.reference, reference.reference) : eq(w.resourceId, reference.resourceId))))})`,
      );
    const originSurfaces = (filter.originSurfaces ?? []).map((origin) => ({
      provider: parseSurfaceProvider(origin.provider),
      surfaceAccountId: required(origin.surfaceAccountId, "Artifact origin account id"),
      resourceId: contextScopeId(origin.scope),
    }));
    if (originSurfaces.length > 0)
      conditions.push(
        sql`exists (select 1 from ${w} where ${w.artifactId} = ${a.id} and ${w.relationship} = ${"originated-in"} and ${or(...originSurfaces.map((origin) => and(eq(w.provider, origin.provider), eq(w.surfaceAccountId, origin.surfaceAccountId), eq(w.resourceId, origin.resourceId))))})`,
      );
    let query = this.#db
      .select({ artifact: a })
      .from(a)
      .innerJoin(t, eq(a.taskId, t.id))
      .where(combine(conditions))
      .orderBy(desc(a.createdAt), desc(a.id));
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query;
    return Promise.all(
      rows.map(async (selected: any) =>
        artifactFromRow(selected.artifact, await this.#artifactReferences(selected.artifact.id)),
      ),
    );
  }

  async saveSurfaceAccount(input: SurfaceAccountInput): Promise<SurfaceAccount> {
    const t = this.#tables.surfaceAccounts;
    const now = new Date().toISOString();
    const update = {
      authMethod: input.authMethod,
      configuration: input.configuration,
      displayName: input.displayName,
      lastVerifiedAt: input.verifiedAt,
      credentialId: input.credentialId,
      status: input.status,
      updatedAt: now,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.secretReferences === undefined ? {} : { secretReferences: input.secretReferences }),
    };
    const rows = await this.#db
      .insert(t)
      .values({
        ...update,
        id: randomUUID(),
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        createdAt: now,
      })
      .onConflictDoUpdate({ target: [t.provider, t.externalAccountId], set: update })
      .returning();
    return surfaceAccountFromRow(rows[0]);
  }
  async findSurfaceAccount(
    providerValue: SurfaceProvider,
    externalAccountId: string,
  ): Promise<SurfaceAccount | undefined> {
    const t = this.#tables.surfaceAccounts;
    return this.#mappedFirst(
      t,
      and(
        eq(t.provider, providerValue),
        eq(t.externalAccountId, externalAccountId),
        eq(t.status, "connected"),
      ),
      surfaceAccountFromRow,
    );
  }
  async findSurfaceAccountById(id: string): Promise<SurfaceAccount | undefined> {
    const t = this.#tables.surfaceAccounts;
    return this.#mappedFirst(t, eq(t.id, id), surfaceAccountFromRow);
  }
  async findSurfaceAccountByName(name: string): Promise<SurfaceAccount | undefined> {
    const t = this.#tables.surfaceAccounts;
    return this.#mappedFirst(
      t,
      and(eq(t.name, name), eq(t.status, "connected")),
      surfaceAccountFromRow,
    );
  }
  async listSurfaceAccounts(): Promise<readonly SurfaceAccount[]> {
    const t = this.#tables.surfaceAccounts;
    return (
      await this.#db
        .select()
        .from(t)
        // The built-in CLI conversation account is not a connected surface.
        .where(and(eq(t.status, "connected"), ne(t.provider, "cli")))
        .orderBy(asc(t.createdAt))
    ).map(surfaceAccountFromRow);
  }
  async retireSurfaceAccount(id: string): Promise<SurfaceAccount | undefined> {
    const t = this.#tables.surfaceAccounts;
    const rows = await this.#db
      .update(t)
      .set({
        status: "retired",
        name: null,
        secretReferences: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(t.id, id))
      .returning();
    return rows[0] === undefined ? undefined : surfaceAccountFromRow(rows[0]);
  }

  private sessionInputTransaction<T>(work: (tx: any) => Generator<any, T, any>): Promise<T> {
    return runDialectTransaction(this.#db, this.provider, work);
  }
  private *controlInputEligible(
    tx: any,
    incoming: any,
    lock = false,
  ): Generator<any, boolean, any> {
    const i = this.#tables.durableInboundEvents,
      c = this.#tables.inboundControlDeliveries,
      s = this.#tables.sessions;
    if (lock)
      yield tx
        .update(s)
        .set({ updatedAt: sql`${s.updatedAt}` })
        .where(and(eq(s.tagId, incoming.tagId), eq(s.sessionKey, incoming.sessionKey)))
        .returning();
    const [blocked] = yield tx
      .select({ id: i.id })
      .from(i)
      .where(
        and(
          eq(i.tagId, incoming.tagId),
          eq(i.sessionKey, incoming.sessionKey),
          or(
            eq(i.sessionBlocked, true),
            sql`(${i.status} = 'pending' and ${i.id} <> ${incoming.id} and ${i.admissionOrder} < ${incoming.admissionOrder})`,
          ),
        ),
      )
      .limit(1);
    if (blocked) return false;
    const [outstanding] = yield tx
      .select({ id: c.inboundEventId })
      .from(c)
      .innerJoin(i, eq(i.id, c.inboundEventId))
      .where(
        and(
          eq(i.tagId, incoming.tagId),
          eq(i.sessionKey, incoming.sessionKey),
          or(eq(c.status, "dispatching"), eq(c.status, "unknown")),
        ),
      )
      .limit(1);
    return !outstanding;
  }
  async findLatestSessionExecutionTask(
    sessionId: string,
    excludeTaskId: string,
  ): Promise<Task | undefined> {
    const t = this.#tables.tasks,
      i = this.#tables.durableInboundEvents;
    const rows = await this.#db
      .select({ task: t })
      .from(t)
      .innerJoin(i, eq(i.id, t.inboundEventId))
      .where(
        and(
          eq(t.sessionId, required(sessionId, "Session id")),
          sql`${t.id} <> ${required(excludeTaskId, "Excluded Task id")}`,
          sql`${t.startedAt} is not null`,
        ),
      )
      .orderBy(desc(i.admissionOrder))
      .limit(1);
    return rows[0] ? taskFromRow(rows[0].task) : undefined;
  }
  async blockInboundSession(
    inboundEventId: string,
    reason: string,
    fence?: { readonly leaseOwner: string; readonly now: string },
  ): Promise<void> {
    const t = this.#tables.durableInboundEvents;
    await this.#db
      .update(t)
      .set({
        sessionBlocked: true,
        lastError: required(reason, "Session block reason"),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(t.id, required(inboundEventId, "Inbound event id")),
          fence === undefined
            ? undefined
            : and(
                eq(t.status, "processing"),
                eq(t.leaseOwner, required(fence.leaseOwner, "Lease owner")),
                sql`${t.leaseExpiresAt} > ${fence.now}`,
              ),
        ),
      );
  }
  async listBlockedSessionAttempts(
    input: Parameters<SessionInputStore["listBlockedSessionAttempts"]>[0],
  ): ReturnType<SessionInputStore["listBlockedSessionAttempts"]> {
    const i = this.#tables.durableInboundEvents,
      t = this.#tables.tasks,
      a = this.#tables.taskAttempts;
    // Pages by turn ID, so turns that stay blocked cannot hide later ones from a caller that
    // passes the last ID it saw.
    return this.#db
      .select({ inboundEventId: i.id, taskId: t.id, attemptId: a.id })
      .from(i)
      .innerJoin(t, eq(t.inboundEventId, i.id))
      .innerJoin(a, eq(a.taskId, t.id))
      .where(
        and(
          eq(i.sessionBlocked, true),
          inArray(i.status, ["completed", "failed"]),
          inArray(i.lastError, [...ATTEMPT_CLEANUP_BLOCK_REASONS]),
          input.after === undefined ? undefined : gt(i.id, input.after),
          ne(a.status, "running"),
          sql`${a.attemptNumber} = (select max(latest."attemptNumber") from "TaskAttempt" latest where latest."taskId" = ${t.id})`,
        ),
      )
      .orderBy(asc(i.id))
      .limit(positiveLimit(input.limit));
  }
  async releaseInboundSession(
    input: Parameters<SessionInputStore["releaseInboundSession"]>[0],
  ): Promise<boolean> {
    const i = this.#tables.durableInboundEvents;
    const attemptId = required(input.attemptId, "Task attempt id");
    // One conditional update: a dispatcher claiming the Session's next turn sees it either still
    // blocked or released, and a repeat changes nothing. The turn keeps its settled status and
    // its reason, so it never becomes due again.
    const rows = await this.#db
      .update(i)
      .set({ sessionBlocked: false, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(i.id, required(input.inboundEventId, "Inbound event id")),
          eq(i.sessionBlocked, true),
          inArray(i.status, ["completed", "failed"]),
          // Other block reasons are resolved elsewhere, not by the Attempt stopping.
          inArray(i.lastError, [...ATTEMPT_CLEANUP_BLOCK_REASONS]),
          sql`exists (select 1 from "Task" bt join "TaskAttempt" ba on ba."taskId" = bt."id" where bt."inboundEventId" = ${i.id} and ba."id" = ${attemptId} and ba."status" <> 'running' and ba."attemptNumber" = (select max(la."attemptNumber") from "TaskAttempt" la where la."taskId" = bt."id"))`,
        ),
      )
      .returning({ id: i.id });
    return rows.length > 0;
  }
  async refreshPendingTaskSessionHistory(
    taskId: string,
    sessionHistory: readonly TaskHistoryEntry[],
  ): Promise<Task> {
    const t = this.#tables.tasks;
    const rows = await this.#db
      .update(t)
      .set({ sessionHistory: taskHistoryArray(sessionHistory, "Session history") })
      .where(and(eq(t.id, required(taskId, "Task id")), eq(t.status, "pending")))
      .returning();
    if (!rows[0]) throw new Error("Only a pending Task can refresh Session history");
    return taskFromRow(rows[0]);
  }
  async findActiveSessionAttempt(
    inboundEventId: string,
  ): ReturnType<SessionInputStore["findActiveSessionAttempt"]> {
    const self = this;
    return this.sessionInputTransaction(function* (tx) {
      const i = self.#tables.durableInboundEvents,
        t = self.#tables.tasks,
        a = self.#tables.taskAttempts,
        s = self.#tables.sessions;
      const [incoming] = yield tx
        .select()
        .from(i)
        .where(eq(i.id, required(inboundEventId, "Inbound event id")))
        .limit(1);
      if (incoming?.status !== "pending" || incoming.sessionBlocked) return undefined;
      if (!(yield* self.controlInputEligible(tx, incoming))) return undefined;
      const rows = yield tx
        .select({ task: t, attempt: a, inbound: i, session: s })
        .from(t)
        .innerJoin(a, eq(a.taskId, t.id))
        .innerJoin(i, eq(i.id, t.inboundEventId))
        .innerJoin(s, eq(s.id, t.sessionId))
        .where(
          and(
            eq(t.tagId, incoming.tagId),
            eq(s.sessionKey, incoming.sessionKey),
            eq(t.status, "running"),
            eq(a.status, "running"),
            eq(i.status, "processing"),
            sql`${i.leaseOwner} is not null and ${i.leaseOwner} <> '' and ${i.leaseExpiresAt} > ${new Date().toISOString()}`,
          ),
        )
        .limit(1);
      const found = rows[0];
      if (!found || !sameInboundAudience(incoming, found.inbound)) return undefined;
      return { task: taskFromRow(found.task), attempt: taskAttemptFromRow(found.attempt) };
    });
  }
  async findInboundControlDelivery(
    inboundEventId: string,
  ): Promise<InboundControlDelivery | undefined> {
    const t = this.#tables.inboundControlDeliveries;
    const row = await this.#first(
      t,
      eq(t.inboundEventId, required(inboundEventId, "Inbound event id")),
    );
    return row ? inboundControlFromRow(row) : undefined;
  }
  async prepareInboundControlDelivery(
    input: Parameters<SessionInputStore["prepareInboundControlDelivery"]>[0],
  ): ReturnType<SessionInputStore["prepareInboundControlDelivery"]> {
    const self = this;
    return this.sessionInputTransaction(function* (tx) {
      const i = self.#tables.durableInboundEvents,
        t = self.#tables.tasks,
        a = self.#tables.taskAttempts,
        c = self.#tables.inboundControlDeliveries,
        s = self.#tables.sessions;
      const [incoming] = yield tx
        .update(i)
        .set({ updatedAt: sql`${i.updatedAt}` })
        .where(eq(i.id, required(input.inboundEventId, "Inbound event id")))
        .returning();
      if (!incoming) return undefined;
      const [existing] = yield tx
        .select()
        .from(c)
        .where(eq(c.inboundEventId, incoming.id))
        .limit(1);
      if (existing) return { created: false, delivery: inboundControlFromRow(existing) };
      if (incoming.status !== "pending" || incoming.sessionBlocked) return undefined;
      if (!(yield* self.controlInputEligible(tx, incoming, true))) return undefined;
      const [target] = yield tx
        .select({ task: t, attempt: a, inbound: i, session: s })
        .from(t)
        .innerJoin(a, eq(a.taskId, t.id))
        .innerJoin(i, eq(i.id, t.inboundEventId))
        .innerJoin(s, eq(s.id, t.sessionId))
        .where(
          and(
            eq(t.id, input.taskId),
            eq(a.id, input.attemptId),
            eq(t.status, "running"),
            eq(a.status, "running"),
            eq(i.status, "processing"),
            sql`${i.leaseOwner} is not null and ${i.leaseOwner} <> '' and ${i.leaseExpiresAt} > ${new Date().toISOString()}`,
          ),
        )
        .limit(1);
      if (
        !target ||
        target.task.tagId !== incoming.tagId ||
        target.session.sessionKey !== incoming.sessionKey ||
        !sameInboundAudience(incoming, target.inbound)
      )
        return undefined;
      const [follower] = yield tx
        .select()
        .from(t)
        .where(and(eq(t.inboundEventId, incoming.id), eq(t.status, "pending")))
        .limit(1);
      if (
        !follower ||
        follower.tagId !== target.task.tagId ||
        follower.sessionId !== target.task.sessionId
      )
        return undefined;
      const at = new Date().toISOString();
      const [created] = yield tx
        .insert(c)
        .values({
          inboundEventId: incoming.id,
          taskId: target.task.id,
          attemptId: target.attempt.id,
          command: record(input.command, "Control command"),
          workerHostId: input.workerHostId ?? null,
          workerId: input.workerId ?? null,
          status: "dispatching",
          detail: null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      return { created: true, delivery: inboundControlFromRow(created) };
    });
  }
  async finishInboundControlDelivery(
    input: Parameters<SessionInputStore["finishInboundControlDelivery"]>[0],
  ): Promise<InboundControlDelivery> {
    if (!["accepted", "rejected", "unknown"].includes(input.status))
      throw new Error("Invalid control delivery status");
    const self = this;
    return this.sessionInputTransaction(function* (tx) {
      const c = self.#tables.inboundControlDeliveries,
        i = self.#tables.durableInboundEvents,
        t = self.#tables.tasks;
      const at = new Date().toISOString();
      const [updated] = yield tx
        .update(c)
        .set({ status: input.status, detail: input.detail ?? null, updatedAt: at })
        .where(and(eq(c.inboundEventId, input.inboundEventId), eq(c.status, "dispatching")))
        .returning();
      if (!updated) {
        const [existing] = yield tx
          .select()
          .from(c)
          .where(eq(c.inboundEventId, input.inboundEventId))
          .limit(1);
        // A withdrawal recorded before the acknowledgement already settled the delivery.
        if (existing?.status === "withdrawn") return inboundControlFromRow(existing);
        if (existing?.status === "unknown") {
          const o = self.#tables.outboundReplies;
          const [notice] = yield tx
            .select({ id: o.id })
            .from(o)
            .where(
              and(
                eq(o.inboundEventId, input.inboundEventId),
                eq(o.deliveryKey, "session-input-unresolved"),
              ),
            )
            .limit(1);
          // Recovery already owns the outcome; a late acknowledgement cannot retract its notice.
          if (notice) return inboundControlFromRow(existing);
        }
        if (!existing || existing.status !== input.status)
          throw new Error("Control delivery cannot change terminal outcome");
        return inboundControlFromRow(existing);
      }
      if (input.status !== "rejected") {
        const status = input.status === "accepted" ? "completed" : "failed";
        const responseText = `Message accepted by active Task ${updated.taskId}. Its outcome is reported by that execution.`;
        yield tx
          .update(i)
          .set({
            status,
            sessionBlocked: input.status === "unknown",
            completedAt: status === "completed" ? at : null,
            failedAt: status === "failed" ? at : null,
            lastError: status === "failed" ? "Control delivery outcome unknown" : null,
            updatedAt: at,
          })
          .where(eq(i.id, input.inboundEventId))
          .returning();
        yield tx
          .update(t)
          .set({
            status,
            endedAt: at,
            ...(input.status === "accepted"
              ? {
                  responseText,
                  result: {
                    summary: responseText,
                    decisions: [],
                    changes: [],
                    unresolved: [],
                    findings: [],
                    references: [],
                    artifacts: [],
                  },
                }
              : {}),
            outcome: {
              reason: `input-${input.status}`,
              targetTaskId: updated.taskId,
              targetAttemptId: updated.attemptId,
            },
            updatedAt: at,
          })
          .where(and(eq(t.inboundEventId, input.inboundEventId), eq(t.status, "pending")))
          .returning();
      }
      return inboundControlFromRow(updated);
    });
  }
  async enqueueUnresolvedSessionInputReplies(
    input: Parameters<SessionInputStore["enqueueUnresolvedSessionInputReplies"]>[0],
  ): Promise<void> {
    const c = this.#tables.inboundControlDeliveries,
      a = this.#tables.taskAttempts,
      o = this.#tables.outboundReplies;
    // Target completion alone does not end the acknowledgement wait.
    const ackExpiredAt = new Date(
      Date.parse(input.now) - SESSION_INPUT_ACK_TIMEOUT_MS,
    ).toISOString();
    const unresolved = or(
      eq(c.status, "unknown"),
      and(eq(c.status, "dispatching"), lte(c.createdAt, ackExpiredAt)),
    );
    const candidates = await this.#db
      .select({ inboundEventId: c.inboundEventId })
      .from(c)
      .innerJoin(a, and(eq(a.id, c.attemptId), eq(a.taskId, c.taskId)))
      .where(
        and(
          unresolved,
          inArray(a.status, ["completed", "failed", "cancelled"]),
          sql`not exists (select 1 from "OutboundReply" r where r."inboundEventId" = ${c.inboundEventId} and r."deliveryKey" = 'session-input-unresolved')`,
        ),
      )
      .limit(100);
    const self = this;
    for (const candidate of candidates) {
      await this.sessionInputTransaction(function* (tx) {
        // Serialize with withdrawal. Whichever wins owns recovery: automatic retry or notice.
        const [delivery] = yield tx
          .update(c)
          .set({ updatedAt: sql`${c.updatedAt}` })
          .where(and(eq(c.inboundEventId, candidate.inboundEventId), unresolved))
          .returning();
        if (!delivery) return;
        const i = self.#tables.durableInboundEvents;
        const [work] = yield tx.select().from(i).where(eq(i.id, delivery.inboundEventId)).limit(1);
        if (!work) return;
        if (delivery.status === "dispatching") {
          yield tx
            .update(c)
            .set({ status: "unknown", updatedAt: input.now })
            .where(eq(c.inboundEventId, delivery.inboundEventId))
            .returning();
          yield tx
            .update(i)
            .set({
              status: "failed",
              sessionBlocked: true,
              completedAt: null,
              failedAt: input.now,
              lastError: "Control delivery outcome unknown",
              updatedAt: input.now,
            })
            .where(eq(i.id, delivery.inboundEventId))
            .returning();
          const t = self.#tables.tasks;
          yield tx
            .update(t)
            .set({
              status: "failed",
              endedAt: input.now,
              outcome: {
                reason: "input-unknown",
                targetTaskId: delivery.taskId,
                targetAttemptId: delivery.attemptId,
              },
              updatedAt: input.now,
            })
            .where(and(eq(t.inboundEventId, delivery.inboundEventId), eq(t.status, "pending")))
            .returning();
        }
        yield tx
          .insert(o)
          .values(
            outboundValues(work, {
              workerId: "control-plane",
              responseText: input.text,
              completedAt: input.now,
              presentation: "error",
              deliveryKey: "session-input-unresolved",
            }),
          )
          .onConflictDoNothing({ target: [o.inboundEventId, o.deliveryKey] })
          .returning();
      });
    }
  }
  async withdrawInboundControlDelivery(
    input: Parameters<SessionInputStore["withdrawInboundControlDelivery"]>[0],
  ): ReturnType<SessionInputStore["withdrawInboundControlDelivery"]> {
    const inboundEventId = required(input.inboundEventId, "Inbound event id");
    const taskId = required(input.taskId, "Task id");
    const attemptId = required(input.attemptId, "Task attempt id");
    const self = this;
    return this.sessionInputTransaction(function* (tx) {
      const c = self.#tables.inboundControlDeliveries,
        i = self.#tables.durableInboundEvents,
        t = self.#tables.tasks;
      // Lock the row first, so a concurrent acknowledgement or withdrawal waits for this one and
      // then finds it withdrawn.
      const [current] = yield tx
        .update(c)
        .set({ updatedAt: sql`${c.updatedAt}` })
        .where(
          and(
            eq(c.inboundEventId, inboundEventId),
            eq(c.taskId, taskId),
            eq(c.attemptId, attemptId),
          ),
        )
        .returning();
      if (
        current?.status !== "accepted" &&
        current?.status !== "unknown" &&
        current?.status !== "dispatching"
      )
        return undefined;
      // Once recovery belongs to the operator, late replay must not also retry the input.
      const o = self.#tables.outboundReplies;
      const [notice] = yield tx
        .select({ id: o.id })
        .from(o)
        .where(
          and(eq(o.inboundEventId, inboundEventId), eq(o.deliveryKey, "session-input-unresolved")),
        )
        .limit(1);
      if (notice) return undefined;
      const at = new Date().toISOString();
      const [updated] = yield tx
        .update(c)
        .set({ status: "withdrawn", updatedAt: at })
        .where(and(eq(c.inboundEventId, inboundEventId), eq(c.status, current.status)))
        .returning();
      if (!updated) return undefined;
      const [follower] = yield tx
        .select({ id: t.id })
        .from(t)
        .where(eq(t.inboundEventId, inboundEventId))
        .limit(1);
      // A dispatching delivery settled nothing yet: its follower is still pending.
      if (current.status === "accepted" || current.status === "unknown") {
        // Withdrawal resolves an uncertain receipt: the model did not consume the input.
        // Undo the acknowledgement settlement so its follower can run on the next activation.
        const settledStatus = current.status === "accepted" ? "completed" : "failed";
        yield tx
          .update(i)
          .set({
            status: "pending",
            sessionBlocked: false,
            completedAt: null,
            failedAt: null,
            lastError: null,
            updatedAt: at,
          })
          .where(and(eq(i.id, inboundEventId), eq(i.status, settledStatus)))
          .returning();
        yield tx
          .update(t)
          .set({
            status: "pending",
            endedAt: null,
            responseText: null,
            result: null,
            outcome: null,
            updatedAt: at,
          })
          .where(
            and(
              eq(t.inboundEventId, inboundEventId),
              eq(t.status, settledStatus),
              sql`${t.startedAt} is null`,
            ),
          )
          .returning();
      }
      return {
        delivery: inboundControlFromRow(updated),
        ...(follower ? { followerTaskId: follower.id } : {}),
      };
    });
  }
  async findInboundEventById(id: string): Promise<DurableInboundEvent | undefined> {
    const t = this.#tables.durableInboundEvents;
    return this.#mappedFirst(t, eq(t.id, required(id, "Inbound event id")), inboundFromRow);
  }
  async admitInboundEvent(input: AdmitInboundEventInput): Promise<AdmitInboundEventResult> {
    const t = this.#tables.durableInboundEvents;
    const now = new Date().toISOString();
    const maxAttempts = input.maxAttempts ?? 3;
    if (maxAttempts < 1 || !Number.isSafeInteger(maxAttempts))
      throw new Error("maxAttempts must be a positive integer");
    try {
      const row = await this.#insert(t, {
        id: randomUUID(),
        surfaceAccountId: required(input.surfaceAccountId, "Surface account id"),
        tagRouteId: required(input.tagRouteId, "Tag route id"),
        tagId: required(input.tagId, "Tag id"),
        execution: parseTaskExecutionRequirements(input.execution ?? {}),
        authorization: input.authorization,
        contextPlan: input.contextPlan,
        ...(this.provider === "sqlite"
          ? {
              admissionOrder: sql`(select coalesce(max("admissionOrder"),0)+1 from "DurableInboundEvent")`,
            }
          : {}),
        sessionKey: required(input.event.sessionKey, "Session key"),
        deliveryId: input.event.eventId,
        logicalEventId: input.event.logicalEventId,
        event: input.event,
        status: "pending",
        attemptCount: 0,
        maxAttempts,
        availableAt: input.availableAt ?? now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: null,
        failedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return { status: "admitted", work: inboundFromRow(row) };
    } catch (error) {
      if (!isUnique(error)) throw error;
      const duplicate = await this.#first(
        t,
        and(
          eq(t.surfaceAccountId, input.surfaceAccountId),
          or(
            eq(t.deliveryId, input.event.eventId),
            eq(t.logicalEventId, input.event.logicalEventId),
          ),
        ),
      );
      if (!duplicate) throw error;
      return { status: "duplicate", work: inboundFromRow(duplicate) };
    }
  }

  async claimNextInboundEvent(input: ClaimDueWorkInput): Promise<DurableInboundEvent | undefined> {
    const [candidate] = await this.listDueInboundEvents({ now: input.now, limit: 1 });
    if (candidate === undefined) return undefined;
    return this.claimDueInboundEvent({ ...input, inboundEventId: candidate.id });
  }

  async listDueInboundEvents(input: ListDueWorkInput): Promise<readonly DurableInboundEvent[]> {
    required(input.now, "Current time");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1)
      throw new Error("limit must be a positive integer");
    const t = this.#tables.durableInboundEvents;
    const rows = await this.#db
      .select()
      .from(t)
      .where(
        and(
          inboundIsDue(t, input.now),
          input.after === undefined
            ? undefined
            : or(
                gt(t.availableAt, input.after.availableAt),
                and(
                  eq(t.availableAt, input.after.availableAt),
                  gt(t.admissionOrder, input.after.admissionOrder),
                ),
              ),
        ),
      )
      .orderBy(asc(t.availableAt), asc(t.admissionOrder))
      .limit(input.limit);
    return rows.map(inboundFromRow);
  }

  async claimDueInboundEvent(
    input: ClaimDueInboundEventInput,
  ): Promise<DurableInboundEvent | undefined> {
    validateLease(input);
    const self = this;
    try {
      return await runDialectTransaction(this.#db, this.provider, function* (tx) {
        const i = self.#tables.durableInboundEvents,
          t = self.#tables.tasks;
        const [work] = yield tx
          .update(i)
          .set({ updatedAt: sql`${i.updatedAt}` })
          .where(
            and(
              eq(i.id, required(input.inboundEventId, "Inbound event id")),
              inboundIsDue(i, input.now),
            ),
          )
          .returning();
        if (!work) return undefined;
        const [task] = yield tx
          .update(t)
          .set({ updatedAt: sql`${t.updatedAt}` })
          .where(eq(t.inboundEventId, work.id))
          .returning();
        const prepared = task ? yield* pendingSurfaceIntent(tx, self.#tables, task.id) : undefined;
        if (input.recoveryOnly && !prepared) return undefined;
        const [claimed] = yield tx
          .update(i)
          .set({
            status: "processing",
            attemptCount: work.attemptCount + (prepared ? 0 : 1),
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: input.now,
          })
          .where(eq(i.id, work.id))
          .returning();
        return inboundFromRow(claimed);
      });
    } catch (error) {
      if (isUnique(error)) return undefined;
      throw error;
    }
  }

  async renewInboundEventLease(input: RenewInboundEventLeaseInput): Promise<boolean> {
    validateLease(input);
    const t = this.#tables.durableInboundEvents;
    const rows = await this.#db
      .update(t)
      .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now })
      .where(
        and(
          eq(t.id, required(input.inboundEventId, "Inbound event id")),
          eq(t.status, "processing"),
          eq(t.leaseOwner, required(input.leaseOwner, "Lease owner")),
        ),
      )
      .returning({ id: t.id });
    return rows.length === 1;
  }

  async completeInboundEvent(input: CompleteInboundEventInput): Promise<OutboundReply> {
    if (this.provider === "sqlite") {
      return this.#db.transaction((tx: DynamicDatabase) =>
        completeInboundSynchronously(tx, this.#tables, input),
      );
    }
    return this.#db.transaction(async (tx: DynamicDatabase) => {
      const t = this.#tables.durableInboundEvents,
        o = this.#tables.outboundReplies;
      const work = (
        await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.id, input.inboundEventId),
              eq(t.status, "processing"),
              eq(t.leaseOwner, input.leaseOwner),
            ),
          )
          .limit(1)
      )[0];
      if (!work) throw staleLeaseError("inbound event", input.inboundEventId);
      const completed = await tx
        .update(t)
        .set({
          status: "completed",
          completedAt: input.completedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          failedAt: null,
          updatedAt: input.completedAt,
        })
        .where(
          and(
            eq(t.id, input.inboundEventId),
            eq(t.status, "processing"),
            eq(t.leaseOwner, input.leaseOwner),
          ),
        )
        .returning({ id: t.id });
      if (completed.length !== 1) throw staleLeaseError("inbound event", input.inboundEventId);
      const row = (await tx.insert(o).values(outboundValues(work, input)).returning())[0];
      return outboundFromRow(row, work.event);
    });
  }

  async prepareSurfaceAttempt(input: SettleSurfaceAttemptInput): Promise<void> {
    const outcome = normalizeSurfaceOutcome(input);

    const payload = { version: 1, ...outcome };
    const self = this;
    // General journal appenders can allocate a sequence concurrently. Retry the
    // entire transaction after a collision so PostgreSQL never reuses an aborted tx.
    for (let retry = 0; retry < 5; retry += 1) {
      try {
        await runDialectTransaction(this.#db, this.provider, function* (tx) {
          const { work, task, attempt } = yield* lockSurfaceAttempt(tx, self.#tables, input);
          yield* validateSubmittedArtifacts(tx, self.#tables, task.id, attempt.attemptNumber, {
            taskResult: outcome.result,
          });
          const pending = yield* pendingSurfaceIntent(tx, self.#tables, task.id);
          if (pending?.type === "surface.failure-prepared")
            throw new Error("Surface Task has a prepared failure");
          const events = self.#tables.taskEvents;
          const [existing] = yield tx
            .select()
            .from(events)
            .where(
              and(
                eq(events.taskId, task.id),
                eq(events.attemptId, attempt.id),
                eq(events.type, "surface.settlement-prepared"),
              ),
            )
            .orderBy(desc(events.sequence))
            .limit(1);
          if (existing) {
            if (!isDeepStrictEqual(existing.payload, payload))
              throw new Error("Surface Attempt already has a different prepared outcome");
            return;
          }
          if (
            work.status !== "processing" ||
            work.leaseOwner !== input.leaseOwner ||
            !work.leaseExpiresAt ||
            Date.parse(work.leaseExpiresAt) <= Date.parse(input.now) ||
            task.status !== "running" ||
            attempt.status !== "running"
          )
            throw staleLeaseError("surface attempt", input.attemptId);
          const nextSequence = yield* nextTaskEventSequence(tx, events, task.id);
          yield tx
            .insert(events)
            .values({
              id: randomUUID(),
              taskId: task.id,
              attemptId: attempt.id,
              sequence: nextSequence,
              type: "surface.settlement-prepared",
              payload,
              createdAt: input.now,
            })
            .returning();
        });
        return;
      } catch (error) {
        if (!isUnique(error) || retry === 4) throw error;
      }
    }
  }

  async settleSurfaceAttempt(input: SettleSurfaceAttemptInput): Promise<OutboundReply> {
    const preparedOutcome = normalizeSurfaceOutcome(input);
    const { outcome, sessionBlockReason, result } = preparedOutcome;
    const self = this;
    return runDialectTransaction(this.#db, this.provider, function* (tx) {
      const i = self.#tables.durableInboundEvents,
        t = self.#tables.tasks,
        a = self.#tables.taskAttempts,
        o = self.#tables.outboundReplies;
      const { work, task, attempt } = yield* lockSurfaceAttempt(tx, self.#tables, input);
      const pending = yield* pendingSurfaceIntent(tx, self.#tables, task.id);
      if (pending?.type === "surface.failure-prepared")
        throw new Error("Surface Task has a prepared failure");
      const events = self.#tables.taskEvents;
      const [prepared] = yield tx
        .select()
        .from(events)
        .where(
          and(
            eq(events.taskId, task.id),
            eq(events.attemptId, attempt.id),
            eq(events.type, "surface.settlement-prepared"),
          ),
        )
        .orderBy(desc(events.sequence))
        .limit(1);
      if (prepared && !isDeepStrictEqual(prepared.payload, { version: 1, ...preparedOutcome }))
        throw new Error("Surface settlement conflicts with the prepared outcome");

      if (work.status === "completed") {
        const [reply] = yield tx
          .select()
          .from(o)
          .where(and(eq(o.inboundEventId, work.id), eq(o.deliveryKey, "final")))
          .limit(1);
        if (
          !isDeepStrictEqual(task.result ?? undefined, result) ||
          task.responseText !== input.responseText ||
          task.status !== input.status ||
          attempt.status !== input.status ||
          task.endedAt !== input.completedAt ||
          attempt.endedAt !== input.completedAt ||
          work.completedAt !== input.completedAt ||
          // The Session may since have been released once cleanup was confirmed; the turn keeps
          // its reason either way.
          (sessionBlockReason !== undefined && work.lastError !== sessionBlockReason) ||
          !isDeepStrictEqual(task.outcome, outcome) ||
          !isDeepStrictEqual(attempt.outcome, outcome) ||
          !reply ||
          reply.text !== input.responseText ||
          reply.workerId !== input.workerId ||
          reply.presentation !== "final-result" ||
          reply.createdAt !== input.completedAt
        )
          throw new Error("Surface settlement conflicts with the committed outcome");
        return outboundFromRow(reply, work.event);
      }
      const matchesTerminal = (row: { status: string; endedAt: string | null; outcome: unknown }) =>
        row.status === input.status &&
        row.endedAt === input.completedAt &&
        isDeepStrictEqual(row.outcome, outcome);
      if (
        work.status !== "processing" ||
        work.leaseOwner !== input.leaseOwner ||
        !work.leaseExpiresAt ||
        Date.parse(work.leaseExpiresAt) <= Date.parse(input.now) ||
        (task.status !== "running" && !matchesTerminal(task)) ||
        (attempt.status !== "running" && !matchesTerminal(attempt))
      )
        throw staleLeaseError("surface attempt", input.attemptId);
      yield* validateSubmittedArtifacts(tx, self.#tables, task.id, attempt.attemptNumber, {
        taskResult: result,
      });
      const changes = {
        status: input.status,
        outcome,
        endedAt: input.completedAt,
        updatedAt: input.completedAt,
      };
      if (attempt.status === "running") {
        const closedAttempts = yield tx
          .update(a)
          .set(changes)
          .where(and(eq(a.id, input.attemptId), eq(a.status, "running")))
          .returning();
        if (closedAttempts.length !== 1) throw staleLeaseError("surface attempt", input.attemptId);
      }
      yield tx
        .update(t)
        .set({ ...changes, result: result ?? null, responseText: input.responseText })
        .where(eq(t.id, task.id))
        .returning();
      yield tx
        .update(i)
        .set({
          status: "completed",
          completedAt: input.completedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(sessionBlockReason === undefined ? {} : { sessionBlocked: true }),
          lastError: sessionBlockReason ?? null,
          failedAt: null,
          updatedAt: input.completedAt,
        })
        .where(eq(i.id, work.id))
        .returning();
      const [reply] = yield tx.insert(o).values(outboundValues(work, input)).returning();
      return outboundFromRow(reply, work.event);
    });
  }

  async enqueueOutboundReply(input: EnqueueOutboundReplyInput): Promise<OutboundReply> {
    const inbound = this.#tables.durableInboundEvents;
    const outbound = this.#tables.outboundReplies;
    const work = await this.#first(
      inbound,
      eq(inbound.id, required(input.inboundEventId, "Inbound event id")),
    );
    if (work === undefined) {
      throw new Error(`Inbound event ${JSON.stringify(input.inboundEventId)} does not exist`);
    }
    const values = outboundValues(work, {
      workerId: input.workerId,
      responseText: input.text,
      completedAt: input.createdAt,
      presentation: input.presentation,
      deliveryKey: input.deliveryKey,
    });
    const insert = this.#db.insert(outbound).values(values);
    const rows =
      input.presentation === "status" && !input.deliveryKey.startsWith("operator-message:")
        ? await insert
            .onConflictDoUpdate({
              target: [outbound.inboundEventId, outbound.deliveryKey],
              set: {
                workerId: input.workerId,
                presentation: input.presentation,
                text: input.text,
                revision: sql`${outbound.revision} + 1`,
                status: "pending",
                attemptCount: 0,
                availableAt: input.createdAt,
                leaseOwner: null,
                leaseExpiresAt: null,
                lastError: null,
                deliveredAt: null,
                failedAt: null,
                updatedAt: input.createdAt,
              },
            })
            .returning()
        : await insert
            .onConflictDoNothing({ target: [outbound.inboundEventId, outbound.deliveryKey] })
            .returning();
    if (rows[0] !== undefined) return outboundFromRow(rows[0], work.event);
    const existing = await this.#first(
      outbound,
      and(
        eq(outbound.inboundEventId, input.inboundEventId),
        eq(outbound.deliveryKey, required(input.deliveryKey, "Outbound delivery key")),
      ),
    );
    if (existing === undefined) throw new Error("Outbound reply was not persisted");
    return outboundFromRow(existing, work.event);
  }

  async prepareSurfaceFailure(input: SettleSurfaceFailureInput): Promise<void> {
    await this.changeSurfaceFailure(input, false);
  }

  async settleSurfaceFailure(input: SettleSurfaceFailureInput): Promise<"pending" | "failed"> {
    return this.changeSurfaceFailure(input, true);
  }

  private async changeSurfaceFailure(
    input: SettleSurfaceFailureInput,
    settle: boolean,
  ): Promise<"pending" | "failed"> {
    const payload = { version: 1, ...normalizeSurfaceFailure(input) };
    const self = this;
    for (let retry = 0; ; retry += 1) {
      try {
        return await runDialectTransaction(this.#db, this.provider, function* (tx) {
          const { work, task } = yield* lockSurfaceTask(tx, self.#tables, input);
          const a = self.#tables.taskAttempts,
            e = self.#tables.taskEvents;
          const status =
            !payload.retryable ||
            payload.sessionBlockReason ||
            payload.claimAttemptCount >= work.maxAttempts
              ? "failed"
              : "pending";
          const journal = yield tx
            .select()
            .from(e)
            .where(
              and(
                eq(e.taskId, task.id),
                inArray(e.type, [
                  "surface.failure-prepared",
                  "surface.failure-settled",
                  "surface.settlement-prepared",
                ]),
              ),
            )
            .orderBy(desc(e.sequence));
          const consumed = journal.find(
            (event: any) =>
              event.type === "surface.failure-settled" && isDeepStrictEqual(event.payload, payload),
          );
          if (consumed) return status;
          const prepared = journal.find(
            (event: any) =>
              event.type === "surface.failure-prepared" &&
              event.payload.claimAttemptCount === payload.claimAttemptCount,
          );
          if (prepared && !isDeepStrictEqual(prepared.payload, payload))
            throw new Error("Surface failure conflicts with the prepared outcome");
          const pending = pendingIntentFromEvents(journal);
          if (pending && !isDeepStrictEqual(pending.payload, payload))
            throw new Error("Surface Task already has a different prepared outcome");
          const attempt = yield* lockLatestTaskAttempt(tx, self.#tables, task.id);
          if (
            input.attemptId
              ? attempt?.id !== input.attemptId || attempt.status !== "running"
              : attempt?.status === "running"
          )
            throw new Error("Surface failure Attempt identity mismatch");
          if (
            work.status !== "processing" ||
            work.leaseOwner !== input.leaseOwner ||
            !work.leaseExpiresAt ||
            Date.parse(work.leaseExpiresAt) <= Date.parse(input.now) ||
            work.attemptCount !== payload.claimAttemptCount ||
            !["pending", "running"].includes(task.status)
          )
            throw staleLeaseError("surface failure", task.id);
          if (!settle) {
            if (!prepared)
              yield* appendSurfaceIntent(
                tx,
                self.#tables,
                task.id,
                input.attemptId,
                "surface.failure-prepared",
                payload,
                input.now,
              );
            return status;
          }
          if (!prepared) throw new Error("Surface failure must be prepared before settlement");
          // The failure source the Worker reported travels with the error onto both outcomes,
          // so operator views and the coordination inbox can explain the failure.
          const failureOutcome = {
            error: payload.error,
            ...(payload.failureKind === undefined ? {} : { failureKind: payload.failureKind }),
          };
          if (input.attemptId)
            yield tx
              .update(a)
              .set({
                status: "failed",
                outcome: failureOutcome,
                endedAt: payload.failedAt,
                updatedAt: payload.failedAt,
              })
              .where(eq(a.id, input.attemptId))
              .returning();
          const t = self.#tables.tasks,
            i = self.#tables.durableInboundEvents;
          yield tx
            .update(t)
            .set({
              status: status === "failed" ? "failed" : "pending",
              ...(status === "failed"
                ? { outcome: failureOutcome, endedAt: payload.failedAt }
                : {}),
              updatedAt: payload.failedAt,
            })
            .where(eq(t.id, task.id))
            .returning();
          yield tx
            .update(i)
            .set({
              status,
              availableAt: payload.retryAt,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: payload.sessionBlockReason ?? payload.error,
              failedAt: status === "failed" ? payload.failedAt : null,
              ...(payload.sessionBlockReason ? { sessionBlocked: true } : {}),
              updatedAt: payload.failedAt,
            })
            .where(eq(i.id, work.id))
            .returning();
          if (status === "failed")
            yield tx
              .insert(self.#tables.outboundReplies)
              .values(
                outboundValues(work, {
                  workerId: payload.workerId,
                  responseText: payload.responseText,
                  completedAt: payload.failedAt,
                  presentation: "error",
                  deliveryKey: "final",
                }),
              )
              .returning();
          yield* appendSurfaceIntent(
            tx,
            self.#tables,
            task.id,
            input.attemptId,
            "surface.failure-settled",
            payload,
            input.now,
          );
          return status;
        });
      } catch (error) {
        if (!isUnique(error) || retry === 4) throw error;
      }
    }
  }

  async retryInboundEvent(input: RetryInboundEventInput): Promise<"failed" | "pending"> {
    const t = this.#tables.durableInboundEvents;
    const work = await this.#first(
      t,
      and(
        eq(t.id, input.inboundEventId),
        eq(t.status, "processing"),
        eq(t.leaseOwner, input.leaseOwner),
      ),
    );
    if (!work) throw staleLeaseError("inbound event", input.inboundEventId);
    const status =
      input.retryable === false || work.attemptCount >= work.maxAttempts ? "failed" : "pending";
    const rows = await this.#db
      .update(t)
      .set({
        status,
        availableAt: input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: input.error,
        failedAt: status === "failed" ? input.failedAt : null,
        updatedAt: input.failedAt,
      })
      .where(
        and(
          eq(t.id, input.inboundEventId),
          eq(t.status, "processing"),
          eq(t.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: t.id });
    if (rows.length !== 1) throw staleLeaseError("inbound event", input.inboundEventId);
    return status;
  }

  async claimNextOutboundReply(input: ClaimDueWorkInput): Promise<OutboundReply | undefined> {
    validateLease(input);
    const t = this.#tables.outboundReplies;
    const candidate = (
      await this.#db
        .select()
        .from(t)
        .where(
          or(
            and(
              eq(t.status, "pending"),
              lte(t.availableAt, input.now),
              lt(t.attemptCount, t.maxAttempts),
            ),
            and(eq(t.status, "delivering"), lte(t.leaseExpiresAt, input.now)),
          ),
        )
        .orderBy(asc(t.availableAt), asc(t.createdAt))
        .limit(1)
    )[0];
    if (!candidate) return undefined;
    const rows = await this.#db
      .update(t)
      .set({
        status: "delivering",
        attemptCount: sql`${t.attemptCount} + 1`,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(t.id, candidate.id),
          eq(t.attemptCount, candidate.attemptCount),
          or(
            and(eq(t.status, "pending"), lte(t.availableAt, input.now)),
            and(eq(t.status, "delivering"), lte(t.leaseExpiresAt, input.now)),
          ),
        ),
      )
      .returning();
    if (!rows[0]) return undefined;
    const inbound = await this.#first(
      this.#tables.durableInboundEvents,
      eq(this.#tables.durableInboundEvents.id, rows[0].inboundEventId),
    );
    if (!inbound) throw new Error(`Outbound reply ${rows[0].id} is missing its inbound event`);
    return outboundFromRow(rows[0], inbound.event);
  }

  async findOutboundReply(
    inboundEventId: string,
    deliveryKey: string,
  ): Promise<OutboundReply | undefined> {
    const outbound = this.#tables.outboundReplies;
    const row = await this.#first(
      outbound,
      and(
        eq(outbound.inboundEventId, required(inboundEventId, "Inbound event id")),
        eq(outbound.deliveryKey, required(deliveryKey, "Outbound delivery key")),
      ),
    );
    if (row === undefined) return undefined;
    const inbound = await this.#first(
      this.#tables.durableInboundEvents,
      eq(this.#tables.durableInboundEvents.id, row.inboundEventId),
    );
    if (inbound === undefined) {
      throw new Error(`Outbound reply ${row.id} is missing its inbound event`);
    }
    return outboundFromRow(row, inbound.event);
  }

  async completeOutboundReply(input: CompleteOutboundReplyInput): Promise<boolean> {
    const t = this.#tables.outboundReplies;
    const rows = await this.#db
      .update(t)
      .set({
        status: "delivered",
        deliveredAt: input.deliveredAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        externalMessageId: input.externalMessageId ?? null,
        failedAt: null,
        updatedAt: input.deliveredAt,
      })
      .where(
        and(
          eq(t.id, input.outboundReplyId),
          eq(t.status, "delivering"),
          eq(t.leaseOwner, input.leaseOwner),
          eq(t.revision, input.revision),
        ),
      )
      .returning({ id: t.id });
    return rows.length === 1;
  }

  async deferOutboundReply(input: DeferOutboundReplyInput): Promise<void> {
    const t = this.#tables.outboundReplies;
    const rows = await this.#db
      .update(t)
      .set({
        status: "pending",
        attemptCount: sql`${t.attemptCount} - 1`,
        availableAt: input.availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.availableAt,
      })
      .where(
        and(
          eq(t.id, input.outboundReplyId),
          eq(t.status, "delivering"),
          eq(t.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: t.id });
    if (rows.length !== 1) throw staleLeaseError("outbound reply", input.outboundReplyId);
  }

  async retryOutboundReply(input: RetryOutboundReplyInput): Promise<"failed" | "pending"> {
    const t = this.#tables.outboundReplies;
    const reply = await this.#first(
      t,
      and(
        eq(t.id, input.outboundReplyId),
        eq(t.status, "delivering"),
        eq(t.leaseOwner, input.leaseOwner),
      ),
    );
    if (!reply) throw staleLeaseError("outbound reply", input.outboundReplyId);
    const status = reply.attemptCount >= reply.maxAttempts ? "failed" : "pending";
    const rows = await this.#db
      .update(t)
      .set({
        status,
        availableAt: input.retryAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: input.error,
        failedAt: status === "failed" ? input.failedAt : null,
        updatedAt: input.failedAt,
      })
      .where(
        and(
          eq(t.id, input.outboundReplyId),
          eq(t.status, "delivering"),
          eq(t.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: t.id });
    if (rows.length !== 1) throw staleLeaseError("outbound reply", input.outboundReplyId);
    return status;
  }

  async #insert(table: DynamicTable, values: Record<string, unknown>): Promise<any> {
    const rows = await this.#db.insert(table).values(values).returning();
    if (!rows[0]) throw new Error("Store insert did not return a row");
    return rows[0];
  }
  async #first(table: DynamicTable, condition: unknown): Promise<any | undefined> {
    return (await this.#db.select().from(table).where(condition).limit(1))[0];
  }
  async #mappedFirst<T>(
    table: DynamicTable,
    condition: unknown,
    map: (row: any) => T,
  ): Promise<T | undefined> {
    const row = await this.#first(table, condition);
    return row === undefined ? undefined : map(row);
  }
  async #delete(table: DynamicTable, condition: unknown): Promise<boolean> {
    return (await this.#db.delete(table).where(condition).returning()).length === 1;
  }
  async #artifactReferences(artifactId: string): Promise<readonly TaskReferenceRow[]> {
    const t = this.#tables.taskReferences;
    return this.#db
      .select()
      .from(t)
      .where(eq(t.artifactId, artifactId))
      .orderBy(asc(t.createdAt), asc(t.id));
  }
}

interface TaskReferenceRow {
  provider: string;
  surfaceAccountId: string | null;
  resourceType: string;
  resourceId: string | null;
  reference: string;
  relationship: string;
}

function tagFromRow(row: any): Tag {
  if (row.status !== "active" && row.status !== "retired")
    throw new Error(`Unsupported Tag status: ${row.status}`);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ...(row.retiredAt ? { retiredAt: row.retiredAt } : {}),
    runsOn: storedLabels(row.runsOn),
    ...storedExecution(row.execution),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function tagWorkerHostBindingFromRow(row: any): TagWorkerHostBinding {
  return {
    tagId: row.tagId,
    workerHostId: row.workerHostId,
    createdAt: row.createdAt,
  };
}
function tagRouteFromRow(row: any): TagRoute {
  return {
    id: row.id,
    tagId: row.tagId,
    surfaceAccountId: row.surfaceAccountId,
    scope: row.scope,
    enabled: row.enabled,
    workspaces: Array.isArray(row.workspaces)
      ? row.workspaces.filter((name: unknown): name is string => typeof name === "string")
      : [],
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function tagPermissionSetFromRow(row: any): TagPermissionSet {
  const approvers = Array.isArray(row.approvers) ? (row.approvers as string[]) : [];
  return {
    id: row.id,
    name: row.name,
    ...(approvers.length === 0 ? {} : { approvers: [...approvers] }),
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function tagPermissionFromRow(row: any): TagPermission {
  const common = {
    id: row.id,
    permissionSetId: row.permissionSetId,
    action: row.action,
    ...(row.approval === "required" ? { approval: "required" as const } : {}),
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
  };
  if (row.target === "runtime") return { ...common, target: "runtime" };
  if (row.target === "mcp")
    return {
      ...common,
      target: "mcp",
      ...(typeof row.scope === "string" && row.scope !== "" ? { resource: row.scope } : {}),
    };
  if (row.target !== "surface" || typeof row.surfaceAccountId !== "string") {
    throw new Error(`Stored Tag permission ${row.id} has an invalid target`);
  }
  return {
    ...common,
    target: "surface",
    surfaceAccountId: row.surfaceAccountId,
    scope: row.scope,
    ...(row.reference === null ? {} : { reference: row.reference }),
  };
}
function tagPermissionActivationFromRow(row: any): TagPermissionActivation {
  return {
    id: row.id,
    permissionSetId: row.permissionSetId,
    tagRouteId: row.tagRouteId,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
  };
}
function tagContextSetFromRow(row: any): TagContextSet {
  return {
    id: row.id,
    name: row.name,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function tagContextItemFromRow(row: any): TagContextItem {
  const type = parseContextType(row.type);
  const version = parseContextTypeVersion(row.version);
  if (typeof row.required !== "boolean") throw new Error(`Context entry ${row.id} is invalid`);
  return {
    id: row.id,
    contextSetId: row.contextSetId,
    itemKey: row.itemKey,
    type,
    version,
    required: row.required,
    config: validateContextConfig(type, version, row.config),
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
  };
}
function tagContextActivationFromRow(row: any): TagContextActivation {
  return {
    id: row.id,
    contextSetId: row.contextSetId,
    tagRouteId: row.tagRouteId,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt,
  };
}

function taskFromRow(row: any): Task {
  return {
    id: row.id,
    inboundEventId: row.inboundEventId,
    tagId: row.tagId,
    sessionId: row.sessionId,
    ...(row.objectiveId == null ? {} : { objectiveId: row.objectiveId }),
    execution: parseTaskExecutionRequirements(row.execution),
    actor: record(row.actor, "task actor") as unknown as InboundEventActor,
    trigger: record(row.trigger, "task trigger"),
    ...(row.requestText == null ? {} : { requestText: row.requestText }),
    ...(row.responseText == null ? {} : { responseText: row.responseText }),
    ...(row.result == null ? {} : { result: taskResultFromJson(row.result) }),
    workspacePlan: workspacePlanFromJson(row.workspacePlan),
    sessionHistory: taskHistoryArray(row.sessionHistory, "task session history"),
    authorizationSnapshot: authorizationFromJson(row.authorizationSnapshot),
    contextPlan: contextPlanFromJson(row.contextPlan),
    status: parseTaskStatus(row.status),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.outcome === null ? {} : { outcome: record(row.outcome, "task outcome") }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function taskAttemptFromRow(row: any): TaskAttempt {
  return {
    id: row.id,
    taskId: row.taskId,
    attemptNumber: row.attemptNumber,
    workerProfile: profileFromRow(row),
    workerSnapshot: record(row.workerSnapshot, "task attempt worker snapshot"),
    ...(row.mcpServersDigest == null ? {} : { mcpServersDigest: row.mcpServersDigest }),
    // Validated when recorded; reads do not rehash every object.
    ...(Array.isArray(row.mountManifests)
      ? { mountManifests: row.mountManifests as readonly MountManifest[] }
      : {}),
    ...(Array.isArray(row.mountOutputManifests)
      ? { mountOutputManifests: row.mountOutputManifests as readonly MountOutputManifest[] }
      : {}),
    ...(Array.isArray(row.liveMounts)
      ? { liveMounts: row.liveMounts as readonly LiveMount[] }
      : {}),
    status: parseTaskAttemptStatus(row.status),
    startedAt: row.startedAt,
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.outcome === null ? {} : { outcome: record(row.outcome, "task attempt outcome") }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function taskEventFromRow(row: any): TaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    ...(row.attemptId === null ? {} : { attemptId: row.attemptId }),
    sequence: row.sequence,
    type: row.type,
    ...(row.payload === null ? {} : { payload: record(row.payload, "task event payload") }),
    createdAt: row.createdAt,
  };
}
function artifactFromRow(row: any, references: readonly TaskReferenceRow[]): Artifact {
  const sourceReferences =
    row.sourceReferences === null
      ? undefined
      : recordArray(row.sourceReferences, "artifact source references");
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    location: row.location,
    ...(row.contentHash === null ? {} : { contentHash: row.contentHash }),
    ...(sourceReferences === undefined ? {} : { sourceReferences }),
    ...(row.metadata === null ? {} : { metadata: record(row.metadata, "artifact metadata") }),
    references: references.map(taskReferenceFromRow),
    createdAt: row.createdAt,
  };
}
function taskReferenceFromRow(row: TaskReferenceRow): TaskReference {
  return {
    provider: parseSurfaceProvider(row.provider),
    ...(row.surfaceAccountId === null ? {} : { surfaceAccountId: row.surfaceAccountId }),
    resourceType: parseTaskResourceType(row.resourceType),
    ...(row.resourceId === null ? {} : { resourceId: row.resourceId }),
    reference: row.reference,
    relationship: parseTaskReferenceRelationship(row.relationship),
  };
}
function surfaceAccountFromRow(row: any): SurfaceAccount {
  if (row.status !== "connected" && row.status !== "retired")
    throw new Error(`Unsupported Surface Account status: ${row.status}`);
  return {
    id: row.id,
    provider: parseSurfaceProvider(row.provider),
    externalAccountId: row.externalAccountId,
    displayName: row.displayName,
    authMethod: row.authMethod,
    credentialId: row.credentialId,
    status: row.status,
    configuration: record(row.configuration, "surface configuration"),
    verifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(row.secretReferences === null || row.secretReferences === undefined
      ? {}
      : {
          secretReferences: record(
            row.secretReferences,
            "surface secret references",
          ) as SurfaceAccount["secretReferences"] & object,
        }),
  };
}

function inboundFromRow(row: any): DurableInboundEvent {
  return {
    id: row.id,
    surfaceAccountId: row.surfaceAccountId,
    tagRouteId: row.tagRouteId,
    tagId: row.tagId,
    execution: parseTaskExecutionRequirements(row.execution),
    authorization: authorizationFromJson(
      row.authorization,
    ) as import("@supertag/core").SurfaceTagAuthorizationSnapshot,
    contextPlan: contextPlanFromJson(row.contextPlan),
    sessionKey: row.sessionKey,
    sessionBlocked: row.sessionBlocked,
    admissionOrder: row.admissionOrder,
    event: eventFromJson(row.event),
    status: parseInboundStatus(row.status),
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseExpiresAt === null ? {} : { leaseExpiresAt: row.leaseExpiresAt }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function outboundFromRow(row: any, inboundEvent: unknown): OutboundReply {
  return {
    id: row.id,
    inboundEventId: row.inboundEventId,
    surfaceAccountId: row.surfaceAccountId,
    workerId: row.workerId,
    event: eventFromJson(inboundEvent),
    callback: callbackFromJson(row.callback),
    presentation: parseOutboundPresentation(row.presentation),
    deliveryKey: row.deliveryKey,
    text: row.text,
    revision: row.revision,
    status: parseOutboundStatus(row.status),
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseExpiresAt === null ? {} : { leaseExpiresAt: row.leaseExpiresAt }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.externalMessageId === null ? {} : { externalMessageId: row.externalMessageId }),
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
    ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function createSynchronously(
  tx: DynamicDatabase,
  tables: any,
  artifactId: string,
  input: CreateArtifactInput,
  references: readonly TaskReference[],
): void {
  tx.insert(tables.artifacts)
    .values({
      id: artifactId,
      taskId: required(input.taskId, "Artifact task id"),
      kind: required(input.kind, "Artifact kind"),
      location: required(input.location, "Artifact location"),
      contentHash: input.contentHash ?? null,
      sourceReferences: input.sourceReferences ?? null,
      metadata: input.metadata ?? null,
      createdAt: input.createdAt,
    })
    .run();
  if (references.length > 0)
    tx.insert(tables.taskReferences)
      .values(
        references.map((reference) => ({
          id: randomUUID(),
          artifactId,
          ...reference,
          surfaceAccountId: reference.surfaceAccountId ?? null,
          resourceId: reference.resourceId ?? null,
          createdAt: input.createdAt,
        })),
      )
      .run();
}

function taskAttemptValues(input: CreateTaskAttemptInput, workerProfile: WorkerProfileRef) {
  return {
    id: randomUUID(),
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    workerProfileId: workerProfile.id,
    workerProfileRevision: workerProfile.revision,
    workerSnapshot: input.workerSnapshot,
    status: "running",
    startedAt: input.startedAt,
    endedAt: null,
    outcome: null,
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
  };
}

type SurfaceOutcome = Omit<SettleSurfaceAttemptInput, "inboundEventId" | "leaseOwner" | "now">;

function normalizeSurfaceOutcome(input: SettleSurfaceAttemptInput): SurfaceOutcome {
  if (input.status !== "completed" && input.status !== "cancelled")
    throw new Error("Invalid surface settlement status");
  if (!Number.isFinite(Date.parse(input.now)) || !Number.isFinite(Date.parse(input.completedAt)))
    throw new Error("Surface settlement requires valid timestamps");
  const outcome: JsonRecord = JSON.parse(JSON.stringify(record(input.outcome, "Task outcome")));
  const sessionBlockReason =
    input.sessionBlockReason === undefined
      ? undefined
      : required(input.sessionBlockReason, "Session block reason");
  const result = input.result === undefined ? undefined : submittedTaskResult(input.result);
  return {
    taskId: input.taskId,
    attemptId: input.attemptId,
    status: input.status,
    workerId: input.workerId,
    responseText: input.responseText,
    completedAt: input.completedAt,
    outcome,
    ...(sessionBlockReason === undefined ? {} : { sessionBlockReason }),
    ...(result === undefined ? {} : { result }),
  };
}

function normalizeSurfaceFailure(
  input: SettleSurfaceFailureInput,
): Omit<SettleSurfaceFailureInput, "inboundEventId" | "leaseOwner" | "now"> {
  if (!Number.isSafeInteger(input.claimAttemptCount) || input.claimAttemptCount < 1)
    throw new Error("Surface failure claim count must be positive");
  for (const at of [input.now, input.failedAt, input.retryAt])
    if (!Number.isFinite(Date.parse(at))) throw new Error("Surface failure timestamp is invalid");
  if (typeof input.retryable !== "boolean")
    throw new Error("Surface failure retryability is required");
  return {
    taskId: required(input.taskId, "Task id"),
    ...(input.attemptId ? { attemptId: required(input.attemptId, "Attempt id") } : {}),
    claimAttemptCount: input.claimAttemptCount,
    error: required(input.error, "Failure error"),
    retryable: input.retryable,
    retryAt: input.retryAt,
    workerId: required(input.workerId, "Worker id"),
    responseText: input.responseText,
    failedAt: input.failedAt,
    ...(input.sessionBlockReason === undefined
      ? {}
      : { sessionBlockReason: required(input.sessionBlockReason, "Session block reason") }),
    ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
  };
}

function pendingIntentFromEvents(events: any[]): any {
  return events.find(
    (event: any) =>
      event.type === "surface.settlement-prepared" ||
      (event.type === "surface.failure-prepared" &&
        !events.some(
          (settled: any) =>
            settled.type === "surface.failure-settled" &&
            isDeepStrictEqual(settled.payload, event.payload),
        )),
  );
}

function* pendingSurfaceIntent(
  tx: DynamicDatabase,
  tables: any,
  taskId: string,
): Generator<any, any, any> {
  const e = tables.taskEvents;
  const events = yield tx
    .select()
    .from(e)
    .where(
      and(
        eq(e.taskId, taskId),
        inArray(e.type, [
          "surface.failure-prepared",
          "surface.failure-settled",
          "surface.settlement-prepared",
        ]),
      ),
    )
    .orderBy(desc(e.sequence));
  return pendingIntentFromEvents(events);
}

function* appendSurfaceIntent(
  tx: DynamicDatabase,
  tables: any,
  taskId: string,
  attemptId: string | undefined,
  type: string,
  payload: unknown,
  createdAt: string,
): Generator<any, void, any> {
  const e = tables.taskEvents;
  const nextSequence = yield* nextTaskEventSequence(tx, e, taskId);
  yield tx
    .insert(e)
    .values({
      id: randomUUID(),
      taskId,
      attemptId: attemptId ?? null,
      sequence: nextSequence,
      type,
      payload,
      createdAt,
    })
    .returning();
}

/** Shared inbound-before-Task lock order for surface admission, preparation and settlement. */
function* lockSurfaceTask(
  tx: DynamicDatabase,
  tables: any,
  input: { readonly inboundEventId: string; readonly taskId: string },
): Generator<any, { work: any; task: any }, any> {
  const i = tables.durableInboundEvents,
    t = tables.tasks;
  const [work] = yield tx
    .update(i)
    .set({ updatedAt: sql`${i.updatedAt}` })
    .where(eq(i.id, required(input.inboundEventId, "Inbound event id")))
    .returning();
  if (!work) throw staleLeaseError("inbound event", input.inboundEventId);
  const [task] = yield tx
    .update(t)
    .set({ updatedAt: sql`${t.updatedAt}` })
    .where(and(eq(t.id, input.taskId), eq(t.inboundEventId, work.id)))
    .returning();
  if (!task) throw new Error("Surface Task identity mismatch");
  return { work, task };
}

function* lockLatestTaskAttempt(
  tx: DynamicDatabase,
  tables: any,
  taskId: string,
): Generator<any, any, any> {
  const a = tables.taskAttempts;
  const [latest] = yield tx
    .select({ id: a.id })
    .from(a)
    .where(eq(a.taskId, taskId))
    .orderBy(desc(a.attemptNumber))
    .limit(1);
  if (!latest) return undefined;
  const [attempt] = yield tx
    .update(a)
    .set({ updatedAt: sql`${a.updatedAt}` })
    .where(eq(a.id, latest.id))
    .returning();
  return attempt;
}

function* lockSurfaceAttempt(
  tx: DynamicDatabase,
  tables: any,
  input: Pick<SettleSurfaceAttemptInput, "inboundEventId" | "taskId" | "attemptId">,
): Generator<any, { work: any; task: any; attempt: any }, any> {
  const { work, task } = yield* lockSurfaceTask(tx, tables, input);
  const attempt = yield* lockLatestTaskAttempt(tx, tables, input.taskId);
  if (!task || attempt?.id !== input.attemptId)
    throw new Error("Surface settlement Task or Attempt identity mismatch");
  return { work, task, attempt };
}

function completeInboundSynchronously(
  tx: DynamicDatabase,
  tables: any,
  input: CompleteInboundEventInput,
): OutboundReply {
  const t = tables.durableInboundEvents,
    o = tables.outboundReplies;
  const work = tx
    .select()
    .from(t)
    .where(
      and(
        eq(t.id, input.inboundEventId),
        eq(t.status, "processing"),
        eq(t.leaseOwner, input.leaseOwner),
      ),
    )
    .limit(1)
    .get();
  if (!work) throw staleLeaseError("inbound event", input.inboundEventId);
  const result = tx
    .update(t)
    .set({
      status: "completed",
      completedAt: input.completedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      failedAt: null,
      updatedAt: input.completedAt,
    })
    .where(
      and(
        eq(t.id, input.inboundEventId),
        eq(t.status, "processing"),
        eq(t.leaseOwner, input.leaseOwner),
      ),
    )
    .run();
  if (result.changes !== 1) throw staleLeaseError("inbound event", input.inboundEventId);
  const row = tx.insert(o).values(outboundValues(work, input)).returning().get();
  return outboundFromRow(row, work.event);
}

function outboundValues(
  work: any,
  input: Pick<CompleteInboundEventInput, "workerId" | "responseText" | "completedAt"> & {
    readonly presentation?: OutboundPresentation;
    readonly deliveryKey?: string;
  },
): Record<string, unknown> {
  return {
    id: randomUUID(),
    inboundEventId: work.id,
    surfaceAccountId: work.surfaceAccountId,
    workerId: input.workerId,
    callback: eventFromJson(work.event).callback,
    presentation: input.presentation ?? "final-result",
    deliveryKey: input.deliveryKey ?? "final",
    text: input.responseText,
    revision: 1,
    status: "pending",
    attemptCount: 0,
    maxAttempts: work.maxAttempts,
    availableAt: input.completedAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    deliveredAt: null,
    failedAt: null,
    createdAt: input.completedAt,
    updatedAt: input.completedAt,
  };
}

function parseContextType(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[a-z0-9][a-z0-9.-]*\/[a-z][a-z0-9-]*$/u.test(value)
  ) {
    throw new Error("Context entry type must be a namespaced type such as acme.io/runbook");
  }
  return value;
}
function parseContextTypeVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    throw new Error("Context entry version must be a positive integer");
  return Number(value);
}
function validateContextConfig(type: string, version: number, value: unknown): JsonRecord {
  if (!isObject(value)) throw new Error("Context entry config must be an object");
  if (JSON.stringify(value).length > 65_536)
    throw new Error("Context entry config must not exceed 64 KiB");
  if (type === SKILL_CONTEXT_TYPE) {
    if (version !== 1) throw new Error(`Unsupported built-in Context type ${type}@${version}`);
    return validateSkillConfig(value);
  }
  if (type === ARTIFACT_CONTEXT_TYPE) {
    if (version !== 1) throw new Error(`Unsupported built-in Context type ${type}@${version}`);
    return {
      sourceRouteId: requiredTextProperty(value, "sourceRouteId"),
      selection: validateTaskSelection(value["selection"]),
    };
  }
  return value;
}
function validateSkillConfig(value: JsonRecord): JsonRecord {
  const allowed = ["digest", "reference", "version"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(`Unsupported Skill Context resource configuration: ${unknown.join(", ")}`);
  const reference = requiredTextProperty(value, "reference");
  const configuration: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== "string" || candidate.trim().length === 0)
      throw new Error(`Skill Context resource configuration ${key} must be a non-empty string`);
    configuration[key] = candidate.trim();
  }
  return { ...configuration, reference };
}

function requiredTextProperty(value: JsonRecord, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0)
    throw new Error(`Context entry config ${key} must be a non-empty string`);
  return candidate.trim();
}

function validateTaskSelection(value: unknown): TagArtifactSelectionPolicy {
  if (!isObject(value)) throw new Error("Artifact selection policy must be an object");
  const unknown = Object.keys(value).filter(
    (key) => !["limit", "match", "maxAgeDays"].includes(key),
  );
  if (unknown.length > 0)
    throw new Error(`Unsupported Artifact selection configuration: ${unknown.join(", ")}`);
  if (value["match"] !== "shared-resource")
    throw new Error("Artifact selection match must be shared-resource");
  const maxAgeDays = value["maxAgeDays"];
  if (!Number.isInteger(maxAgeDays) || Number(maxAgeDays) < 1 || Number(maxAgeDays) > 3_650)
    throw new Error("Artifact selection maxAgeDays must be an integer between 1 and 3650");
  const limit = value["limit"];
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 5)
    throw new Error("Artifact selection limit must be an integer between 1 and 5");
  return { match: "shared-resource", maxAgeDays: Number(maxAgeDays), limit: Number(limit) };
}

function normalizeTaskReferences(references: readonly TaskReference[]): readonly TaskReference[] {
  const normalized = references.map((reference) => ({
    provider: parseSurfaceProvider(reference.provider),
    ...(reference.surfaceAccountId === undefined
      ? {}
      : {
          surfaceAccountId: required(
            reference.surfaceAccountId,
            "Work reference Surface Account id",
          ),
        }),
    resourceType: parseTaskResourceType(reference.resourceType),
    ...(reference.resourceId === undefined
      ? {}
      : { resourceId: required(reference.resourceId, "Work reference resource id") }),
    reference: required(reference.reference, "Work reference"),
    relationship: parseTaskReferenceRelationship(reference.relationship),
  }));
  return [
    ...new Map(
      normalized.map((reference) => [
        `${reference.provider}\0${reference.surfaceAccountId ?? ""}\0${reference.resourceType}\0${reference.resourceId ?? ""}\0${reference.reference}\0${reference.relationship}`,
        reference,
      ]),
    ).values(),
  ];
}
function normalizeTaskReferencesForMatch(
  references: NonNullable<ArtifactListFilter["relatedTo"]>,
): readonly NonNullable<ArtifactListFilter["relatedTo"]>[number][] {
  return references.map((reference) => ({
    provider: parseSurfaceProvider(reference.provider),
    resourceType: parseTaskResourceType(reference.resourceType),
    ...(reference.resourceId === undefined
      ? {}
      : { resourceId: required(reference.resourceId, "Work reference resource id") }),
    reference: required(reference.reference, "Work reference"),
  }));
}

function contextScopeId(scope: string): string {
  const normalized = required(scope, "Context source scope");
  const separator = normalized.indexOf(":");
  if (separator < 1 || separator === normalized.length - 1) {
    throw new Error(`Context source scope ${JSON.stringify(scope)} is invalid`);
  }
  return normalized.slice(separator + 1);
}
function parseTaskResourceType(value: string): TaskReference["resourceType"] {
  if (
    value === "artifact" ||
    value === "channel" ||
    value === "file" ||
    value === "issue" ||
    value === "project" ||
    value === "pull-request" ||
    value === "repository" ||
    value === "thread"
  )
    return value;
  throw new Error(`Unsupported work resource type: ${value}`);
}
function parseTaskReferenceRelationship(value: string): TaskReference["relationship"] {
  if (
    value === "changed" ||
    value === "inspected" ||
    value === "mentioned" ||
    value === "originated-in" ||
    value === "produced"
  )
    return value;
  throw new Error(`Unsupported work reference relationship: ${value}`);
}
function parseSurfaceProvider(value: string): SurfaceProvider {
  if (
    value === "cli" ||
    value === "github" ||
    value === "lark" ||
    value === "linear" ||
    value === "slack" ||
    value === "teams"
  )
    return value;
  throw new Error(`Unsupported surface provider: ${value}`);
}
function parseTaskStatus(value: string): TaskStatus {
  if (
    value === "cancelled" ||
    value === "completed" ||
    value === "failed" ||
    value === "pending" ||
    value === "running"
  )
    return value;
  throw new Error(`Unsupported Task status: ${value}`);
}
function parseTaskAttemptStatus(value: string): TaskAttemptStatus {
  if (value === "cancelled" || value === "completed" || value === "failed" || value === "running")
    return value;
  throw new Error(`Unsupported Task Attempt status: ${value}`);
}
function parseInboundStatus(value: string): DurableInboundEventStatus {
  if (value === "completed" || value === "failed" || value === "pending" || value === "processing")
    return value;
  throw new Error(`Unsupported durable inbound event status: ${value}`);
}
function parseOutboundStatus(value: string): OutboundReplyStatus {
  if (value === "delivered" || value === "delivering" || value === "failed" || value === "pending")
    return value;
  throw new Error(`Unsupported outbound reply status: ${value}`);
}
function parseOutboundPresentation(value: string): OutboundPresentation {
  if (
    value === "acknowledgement" ||
    value === "error" ||
    value === "final-result" ||
    value === "status"
  )
    return value;
  throw new Error(`Unsupported outbound presentation: ${value}`);
}

function eventFromJson(value: unknown): InboundSurfaceEvent {
  if (!isObject(value)) throw new Error("Persisted inbound event is invalid");
  return value as unknown as InboundSurfaceEvent;
}
function callbackFromJson(value: unknown): CallbackRoute {
  if (!isObject(value)) throw new Error("Persisted callback route is invalid");
  return value as unknown as CallbackRoute;
}
function authorizationFromJson(value: unknown): TagAuthorizationSnapshot {
  if (
    !isObject(value) ||
    (value["version"] !== 5 && value["version"] !== 4) ||
    !isObject(value["tag"]) ||
    !isObject(value["origin"]) ||
    !isObject(value["requester"]) ||
    !Array.isArray(value["permissionSets"]) ||
    !Array.isArray(value["resources"]) ||
    !Array.isArray(value["runtimeActions"])
  )
    throw new Error("Persisted Tag authorization snapshot is invalid");
  if (value["roles"] !== undefined && !Array.isArray(value["roles"]))
    throw new Error("Persisted Tag Role snapshot is invalid");
  return value as unknown as TagAuthorizationSnapshot;
}
function contextPlanFromJson(value: unknown): TagContextPlan {
  if (!isObject(value) || value["version"] !== 7 || !Array.isArray(value["sets"]))
    throw new Error("Persisted Tag Context Plan is invalid");
  return value as unknown as TagContextPlan;
}
function workspacePlanFromJson(value: unknown): TaskWorkspacePlan {
  if (!isObject(value) || value["version"] !== 1) {
    throw new Error("Persisted Task workspace plan is invalid");
  }
  if (value["status"] === "none") return value as unknown as TaskWorkspacePlan;
  if (value["status"] === "selected" && isObject(value["target"])) {
    return value as unknown as TaskWorkspacePlan;
  }
  if (value["status"] === "selection-required" && Array.isArray(value["choices"])) {
    return value as unknown as TaskWorkspacePlan;
  }
  if (value["status"] === "unavailable" && Array.isArray(value["requested"])) {
    return value as unknown as TaskWorkspacePlan;
  }
  if (
    value["status"] === "workspace" &&
    typeof value["workspace"] === "string" &&
    typeof value["branch"] === "string"
  ) {
    return value as unknown as TaskWorkspacePlan;
  }
  throw new Error("Persisted Task workspace plan is invalid");
}
function validChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Changed paths must contain at most 500 paths");
  const paths = value.map((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.length > 4096 ||
      path.startsWith("/") ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === ".." || part === ".git")
    )
      throw new Error("Changed paths must be repository-relative paths outside .git");
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new Error("Changed paths must be unique");
  return paths;
}

function record(value: unknown, label: string): JsonRecord {
  if (!isObject(value)) throw new Error(`Persisted ${label} is invalid`);
  return value;
}
function recordArray(value: unknown, label: string): readonly JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isObject))
    throw new Error(`Persisted ${label} is invalid`);
  return value;
}
function taskResultFromJson(value: unknown): TaskResult {
  const result = record(value, "Task result");
  if (
    typeof result["summary"] !== "string" ||
    !Array.isArray(result["decisions"]) ||
    !Array.isArray(result["changes"]) ||
    !Array.isArray(result["unresolved"]) ||
    !Array.isArray(result["artifacts"]) ||
    !Array.isArray(result["references"])
  )
    throw new Error("Persisted Task result is invalid");
  normalizeTaskReferences(result["references"] as unknown as readonly TaskReference[]);
  parseTaskFindings(result["findings"]);
  return JSON.parse(JSON.stringify(result)) as TaskResult;
}
/** A submitted result whose findings the Control Plane records for this Task only. */
function submittedTaskResult(value: unknown): TaskResult {
  const result = record(value, "Task result");
  return taskResultFromJson({ ...result, findings: recordTaskFindings(result["findings"]) });
}
function taskHistoryArray(value: unknown, label: string): readonly TaskHistoryEntry[] {
  if (!Array.isArray(value)) throw new Error(`Persisted ${label} is invalid`);
  for (const candidate of value) {
    if (
      !isObject(candidate) ||
      !isObject(candidate["result"]) ||
      typeof candidate["completedAt"] !== "string" ||
      typeof candidate["taskId"] !== "string" ||
      typeof candidate["sessionId"] !== "string" ||
      typeof candidate["tagId"] !== "string"
    ) {
      throw new Error(`Persisted ${label} contains an invalid Task history`);
    }
  }
  return value as unknown as readonly TaskHistoryEntry[];
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(value: string, label: string): string {
  const result = value.trim();
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("List limit must be an integer between 1 and 1000");
  }
  return value;
}
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}
function profile(value: WorkerProfileRef): WorkerProfileRef {
  return {
    id: required(value.id, "Worker profile id"),
    revision: required(value.revision, "Worker profile revision"),
  };
}
function profileFromRow(row: {
  workerProfileId: string;
  workerProfileRevision: string;
}): WorkerProfileRef {
  return profile({ id: row.workerProfileId, revision: row.workerProfileRevision });
}
function compact<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}
function combine(conditions: readonly unknown[]): unknown {
  return conditions.length === 0 ? undefined : and(...(conditions as any[]));
}
function inboundIsDue(table: DynamicTable, now: string): any {
  return and(
    sql`not exists (select 1 from "DurableInboundEvent" blocked where blocked."tagId" = ${table.tagId} and blocked."sessionKey" = ${table.sessionKey} and blocked."sessionBlocked" = true)`,
    sql`not exists (select 1 from "InboundControlDelivery" c where c."inboundEventId" = ${table.id} and c."status" not in ('rejected','withdrawn'))`,
    sql`not exists (select 1 from "DurableInboundEvent" predecessor where predecessor."tagId" = ${table.tagId} and predecessor."sessionKey" = ${table.sessionKey} and predecessor."id" <> ${table.id} and (predecessor."status" = 'processing' or (predecessor."status" = 'pending' and predecessor."admissionOrder" < ${table.admissionOrder})))`,
    sql`not exists (select 1 from "InboundControlDelivery" c join "DurableInboundEvent" i on i."id" = c."inboundEventId" where i."tagId" = ${table.tagId} and i."sessionKey" = ${table.sessionKey} and c."status" in ('dispatching','unknown'))`,
    // A conversation runs at most WORK_SESSION_MAX_RUNNING work Sessions at once; the rest queue.
    sql`not exists (select 1 from "Session" ws where ws."tagId" = ${table.tagId} and ws."sessionKey" = ${table.sessionKey} and ws."parentSessionId" is not null and (select count(*) from "DurableInboundEvent" r join "Session" rs on rs."tagId" = r."tagId" and rs."sessionKey" = r."sessionKey" where rs."parentSessionId" = ws."parentSessionId" and r."status" = 'processing' and r."id" <> ${table.id}) >= ${WORK_SESSION_MAX_RUNNING})`,
    or(
      and(
        eq(table.status, "pending"),
        lte(table.availableAt, now),
        lt(table.attemptCount, table.maxAttempts),
        // A turn of an Objective's Session waits while the Objective is paused or closed.
        sql`not exists (select 1 from "Session" os join "Objective" o on o."id" = os."objectiveId" where os."tagId" = ${table.tagId} and os."sessionKey" = ${table.sessionKey} and (o."pausedAt" is not null or o."status" in ('completed','cancelled')))`,
        // Turns across the Sessions of every Objective naming a Team stay within its maxConcurrency.
        sql`not exists (select 1 from "Session" os join "Objective" o on o."id" = os."objectiveId" join "Team" tm on tm."id" = o."teamId" where os."tagId" = ${table.tagId} and os."sessionKey" = ${table.sessionKey} and tm."maxConcurrency" is not null and (select count(*) from "DurableInboundEvent" r join "Session" rs on rs."tagId" = r."tagId" and rs."sessionKey" = r."sessionKey" join "Objective" ro on ro."id" = rs."objectiveId" where ro."teamId" = tm."id" and r."status" = 'processing' and r."id" <> ${table.id}) >= tm."maxConcurrency")`,
      ),
      and(eq(table.status, "processing"), lte(table.leaseExpiresAt, now)),
    ),
  );
}
function isUnique(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    const code = current["code"];
    if (code === "23505" || (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")))
      return true;
    current = current["cause"];
  }
  return false;
}
function validateLease(input: ClaimDueWorkInput): void {
  const now = Date.parse(input.now),
    expiresAt = Date.parse(input.leaseExpiresAt);
  if (input.leaseOwner.trim() === "") throw new Error("leaseOwner must not be empty");
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now)
    throw new Error("leaseExpiresAt must be later than now");
}
function staleLeaseError(kind: string, id: string): Error {
  return new Error(`Cannot update ${kind} ${id}: lease is no longer owned`);
}
function sqlitePathFromUrl(url: string): string {
  const path = url.slice("file:".length);
  if (path === ":memory:" || path === "::memory:") return ":memory:";
  return decodeURIComponent(path);
}

function inboundControlFromRow(row: any): InboundControlDelivery {
  return {
    inboundEventId: row.inboundEventId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    command: record(row.command, "Control command"),
    status: row.status,
    ...(row.workerHostId === null ? {} : { workerHostId: row.workerHostId }),
    ...(row.workerId === null ? {} : { workerId: row.workerId }),
    ...(row.detail === null ? {} : { detail: record(row.detail, "Control detail") }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function sameInboundAudience(left: any, right: any): boolean {
  const audience = (row: any) =>
    JSON.stringify({
      tagId: row.tagId,
      surfaceAccountId: row.surfaceAccountId,
      tagRouteId: row.tagRouteId,
      provider: row.event.provider,
      externalAccountId: row.event.externalAccountId,
      scope: row.event.scope,
      sessionKey: row.event.sessionKey,
      callback: row.event.callback,
    });
  return (
    left.event?.actor?.kind === "user" &&
    left.authorization?.version === 5 &&
    left.authorization?.tag?.id === left.tagId &&
    left.authorization?.requester?.id === left.event.actor.id &&
    left.authorization?.requester?.kind === "user" &&
    left.authorization?.origin?.surfaceAccountId === left.surfaceAccountId &&
    left.authorization?.origin?.tagRouteId === left.tagRouteId &&
    left.authorization?.origin?.provider === left.event.provider &&
    left.authorization?.origin?.scope === left.event.scope &&
    audience(left) === audience(right)
  );
}
