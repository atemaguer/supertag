CREATE TABLE `OperatorInputReceipt` (
	`taskId` text NOT NULL,
	`attemptCount` integer NOT NULL,
	`messageId` text NOT NULL,
	`seenAt` text NOT NULL,
	`handledAt` text,
	`handlingKind` text,
	`handlingId` text,
	PRIMARY KEY(`taskId`, `attemptCount`, `messageId`),
	FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`messageId`) REFERENCES `TagMessage`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OperatorInputReceipt_message_idx` ON `OperatorInputReceipt` (`messageId`);