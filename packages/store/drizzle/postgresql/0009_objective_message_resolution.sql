ALTER TABLE "ObjectiveMessage" ADD COLUMN "resolvedAt" text;--> statement-breakpoint
ALTER TABLE "ObjectiveMessage" ADD COLUMN "resolutionReason" text;--> statement-breakpoint
-- Resolve operator questions and approval requests of Objectives that closed before this migration, as closing does now.
UPDATE "ObjectiveMessage" AS m SET
  "resolvedAt" = CASE WHEN o."status" = 'cancelled' THEN COALESCE(o."cancelledAt", o."updatedAt") ELSE o."updatedAt" END,
  "resolutionReason" = CASE WHEN o."status" = 'cancelled' THEN 'Objective cancelled' ELSE 'Objective completed' END,
  "updatedAt" = CASE WHEN o."status" = 'cancelled' THEN COALESCE(o."cancelledAt", o."updatedAt") ELSE o."updatedAt" END
FROM "Objective" AS o
WHERE o."id" = m."objectiveId" AND o."status" IN ('completed', 'cancelled')
  AND m."needsReply" = true AND m."replyMessageId" IS NULL AND m."resolvedAt" IS NULL;--> statement-breakpoint
UPDATE "ApprovalRequest" AS a SET
  "status" = 'expired',
  "decidedAt" = CASE WHEN o."status" = 'cancelled' THEN COALESCE(o."cancelledAt", o."updatedAt") ELSE o."updatedAt" END,
  "reason" = CASE WHEN o."status" = 'cancelled' THEN 'Objective cancelled' ELSE 'Objective completed' END,
  "updatedAt" = CASE WHEN o."status" = 'cancelled' THEN COALESCE(o."cancelledAt", o."updatedAt") ELSE o."updatedAt" END
FROM "Objective" AS o
WHERE o."id" = a."objectiveId" AND o."status" IN ('completed', 'cancelled') AND a."status" = 'pending';
