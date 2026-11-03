CREATE TABLE `TeamLiveDelivery` (
	`id` text PRIMARY KEY NOT NULL,
	`objectiveId` text NOT NULL,
	`teamId` text NOT NULL,
	`taskId` text NOT NULL,
	`attemptId` text NOT NULL,
	`senderTagId` text NOT NULL,
	`recipientTagId` text NOT NULL,
	`itemKind` text NOT NULL,
	`itemId` text NOT NULL,
	`itemType` text NOT NULL,
	`status` text NOT NULL,
	`truncated` integer NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`senderTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipientTagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `TeamLiveDelivery_item_key` ON `TeamLiveDelivery` (`recipientTagId`,`objectiveId`,`itemKind`,`itemId`);--> statement-breakpoint
CREATE INDEX `TeamLiveDelivery_pair_idx` ON `TeamLiveDelivery` (`attemptId`,`senderTagId`);--> statement-breakpoint
CREATE INDEX `TeamLiveDelivery_objective_idx` ON `TeamLiveDelivery` (`objectiveId`,`createdAt`);