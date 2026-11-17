ALTER TABLE "organization_invitations" RENAME COLUMN "user_id" TO "invited_by";--> statement-breakpoint
ALTER TABLE "organization_invitations" RENAME COLUMN "email" TO "invited_user_email";--> statement-breakpoint
ALTER TABLE "organization_invitations" RENAME CONSTRAINT "organization_invitations_org_email_unique" TO "organization_invitations_org_invited_user_email_unique";--> statement-breakpoint
ALTER TABLE "organization_invitations" RENAME CONSTRAINT "organization_invitations_user_id_user_id_fkey" TO "organization_invitations_invited_by_user_id_fkey";