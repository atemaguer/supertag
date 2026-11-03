-- Rebuilding Team would violate TaskAssignment's ON DELETE RESTRICT foreign key inside the
-- migration transaction, so swap the column in place instead.
ALTER TABLE `Team` ADD `maxConcurrency_nullable` integer;--> statement-breakpoint
UPDATE `Team` SET `maxConcurrency_nullable` = `maxConcurrency` WHERE NOT (`parentTeamId` IS NULL AND `id` = `objectiveId` || ':leadership');--> statement-breakpoint
ALTER TABLE `Team` DROP COLUMN `maxConcurrency`;--> statement-breakpoint
ALTER TABLE `Team` RENAME COLUMN `maxConcurrency_nullable` TO `maxConcurrency`;
