ALTER TABLE `ObjectiveMessage` ADD `resolvedAt` text;--> statement-breakpoint
ALTER TABLE `ObjectiveMessage` ADD `resolutionReason` text;--> statement-breakpoint
-- Resolve operator questions and approval requests of Objectives that closed before this migration, as closing does now.
UPDATE `ObjectiveMessage` SET
  `resolvedAt` = (SELECT CASE WHEN o.`status` = 'cancelled' THEN COALESCE(o.`cancelledAt`, o.`updatedAt`) ELSE o.`updatedAt` END FROM `Objective` o WHERE o.`id` = `ObjectiveMessage`.`objectiveId`),
  `resolutionReason` = (SELECT CASE WHEN o.`status` = 'cancelled' THEN 'Objective cancelled' ELSE 'Objective completed' END FROM `Objective` o WHERE o.`id` = `ObjectiveMessage`.`objectiveId`),
  `updatedAt` = (SELECT CASE WHEN o.`status` = 'cancelled' THEN COALESCE(o.`cancelledAt`, o.`updatedAt`) ELSE o.`updatedAt` END FROM `Objective` o WHERE o.`id` = `ObjectiveMessage`.`objectiveId`)
WHERE `needsReply` = 1 AND `replyMessageId` IS NULL AND `resolvedAt` IS NULL
  AND `objectiveId` IN (SELECT `id` FROM `Objective` WHERE `status` IN ('completed', 'cancelled'));--> statement-breakpoint
UPDATE `ApprovalRequest` SET
  `status` = 'expired',
  `decidedAt` = (SELECT CASE WHEN o.`status` = 'cancelled' THEN COALESCE(o.`cancelledAt`, o.`updatedAt`) ELSE o.`updatedAt` END FROM `Objective` o WHERE o.`id` = `ApprovalRequest`.`objectiveId`),
  `reason` = (SELECT CASE WHEN o.`status` = 'cancelled' THEN 'Objective cancelled' ELSE 'Objective completed' END FROM `Objective` o WHERE o.`id` = `ApprovalRequest`.`objectiveId`),
  `updatedAt` = (SELECT CASE WHEN o.`status` = 'cancelled' THEN COALESCE(o.`cancelledAt`, o.`updatedAt`) ELSE o.`updatedAt` END FROM `Objective` o WHERE o.`id` = `ApprovalRequest`.`objectiveId`)
WHERE `status` = 'pending'
  AND `objectiveId` IN (SELECT `id` FROM `Objective` WHERE `status` IN ('completed', 'cancelled'));
