import {
  pgEnum,
  uuid,
  varchar,
  timestamp,
  unique,
  text,
  snakeCase,
} from "drizzle-orm/pg-core";
import { createSchemaFactory } from "drizzle-orm/zod";
import { z } from "@hono/zod-openapi";
import { organizations } from "./organizations";
import { user } from "../../../auth-schema";

const organizationInvitationStatusEnum = pgEnum(
  "organization_invitation_status",
  ["pending", "accepted", "declined"],
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
    userId: text("user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    email: varchar("email", { length: 255 }).notNull(),
    status: organizationInvitationStatusEnum("status")
      .default("pending")
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createAt: timestamp("create_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("organization_invitations_org_email_unique").on(
      table.organizationId,
      table.email,
    ),
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
);

export type { OrganizationInvitation, InsertOrganizationInvitation };
export {
  organizationInvitations,
  organizationInvitationStatusEnum,
  selectOrganizationInvitationSchema,
  updateOrganizationInvitationSchema,
  insertOrganizationInvitationSchema,
};
