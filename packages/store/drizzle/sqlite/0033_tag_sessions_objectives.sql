ALTER TABLE `Task` RENAME COLUMN "surfaceObjectiveId" TO "objectiveId";--> statement-breakpoint
DROP TABLE `ObjectiveMessage`;--> statement-breakpoint
DROP TABLE `ObjectiveSession`;--> statement-breakpoint
DROP TABLE `OperatorInputReceipt`;--> statement-breakpoint
DROP TABLE `OverlapWarning`;--> statement-breakpoint
DROP TABLE `TagDigestDelivery`;--> statement-breakpoint
DROP TABLE `TagMailboxCredential`;--> statement-breakpoint
DROP TABLE `TagMessage`;--> statement-breakpoint
DROP TABLE `TaskAssignment`;--> statement-breakpoint
DROP TABLE `TeamLiveDelivery`;--> statement-breakpoint
DROP TABLE `TeamReplyTrigger`;--> statement-breakpoint
DROP TABLE `Team`;--> statement-breakpoint
DROP TABLE `WorkstreamPost`;--> statement-breakpoint
DROP TABLE `Workstream`;--> statement-breakpoint
DROP INDEX `Role_systemKey_key`;--> statement-breakpoint
ALTER TABLE `Role` DROP COLUMN `origin`;--> statement-breakpoint
ALTER TABLE `Role` DROP COLUMN `systemKey`;--> statement-breakpoint
ALTER TABLE `Session` ADD `objectiveId` text REFERENCES Objective(id);--> statement-breakpoint
CREATE INDEX `Session_objectiveId_idx` ON `Session` (`objectiveId`);--> statement-breakpoint
ALTER TABLE `Objective` DROP COLUMN `observations`;--> statement-breakpoint
ALTER TABLE `Objective` DROP COLUMN `observationState`;--> statement-breakpoint
ALTER TABLE `Objective` DROP COLUMN `spentMinor`;--> statement-breakpoint
ALTER TABLE `Objective` DROP COLUMN `reservedMinor`;--> statement-breakpoint
ALTER TABLE `TagMessagingGrant` DROP COLUMN `messageTypes`;