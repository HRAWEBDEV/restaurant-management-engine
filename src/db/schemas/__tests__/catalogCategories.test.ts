import { describe, expect, it } from "bun:test";
import {
  insertCatalogCategorySchema,
  selectCatalogCategorySchema,
  updateCatalogCategorySchema,
} from "../catalogCategories";

const validRow = {
  id: "9b3a1f6e-0000-4000-8000-000000000001",
  workspaceId: "9b3a1f6e-0000-4000-8000-000000000002",
  name: "Starters",
  description: "Small plates to open the meal",
  position: 0,
  isActive: true,
  createdAt: new Date("2026-11-24T00:00:00.000Z"),
  updatedAt: new Date("2026-11-24T00:00:00.000Z"),
};

describe("catalog categories schemas", () => {
  it("select schema accepts a full row", () => {
    const parsed = selectCatalogCategorySchema.parse(validRow);
    expect(parsed.name).toBe("Starters");
    expect(parsed.isActive).toBe(true);
  });

  it("insert schema accepts only client-managed fields and defaults the rest", () => {
    const parsed = insertCatalogCategorySchema.parse({
      name: "Drinks",
      description: null,
    });
    expect(parsed).toEqual({ name: "Drinks", description: null });
  });

  it("insert schema strips server-managed fields", () => {
    const parsed = insertCatalogCategorySchema.parse(validRow);
    expect(parsed).toEqual({
      name: "Starters",
      description: "Small plates to open the meal",
      position: 0,
      isActive: true,
    });
  });

  it("insert schema requires a name", () => {
    const result = insertCatalogCategorySchema.safeParse({
      description: "missing name",
    });
    expect(result.success).toBe(false);
  });

  it("update schema only accepts name, description, and isActive", () => {
    const parsed = updateCatalogCategorySchema.parse({
      name: "Beverages",
      description: "Soft drinks and juices",
      isActive: false,
    });
    expect(parsed).toEqual({
      name: "Beverages",
      description: "Soft drinks and juices",
      isActive: false,
    });
  });

  it("update schema strips fields outside its pick list", () => {
    const parsed = updateCatalogCategorySchema.parse({
      name: "Beverages",
      position: 5,
      workspaceId: validRow.workspaceId,
      id: validRow.id,
    });
    expect(parsed).toEqual({ name: "Beverages" });
  });

  it("update schema accepts a partial patch", () => {
    const parsed = updateCatalogCategorySchema.parse({ isActive: false });
    expect(parsed).toEqual({ isActive: false });
  });

  it("rejects a wrong-typed name", () => {
    const result = insertCatalogCategorySchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });
});
