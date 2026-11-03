ALTER TABLE "TaskAttempt" ADD COLUMN "mcpServersDigest" text;--> statement-breakpoint
ALTER TABLE "Workspace" ADD COLUMN "mcp" jsonb;