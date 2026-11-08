CREATE TABLE `OverlapWarning` (
	`objectiveId` text NOT NULL,
	`lowerAttemptId` text NOT NULL,
	`higherAttemptId` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`objectiveId`, `lowerAttemptId`, `higherAttemptId`, `path`)
);
--> statement-breakpoint
CREATE TABLE `TagMessage` (
	`id` text PRIMARY KEY NOT NULL,
	`senderTagId` text NOT NULL,
	`recipientTagId` text NOT NULL,
	`objectiveId` text,
	`sourceTaskId` text,
	`workstreamPostId` text,
	`text` text NOT NULL,
	`hops` integer DEFAULT 0 NOT NULL,
	`taskId` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`senderTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipientTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workstreamPostId`) REFERENCES `WorkstreamPost`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `TagMessage_recipient_task_created_idx` ON `TagMessage` (`recipientTagId`,`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `TagMessage_task_idx` ON `TagMessage` (`taskId`);--> statement-breakpoint
CREATE INDEX `TagMessage_sender_history_idx` ON `TagMessage` (`senderTagId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `TagMessage_recipient_history_idx` ON `TagMessage` (`recipientTagId`,`createdAt`,`id`);--> statement-breakpoint
CREATE TABLE `Team` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`memberTagIds` text NOT NULL,
	`maxConcurrency` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Team_name_key` ON `Team` (`name`);--> statement-breakpoint
CREATE TABLE `WorkstreamPost` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`authorTagId` text NOT NULL,
	`sourceTaskId` text,
	`to` text DEFAULT '[]' NOT NULL,
	`body` text NOT NULL,
	`sequence` integer NOT NULL,
	`createdAt` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sourceTaskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_sequence_key` ON `WorkstreamPost` (`teamId`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_idempotency_key` ON `WorkstreamPost` (`teamId`,`authorTagId`,`idempotencyKey`);--> statement-breakpoint
ALTER TABLE `Objective` ADD `teamId` text REFERENCES Team(id);--> statement-breakpoint
CREATE INDEX `Objective_teamId_idx` ON `Objective` (`teamId`);