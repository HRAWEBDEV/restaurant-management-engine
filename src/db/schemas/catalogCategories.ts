import {
  uuid,
  varchar,
  text,
  integer,
  boolean,
  unique,
  snakeCase,
} from "drizzle-orm/pg-core";
import { createSchemaFactory } from "drizzle-orm/zod";
import { workspaces } from "./workspaces";
import { trackChanges } from "../utils/trackChanges";
import { z } from "@hono/zod-openapi";

type CatalogCategory = typeof catalogCategories.$inferSelect;
type InsertCatalogCategory = typeof catalogCategories.$inferInsert;

const catalogCategories = snakeCase.table(
  "catalog_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, {
        onDelete: "cascade",
      }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...trackChanges,
  },
  (table) => [
    unique("catalog_categories_workspace_id_name_unique").on(
      table.workspaceId,
      table.name,
    ),
  ],
);

const { createInsertSchema, createUpdateSchema, createSelectSchema } =
  createSchemaFactory({
    zodInstance: z,
  });
const selectCatalogCategorySchema = createSelectSchema(catalogCategories);
const insertCatalogCategorySchema = createInsertSchema(
  catalogCategories,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  workspaceId: true,
});
const updateCatalogCategorySchema = createUpdateSchema(
  catalogCategories,
).pick({
  name: true,
  description: true,
  isActive: true,
});

export type { CatalogCategory, InsertCatalogCategory };
export {
  catalogCategories,
  selectCatalogCategorySchema,
  insertCatalogCategorySchema,
  updateCatalogCategorySchema,
};
