import {
  snakeCase,
  uuid,
  pgEnum,
  unique,
  timestamp,
  text,
} from "drizzle-orm/pg-core";
import { createSchemaFactory } from "drizzle-orm/zod";
import { organizations } from "./organizations";
import { user } from "../../../auth-schema";
import { z } from "@hono/zod-openapi";

const ogMemberRoles = ["owner", "admin", "member"] as const;
const roleEnum = pgEnum("organization_roles", ogMemberRoles);

type OrganizationMember = typeof organizationMembers.$inferSelect;
type InsertOrganizationMember = typeof organizationMembers.$inferInsert;

const organizationMembers = snakeCase.table(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    role: roleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    addedBy: text("added_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    unique("organization_members_unique").on(
      table.organizationId,
      table.userId,
    ),
    unique("organization_members_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
  ],
);

const { createSelectSchema, createInsertSchema, createUpdateSchema } =
  createSchemaFactory({
    zodInstance: z,
  });
// createSelectSchema maps pgEnum columns to plain strings, so the role is
// overridden to preserve the literal union, matching the insert/update schemas.
const selectOrganizationMemberSchema = createSelectSchema(organizationMembers, {
  role: z.enum(ogMemberRoles),
});
const insertOrganizationMemberSchema = createInsertSchema(organizationMembers, {
  role: z.enum(ogMemberRoles),
}).omit({
  id: true,
  joinedAt: true,
});
const updateOrganizationMemberSchema = createUpdateSchema(organizationMembers, {
  role: z.enum(ogMemberRoles),
}).pick({
  id: true,
  role: true,
});

export type { OrganizationMember, InsertOrganizationMember };
export {
  organizationMembers,
  roleEnum,
  selectOrganizationMemberSchema,
  insertOrganizationMemberSchema,
  updateOrganizationMemberSchema,
  ogMemberRoles,
};
