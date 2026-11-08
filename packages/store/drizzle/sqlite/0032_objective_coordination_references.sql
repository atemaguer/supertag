PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ArtifactPublicationApproval` (
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
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceObjectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceAttemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewedByTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_ArtifactPublicationApproval`("id", "sourceTaskId", "sourceObjectiveId", "artifactId", "paths", "entries", "sourceAttemptId", "sourceAttemptCount", "reviewedByTagId", "assessment", "acceptedAt", "audienceObjectiveIds", "approvedByKind", "approvedById", "approvedAt", "supersedesPublicationId", "status", "revision", "withdrawnByKind", "withdrawnById", "withdrawnAt", "createdAt", "updatedAt") SELECT "id", "sourceTaskId", "sourceObjectiveId", "artifactId", "paths", "entries", "sourceAttemptId", "sourceAttemptCount", "reviewedByTagId", "assessment", "acceptedAt", "audienceObjectiveIds", "approvedByKind", "approvedById", "approvedAt", "supersedesPublicationId", "status", "revision", "withdrawnByKind", "withdrawnById", "withdrawnAt", "createdAt", "updatedAt" FROM `ArtifactPublicationApproval`;--> statement-breakpoint
DROP TABLE `ArtifactPublicationApproval`;--> statement-breakpoint
ALTER TABLE `__new_ArtifactPublicationApproval` RENAME TO `ArtifactPublicationApproval`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ArtifactPublicationApproval_source_idx` ON `ArtifactPublicationApproval` (`sourceObjectiveId`,`sourceTaskId`);--> statement-breakpoint
CREATE INDEX `ArtifactPublicationApproval_status_idx` ON `ArtifactPublicationApproval` (`status`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `__new_ResourceChange` (
	`id` text PRIMARY KEY NOT NULL,
	`resourceType` text NOT NULL,
	`resourceId` text NOT NULL,
	`fromRevision` integer NOT NULL,
	`toRevision` integer NOT NULL,
	`actorTagId` text,
	`operatorId` text,
	`sourceTaskId` text,
	`changes` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`actorTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_ResourceChange`("id", "resourceType", "resourceId", "fromRevision", "toRevision", "actorTagId", "operatorId", "sourceTaskId", "changes", "createdAt") SELECT "id", "resourceType", "resourceId", "fromRevision", "toRevision", "actorTagId", "operatorId", "sourceTaskId", "changes", "createdAt" FROM `ResourceChange`;--> statement-breakpoint
DROP TABLE `ResourceChange`;--> statement-breakpoint
ALTER TABLE `__new_ResourceChange` RENAME TO `ResourceChange`;--> statement-breakpoint
CREATE UNIQUE INDEX `ResourceChange_resource_revision_key` ON `ResourceChange` (`resourceType`,`resourceId`,`toRevision`);--> statement-breakpoint
CREATE INDEX `ResourceChange_resource_created_idx` ON `ResourceChange` (`resourceType`,`resourceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ResourceChange_source_task_idx` ON `ResourceChange` (`sourceTaskId`);