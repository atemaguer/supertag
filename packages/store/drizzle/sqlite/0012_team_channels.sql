-- Workstreams become Team channels: one per Team, sharing the Team ID, with everything else read
-- from the Team. Ad-hoc Workstreams and their posts go away, and so do Workstream references on
-- Mailbox messages and Tasks.
-- Old Workstreams sharing a Team's ID keep only posts written in that Team's Objective by its
-- members; a Workstream from another Objective that reused the ID is dropped with its posts.
-- SQLite applies migrations in one transaction, where PRAGMA foreign_keys has no effect, so the
-- migration runner turns enforcement off while this migration is pending. Rebuilding TagMessage
-- and Workstream in place keeps the rows that reference them; the last statements fail the
-- migration if any reference into or out of either rebuilt table is broken.
UPDATE `TaskAssignment` SET `workstreamId` = NULL
WHERE `workstreamId` IS NOT NULL AND `workstreamId` NOT IN (SELECT `id` FROM `Team`);--> statement-breakpoint
DELETE FROM `Workstream` WHERE `id` IN (
	SELECT `Workstream`.`id` FROM `Workstream` JOIN `Team` ON `Team`.`id` = `Workstream`.`id`
	WHERE `Workstream`.`objectiveId` <> `Team`.`objectiveId`
);--> statement-breakpoint
UPDATE `TaskAssignment` SET `workstreamId` = NULL
WHERE `workstreamId` IS NOT NULL AND `workstreamId` NOT IN (SELECT `id` FROM `Workstream`);--> statement-breakpoint
DELETE FROM `WorkstreamPost` WHERE `workstreamId` NOT IN (SELECT `id` FROM `Workstream`)
OR NOT EXISTS (
	SELECT 1 FROM `Team`, json_each(`Team`.`memberTagIds`)
	WHERE `Team`.`id` = `WorkstreamPost`.`workstreamId` AND json_each.value = `WorkstreamPost`.`authorTagId`
);--> statement-breakpoint
DELETE FROM `Workstream` WHERE `id` NOT IN (SELECT `id` FROM `Team`);--> statement-breakpoint
CREATE TABLE `__new_TagMessage` (
	`id` text PRIMARY KEY NOT NULL,
	`senderTagId` text NOT NULL,
	`recipientTagId` text NOT NULL,
	`recipientTeamId` text,
	`directTeamId` text,
	`operatorId` text,
	`objectiveId` text NOT NULL,
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
	FOREIGN KEY (`recipientTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_TagMessage`("id", "senderTagId", "recipientTagId", "recipientTeamId", "directTeamId", "operatorId", "objectiveId", "type", "body", "bodyPrunedAt", "idempotencyKey", "fingerprint", "inReplyTo", "status", "attemptCount", "leaseToken", "leaseCredentialId", "leaseExpiresAt", "processedAt", "createdAt", "updatedAt") SELECT "id", "senderTagId", "recipientTagId", "recipientTeamId", "directTeamId", "operatorId", "objectiveId", "type", "body", "bodyPrunedAt", "idempotencyKey", "fingerprint", "inReplyTo", "status", "attemptCount", "leaseToken", "leaseCredentialId", "leaseExpiresAt", "processedAt", "createdAt", "updatedAt" FROM `TagMessage`;--> statement-breakpoint
DROP TABLE `TagMessage`;--> statement-breakpoint
ALTER TABLE `__new_TagMessage` RENAME TO `TagMessage`;--> statement-breakpoint
CREATE UNIQUE INDEX `TagMessage_sender_idempotency_key` ON `TagMessage` (`senderTagId`,`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `TagMessage_recipient_status_created_idx` ON `TagMessage` (`recipientTagId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `TagMessage_sender_history_idx` ON `TagMessage` (`senderTagId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `TagMessage_recipient_history_idx` ON `TagMessage` (`recipientTagId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `TagMessage_retention_idx` ON `TagMessage` (`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `TagMessage_objective_idx` ON `TagMessage` (`objectiveId`);--> statement-breakpoint
CREATE TABLE `__new_Workstream` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `Team`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_Workstream`("id", "createdAt") SELECT "id", "createdAt" FROM `Workstream`;--> statement-breakpoint
DROP TABLE `Workstream`;--> statement-breakpoint
ALTER TABLE `__new_Workstream` RENAME TO `Workstream`;--> statement-breakpoint
ALTER TABLE `WorkstreamPost` ADD `type` text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE `WorkstreamPost` ADD `to` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
INSERT INTO `Workstream` (`id`, `createdAt`)
SELECT `id`, `createdAt` FROM `Team` WHERE `id` NOT IN (SELECT `id` FROM `Workstream`);--> statement-breakpoint
CREATE TEMP TABLE `__team_channels_foreign_key_check` (`violations` integer CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `__team_channels_foreign_key_check`
SELECT count(*) FROM pragma_foreign_key_check
WHERE `parent` IN ('TagMessage', 'Workstream')
OR `table` IN ('TagMessage', 'Workstream');--> statement-breakpoint
DROP TABLE `__team_channels_foreign_key_check`;
