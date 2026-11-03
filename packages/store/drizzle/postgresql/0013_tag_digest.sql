CREATE TABLE "TagDigestDelivery" (
	"tagId" text NOT NULL,
	"objectiveId" text NOT NULL,
	"itemKind" text NOT NULL,
	"itemId" text NOT NULL,
	"deliveredAt" text NOT NULL,
	CONSTRAINT "TagDigestDelivery_tagId_objectiveId_itemKind_itemId_pk" PRIMARY KEY("tagId","objectiveId","itemKind","itemId")
);
--> statement-breakpoint
ALTER TABLE "TagDigestDelivery" ADD CONSTRAINT "TagDigestDelivery_tagId_Tag_id_fk" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TagDigestDelivery" ADD CONSTRAINT "TagDigestDelivery_objectiveId_Objective_id_fk" FOREIGN KEY ("objectiveId") REFERENCES "public"."Objective"("id") ON DELETE restrict ON UPDATE no action;