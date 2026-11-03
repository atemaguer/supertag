ALTER TABLE `TeamLiveDelivery` ADD `dispatchedAt` text;
--> statement-breakpoint
-- Earlier rows did not distinguish preparation from handoff. Keep uncertain transcripts blocked.
UPDATE "TeamLiveDelivery" SET "dispatchedAt" = "createdAt"
WHERE "status" IN ('pending', 'unknown', 'withdrawn', 'revoked');
