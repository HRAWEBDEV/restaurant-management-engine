import {
  uuid,
  varchar,
  integer,
  boolean,
  unique,
  uniqueIndex,
  snakeCase,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createSchemaFactory } from "drizzle-orm/zod";
import { workspaces } from "./workspaces";
import { trackChanges } from "../utils/trackChanges";
import { z } from "@hono/zod-openapi";

type TaxClass = typeof taxClasses.$inferSelect;
type InsertTaxClass = typeof taxClasses.$inferInsert;

const taxClasses = snakeCase.table(
  "tax_classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, {
        onDelete: "cascade",
      }),
    name: varchar("name", { length: 100 }).notNull(),
    rate: integer("rate").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    ...trackChanges,
  },
  (table) => [
    unique("tax_classes_workspace_id_name_unique").on(
      table.workspaceId,
      table.name,
    ),
    uniqueIndex("tax_classes_workspace_default_unique")
      .on(table.workspaceId)
      .where(sql`${table.isDefault} = true`),
  ],
);

const { createInsertSchema, createUpdateSchema, createSelectSchema } =
  createSchemaFactory({
    zodInstance: z,
  });
const selectTaxClassSchema = createSelectSchema(taxClasses);
const insertTaxClassSchema = createInsertSchema(taxClasses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  workspaceId: true,
});
const updateTaxClassSchema = createUpdateSchema(taxClasses).pick({
  name: true,
  rate: true,
  isDefault: true,
});

export type { TaxClass, InsertTaxClass };
export {
  taxClasses,
  selectTaxClassSchema,
  insertTaxClassSchema,
  updateTaxClassSchema,
};
