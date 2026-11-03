CREATE TABLE `AttemptChangedPaths` (
	`attemptId` text PRIMARY KEY NOT NULL,
	`paths` text NOT NULL,
	`truncated` integer NOT NULL,
	`reportedAt` text NOT NULL,
	FOREIGN KEY (`attemptId`) REFERENCES `TaskAttempt`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `OverlapWarning` (
	`teamId` text NOT NULL,
	`lowerAttemptId` text NOT NULL,
	`higherAttemptId` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`teamId`, `lowerAttemptId`, `higherAttemptId`, `path`)
);
