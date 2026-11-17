ALTER TYPE "organization_invitation_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "organization_invitation_status" ADD VALUE 'revoked';--> statement-breakpoint
ALTER TABLE "organization_invitations" DROP CONSTRAINT "organization_invitations_org_invited_user_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_pending_unique" ON "organization_invitations" ("organization_id","invited_user_email") WHERE "status" = 'pending';