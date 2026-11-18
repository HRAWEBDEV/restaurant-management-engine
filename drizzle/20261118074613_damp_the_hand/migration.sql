CREATE TABLE "activity_logs" (
	"id" bigserial PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" text,
	"actor_label" varchar(150) NOT NULL,
	"source" varchar(20) DEFAULT 'api' NOT NULL,
	"action" varchar(32) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"changes" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_logs_organization_id_idx" ON "activity_logs" ("organization_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_logs_workspace_id_idx" ON "activity_logs" ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_logs_entity_idx" ON "activity_logs" ("entity_type","entity_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_logs_actor_idx" ON "activity_logs" ("actor_user_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_user_id_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL;