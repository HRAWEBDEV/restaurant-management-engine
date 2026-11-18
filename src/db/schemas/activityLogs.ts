import {
  bigserial,
  index,
  jsonb,
  snakeCase,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createSchemaFactory } from "drizzle-orm/zod";
import { organizations } from "./organizations";
import { workspaces } from "./workspaces";
import { user } from "../../../auth-schema";
import { z } from "@hono/zod-openapi";

type ActivityLogChange = { from: unknown; to: unknown };
type ActivityChanges = Record<string, ActivityLogChange>;
type ActivityLogMetadata = Record<string, unknown>;

type ActivityLog = typeof activityLogs.$inferSelect;
type InsertActivityLog = typeof activityLogs.$inferInsert;

// Append-only: no trackChanges (no updated_at); rows are never updated.
// workspace_id stays single-column on purpose: a composite (workspace_id,
// organization_id) FK with ON DELETE SET NULL would also null organization_id,
// which is NOT NULL.
const activityLogs = snakeCase.table(
  "activity_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, {
        onDelete: "cascade",
      }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Snapshot so the feed stays readable after the user is deleted or renamed.
    actorLabel: varchar("actor_label", { length: 150 }).notNull(),
    source: varchar("source", { length: 20 }).notNull().default("api"),
    action: varchar("action", { length: 32 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: text("entity_id").notNull(),
    // Rendered once at write time; never regenerated from the entity.
    summary: text("summary").notNull(),
    changes: jsonb("changes").$type<ActivityChanges>(),
    metadata: jsonb("metadata").$type<ActivityLogMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activity_logs_organization_id_idx").on(
      table.organizationId,
      table.id.desc(),
    ),
    index("activity_logs_workspace_id_idx").on(
      table.workspaceId,
      table.id.desc(),
    ),
    index("activity_logs_entity_idx").on(
      table.entityType,
      table.entityId,
      table.id.desc(),
    ),
    index("activity_logs_actor_idx").on(table.actorUserId, table.id.desc()),
  ],
);

const { createSelectSchema, createInsertSchema } = createSchemaFactory({
  zodInstance: z,
});
const selectActivityLogSchema = createSelectSchema(activityLogs);
const insertActivityLogSchema = createInsertSchema(activityLogs).omit({
  id: true,
  createdAt: true,
});

export type {
  ActivityChanges,
  ActivityLog,
  ActivityLogChange,
  ActivityLogMetadata,
  InsertActivityLog,
};
export { activityLogs, selectActivityLogSchema, insertActivityLogSchema };
