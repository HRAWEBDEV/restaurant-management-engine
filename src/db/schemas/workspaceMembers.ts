import {
  uuid,
  pgEnum,
  unique,
  timestamp,
  snakeCase,
  text,
  foreignKey,
} from "drizzle-orm/pg-core";
import { createSchemaFactory } from "drizzle-orm/zod";
import { z } from "@hono/zod-openapi";
import { organizationMembers } from "./organizationMembers";
import { workspaces } from "./workspaces";
import { user } from "../../../auth-schema";

const workspaceRoles = ["admin", "member"] as const;
export const roleEnum = pgEnum("workspace_roles", ["admin", "member"]);

type WorkspaceMember = typeof workspaceMembers.$inferSelect;
type InsertWorkspaceMember = typeof workspaceMembers.$inferInsert;

const workspaceMembers = snakeCase.table(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    organizationMemberId: uuid("organization_member_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    role: roleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    addedBy: text("added_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    unique("workspace_members_unique").on(
      table.organizationMemberId,
      table.workspaceId,
    ),
    foreignKey({
      name: "workspace_members_workspace_org_fkey",
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "workspace_members_member_org_fkey",
      columns: [table.organizationMemberId, table.organizationId],
      foreignColumns: [
        organizationMembers.id,
        organizationMembers.organizationId,
      ],
    }).onDelete("cascade"),
  ],
);

const { createInsertSchema, createSelectSchema, createUpdateSchema } =
  createSchemaFactory({
    zodInstance: z,
  });
const selectWorkspaceMemberSchema = createSelectSchema(workspaceMembers, {
  role: z.enum(workspaceRoles),
});
const insertWorkspaceMemberSchema = createInsertSchema(workspaceMembers, {
  role: z.enum(workspaceRoles),
}).omit({
  id: true,
  joinedAt: true,
  organizationId: true,
});
const upadteWorkspaceMemberSchema = createUpdateSchema(workspaceMembers, {
  role: z.enum(workspaceRoles),
}).pick({
  id: true,
  role: true,
});

export type { WorkspaceMember, InsertWorkspaceMember };
export {
  workspaceMembers,
  selectWorkspaceMemberSchema,
  insertWorkspaceMemberSchema,
  upadteWorkspaceMemberSchema,
  workspaceRoles,
};
