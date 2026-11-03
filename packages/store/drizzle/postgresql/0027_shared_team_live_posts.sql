DROP INDEX "TeamLiveDelivery_item_key";--> statement-breakpoint
CREATE UNIQUE INDEX "TeamLiveDelivery_message_key" ON "TeamLiveDelivery" USING btree ("recipientTagId","objectiveId","itemId") WHERE "TeamLiveDelivery"."itemKind" = 'direct_message';--> statement-breakpoint
CREATE UNIQUE INDEX "TeamLiveDelivery_item_key" ON "TeamLiveDelivery" USING btree ("attemptId","itemKind","itemId");