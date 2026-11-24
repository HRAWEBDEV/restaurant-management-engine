import {
  pgEnum,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  text,
  snakeCase,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createSchemaFactory } from "drizzle-orm/zod";
import { z } from "@hono/zod-openapi";
import { organizations } from "./organizations";
import { user } from "../../../auth-schema";

const organizationInvitationStatusEnum = pgEnum(
  "organization_invitation_status",
  ["pending", "accepted", "declined", "expired", "revoked"],
);

type OrganizationInvitation = typeof organizationInvitations.$inferSelect;
type InsertOrganizationInvitation = typeof organizationInvitations.$inferInsert;

const organizationInvitations = snakeCase.table(
  "organization_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, {
        onDelete: "cascade",
      }),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    invitedUserEmail: varchar("invited_user_email", { length: 255 }).notNull(),
    status: organizationInvitationStatusEnum("status")
      .default("pending")
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("organization_invitations_pending_unique")
      .on(table.organizationId, table.invitedUserEmail)
      .where(sql`${table.status} = 'pending'`),
  ],
);

const { createSelectSchema, createUpdateSchema, createInsertSchema } =
  createSchemaFactory({
    zodInstance: z,
  });

const selectOrganizationInvitationSchema = createSelectSchema(
  organizationInvitations,
);
const updateOrganizationInvitationSchema = createUpdateSchema(
  organizationInvitations,
);
const insertOrganizationInvitationSchema = createInsertSchema(
  organizationInvitations,
).omit({
  id: true,
  invitedBy: true,
  status: true,
  acceptedAt: true,
  createdAt: true,
});

export type { OrganizationInvitation, InsertOrganizationInvitation };
export {
  organizationInvitations,
  organizationInvitationStatusEnum,
  selectOrganizationInvitationSchema,
  updateOrganizationInvitationSchema,
  insertOrganizationInvitationSchema,
};
