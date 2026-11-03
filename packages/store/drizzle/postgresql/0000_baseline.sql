CREATE TABLE "ApprovalRequest" (
	"id" text PRIMARY KEY NOT NULL,
	"objectiveId" text,
	"taskId" text NOT NULL,
	"attemptId" text,
	"requestingTagId" text NOT NULL,
	"kind" text NOT NULL,
	"actions" jsonb NOT NULL,
	"argumentsDigest" text,
	"summary" text NOT NULL,
	"ruleSources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approvers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"scope" text,
	"validUntil" text,
	"decidedBy" text,
	"decidedByKind" text,
	"decidedAt" text,
	"reason" text,
	"consumedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ArtifactAcquisition" (
	"id" text PRIMARY KEY NOT NULL,
	"operationId" text NOT NULL,
	"artifactId" text NOT NULL,
	"taskId" text NOT NULL,
	"attemptId" text NOT NULL,
	"paths" jsonb NOT NULL,
	"delivery" text NOT NULL,
	"destination" text,
	"status" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ArtifactApprovalAuditEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"approvalType" text NOT NULL,
	"approvalId" text NOT NULL,
	"objectiveId" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"actorKind" text NOT NULL,
	"actorId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ArtifactConsumptionApproval" (
	"id" text PRIMARY KEY NOT NULL,
	"publicationApprovalId" text NOT NULL,
	"objectiveId" text NOT NULL,
	"approvedByKind" text NOT NULL,
	"approvedById" text NOT NULL,
	"approvedAt" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"withdrawnByKind" text,
	"withdrawnById" text,
	"withdrawnAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ArtifactPublicationApproval" (
	"id" text PRIMARY KEY NOT NULL,
	"sourceTaskId" text NOT NULL,
	"sourceObjectiveId" text NOT NULL,
	"artifactId" text DEFAULT '' NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sourceAttemptId" text NOT NULL,
	"sourceAttemptCount" integer NOT NULL,
	"reviewedByTagId" text NOT NULL,
	"assessment" text NOT NULL,
	"acceptedAt" text NOT NULL,
	"audienceObjectiveIds" jsonb NOT NULL,
	"approvedByKind" text NOT NULL,
	"approvedById" text NOT NULL,
	"approvedAt" text NOT NULL,
	"supersedesPublicationId" text,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"withdrawnByKind" text,
	"withdrawnById" text,
	"withdrawnAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ArtifactStorageLocation" (
	"workerHostId" text NOT NULL,
	"digest" text NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"connectionGeneration" integer NOT NULL,
	"inventoryRevision" integer NOT NULL,
	"transferBaseUrl" text NOT NULL,
	"status" text NOT NULL,
	"observedAt" text NOT NULL,
	"unavailableAt" text
);
--> statement-breakpoint
CREATE TABLE "ArtifactUpload" (
	"attemptId" text NOT NULL,
	"taskId" text NOT NULL,
	"digest" text NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"kind" text NOT NULL,
	"location" text NOT NULL,
	"contentHash" text,
	"sourceReferences" jsonb,
	"metadata" jsonb,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuditEntry" (
	"id" text PRIMARY KEY NOT NULL,
	"at" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"outcome" text NOT NULL,
	"status" integer,
	"source" text NOT NULL,
	"method" text,
	"path" text
);
--> statement-breakpoint
CREATE TABLE "AuthKey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lookupId" text NOT NULL,
	"secretDigest" text NOT NULL,
	"tagIds" jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reusable" boolean NOT NULL,
	"ephemeral" boolean NOT NULL,
	"expiresAt" text NOT NULL,
	"usedAt" text,
	"redemptionCount" integer DEFAULT 0 NOT NULL,
	"revokedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "CapturedArtifact" (
	"id" text PRIMARY KEY NOT NULL,
	"operationId" text NOT NULL,
	"taskId" text NOT NULL,
	"attemptId" text NOT NULL,
	"tagId" text NOT NULL,
	"sessionId" text NOT NULL,
	"objectiveId" text,
	"title" text NOT NULL,
	"summary" text,
	"kind" text NOT NULL,
	"entries" jsonb NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"harnessSession" jsonb,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DurableInboundEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"surfaceAccountId" text NOT NULL,
	"tagRouteId" text NOT NULL,
	"tagId" text NOT NULL,
	"execution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"admissionOrder" serial NOT NULL,
	"sessionBlocked" boolean DEFAULT false NOT NULL,
	"sessionKey" text NOT NULL,
	"authorization" jsonb NOT NULL,
	"contextPlan" jsonb NOT NULL,
	"deliveryId" text NOT NULL,
	"logicalEventId" text NOT NULL,
	"event" jsonb NOT NULL,
	"status" text NOT NULL,
	"attemptCount" integer NOT NULL,
	"maxAttempts" integer NOT NULL,
	"availableAt" text NOT NULL,
	"leaseOwner" text,
	"leaseExpiresAt" text,
	"lastError" text,
	"completedAt" text,
	"failedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "InboundControlDelivery" (
	"inboundEventId" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"attemptId" text NOT NULL,
	"command" jsonb NOT NULL,
	"workerHostId" text,
	"workerId" text,
	"status" text NOT NULL,
	"detail" jsonb,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "InboundEventKey" (
	"id" text PRIMARY KEY NOT NULL,
	"surfaceAccountId" text NOT NULL,
	"eventId" text NOT NULL,
	"claimedAt" text NOT NULL,
	"taskId" text
);
--> statement-breakpoint
CREATE TABLE "ObjectiveMessage" (
	"id" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"senderTagId" text NOT NULL,
	"sourceTaskId" text NOT NULL,
	"type" text NOT NULL,
	"body" jsonb NOT NULL,
	"idempotencyKey" text NOT NULL,
	"fingerprint" text NOT NULL,
	"replyMessageId" text,
	"repliedByOperatorId" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ObjectiveSession" (
	"sessionId" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"surfaceTaskId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Objective" (
	"id" text PRIMARY KEY NOT NULL,
	"ongoing" boolean DEFAULT false NOT NULL,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observationState" jsonb DEFAULT '{"cursors":{}}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"ownerTagId" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"lockRevision" integer DEFAULT 0 NOT NULL,
	"executionStartedAt" text,
	"surfaceTaskId" text,
	"notificationTaskId" text,
	"surfaceSessionId" text,
	"deadline" text,
	"budgetLimitMinor" integer,
	"budgetCurrency" text,
	"limitState" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spentMinor" integer DEFAULT 0 NOT NULL,
	"reservedMinor" integer DEFAULT 0 NOT NULL,
	"runtimeActions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completionSummary" text,
	"cancelledAt" text,
	"cancellationReason" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OperatorNotificationItem" (
	"destination" text NOT NULL,
	"itemKey" text NOT NULL,
	"notificationId" text NOT NULL,
	"objectiveId" text NOT NULL,
	"createdAt" text NOT NULL,
	CONSTRAINT "OperatorNotificationItem_destination_itemKey_pk" PRIMARY KEY("destination","itemKey")
);
--> statement-breakpoint
CREATE TABLE "OperatorNotification" (
	"id" text PRIMARY KEY NOT NULL,
	"destination" text NOT NULL,
	"objectiveId" text NOT NULL,
	"itemKeys" jsonb NOT NULL,
	"text" text NOT NULL,
	"immediate" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"attemptCount" integer NOT NULL,
	"maxAttempts" integer NOT NULL,
	"availableAt" text NOT NULL,
	"leaseOwner" text,
	"leaseExpiresAt" text,
	"lastError" text,
	"externalMessageId" text,
	"deliveredAt" text,
	"failedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OperatorToken" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lookupId" text NOT NULL,
	"secretDigest" text NOT NULL,
	"expiresAt" text NOT NULL,
	"lastUsedAt" text,
	"revokedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OutboundReply" (
	"id" text PRIMARY KEY NOT NULL,
	"inboundEventId" text NOT NULL,
	"surfaceAccountId" text NOT NULL,
	"workerId" text NOT NULL,
	"callback" jsonb NOT NULL,
	"presentation" text DEFAULT 'final-result' NOT NULL,
	"deliveryKey" text DEFAULT 'final' NOT NULL,
	"text" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"attemptCount" integer NOT NULL,
	"maxAttempts" integer NOT NULL,
	"availableAt" text NOT NULL,
	"leaseOwner" text,
	"leaseExpiresAt" text,
	"lastError" text,
	"externalMessageId" text,
	"deliveredAt" text,
	"failedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ResourceChange" (
	"id" text PRIMARY KEY NOT NULL,
	"resourceType" text NOT NULL,
	"resourceId" text NOT NULL,
	"fromRevision" integer NOT NULL,
	"toRevision" integer NOT NULL,
	"actorTagId" text,
	"operatorId" text,
	"sourceTaskId" text,
	"sourceMessageId" text,
	"changes" jsonb NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ResourceManagement" (
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"applySet" text,
	"fields" jsonb NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "ResourceManagement_kind_name_pk" PRIMARY KEY("kind","name")
);
--> statement-breakpoint
CREATE TABLE "RoleAssignment" (
	"id" text PRIMARY KEY NOT NULL,
	"roleId" text NOT NULL,
	"tagId" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RoleContextSet" (
	"roleId" text NOT NULL,
	"contextSetId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RolePermissionSet" (
	"roleId" text NOT NULL,
	"permissionSetId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Role" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"instructions" text NOT NULL,
	"execution" jsonb,
	"origin" text NOT NULL,
	"systemKey" text,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SessionState" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionId" text NOT NULL,
	"taskId" text NOT NULL,
	"attemptId" text NOT NULL,
	"harnessId" text NOT NULL,
	"nativeId" text,
	"ref" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"status" text NOT NULL,
	"writeVersion" bigint NOT NULL,
	"compatibility" text,
	"workerProfile" jsonb,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Session" (
	"id" text PRIMARY KEY NOT NULL,
	"tagId" text NOT NULL,
	"sessionKey" text NOT NULL,
	"origin" jsonb NOT NULL,
	"state" text NOT NULL,
	"lastInteractionAt" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SurfaceAccount" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"externalAccountId" text NOT NULL,
	"displayName" text NOT NULL,
	"authMethod" text NOT NULL,
	"credentialId" text NOT NULL,
	"status" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"name" text,
	"secretReferences" jsonb,
	"lastVerifiedAt" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagContextActivation" (
	"id" text PRIMARY KEY NOT NULL,
	"contextSetId" text NOT NULL,
	"tagRouteId" text NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagContextItem" (
	"id" text PRIMARY KEY NOT NULL,
	"contextSetId" text NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"required" boolean NOT NULL,
	"itemKey" text NOT NULL,
	"config" jsonb NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagContextSet" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagMailboxCredential" (
	"id" text PRIMARY KEY NOT NULL,
	"tagId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagMessage" (
	"id" text PRIMARY KEY NOT NULL,
	"senderTagId" text NOT NULL,
	"recipientTagId" text NOT NULL,
	"recipientTeamId" text,
	"operatorId" text,
	"objectiveId" text NOT NULL,
	"workstreamId" text,
	"type" text NOT NULL,
	"body" jsonb NOT NULL,
	"bodyPrunedAt" text,
	"idempotencyKey" text NOT NULL,
	"fingerprint" text NOT NULL,
	"inReplyTo" text,
	"status" text NOT NULL,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"leaseToken" text,
	"leaseCredentialId" text,
	"leaseExpiresAt" text,
	"processedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagMessagingGrant" (
	"senderTagId" text NOT NULL,
	"recipientTagId" text NOT NULL,
	"messageTypes" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagPermissionActivation" (
	"id" text PRIMARY KEY NOT NULL,
	"permissionSetId" text NOT NULL,
	"tagRouteId" text NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagPermissionSet" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"approvers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagPermission" (
	"id" text PRIMARY KEY NOT NULL,
	"permissionSetId" text NOT NULL,
	"target" text DEFAULT 'surface' NOT NULL,
	"surfaceAccountId" text,
	"scope" text NOT NULL,
	"reference" text,
	"action" text NOT NULL,
	"approval" text,
	"createdBy" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagRoute" (
	"id" text PRIMARY KEY NOT NULL,
	"tagId" text NOT NULL,
	"surfaceAccountId" text NOT NULL,
	"scope" text NOT NULL,
	"enabled" boolean NOT NULL,
	"workspaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdBy" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TagWorkerHostBinding" (
	"tagId" text NOT NULL,
	"workerHostId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Tag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"runsOn" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution" jsonb,
	"retiredAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TaskAssignment" (
	"taskId" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"workstreamId" text,
	"teamId" text NOT NULL,
	"requestedByTagId" text NOT NULL,
	"assignedTagId" text NOT NULL,
	"parentTaskId" text,
	"waitState" jsonb,
	"sourceMessageId" text,
	"instruction" text NOT NULL,
	"acceptanceCriteria" jsonb NOT NULL,
	"dependencies" jsonb NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"approval" text NOT NULL,
	"leaseOwner" text,
	"leaseExpiresAt" text,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"availableAt" text NOT NULL,
	"reservedMinor" integer DEFAULT 0 NOT NULL,
	"chargedMinor" integer,
	"result" jsonb,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TaskAttempt" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"attemptNumber" integer NOT NULL,
	"workerProfileId" text NOT NULL,
	"workerProfileRevision" text NOT NULL,
	"workerSnapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"startedAt" text NOT NULL,
	"endedAt" text,
	"outcome" jsonb,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TaskEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" text NOT NULL,
	"attemptId" text,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TaskReference" (
	"id" text PRIMARY KEY NOT NULL,
	"artifactId" text NOT NULL,
	"provider" text NOT NULL,
	"surfaceAccountId" text,
	"resourceType" text NOT NULL,
	"resourceId" text,
	"reference" text NOT NULL,
	"relationship" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Task" (
	"id" text PRIMARY KEY NOT NULL,
	"inboundEventId" text,
	"tagId" text NOT NULL,
	"sessionId" text NOT NULL,
	"surfaceObjectiveId" text,
	"execution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"trigger" jsonb NOT NULL,
	"requestText" text,
	"responseText" text,
	"result" jsonb,
	"workspacePlan" jsonb DEFAULT '{"version":1,"status":"none"}'::jsonb NOT NULL,
	"sessionHistory" jsonb NOT NULL,
	"authorizationSnapshot" jsonb NOT NULL,
	"contextPlan" jsonb NOT NULL,
	"status" text NOT NULL,
	"startedAt" text,
	"endedAt" text,
	"outcome" jsonb,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Team" (
	"id" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"objectiveIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scaling" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name" text NOT NULL,
	"leadTagId" text NOT NULL,
	"memberTagIds" jsonb NOT NULL,
	"parentTeamId" text,
	"maxConcurrency" integer NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorkerArtifactInventory" (
	"workerHostId" text PRIMARY KEY NOT NULL,
	"connectionGeneration" integer NOT NULL,
	"inventoryRevision" integer NOT NULL,
	"transferBaseUrl" text NOT NULL,
	"observedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorkerHostCredential" (
	"workerHostId" text NOT NULL,
	"revision" integer NOT NULL,
	"credentialId" text NOT NULL,
	"status" text NOT NULL,
	"createdAt" text NOT NULL,
	"retiredAt" text
);
--> statement-breakpoint
CREATE TABLE "WorkerHost" (
	"id" text PRIMARY KEY NOT NULL,
	"credentialId" text NOT NULL,
	"credentialRevision" integer NOT NULL,
	"enrollmentStatus" text NOT NULL,
	"ephemeral" boolean DEFAULT false NOT NULL,
	"authKey" text,
	"connectionGeneration" integer NOT NULL,
	"connectionStatus" text NOT NULL,
	"workletId" text,
	"protocolVersion" integer,
	"durableProtocolVersion" integer,
	"controlProtocolVersion" integer,
	"workerSnapshot" jsonb NOT NULL,
	"grantedLabels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capacity" integer NOT NULL,
	"availableSlots" integer NOT NULL,
	"activeAttempts" integer NOT NULL,
	"ready" boolean NOT NULL,
	"draining" boolean NOT NULL,
	"lastAuthenticatedAt" text,
	"failedAuthenticationCount" integer DEFAULT 0 NOT NULL,
	"lastAuthenticationFailureAt" text,
	"lastSeenAt" text,
	"connectedAt" text,
	"disconnectedAt" text,
	"revokedAt" text,
	"revocationReason" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorkspacePullRequestTransition" (
	"taskId" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"action" text NOT NULL,
	"attemptCount" integer NOT NULL,
	"nextAttemptAt" text NOT NULL,
	"lastError" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source" text,
	"ref" text,
	"setup" text,
	"delivery" text NOT NULL,
	"revision" integer NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorkstreamPost" (
	"id" text PRIMARY KEY NOT NULL,
	"workstreamId" text NOT NULL,
	"authorTagId" text NOT NULL,
	"sourceTaskId" text,
	"body" text NOT NULL,
	"references" jsonb NOT NULL,
	"replyTo" text,
	"sequence" integer NOT NULL,
	"createdAt" text NOT NULL,
	"idempotencyKey" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Workstream" (
	"id" text PRIMARY KEY NOT NULL,
	"objectiveId" text NOT NULL,
	"title" text NOT NULL,
	"ownerTagId" text NOT NULL,
	"participantTagIds" jsonb NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ArtifactAcquisition" ADD CONSTRAINT "ArtifactAcquisition_artifactId_CapturedArtifact_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."CapturedArtifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactAcquisition" ADD CONSTRAINT "ArtifactAcquisition_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactAcquisition" ADD CONSTRAINT "ArtifactAcquisition_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactApprovalAuditEvent" ADD CONSTRAINT "ArtifactApprovalAuditEvent_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactConsumptionApproval" ADD CONSTRAINT "ArtifactConsumptionApproval_publicationApprovalId_ArtifactPublicationApproval_id_fk" FOREIGN KEY ("publicationApprovalId") REFERENCES "public"."ArtifactPublicationApproval"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactConsumptionApproval" ADD CONSTRAINT "ArtifactConsumptionApproval_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactPublicationApproval" ADD CONSTRAINT "ArtifactPublicationApproval_sourceTaskId_TaskAssignment_taskId_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."TaskAssignment"("taskId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactPublicationApproval" ADD CONSTRAINT "ArtifactPublicationApproval_sourceObjectiveId_Objective_id_fk" FOREIGN KEY ("sourceObjectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactPublicationApproval" ADD CONSTRAINT "ArtifactPublicationApproval_sourceAttemptId_TaskAttempt_id_fk" FOREIGN KEY ("sourceAttemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactPublicationApproval" ADD CONSTRAINT "ArtifactPublicationApproval_reviewedByTagId_Tag_id_fk" FOREIGN KEY ("reviewedByTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactStorageLocation" ADD CONSTRAINT "ArtifactStorageLocation_workerHostId_WorkerHost_id_fk" FOREIGN KEY ("workerHostId") REFERENCES "public"."WorkerHost"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactUpload" ADD CONSTRAINT "ArtifactUpload_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactUpload" ADD CONSTRAINT "ArtifactUpload_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CapturedArtifact" ADD CONSTRAINT "CapturedArtifact_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CapturedArtifact" ADD CONSTRAINT "CapturedArtifact_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CapturedArtifact" ADD CONSTRAINT "CapturedArtifact_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CapturedArtifact" ADD CONSTRAINT "CapturedArtifact_sessionId_Session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CapturedArtifact" ADD CONSTRAINT "CapturedArtifact_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DurableInboundEvent" ADD CONSTRAINT "DurableInboundEvent_surfaceAccountId_SurfaceAccount_id_fk" FOREIGN KEY ("surfaceAccountId") REFERENCES "public"."SurfaceAccount"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InboundControlDelivery" ADD CONSTRAINT "InboundControlDelivery_inboundEventId_DurableInboundEvent_id_fk" FOREIGN KEY ("inboundEventId") REFERENCES "public"."DurableInboundEvent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InboundControlDelivery" ADD CONSTRAINT "InboundControlDelivery_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InboundControlDelivery" ADD CONSTRAINT "InboundControlDelivery_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "InboundEventKey" ADD CONSTRAINT "InboundEventKey_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveMessage" ADD CONSTRAINT "ObjectiveMessage_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveMessage" ADD CONSTRAINT "ObjectiveMessage_senderTagId_Tag_id_fk" FOREIGN KEY ("senderTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveMessage" ADD CONSTRAINT "ObjectiveMessage_sourceTaskId_TaskAssignment_taskId_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."TaskAssignment"("taskId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveMessage" ADD CONSTRAINT "ObjectiveMessage_replyMessageId_TagMessage_id_fk" FOREIGN KEY ("replyMessageId") REFERENCES "public"."TagMessage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveSession" ADD CONSTRAINT "ObjectiveSession_sessionId_Session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveSession" ADD CONSTRAINT "ObjectiveSession_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ObjectiveSession" ADD CONSTRAINT "ObjectiveSession_surfaceTaskId_Task_id_fk" FOREIGN KEY ("surfaceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_ownerTagId_Tag_id_fk" FOREIGN KEY ("ownerTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_surfaceTaskId_Task_id_fk" FOREIGN KEY ("surfaceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_notificationTaskId_Task_id_fk" FOREIGN KEY ("notificationTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Objective" ADD CONSTRAINT "Objective_surfaceSessionId_Session_id_fk" FOREIGN KEY ("surfaceSessionId") REFERENCES "public"."Session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OperatorNotificationItem" ADD CONSTRAINT "OperatorNotificationItem_notificationId_OperatorNotification_id_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."OperatorNotification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OutboundReply" ADD CONSTRAINT "OutboundReply_inboundEventId_DurableInboundEvent_id_fk" FOREIGN KEY ("inboundEventId") REFERENCES "public"."DurableInboundEvent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OutboundReply" ADD CONSTRAINT "OutboundReply_surfaceAccountId_SurfaceAccount_id_fk" FOREIGN KEY ("surfaceAccountId") REFERENCES "public"."SurfaceAccount"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResourceChange" ADD CONSTRAINT "ResourceChange_actorTagId_Tag_id_fk" FOREIGN KEY ("actorTagId") REFERENCES "public"."Tag"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResourceChange" ADD CONSTRAINT "ResourceChange_sourceTaskId_Task_id_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."Task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResourceChange" ADD CONSTRAINT "ResourceChange_sourceMessageId_TagMessage_id_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."TagMessage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_Role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."Role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoleContextSet" ADD CONSTRAINT "RoleContextSet_roleId_Role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."Role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RoleContextSet" ADD CONSTRAINT "RoleContextSet_contextSetId_TagContextSet_id_fk" FOREIGN KEY ("contextSetId") REFERENCES "public"."TagContextSet"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RolePermissionSet" ADD CONSTRAINT "RolePermissionSet_roleId_Role_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."Role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RolePermissionSet" ADD CONSTRAINT "RolePermissionSet_permissionSetId_TagPermissionSet_id_fk" FOREIGN KEY ("permissionSetId") REFERENCES "public"."TagPermissionSet"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SessionState" ADD CONSTRAINT "SessionState_sessionId_Session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SessionState" ADD CONSTRAINT "SessionState_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SessionState" ADD CONSTRAINT "SessionState_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagContextActivation" ADD CONSTRAINT "TagContextActivation_contextSetId_TagContextSet_id_fk" FOREIGN KEY ("contextSetId") REFERENCES "public"."TagContextSet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagContextActivation" ADD CONSTRAINT "TagContextActivation_tagRouteId_TagRoute_id_fk" FOREIGN KEY ("tagRouteId") REFERENCES "public"."TagRoute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagContextItem" ADD CONSTRAINT "TagContextItem_contextSetId_TagContextSet_id_fk" FOREIGN KEY ("contextSetId") REFERENCES "public"."TagContextSet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMailboxCredential" ADD CONSTRAINT "TagMailboxCredential_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_senderTagId_Tag_id_fk" FOREIGN KEY ("senderTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_recipientTagId_Tag_id_fk" FOREIGN KEY ("recipientTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessage" ADD CONSTRAINT "TagMessage_workstreamId_Workstream_id_fk" FOREIGN KEY ("workstreamId") REFERENCES "public"."Workstream"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessagingGrant" ADD CONSTRAINT "TagMessagingGrant_senderTagId_Tag_id_fk" FOREIGN KEY ("senderTagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagMessagingGrant" ADD CONSTRAINT "TagMessagingGrant_recipientTagId_Tag_id_fk" FOREIGN KEY ("recipientTagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagPermissionActivation" ADD CONSTRAINT "TagPermissionActivation_permissionSetId_TagPermissionSet_id_fk" FOREIGN KEY ("permissionSetId") REFERENCES "public"."TagPermissionSet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagPermissionActivation" ADD CONSTRAINT "TagPermissionActivation_tagRouteId_TagRoute_id_fk" FOREIGN KEY ("tagRouteId") REFERENCES "public"."TagRoute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagPermission" ADD CONSTRAINT "TagPermission_permissionSetId_TagPermissionSet_id_fk" FOREIGN KEY ("permissionSetId") REFERENCES "public"."TagPermissionSet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagPermission" ADD CONSTRAINT "TagPermission_surfaceAccountId_SurfaceAccount_id_fk" FOREIGN KEY ("surfaceAccountId") REFERENCES "public"."SurfaceAccount"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagRoute" ADD CONSTRAINT "TagRoute_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagRoute" ADD CONSTRAINT "TagRoute_surfaceAccountId_SurfaceAccount_id_fk" FOREIGN KEY ("surfaceAccountId") REFERENCES "public"."SurfaceAccount"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagWorkerHostBinding" ADD CONSTRAINT "TagWorkerHostBinding_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_workstreamId_Workstream_id_fk" FOREIGN KEY ("workstreamId") REFERENCES "public"."Workstream"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_teamId_Team_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_requestedByTagId_Tag_id_fk" FOREIGN KEY ("requestedByTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_assignedTagId_Tag_id_fk" FOREIGN KEY ("assignedTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_sourceMessageId_TagMessage_id_fk" FOREIGN KEY ("sourceMessageId") REFERENCES "public"."TagMessage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskAttempt" ADD CONSTRAINT "TaskAttempt_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_attemptId_TaskAttempt_id_fk" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskAttempt"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TaskReference" ADD CONSTRAINT "TaskReference_artifactId_Artifact_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."Artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_sessionId_Session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Team" ADD CONSTRAINT "Team_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Team" ADD CONSTRAINT "Team_leadTagId_Tag_id_fk" FOREIGN KEY ("leadTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkerArtifactInventory" ADD CONSTRAINT "WorkerArtifactInventory_workerHostId_WorkerHost_id_fk" FOREIGN KEY ("workerHostId") REFERENCES "public"."WorkerHost"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkerHostCredential" ADD CONSTRAINT "WorkerHostCredential_workerHostId_WorkerHost_id_fk" FOREIGN KEY ("workerHostId") REFERENCES "public"."WorkerHost"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkspacePullRequestTransition" ADD CONSTRAINT "WorkspacePullRequestTransition_taskId_Task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_workstreamId_Workstream_id_fk" FOREIGN KEY ("workstreamId") REFERENCES "public"."Workstream"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_authorTagId_Tag_id_fk" FOREIGN KEY ("authorTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WorkstreamPost" ADD CONSTRAINT "WorkstreamPost_sourceTaskId_Task_id_fk" FOREIGN KEY ("sourceTaskId") REFERENCES "public"."Task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Workstream" ADD CONSTRAINT "Workstream_ownerTagId_Tag_id_fk" FOREIGN KEY ("ownerTagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ApprovalRequest_objective_status_idx" ON "ApprovalRequest" USING btree ("objectiveId","status","scope");--> statement-breakpoint
CREATE INDEX "ApprovalRequest_task_status_idx" ON "ApprovalRequest" USING btree ("taskId","status");--> statement-breakpoint
CREATE INDEX "ApprovalRequest_status_created_idx" ON "ApprovalRequest" USING btree ("status","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ArtifactAcquisition_attempt_operation_key" ON "ArtifactAcquisition" USING btree ("attemptId","operationId");--> statement-breakpoint
CREATE INDEX "ArtifactAcquisition_attempt_created_idx" ON "ArtifactAcquisition" USING btree ("attemptId","createdAt","id");--> statement-breakpoint
CREATE INDEX "ArtifactAcquisition_artifact_idx" ON "ArtifactAcquisition" USING btree ("artifactId");--> statement-breakpoint
CREATE UNIQUE INDEX "ArtifactApprovalAuditEvent_approval_revision_key" ON "ArtifactApprovalAuditEvent" USING btree ("approvalType","approvalId","revision");--> statement-breakpoint
CREATE INDEX "ArtifactApprovalAuditEvent_objective_idx" ON "ArtifactApprovalAuditEvent" USING btree ("objectiveId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ArtifactConsumptionApproval_publication_objective_key" ON "ArtifactConsumptionApproval" USING btree ("publicationApprovalId","objectiveId");--> statement-breakpoint
CREATE INDEX "ArtifactConsumptionApproval_objective_status_idx" ON "ArtifactConsumptionApproval" USING btree ("objectiveId","status");--> statement-breakpoint
CREATE INDEX "ArtifactPublicationApproval_source_idx" ON "ArtifactPublicationApproval" USING btree ("sourceObjectiveId","sourceTaskId");--> statement-breakpoint
CREATE INDEX "ArtifactPublicationApproval_status_idx" ON "ArtifactPublicationApproval" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ArtifactStorageLocation_host_digest_key" ON "ArtifactStorageLocation" USING btree ("workerHostId","digest");--> statement-breakpoint
CREATE INDEX "ArtifactStorageLocation_digest_status_idx" ON "ArtifactStorageLocation" USING btree ("digest","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ArtifactUpload_attempt_digest_key" ON "ArtifactUpload" USING btree ("attemptId","digest");--> statement-breakpoint
CREATE INDEX "Artifact_taskId_kind_idx" ON "Artifact" USING btree ("taskId","kind");--> statement-breakpoint
CREATE INDEX "AuditEntry_at_idx" ON "AuditEntry" USING btree ("at");--> statement-breakpoint
CREATE INDEX "AuditEntry_actor_at_idx" ON "AuditEntry" USING btree ("actor","at");--> statement-breakpoint
CREATE UNIQUE INDEX "AuthKey_name_key" ON "AuthKey" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "AuthKey_lookupId_key" ON "AuthKey" USING btree ("lookupId");--> statement-breakpoint
CREATE UNIQUE INDEX "CapturedArtifact_attempt_operation_key" ON "CapturedArtifact" USING btree ("attemptId","operationId");--> statement-breakpoint
CREATE INDEX "CapturedArtifact_objective_created_idx" ON "CapturedArtifact" USING btree ("objectiveId","createdAt","id");--> statement-breakpoint
CREATE INDEX "CapturedArtifact_session_created_idx" ON "CapturedArtifact" USING btree ("sessionId","createdAt","id");--> statement-breakpoint
CREATE INDEX "CapturedArtifact_task_created_idx" ON "CapturedArtifact" USING btree ("taskId","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "DurableInboundEvent_session_processing_key" ON "DurableInboundEvent" USING btree ("tagId","sessionKey") WHERE "DurableInboundEvent"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "DurableInboundEvent_session_queue_idx" ON "DurableInboundEvent" USING btree ("tagId","sessionKey","admissionOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "DurableInboundEvent_admissionOrder_key" ON "DurableInboundEvent" USING btree ("admissionOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "DurableInboundEvent_surfaceAccountId_deliveryId_key" ON "DurableInboundEvent" USING btree ("surfaceAccountId","deliveryId");--> statement-breakpoint
CREATE UNIQUE INDEX "DurableInboundEvent_surfaceAccountId_logicalEventId_key" ON "DurableInboundEvent" USING btree ("surfaceAccountId","logicalEventId");--> statement-breakpoint
CREATE INDEX "DurableInboundEvent_status_availableAt_idx" ON "DurableInboundEvent" USING btree ("status","availableAt");--> statement-breakpoint
CREATE INDEX "DurableInboundEvent_status_leaseExpiresAt_idx" ON "DurableInboundEvent" USING btree ("status","leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "InboundControlDelivery_attempt_idx" ON "InboundControlDelivery" USING btree ("attemptId");--> statement-breakpoint
CREATE UNIQUE INDEX "InboundEventKey_surfaceAccountId_eventId_key" ON "InboundEventKey" USING btree ("surfaceAccountId","eventId");--> statement-breakpoint
CREATE INDEX "InboundEventKey_taskId_idx" ON "InboundEventKey" USING btree ("taskId");--> statement-breakpoint
CREATE UNIQUE INDEX "ObjectiveMessage_sender_key" ON "ObjectiveMessage" USING btree ("objectiveId","senderTagId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "ObjectiveMessage_pending_idx" ON "ObjectiveMessage" USING btree ("replyMessageId","createdAt","id");--> statement-breakpoint
CREATE INDEX "ObjectiveMessage_objective_idx" ON "ObjectiveMessage" USING btree ("objectiveId","createdAt","id");--> statement-breakpoint
CREATE INDEX "ObjectiveSession_objectiveId_idx" ON "ObjectiveSession" USING btree ("objectiveId");--> statement-breakpoint
CREATE INDEX "Objective_owner_idx" ON "Objective" USING btree ("ownerTagId");--> statement-breakpoint
CREATE UNIQUE INDEX "Objective_surfaceSessionId_key" ON "Objective" USING btree ("surfaceSessionId");--> statement-breakpoint
CREATE INDEX "OperatorNotificationItem_notification_idx" ON "OperatorNotificationItem" USING btree ("notificationId");--> statement-breakpoint
CREATE INDEX "OperatorNotification_destination_objective_idx" ON "OperatorNotification" USING btree ("destination","objectiveId","createdAt");--> statement-breakpoint
CREATE INDEX "OperatorNotification_status_availableAt_idx" ON "OperatorNotification" USING btree ("status","availableAt");--> statement-breakpoint
CREATE INDEX "OperatorNotification_status_leaseExpiresAt_idx" ON "OperatorNotification" USING btree ("status","leaseExpiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "OperatorToken_name_key" ON "OperatorToken" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "OperatorToken_lookupId_key" ON "OperatorToken" USING btree ("lookupId");--> statement-breakpoint
CREATE UNIQUE INDEX "OutboundReply_inboundEventId_deliveryKey_key" ON "OutboundReply" USING btree ("inboundEventId","deliveryKey");--> statement-breakpoint
CREATE INDEX "OutboundReply_status_availableAt_idx" ON "OutboundReply" USING btree ("status","availableAt");--> statement-breakpoint
CREATE INDEX "OutboundReply_status_leaseExpiresAt_idx" ON "OutboundReply" USING btree ("status","leaseExpiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ResourceChange_resource_revision_key" ON "ResourceChange" USING btree ("resourceType","resourceId","toRevision");--> statement-breakpoint
CREATE INDEX "ResourceChange_resource_created_idx" ON "ResourceChange" USING btree ("resourceType","resourceId","createdAt");--> statement-breakpoint
CREATE INDEX "ResourceChange_source_task_idx" ON "ResourceChange" USING btree ("sourceTaskId");--> statement-breakpoint
CREATE INDEX "ResourceChange_source_message_idx" ON "ResourceChange" USING btree ("sourceMessageId");--> statement-breakpoint
CREATE INDEX "ResourceManagement_applySet_idx" ON "ResourceManagement" USING btree ("applySet");--> statement-breakpoint
CREATE UNIQUE INDEX "RoleAssignment_roleId_tagId_key" ON "RoleAssignment" USING btree ("roleId","tagId");--> statement-breakpoint
CREATE INDEX "RoleAssignment_tagId_status_idx" ON "RoleAssignment" USING btree ("tagId","status");--> statement-breakpoint
CREATE INDEX "RoleAssignment_roleId_status_idx" ON "RoleAssignment" USING btree ("roleId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "RoleContextSet_roleId_contextSetId_key" ON "RoleContextSet" USING btree ("roleId","contextSetId");--> statement-breakpoint
CREATE INDEX "RoleContextSet_contextSetId_idx" ON "RoleContextSet" USING btree ("contextSetId");--> statement-breakpoint
CREATE UNIQUE INDEX "RolePermissionSet_roleId_permissionSetId_key" ON "RolePermissionSet" USING btree ("roleId","permissionSetId");--> statement-breakpoint
CREATE INDEX "RolePermissionSet_permissionSetId_idx" ON "RolePermissionSet" USING btree ("permissionSetId");--> statement-breakpoint
CREATE UNIQUE INDEX "Role_name_key" ON "Role" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "Role_systemKey_key" ON "Role" USING btree ("systemKey");--> statement-breakpoint
CREATE INDEX "Role_status_idx" ON "Role" USING btree ("status");--> statement-breakpoint
CREATE INDEX "SessionState_sessionId_createdAt_idx" ON "SessionState" USING btree ("sessionId","createdAt");--> statement-breakpoint
CREATE INDEX "SessionState_taskId_createdAt_idx" ON "SessionState" USING btree ("taskId","createdAt");--> statement-breakpoint
CREATE INDEX "SessionState_attemptId_idx" ON "SessionState" USING btree ("attemptId");--> statement-breakpoint
CREATE UNIQUE INDEX "Session_tagId_sessionKey_key" ON "Session" USING btree ("tagId","sessionKey");--> statement-breakpoint
CREATE INDEX "Session_lastInteractionAt_idx" ON "Session" USING btree ("lastInteractionAt");--> statement-breakpoint
CREATE UNIQUE INDEX "SurfaceAccount_provider_externalAccountId_key" ON "SurfaceAccount" USING btree ("provider","externalAccountId");--> statement-breakpoint
CREATE UNIQUE INDEX "SurfaceAccount_name_key" ON "SurfaceAccount" USING btree ("name");--> statement-breakpoint
CREATE INDEX "SurfaceAccount_provider_status_idx" ON "SurfaceAccount" USING btree ("provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "TagContextActivation_contextSetId_tagRouteId_key" ON "TagContextActivation" USING btree ("contextSetId","tagRouteId");--> statement-breakpoint
CREATE INDEX "TagContextActivation_tagRouteId_idx" ON "TagContextActivation" USING btree ("tagRouteId");--> statement-breakpoint
CREATE UNIQUE INDEX "TagContextItem_contextSetId_itemKey_key" ON "TagContextItem" USING btree ("contextSetId","itemKey");--> statement-breakpoint
CREATE UNIQUE INDEX "TagContextSet_name_key" ON "TagContextSet" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "TagMailboxCredential_tokenHash_key" ON "TagMailboxCredential" USING btree ("tokenHash");--> statement-breakpoint
CREATE UNIQUE INDEX "TagMessage_sender_idempotency_key" ON "TagMessage" USING btree ("senderTagId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "TagMessage_recipient_status_created_idx" ON "TagMessage" USING btree ("recipientTagId","status","createdAt");--> statement-breakpoint
CREATE INDEX "TagMessage_sender_history_idx" ON "TagMessage" USING btree ("senderTagId","createdAt","id");--> statement-breakpoint
CREATE INDEX "TagMessage_recipient_history_idx" ON "TagMessage" USING btree ("recipientTagId","createdAt","id");--> statement-breakpoint
CREATE INDEX "TagMessage_retention_idx" ON "TagMessage" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "TagMessage_objective_idx" ON "TagMessage" USING btree ("objectiveId");--> statement-breakpoint
CREATE INDEX "TagMessage_workstream_created_idx" ON "TagMessage" USING btree ("workstreamId","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "TagMessagingGrant_pair_key" ON "TagMessagingGrant" USING btree ("senderTagId","recipientTagId");--> statement-breakpoint
CREATE UNIQUE INDEX "TagPermissionActivation_permissionSetId_tagRouteId_key" ON "TagPermissionActivation" USING btree ("permissionSetId","tagRouteId");--> statement-breakpoint
CREATE INDEX "TagPermissionActivation_tagRouteId_idx" ON "TagPermissionActivation" USING btree ("tagRouteId");--> statement-breakpoint
CREATE UNIQUE INDEX "TagPermissionSet_name_key" ON "TagPermissionSet" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "TagPermission_surface_target_action_key" ON "TagPermission" USING btree ("permissionSetId","surfaceAccountId","scope","action") WHERE "TagPermission"."target" = 'surface';--> statement-breakpoint
CREATE UNIQUE INDEX "TagPermission_runtime_target_action_key" ON "TagPermission" USING btree ("permissionSetId","target","action") WHERE "TagPermission"."target" = 'runtime';--> statement-breakpoint
CREATE INDEX "TagPermission_permissionSetId_idx" ON "TagPermission" USING btree ("permissionSetId");--> statement-breakpoint
CREATE INDEX "TagPermission_target_idx" ON "TagPermission" USING btree ("target");--> statement-breakpoint
CREATE INDEX "TagPermission_surfaceAccountId_scope_idx" ON "TagPermission" USING btree ("surfaceAccountId","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "TagRoute_surfaceAccountId_scope_key" ON "TagRoute" USING btree ("surfaceAccountId","scope");--> statement-breakpoint
CREATE INDEX "TagRoute_tagId_idx" ON "TagRoute" USING btree ("tagId");--> statement-breakpoint
CREATE UNIQUE INDEX "TagWorkerHostBinding_tagId_workerHostId_key" ON "TagWorkerHostBinding" USING btree ("tagId","workerHostId");--> statement-breakpoint
CREATE INDEX "TagWorkerHostBinding_workerHostId_idx" ON "TagWorkerHostBinding" USING btree ("workerHostId");--> statement-breakpoint
CREATE UNIQUE INDEX "Tag_active_name_key" ON "Tag" USING btree ("name") WHERE "Tag"."status" = 'active';--> statement-breakpoint
CREATE INDEX "Tag_name_idx" ON "Tag" USING btree ("name");--> statement-breakpoint
CREATE INDEX "Tag_status_idx" ON "Tag" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "TaskAssignment_sourceMessageId_key" ON "TaskAssignment" USING btree ("sourceMessageId");--> statement-breakpoint
CREATE INDEX "TaskAssignment_objective_status_idx" ON "TaskAssignment" USING btree ("objectiveId","status");--> statement-breakpoint
CREATE INDEX "TaskAssignment_team_status_idx" ON "TaskAssignment" USING btree ("teamId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "TaskAttempt_taskId_attemptNumber_key" ON "TaskAttempt" USING btree ("taskId","attemptNumber");--> statement-breakpoint
CREATE INDEX "TaskAttempt_taskId_createdAt_idx" ON "TaskAttempt" USING btree ("taskId","createdAt");--> statement-breakpoint
CREATE INDEX "TaskAttempt_status_idx" ON "TaskAttempt" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "TaskEvent_taskId_sequence_key" ON "TaskEvent" USING btree ("taskId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "TaskReference_artifactId_provider_resourceType_reference_relationship_key" ON "TaskReference" USING btree ("artifactId","provider","resourceType","reference","relationship");--> statement-breakpoint
CREATE INDEX "TaskReference_provider_resourceType_resourceId_idx" ON "TaskReference" USING btree ("provider","resourceType","resourceId");--> statement-breakpoint
CREATE INDEX "TaskReference_provider_resourceType_reference_idx" ON "TaskReference" USING btree ("provider","resourceType","reference");--> statement-breakpoint
CREATE INDEX "TaskReference_artifactId_relationship_idx" ON "TaskReference" USING btree ("artifactId","relationship");--> statement-breakpoint
CREATE UNIQUE INDEX "Task_inboundEventId_key" ON "Task" USING btree ("inboundEventId");--> statement-breakpoint
CREATE INDEX "Task_tagId_createdAt_idx" ON "Task" USING btree ("tagId","createdAt");--> statement-breakpoint
CREATE INDEX "Task_sessionId_createdAt_idx" ON "Task" USING btree ("sessionId","createdAt");--> statement-breakpoint
CREATE INDEX "Task_status_idx" ON "Task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "Team_objective_idx" ON "Team" USING btree ("objectiveId");--> statement-breakpoint
CREATE INDEX "Team_parent_idx" ON "Team" USING btree ("parentTeamId");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkerHostCredential_host_revision_key" ON "WorkerHostCredential" USING btree ("workerHostId","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkerHostCredential_credentialId_key" ON "WorkerHostCredential" USING btree ("credentialId");--> statement-breakpoint
CREATE INDEX "WorkerHostCredential_host_status_idx" ON "WorkerHostCredential" USING btree ("workerHostId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkerHost_credentialId_key" ON "WorkerHost" USING btree ("credentialId");--> statement-breakpoint
CREATE INDEX "WorkerHost_enrollment_connection_idx" ON "WorkerHost" USING btree ("enrollmentStatus","connectionStatus");--> statement-breakpoint
CREATE INDEX "WorkerHost_lastSeenAt_idx" ON "WorkerHost" USING btree ("lastSeenAt");--> statement-breakpoint
CREATE INDEX "WorkspacePullRequestTransition_nextAttemptAt_idx" ON "WorkspacePullRequestTransition" USING btree ("nextAttemptAt");--> statement-breakpoint
CREATE UNIQUE INDEX "Workspace_name_key" ON "Workspace" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkstreamPost_sequence_key" ON "WorkstreamPost" USING btree ("workstreamId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "WorkstreamPost_idempotency_key" ON "WorkstreamPost" USING btree ("workstreamId","authorTagId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "Workstream_objective_idx" ON "Workstream" USING btree ("objectiveId");--> statement-breakpoint
CREATE INDEX "Workstream_owner_idx" ON "Workstream" USING btree ("ownerTagId");