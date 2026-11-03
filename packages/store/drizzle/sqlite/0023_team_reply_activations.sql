CREATE TABLE `TeamReplyTrigger` (
	`id` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`teamId` text NOT NULL,
	`senderTagId` text NOT NULL,
	`recipientTagId` text NOT NULL,
	`itemKind` text NOT NULL,
	`itemId` text NOT NULL,
	`itemType` text NOT NULL,
	`sourceTaskId` text,
	`taskId` text,
	`status` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`senderTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipientTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TeamReplyTrigger_item_recipient_key` ON `TeamReplyTrigger` (`itemKind`,`itemId`,`recipientTagId`);--> statement-breakpoint
CREATE INDEX `TeamReplyTrigger_status_created_idx` ON `TeamReplyTrigger` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `TeamReplyTrigger_recipient_objective_idx` ON `TeamReplyTrigger` (`recipientTagId`,`objectiveId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `TeamReplyTrigger_task_idx` ON `TeamReplyTrigger` (`taskId`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_WorkstreamPost` (
	`id` text PRIMARY KEY NOT NULL,
	`workstreamId` text NOT NULL,
	`authorTagId` text,
	`objectiveId` text NOT NULL,
	`sourceTaskId` text,
	`type` text DEFAULT 'note' NOT NULL,
	`to` text DEFAULT '[]' NOT NULL,
	`body` text NOT NULL,
	`references` text NOT NULL,
	`replyTo` text,
	`sequence` integer NOT NULL,
	`createdAt` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	FOREIGN KEY (`workstreamId`) REFERENCES `Workstream`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`authorTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_WorkstreamPost`("id", "workstreamId", "authorTagId", "objectiveId", "sourceTaskId", "type", "to", "body", "references", "replyTo", "sequence", "createdAt", "idempotencyKey") SELECT "id", "workstreamId", "authorTagId", "objectiveId", "sourceTaskId", "type", "to", "body", "references", "replyTo", "sequence", "createdAt", "idempotencyKey" FROM `WorkstreamPost`;--> statement-breakpoint
DROP TABLE `WorkstreamPost`;--> statement-breakpoint
ALTER TABLE `__new_WorkstreamPost` RENAME TO `WorkstreamPost`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_sequence_key` ON `WorkstreamPost` (`workstreamId`,`objectiveId`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_idempotency_key` ON `WorkstreamPost` (`workstreamId`,`authorTagId`,`idempotencyKey`);--> statement-breakpoint
ALTER TABLE `TaskAssignment` ADD `activationKind` text;