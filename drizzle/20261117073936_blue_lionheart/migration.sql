ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_workspace_id_workspaces_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_XXS3NoABnooI_fkey";--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "workspace_members" wm
   SET "organization_id" = w."organization_id"
  FROM "workspaces" w
 WHERE w."id" = wm."workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_org_fkey" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "workspaces"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_member_org_fkey" FOREIGN KEY ("organization_member_id","organization_id") REFERENCES "organization_members"("id","organization_id") ON DELETE CASCADE;
