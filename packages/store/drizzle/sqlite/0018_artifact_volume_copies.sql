CREATE TABLE `ArtifactVolumeCopy` (
	`volumeId` text NOT NULL,
	`key` text NOT NULL,
	`digest` text NOT NULL,
	`sizeBytes` integer NOT NULL,
	`workerHostId` text,
	`status` text NOT NULL,
	`observedAt` text NOT NULL,
	`unavailableAt` text,
	FOREIGN KEY (`volumeId`) REFERENCES `Volume`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workerHostId`) REFERENCES `WorkerHost`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ArtifactVolumeCopy_volume_key_key` ON `ArtifactVolumeCopy` (`volumeId`,`key`);--> statement-breakpoint
CREATE INDEX `ArtifactVolumeCopy_digest_status_idx` ON `ArtifactVolumeCopy` (`digest`,`status`);