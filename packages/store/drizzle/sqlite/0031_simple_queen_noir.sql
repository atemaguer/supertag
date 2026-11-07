ALTER TABLE `Session` ADD `parentSessionId` text REFERENCES Session(id);--> statement-breakpoint
CREATE INDEX `Session_parentSessionId_idx` ON `Session` (`parentSessionId`);