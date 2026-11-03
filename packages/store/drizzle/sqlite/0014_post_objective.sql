-- Team channel posts record the Objective they were written under, and only readers of that
-- Objective see them. A stored post takes the Objective of the Task that wrote it, or else its
-- Team's governing Objective. Each Objective numbers its own posts in a channel, so stored posts
-- are renumbered 1, 2, … per Objective in their old order. Observation cursors, pending
-- observation batches and their unsettled notices, and registered wait_for afterSequence values
-- become the number of that Objective's posts at or before the old value, so no Objective skips
-- or repeats a post.
-- A reply that would cross Objectives loses its parent.
-- Nothing references WorkstreamPost, so it is rebuilt with foreign key enforcement on.
CREATE TABLE `__new_WorkstreamPost` (
	`id` text PRIMARY KEY NOT NULL,
	`workstreamId` text NOT NULL,
	`authorTagId` text NOT NULL,
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
INSERT INTO `__new_WorkstreamPost`("id", "workstreamId", "authorTagId", "objectiveId", "sourceTaskId", "type", "to", "body", "references", "replyTo", "sequence", "createdAt", "idempotencyKey")
SELECT `p`.`id`, `p`.`workstreamId`, `p`.`authorTagId`,
	coalesce(
		(SELECT `a`.`objectiveId` FROM `TaskAssignment` `a` WHERE `a`.`taskId` = `p`.`sourceTaskId`),
		(SELECT `t`.`objectiveId` FROM `Team` `t` WHERE `t`.`id` = `p`.`workstreamId`)
	),
	`p`.`sourceTaskId`, `p`.`type`, `p`.`to`, `p`.`body`, `p`.`references`, `p`.`replyTo`, `p`.`sequence`, `p`.`createdAt`, `p`.`idempotencyKey`
FROM `WorkstreamPost` `p`;--> statement-breakpoint
UPDATE `__new_WorkstreamPost` SET `replyTo` = NULL
WHERE `replyTo` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `__new_WorkstreamPost` `parent`
	WHERE `parent`.`id` = `__new_WorkstreamPost`.`replyTo`
	AND `parent`.`workstreamId` = `__new_WorkstreamPost`.`workstreamId`
	AND `parent`.`objectiveId` = `__new_WorkstreamPost`.`objectiveId`
);--> statement-breakpoint
UPDATE `Objective` SET `observationState` = json_set(`observationState`, '$.cursors', json((
	SELECT json_group_object(`c`.`key`, (
		SELECT count(*) FROM `__new_WorkstreamPost` `p`
		WHERE `p`.`workstreamId` = `c`.`key` AND `p`.`objectiveId` = `Objective`.`id` AND `p`.`sequence` <= `c`.`value`
	)) FROM json_each(`Objective`.`observationState`, '$.cursors') `c`
)))
WHERE json_type(`observationState`, '$.cursors') = 'object';--> statement-breakpoint
UPDATE `Objective` SET `observationState` = json_set(`observationState`, '$.pending.through', json((
	SELECT json_group_object(`c`.`key`, (
		SELECT count(*) FROM `__new_WorkstreamPost` `p`
		WHERE `p`.`workstreamId` = `c`.`key` AND `p`.`objectiveId` = `Objective`.`id` AND `p`.`sequence` <= `c`.`value`
	)) FROM json_each(`Objective`.`observationState`, '$.pending.through') `c`
)))
WHERE json_type(`observationState`, '$.pending.through') = 'object';--> statement-breakpoint
UPDATE `TaskAssignment` SET `waitState` = json_set(`waitState`, '$.workstreamPosts.afterSequence', (
	SELECT count(*) FROM `__new_WorkstreamPost` `p`
	WHERE `p`.`workstreamId` = json_extract(`TaskAssignment`.`waitState`, '$.workstreamPosts.workstreamId')
	AND `p`.`objectiveId` = `TaskAssignment`.`objectiveId`
	AND `p`.`sequence` <= json_extract(`TaskAssignment`.`waitState`, '$.workstreamPosts.afterSequence')
))
WHERE json_type(`waitState`, '$.workstreamPosts') = 'object';--> statement-breakpoint
UPDATE `TagMessage` SET `body` = json_set(`body`,
	'$.afterSequence', (
		SELECT count(*) FROM `__new_WorkstreamPost` `p`
		WHERE `p`.`workstreamId` = json_extract(`TagMessage`.`body`, '$.workstreamId')
		AND `p`.`objectiveId` = `TagMessage`.`objectiveId`
		AND `p`.`sequence` <= json_extract(`TagMessage`.`body`, '$.afterSequence')
	),
	'$.throughSequence', (
		SELECT count(*) FROM `__new_WorkstreamPost` `p`
		WHERE `p`.`workstreamId` = json_extract(`TagMessage`.`body`, '$.workstreamId')
		AND `p`.`objectiveId` = `TagMessage`.`objectiveId`
		AND `p`.`sequence` <= json_extract(`TagMessage`.`body`, '$.throughSequence')
	))
WHERE `status` IN ('pending', 'processing') AND json_valid(`body`)
AND json_extract(`body`, '$.kind') = 'observations.available';--> statement-breakpoint
CREATE TABLE `__WorkstreamPost_sequence` AS
SELECT `id`, row_number() OVER (PARTITION BY `workstreamId`, `objectiveId` ORDER BY `sequence`) AS `sequence`
FROM `__new_WorkstreamPost`;--> statement-breakpoint
UPDATE `__new_WorkstreamPost` SET `sequence` = (
	SELECT `s`.`sequence` FROM `__WorkstreamPost_sequence` `s` WHERE `s`.`id` = `__new_WorkstreamPost`.`id`
);--> statement-breakpoint
DROP TABLE `__WorkstreamPost_sequence`;--> statement-breakpoint
DROP TABLE `WorkstreamPost`;--> statement-breakpoint
ALTER TABLE `__new_WorkstreamPost` RENAME TO `WorkstreamPost`;--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_sequence_key` ON `WorkstreamPost` (`workstreamId`,`objectiveId`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `WorkstreamPost_idempotency_key` ON `WorkstreamPost` (`workstreamId`,`authorTagId`,`idempotencyKey`);
