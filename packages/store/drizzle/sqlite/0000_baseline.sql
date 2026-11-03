CREATE TABLE `ApprovalRequest` (
	`id` text PRIMARY KEY NOT NULL,
	`objectiveId` text,
	`taskId` text NOT NULL,
	`attemptId` text,
	`requestingTagId` text NOT NULL,
	`kind` text NOT NULL,
	`actions` text NOT NULL,
	`argumentsDigest` text,
	`summary` text NOT NULL,
	`ruleSources` text DEFAULT '[]' NOT NULL,
	`approvers` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`scope` text,
	`validUntil` text,
	`decidedBy` text,
	`decidedByKind` text,
	`decidedAt` text,
	`reason` text,
	`consumedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ApprovalRequest_objective_status_idx` ON `ApprovalRequest` (`objectiveId`,`status`,`scope`);--> statement-breakpoint
CREATE INDEX `ApprovalRequest_task_status_idx` ON `ApprovalRequest` (`taskId`,`status`);--> statement-breakpoint
CREATE INDEX `ApprovalRequest_status_created_idx` ON `ApprovalRequest` (`status`,`createdAt`,`id`);--> statement-breakpoint
CREATE TABLE `ArtifactAcquisition` (
	`id` text PRIMARY KEY NOT NULL,
	`operationId` text NOT NULL,
	`artifactId` text NOT NULL,
	`taskId` text NOT NULL,
	`attemptId` text NOT NULL,
	`paths` text NOT NULL,
	`delivery` text NOT NULL,
	`destination` text,
	`status` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`artifactId`) REFERENCES `CapturedArtifact`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ArtifactAcquisition_attempt_operation_key` ON `ArtifactAcquisition` (`attemptId`,`operationId`);--> statement-breakpoint
CREATE INDEX `ArtifactAcquisition_attempt_created_idx` ON `ArtifactAcquisition` (`attemptId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `ArtifactAcquisition_artifact_idx` ON `ArtifactAcquisition` (`artifactId`);--> statement-breakpoint
CREATE TABLE `ArtifactApprovalAuditEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`approvalType` text NOT NULL,
	`approvalId` text NOT NULL,
	`objectiveId` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`actorKind` text NOT NULL,
	`actorId` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ArtifactApprovalAuditEvent_approval_revision_key` ON `ArtifactApprovalAuditEvent` (`approvalType`,`approvalId`,`revision`);--> statement-breakpoint
CREATE INDEX `ArtifactApprovalAuditEvent_objective_idx` ON `ArtifactApprovalAuditEvent` (`objectiveId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `ArtifactConsumptionApproval` (
	`id` text PRIMARY KEY NOT NULL,
	`publicationApprovalId` text NOT NULL,
	`objectiveId` text NOT NULL,
	`approvedByKind` text NOT NULL,
	`approvedById` text NOT NULL,
	`approvedAt` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`withdrawnByKind` text,
	`withdrawnById` text,
	`withdrawnAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`publicationApprovalId`) REFERENCES `ArtifactPublicationApproval`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ArtifactConsumptionApproval_publication_objective_key` ON `ArtifactConsumptionApproval` (`publicationApprovalId`,`objectiveId`);--> statement-breakpoint
CREATE INDEX `ArtifactConsumptionApproval_objective_status_idx` ON `ArtifactConsumptionApproval` (`objectiveId`,`status`);--> statement-breakpoint
CREATE TABLE `ArtifactPublicationApproval` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceTaskId` text NOT NULL,
	`sourceObjectiveId` text NOT NULL,
	`artifactId` text DEFAULT '' NOT NULL,
	`paths` text DEFAULT '[]' NOT NULL,
	`entries` text DEFAULT '[]' NOT NULL,
	`sourceAttemptId` text NOT NULL,
	`sourceAttemptCount` integer NOT NULL,
	`reviewedByTagId` text NOT NULL,
	`assessment` text NOT NULL,
	`acceptedAt` text NOT NULL,
	`audienceObjectiveIds` text NOT NULL,
	`approvedByKind` text NOT NULL,
	`approvedById` text NOT NULL,
	`approvedAt` text NOT NULL,
	`supersedesPublicationId` text,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`withdrawnByKind` text,
	`withdrawnById` text,
	`withdrawnAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `TaskAssignment`(`taskId`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceObjectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceAttemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewedByTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ArtifactPublicationApproval_source_idx` ON `ArtifactPublicationApproval` (`sourceObjectiveId`,`sourceTaskId`);--> statement-breakpoint
CREATE INDEX `ArtifactPublicationApproval_status_idx` ON `ArtifactPublicationApproval` (`status`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `ArtifactStorageLocation` (
	`workerHostId` text NOT NULL,
	`digest` text NOT NULL,
	`sizeBytes` integer NOT NULL,
	`connectionGeneration` integer NOT NULL,
	`inventoryRevision` integer NOT NULL,
	`transferBaseUrl` text NOT NULL,
	`status` text NOT NULL,
	`observedAt` text NOT NULL,
	`unavailableAt` text,
	FOREIGN KEY (`workerHostId`) REFERENCES `WorkerHost`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ArtifactStorageLocation_host_digest_key` ON `ArtifactStorageLocation` (`workerHostId`,`digest`);--> statement-breakpoint
CREATE INDEX `ArtifactStorageLocation_digest_status_idx` ON `ArtifactStorageLocation` (`digest`,`status`);--> statement-breakpoint
CREATE TABLE `ArtifactUpload` (
	`attemptId` text NOT NULL,
	`taskId` text NOT NULL,
	`digest` text NOT NULL,
	`sizeBytes` integer NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ArtifactUpload_attempt_digest_key` ON `ArtifactUpload` (`attemptId`,`digest`);--> statement-breakpoint
CREATE TABLE `Artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`kind` text NOT NULL,
	`location` text NOT NULL,
	`contentHash` text,
	`sourceReferences` text,
	`metadata` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `Artifact_taskId_kind_idx` ON `Artifact` (`taskId`,`kind`);--> statement-breakpoint
CREATE TABLE `AuditEntry` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`outcome` text NOT NULL,
	`status` integer,
	`source` text NOT NULL,
	`method` text,
	`path` text
);
--> statement-breakpoint
CREATE INDEX `AuditEntry_at_idx` ON `AuditEntry` (`at`);--> statement-breakpoint
CREATE INDEX `AuditEntry_actor_at_idx` ON `AuditEntry` (`actor`,`at`);--> statement-breakpoint
CREATE TABLE `AuthKey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lookupId` text NOT NULL,
	`secretDigest` text NOT NULL,
	`tagIds` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`reusable` integer NOT NULL,
	`ephemeral` integer NOT NULL,
	`expiresAt` text NOT NULL,
	`usedAt` text,
	`redemptionCount` integer DEFAULT 0 NOT NULL,
	`revokedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `AuthKey_name_key` ON `AuthKey` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `AuthKey_lookupId_key` ON `AuthKey` (`lookupId`);--> statement-breakpoint
CREATE TABLE `CapturedArtifact` (
	`id` text PRIMARY KEY NOT NULL,
	`operationId` text NOT NULL,
	`taskId` text NOT NULL,
	`attemptId` text NOT NULL,
	`tagId` text NOT NULL,
	`sessionId` text NOT NULL,
	`objectiveId` text,
	`title` text NOT NULL,
	`summary` text,
	`kind` text NOT NULL,
	`entries` text NOT NULL,
	`inputs` text DEFAULT '[]' NOT NULL,
	`harnessSession` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CapturedArtifact_attempt_operation_key` ON `CapturedArtifact` (`attemptId`,`operationId`);--> statement-breakpoint
CREATE INDEX `CapturedArtifact_objective_created_idx` ON `CapturedArtifact` (`objectiveId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `CapturedArtifact_session_created_idx` ON `CapturedArtifact` (`sessionId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `CapturedArtifact_task_created_idx` ON `CapturedArtifact` (`taskId`,`createdAt`,`id`);--> statement-breakpoint
CREATE TABLE `DurableInboundEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`surfaceAccountId` text NOT NULL,
	`tagRouteId` text NOT NULL,
	`tagId` text NOT NULL,
	`execution` text DEFAULT '{}' NOT NULL,
	`admissionOrder` integer DEFAULT 0 NOT NULL,
	`sessionBlocked` integer DEFAULT false NOT NULL,
	`sessionKey` text DEFAULT '' NOT NULL,
	`authorization` text NOT NULL,
	`contextPlan` text NOT NULL,
	`deliveryId` text NOT NULL,
	`logicalEventId` text NOT NULL,
	`event` text NOT NULL,
	`status` text NOT NULL,
	`attemptCount` integer NOT NULL,
	`maxAttempts` integer NOT NULL,
	`availableAt` text NOT NULL,
	`leaseOwner` text,
	`leaseExpiresAt` text,
	`lastError` text,
	`completedAt` text,
	`failedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`surfaceAccountId`) REFERENCES `SurfaceAccount`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `DurableInboundEvent_session_processing_key` ON `DurableInboundEvent` (`tagId`,`sessionKey`) WHERE "DurableInboundEvent"."status" = 'processing';--> statement-breakpoint
CREATE INDEX `DurableInboundEvent_session_queue_idx` ON `DurableInboundEvent` (`tagId`,`sessionKey`,`admissionOrder`);--> statement-breakpoint
CREATE UNIQUE INDEX `DurableInboundEvent_admissionOrder_key` ON `DurableInboundEvent` (`admissionOrder`);--> statement-breakpoint
CREATE UNIQUE INDEX `DurableInboundEvent_surfaceAccountId_deliveryId_key` ON `DurableInboundEvent` (`surfaceAccountId`,`deliveryId`);--> statement-breakpoint
CREATE UNIQUE INDEX `DurableInboundEvent_surfaceAccountId_logicalEventId_key` ON `DurableInboundEvent` (`surfaceAccountId`,`logicalEventId`);--> statement-breakpoint
CREATE INDEX `DurableInboundEvent_status_availableAt_idx` ON `DurableInboundEvent` (`status`,`availableAt`);--> statement-breakpoint
CREATE INDEX `DurableInboundEvent_status_leaseExpiresAt_idx` ON `DurableInboundEvent` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE TABLE `InboundControlDelivery` (
	`inboundEventId` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`attemptId` text NOT NULL,
	`command` text NOT NULL,
	`workerHostId` text,
	`workerId` text,
	`status` text NOT NULL,
	`detail` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`inboundEventId`) REFERENCES `DurableInboundEvent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `InboundControlDelivery_attempt_idx` ON `InboundControlDelivery` (`attemptId`);--> statement-breakpoint
CREATE TABLE `InboundEventKey` (
	`id` text PRIMARY KEY NOT NULL,
	`surfaceAccountId` text NOT NULL,
	`eventId` text NOT NULL,
	`claimedAt` text NOT NULL,
	`taskId` text,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `InboundEventKey_surfaceAccountId_eventId_key` ON `InboundEventKey` (`surfaceAccountId`,`eventId`);--> statement-breakpoint
CREATE INDEX `InboundEventKey_taskId_idx` ON `InboundEventKey` (`taskId`);--> statement-breakpoint
CREATE TABLE `ObjectiveMessage` (
	`id` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`senderTagId` text NOT NULL,
	`sourceTaskId` text NOT NULL,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	`fingerprint` text NOT NULL,
	`replyMessageId` text,
	`repliedByOperatorId` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`senderTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `TaskAssignment`(`taskId`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`replyMessageId`) REFERENCES `TagMessage`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ObjectiveMessage_sender_key` ON `ObjectiveMessage` (`objectiveId`,`senderTagId`,`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `ObjectiveMessage_pending_idx` ON `ObjectiveMessage` (`replyMessageId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `ObjectiveMessage_objective_idx` ON `ObjectiveMessage` (`objectiveId`,`createdAt`,`id`);--> statement-breakpoint
CREATE TABLE `ObjectiveSession` (
	`sessionId` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`surfaceTaskId` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surfaceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ObjectiveSession_objectiveId_idx` ON `ObjectiveSession` (`objectiveId`);--> statement-breakpoint
CREATE TABLE `Objective` (
	`id` text PRIMARY KEY NOT NULL,
	`ongoing` integer DEFAULT false NOT NULL,
	`observations` text DEFAULT '[]' NOT NULL,
	`observationState` text DEFAULT '{"cursors":{}}' NOT NULL,
	`outcome` text NOT NULL,
	`ownerTagId` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lockRevision` integer DEFAULT 0 NOT NULL,
	`executionStartedAt` text,
	`surfaceTaskId` text,
	`notificationTaskId` text,
	`surfaceSessionId` text,
	`deadline` text,
	`budgetLimitMinor` integer,
	`budgetCurrency` text,
	`limitState` text DEFAULT '{}' NOT NULL,
	`spentMinor` integer DEFAULT 0 NOT NULL,
	`reservedMinor` integer DEFAULT 0 NOT NULL,
	`runtimeActions` text DEFAULT '[]' NOT NULL,
	`workspaces` text DEFAULT '[]' NOT NULL,
	`completionSummary` text,
	`cancelledAt` text,
	`cancellationReason` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`ownerTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`surfaceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`notificationTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`surfaceSessionId`) REFERENCES `Session`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `Objective_owner_idx` ON `Objective` (`ownerTagId`);--> statement-breakpoint
CREATE UNIQUE INDEX `Objective_surfaceSessionId_key` ON `Objective` (`surfaceSessionId`);--> statement-breakpoint
CREATE TABLE `OperatorNotificationItem` (
	`destination` text NOT NULL,
	`itemKey` text NOT NULL,
	`notificationId` text NOT NULL,
	`objectiveId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`destination`, `itemKey`),
	FOREIGN KEY (`notificationId`) REFERENCES `OperatorNotification`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OperatorNotificationItem_notification_idx` ON `OperatorNotificationItem` (`notificationId`);--> statement-breakpoint
CREATE TABLE `OperatorNotification` (
	`id` text PRIMARY KEY NOT NULL,
	`destination` text NOT NULL,
	`objectiveId` text NOT NULL,
	`itemKeys` text NOT NULL,
	`text` text NOT NULL,
	`immediate` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`attemptCount` integer NOT NULL,
	`maxAttempts` integer NOT NULL,
	`availableAt` text NOT NULL,
	`leaseOwner` text,
	`leaseExpiresAt` text,
	`lastError` text,
	`externalMessageId` text,
	`deliveredAt` text,
	`failedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `OperatorNotification_destination_objective_idx` ON `OperatorNotification` (`destination`,`objectiveId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `OperatorNotification_status_availableAt_idx` ON `OperatorNotification` (`status`,`availableAt`);--> statement-breakpoint
CREATE INDEX `OperatorNotification_status_leaseExpiresAt_idx` ON `OperatorNotification` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE TABLE `OperatorToken` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lookupId` text NOT NULL,
	`secretDigest` text NOT NULL,
	`expiresAt` text NOT NULL,
	`lastUsedAt` text,
	`revokedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OperatorToken_name_key` ON `OperatorToken` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `OperatorToken_lookupId_key` ON `OperatorToken` (`lookupId`);--> statement-breakpoint
CREATE TABLE `OutboundReply` (
	`id` text PRIMARY KEY NOT NULL,
	`inboundEventId` text NOT NULL,
	`surfaceAccountId` text NOT NULL,
	`workerId` text NOT NULL,
	`callback` text NOT NULL,
	`presentation` text DEFAULT 'final-result' NOT NULL,
	`deliveryKey` text DEFAULT 'final' NOT NULL,
	`text` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`attemptCount` integer NOT NULL,
	`maxAttempts` integer NOT NULL,
	`availableAt` text NOT NULL,
	`leaseOwner` text,
	`leaseExpiresAt` text,
	`lastError` text,
	`externalMessageId` text,
	`deliveredAt` text,
	`failedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`inboundEventId`) REFERENCES `DurableInboundEvent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surfaceAccountId`) REFERENCES `SurfaceAccount`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OutboundReply_inboundEventId_deliveryKey_key` ON `OutboundReply` (`inboundEventId`,`deliveryKey`);--> statement-breakpoint
CREATE INDEX `OutboundReply_status_availableAt_idx` ON `OutboundReply` (`status`,`availableAt`);--> statement-breakpoint
CREATE INDEX `OutboundReply_status_leaseExpiresAt_idx` ON `OutboundReply` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE TABLE `ResourceChange` (
	`id` text PRIMARY KEY NOT NULL,
	`resourceType` text NOT NULL,
	`resourceId` text NOT NULL,
	`fromRevision` integer NOT NULL,
	`toRevision` integer NOT NULL,
	`actorTagId` text,
	`operatorId` text,
	`sourceTaskId` text,
	`sourceMessageId` text,
	`changes` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`actorTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sourceMessageId`) REFERENCES `TagMessage`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ResourceChange_resource_revision_key` ON `ResourceChange` (`resourceType`,`resourceId`,`toRevision`);--> statement-breakpoint
CREATE INDEX `ResourceChange_resource_created_idx` ON `ResourceChange` (`resourceType`,`resourceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ResourceChange_source_task_idx` ON `ResourceChange` (`sourceTaskId`);--> statement-breakpoint
CREATE INDEX `ResourceChange_source_message_idx` ON `ResourceChange` (`sourceMessageId`);--> statement-breakpoint
CREATE TABLE `ResourceManagement` (
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`applySet` text,
	`fields` text NOT NULL,
	`updatedAt` text NOT NULL,
	PRIMARY KEY(`kind`, `name`)
);
--> statement-breakpoint
CREATE INDEX `ResourceManagement_applySet_idx` ON `ResourceManagement` (`applySet`);--> statement-breakpoint
CREATE TABLE `RoleAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`roleId` text NOT NULL,
	`tagId` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RoleAssignment_roleId_tagId_key` ON `RoleAssignment` (`roleId`,`tagId`);--> statement-breakpoint
CREATE INDEX `RoleAssignment_tagId_status_idx` ON `RoleAssignment` (`tagId`,`status`);--> statement-breakpoint
CREATE INDEX `RoleAssignment_roleId_status_idx` ON `RoleAssignment` (`roleId`,`status`);--> statement-breakpoint
CREATE TABLE `RoleContextSet` (
	`roleId` text NOT NULL,
	`contextSetId` text NOT NULL,
	FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contextSetId`) REFERENCES `TagContextSet`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RoleContextSet_roleId_contextSetId_key` ON `RoleContextSet` (`roleId`,`contextSetId`);--> statement-breakpoint
CREATE INDEX `RoleContextSet_contextSetId_idx` ON `RoleContextSet` (`contextSetId`);--> statement-breakpoint
CREATE TABLE `RolePermissionSet` (
	`roleId` text NOT NULL,
	`permissionSetId` text NOT NULL,
	FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permissionSetId`) REFERENCES `TagPermissionSet`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RolePermissionSet_roleId_permissionSetId_key` ON `RolePermissionSet` (`roleId`,`permissionSetId`);--> statement-breakpoint
CREATE INDEX `RolePermissionSet_permissionSetId_idx` ON `RolePermissionSet` (`permissionSetId`);--> statement-breakpoint
CREATE TABLE `Role` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`instructions` text NOT NULL,
	`execution` text,
	`origin` text NOT NULL,
	`systemKey` text,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Role_name_key` ON `Role` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `Role_systemKey_key` ON `Role` (`systemKey`);--> statement-breakpoint
CREATE INDEX `Role_status_idx` ON `Role` (`status`);--> statement-breakpoint
CREATE TABLE `SessionState` (
	`id` text PRIMARY KEY NOT NULL,
	`sessionId` text NOT NULL,
	`taskId` text NOT NULL,
	`attemptId` text NOT NULL,
	`harnessId` text NOT NULL,
	`nativeId` text,
	`ref` text NOT NULL,
	`data` text NOT NULL,
	`status` text NOT NULL,
	`writeVersion` integer NOT NULL,
	`compatibility` text,
	`workerProfile` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SessionState_sessionId_createdAt_idx` ON `SessionState` (`sessionId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SessionState_taskId_createdAt_idx` ON `SessionState` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SessionState_attemptId_idx` ON `SessionState` (`attemptId`);--> statement-breakpoint
CREATE TABLE `Session` (
	`id` text PRIMARY KEY NOT NULL,
	`tagId` text NOT NULL,
	`sessionKey` text NOT NULL,
	`origin` text NOT NULL,
	`state` text NOT NULL,
	`lastInteractionAt` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Session_tagId_sessionKey_key` ON `Session` (`tagId`,`sessionKey`);--> statement-breakpoint
CREATE INDEX `Session_lastInteractionAt_idx` ON `Session` (`lastInteractionAt`);--> statement-breakpoint
CREATE TABLE `SurfaceAccount` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`externalAccountId` text NOT NULL,
	`displayName` text NOT NULL,
	`authMethod` text NOT NULL,
	`credentialId` text NOT NULL,
	`status` text NOT NULL,
	`configuration` text NOT NULL,
	`name` text,
	`secretReferences` text,
	`lastVerifiedAt` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SurfaceAccount_provider_externalAccountId_key` ON `SurfaceAccount` (`provider`,`externalAccountId`);--> statement-breakpoint
CREATE UNIQUE INDEX `SurfaceAccount_name_key` ON `SurfaceAccount` (`name`);--> statement-breakpoint
CREATE INDEX `SurfaceAccount_provider_status_idx` ON `SurfaceAccount` (`provider`,`status`);--> statement-breakpoint
CREATE TABLE `TagContextActivation` (
	`id` text PRIMARY KEY NOT NULL,
	`contextSetId` text NOT NULL,
	`tagRouteId` text NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`contextSetId`) REFERENCES `TagContextSet`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tagRouteId`) REFERENCES `TagRoute`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagContextActivation_contextSetId_tagRouteId_key` ON `TagContextActivation` (`contextSetId`,`tagRouteId`);--> statement-breakpoint
CREATE INDEX `TagContextActivation_tagRouteId_idx` ON `TagContextActivation` (`tagRouteId`);--> statement-breakpoint
CREATE TABLE `TagContextItem` (
	`id` text PRIMARY KEY NOT NULL,
	`contextSetId` text NOT NULL,
	`type` text NOT NULL,
	`version` integer NOT NULL,
	`required` integer NOT NULL,
	`itemKey` text NOT NULL,
	`config` text NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`contextSetId`) REFERENCES `TagContextSet`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagContextItem_contextSetId_itemKey_key` ON `TagContextItem` (`contextSetId`,`itemKey`);--> statement-breakpoint
CREATE TABLE `TagContextSet` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagContextSet_name_key` ON `TagContextSet` (`name`);--> statement-breakpoint
CREATE TABLE `TagMailboxCredential` (
	`id` text PRIMARY KEY NOT NULL,
	`tagId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagMailboxCredential_tokenHash_key` ON `TagMailboxCredential` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `TagMessage` (
	`id` text PRIMARY KEY NOT NULL,
	`senderTagId` text NOT NULL,
	`recipientTagId` text NOT NULL,
	`recipientTeamId` text,
	`operatorId` text,
	`objectiveId` text NOT NULL,
	`workstreamId` text,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`bodyPrunedAt` text,
	`idempotencyKey` text NOT NULL,
	`fingerprint` text NOT NULL,
	`inReplyTo` text,
	`status` text NOT NULL,
	`attemptCount` integer DEFAULT 0 NOT NULL,
	`leaseToken` text,
	`leaseCredentialId` text,
	`leaseExpiresAt` text,
	`processedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`senderTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipientTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workstreamId`) REFERENCES `Workstream`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagMessage_sender_idempotency_key` ON `TagMessage` (`senderTagId`,`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `TagMessage_recipient_status_created_idx` ON `TagMessage` (`recipientTagId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `TagMessage_sender_history_idx` ON `TagMessage` (`senderTagId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `TagMessage_recipient_history_idx` ON `TagMessage` (`recipientTagId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `TagMessage_retention_idx` ON `TagMessage` (`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `TagMessage_objective_idx` ON `TagMessage` (`objectiveId`);--> statement-breakpoint
CREATE INDEX `TagMessage_workstream_created_idx` ON `TagMessage` (`workstreamId`,`createdAt`,`id`);--> statement-breakpoint
CREATE TABLE `TagMessagingGrant` (
	`senderTagId` text NOT NULL,
	`recipientTagId` text NOT NULL,
	`messageTypes` text NOT NULL,
	FOREIGN KEY (`senderTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipientTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagMessagingGrant_pair_key` ON `TagMessagingGrant` (`senderTagId`,`recipientTagId`);--> statement-breakpoint
CREATE TABLE `TagPermissionActivation` (
	`id` text PRIMARY KEY NOT NULL,
	`permissionSetId` text NOT NULL,
	`tagRouteId` text NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`permissionSetId`) REFERENCES `TagPermissionSet`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tagRouteId`) REFERENCES `TagRoute`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagPermissionActivation_permissionSetId_tagRouteId_key` ON `TagPermissionActivation` (`permissionSetId`,`tagRouteId`);--> statement-breakpoint
CREATE INDEX `TagPermissionActivation_tagRouteId_idx` ON `TagPermissionActivation` (`tagRouteId`);--> statement-breakpoint
CREATE TABLE `TagPermissionSet` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`approvers` text DEFAULT '[]' NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagPermissionSet_name_key` ON `TagPermissionSet` (`name`);--> statement-breakpoint
CREATE TABLE `TagPermission` (
	`id` text PRIMARY KEY NOT NULL,
	`permissionSetId` text NOT NULL,
	`target` text DEFAULT 'surface' NOT NULL,
	`surfaceAccountId` text,
	`scope` text NOT NULL,
	`reference` text,
	`action` text NOT NULL,
	`approval` text,
	`createdBy` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`permissionSetId`) REFERENCES `TagPermissionSet`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surfaceAccountId`) REFERENCES `SurfaceAccount`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagPermission_surface_target_action_key` ON `TagPermission` (`permissionSetId`,`surfaceAccountId`,`scope`,`action`) WHERE "TagPermission"."target" = 'surface';--> statement-breakpoint
CREATE UNIQUE INDEX `TagPermission_runtime_target_action_key` ON `TagPermission` (`permissionSetId`,`target`,`action`) WHERE "TagPermission"."target" = 'runtime';--> statement-breakpoint
CREATE INDEX `TagPermission_permissionSetId_idx` ON `TagPermission` (`permissionSetId`);--> statement-breakpoint
CREATE INDEX `TagPermission_target_idx` ON `TagPermission` (`target`);--> statement-breakpoint
CREATE INDEX `TagPermission_surfaceAccountId_scope_idx` ON `TagPermission` (`surfaceAccountId`,`scope`);--> statement-breakpoint
CREATE TABLE `TagRoute` (
	`id` text PRIMARY KEY NOT NULL,
	`tagId` text NOT NULL,
	`surfaceAccountId` text NOT NULL,
	`scope` text NOT NULL,
	`enabled` integer NOT NULL,
	`workspaces` text DEFAULT '[]' NOT NULL,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surfaceAccountId`) REFERENCES `SurfaceAccount`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagRoute_surfaceAccountId_scope_key` ON `TagRoute` (`surfaceAccountId`,`scope`);--> statement-breakpoint
CREATE INDEX `TagRoute_tagId_idx` ON `TagRoute` (`tagId`);--> statement-breakpoint
CREATE TABLE `TagWorkerHostBinding` (
	`tagId` text NOT NULL,
	`workerHostId` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TagWorkerHostBinding_tagId_workerHostId_key` ON `TagWorkerHostBinding` (`tagId`,`workerHostId`);--> statement-breakpoint
CREATE INDEX `TagWorkerHostBinding_workerHostId_idx` ON `TagWorkerHostBinding` (`workerHostId`);--> statement-breakpoint
CREATE TABLE `Tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`runsOn` text DEFAULT '[]' NOT NULL,
	`execution` text,
	`retiredAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Tag_active_name_key` ON `Tag` (`name`) WHERE "Tag"."status" = 'active';--> statement-breakpoint
CREATE INDEX `Tag_name_idx` ON `Tag` (`name`);--> statement-breakpoint
CREATE INDEX `Tag_status_idx` ON `Tag` (`status`);--> statement-breakpoint
CREATE TABLE `TaskAssignment` (
	`taskId` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`workstreamId` text,
	`teamId` text NOT NULL,
	`requestedByTagId` text NOT NULL,
	`assignedTagId` text NOT NULL,
	`parentTaskId` text,
	`waitState` text,
	`sourceMessageId` text,
	`instruction` text NOT NULL,
	`acceptanceCriteria` text NOT NULL,
	`dependencies` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`approval` text NOT NULL,
	`leaseOwner` text,
	`leaseExpiresAt` text,
	`attemptCount` integer DEFAULT 0 NOT NULL,
	`availableAt` text NOT NULL,
	`reservedMinor` integer DEFAULT 0 NOT NULL,
	`chargedMinor` integer,
	`result` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workstreamId`) REFERENCES `Workstream`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requestedByTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assignedTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceMessageId`) REFERENCES `TagMessage`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TaskAssignment_sourceMessageId_key` ON `TaskAssignment` (`sourceMessageId`);--> statement-breakpoint
CREATE INDEX `TaskAssignment_objective_status_idx` ON `TaskAssignment` (`objectiveId`,`status`);--> statement-breakpoint
CREATE INDEX `TaskAssignment_team_status_idx` ON `TaskAssignment` (`teamId`,`status`);--> statement-breakpoint
CREATE TABLE `TaskAttempt` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`attemptNumber` integer NOT NULL,
	`workerProfileId` text NOT NULL,
	`workerProfileRevision` text NOT NULL,
	`workerSnapshot` text NOT NULL,
	`status` text NOT NULL,
	`startedAt` text NOT NULL,
	`endedAt` text,
	`outcome` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TaskAttempt_taskId_attemptNumber_key` ON `TaskAttempt` (`taskId`,`attemptNumber`);--> statement-breakpoint
CREATE INDEX `TaskAttempt_taskId_createdAt_idx` ON `TaskAttempt` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `TaskAttempt_status_idx` ON `TaskAttempt` (`status`);--> statement-breakpoint
CREATE TABLE `TaskEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`attemptId` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TaskEvent_taskId_sequence_key` ON `TaskEvent` (`taskId`,`sequence`);--> statement-breakpoint
CREATE TABLE `TaskReference` (
	`id` text PRIMARY KEY NOT NULL,
	`artifactId` text NOT NULL,
	`provider` text NOT NULL,
	`surfaceAccountId` text,
	`resourceType` text NOT NULL,
	`resourceId` text,
	`reference` text NOT NULL,
	`relationship` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TaskReference_artifactId_provider_resourceType_reference_relationship_key` ON `TaskReference` (`artifactId`,`provider`,`resourceType`,`reference`,`relationship`);--> statement-breakpoint
CREATE INDEX `TaskReference_provider_resourceType_resourceId_idx` ON `TaskReference` (`provider`,`resourceType`,`resourceId`);--> statement-breakpoint
CREATE INDEX `TaskReference_provider_resourceType_reference_idx` ON `TaskReference` (`provider`,`resourceType`,`reference`);--> statement-breakpoint
CREATE INDEX `TaskReference_artifactId_relationship_idx` ON `TaskReference` (`artifactId`,`relationship`);--> statement-breakpoint
CREATE TABLE `Task` (
	`id` text PRIMARY KEY NOT NULL,
	`inboundEventId` text,
	`tagId` text NOT NULL,
	`sessionId` text NOT NULL,
	`surfaceObjectiveId` text,
	`execution` text DEFAULT '{}' NOT NULL,
	`actor` text NOT NULL,
	`trigger` text NOT NULL,
	`requestText` text,
	`responseText` text,
	`result` text,
	`workspacePlan` text DEFAULT '{"version":1,"status":"none"}' NOT NULL,
	`sessionHistory` text NOT NULL,
	`authorizationSnapshot` text NOT NULL,
	`contextPlan` text NOT NULL,
	`status` text NOT NULL,
	`startedAt` text,
	`endedAt` text,
	`outcome` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Task_inboundEventId_key` ON `Task` (`inboundEventId`);--> statement-breakpoint
CREATE INDEX `Task_tagId_createdAt_idx` ON `Task` (`tagId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `Task_sessionId_createdAt_idx` ON `Task` (`sessionId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `Task_status_idx` ON `Task` (`status`);--> statement-breakpoint
CREATE TABLE `Team` (
	`id` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`objectiveIds` text DEFAULT '[]' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`scaling` text DEFAULT '{}' NOT NULL,
	`name` text NOT NULL,
	`leadTagId` text NOT NULL,
	`memberTagIds` text NOT NULL,
	`parentTeamId` text,
	`maxConcurrency` integer NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leadTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `Team_objective_idx` ON `Team` (`objectiveId`);--> statement-breakpoint
CREATE INDEX `Team_parent_idx` ON `Team` (`parentTeamId`);--> statement-breakpoint
CREATE TABLE `WorkerArtifactInventory` (
	`workerHostId` text PRIMARY KEY NOT NULL,
	`connectionGeneration` integer NOT NULL,
	`inventoryRevision` integer NOT NULL,
	`transferBaseUrl` text NOT NULL,
	`observedAt` text NOT NULL,
	FOREIGN KEY (`workerHostId`) REFERENCES `WorkerHost`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `WorkerHostCredential` (
	`workerHostId` text NOT NULL,
	`revision` integer NOT NULL,
	`credentialId` text NOT NULL,
	`status` text NOT NULL,
	`createdAt` text NOT NULL,
	`retiredAt` text,
	FOREIGN KEY (`workerHostId`) REFERENCES `WorkerHost`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `WorkerHostCredential_host_revision_key` ON `WorkerHostCredential` (`workerHostId`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `WorkerHostCredential_credentialId_key` ON `WorkerHostCredential` (`credentialId`);--> statement-breakpoint
CREATE INDEX `WorkerHostCredential_host_status_idx` ON `WorkerHostCredential` (`workerHostId`,`status`);--> statement-breakpoint
CREATE TABLE `WorkerHost` (
	`id` text PRIMARY KEY NOT NULL,
	`credentialId` text NOT NULL,
	`credentialRevision` integer NOT NULL,
	`enrollmentStatus` text NOT NULL,
	`ephemeral` integer DEFAULT false NOT NULL,
	`authKey` text,
	`connectionGeneration` integer NOT NULL,
	`connectionStatus` text NOT NULL,
	`workletId` text,
	`protocolVersion` integer,
	`durableProtocolVersion` integer,
	`controlProtocolVersion` integer,
	`workerSnapshot` text NOT NULL,
	`grantedLabels` text DEFAULT '[]' NOT NULL,
	`capacity` integer NOT NULL,
	`availableSlots` integer NOT NULL,
	`activeAttempts` integer NOT NULL,
	`ready` integer NOT NULL,
	`draining` integer NOT NULL,
	`lastAuthenticatedAt` text,
	`failedAuthenticationCount` integer DEFAULT 0 NOT NULL,
	`lastAuthenticationFailureAt` text,
	`lastSeenAt` text,
	`connectedAt` text,
	`disconnectedAt` text,
	`revokedAt` text,
	`revocationReason` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `WorkerHost_credentialId_key` ON `WorkerHost` (`credentialId`);--> statement-breakpoint
CREATE INDEX `WorkerHost_enrollment_connection_idx` ON `WorkerHost` (`enrollmentStatus`,`connectionStatus`);--> statement-breakpoint
CREATE INDEX `WorkerHost_lastSeenAt_idx` ON `WorkerHost` (`lastSeenAt`);--> statement-breakpoint
CREATE TABLE `WorkspacePullRequestTransition` (
	`taskId` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`action` text NOT NULL,
	`attemptCount` integer NOT NULL,
	`nextAttemptAt` text NOT NULL,
	`lastError` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `WorkspacePullRequestTransition_nextAttemptAt_idx` ON `WorkspacePullRequestTransition` (`nextAttemptAt`);--> statement-breakpoint
CREATE TABLE `Workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text,
	`ref` text,
	`setup` text,
	`delivery` text NOT NULL,
	`revision` integer NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Workspace_name_key` ON `Workspace` (`name`);--> statement-breakpoint
CREATE TABLE `WorkstreamPost` (
	`id` text PRIMARY KEY NOT NULL,
	`workstreamId` text NOT NULL,
	`authorTagId` text NOT NULL,
	`sourceTaskId` text,
	`body` text NOT NULL,
	`references` text NOT NULL,
	`replyTo` text,
	`sequence` integer NOT NULL,
	`createdAt` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	FOREIGN KEY (`workstreamId`) REFERENCES `Workstream`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`authorTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_sequence_key` ON `WorkstreamPost` (`workstreamId`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_idempotency_key` ON `WorkstreamPost` (`workstreamId`,`authorTagId`,`idempotencyKey`);--> statement-breakpoint
CREATE TABLE `Workstream` (
	`id` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`title` text NOT NULL,
	`ownerTagId` text NOT NULL,
	`participantTagIds` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`ownerTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `Workstream_objective_idx` ON `Workstream` (`objectiveId`);--> statement-breakpoint
CREATE INDEX `Workstream_owner_idx` ON `Workstream` (`ownerTagId`);