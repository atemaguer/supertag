CREATE TABLE `TagDigestDelivery` (
	`tagId` text NOT NULL,
	`objectiveId` text NOT NULL,
	`itemKind` text NOT NULL,
	`itemId` text NOT NULL,
	`deliveredAt` text NOT NULL,
	PRIMARY KEY(`tagId`, `objectiveId`, `itemKind`, `itemId`),
	FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`objectiveId`) REFERENCES `Objective`(`id`) ON UPDATE no action ON DELETE restrict
);
