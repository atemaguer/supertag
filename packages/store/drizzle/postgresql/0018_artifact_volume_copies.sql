CREATE TABLE "ArtifactVolumeCopy" (
	"volumeId" text NOT NULL,
	"key" text NOT NULL,
	"digest" text NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"workerHostId" text,
	"status" text NOT NULL,
	"observedAt" text NOT NULL,
	"unavailableAt" text
);
--> statement-breakpoint
ALTER TABLE "ArtifactVolumeCopy" ADD CONSTRAINT "ArtifactVolumeCopy_volumeId_Volume_id_fk" FOREIGN KEY ("volumeId") REFERENCES "public"."Volume"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ArtifactVolumeCopy" ADD CONSTRAINT "ArtifactVolumeCopy_workerHostId_WorkerHost_id_fk" FOREIGN KEY ("workerHostId") REFERENCES "public"."WorkerHost"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ArtifactVolumeCopy_volume_key_key" ON "ArtifactVolumeCopy" USING btree ("volumeId","key");--> statement-breakpoint
CREATE INDEX "ArtifactVolumeCopy_digest_status_idx" ON "ArtifactVolumeCopy" USING btree ("digest","status");