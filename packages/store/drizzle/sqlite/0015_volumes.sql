CREATE TABLE `Volume` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`credential` text,
	`revision` integer NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Volume_name_key` ON `Volume` (`name`);--> statement-breakpoint
ALTER TABLE `TaskAttempt` ADD `mountManifests` text;--> statement-breakpoint
ALTER TABLE `Workspace` ADD `mounts` text;