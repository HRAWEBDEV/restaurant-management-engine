import { describe, expect, it } from "bun:test";
import {
  insertTaxClassSchema,
  selectTaxClassSchema,
  updateTaxClassSchema,
} from "../taxClasses";

const validRow = {
  id: "9b3a1f6e-0000-4000-8000-000000000001",
  workspaceId: "9b3a1f6e-0000-4000-8000-000000000002",
  name: "VAT 8.25%",
  rate: 825,
  isDefault: true,
  createdAt: new Date("2026-11-24T00:00:00.000Z"),
  updatedAt: new Date("2026-11-24T00:00:00.000Z"),
};

describe("tax class schemas", () => {
  it("select schema accepts a full row", () => {
    const parsed = selectTaxClassSchema.parse(validRow);
    expect(parsed.name).toBe("VAT 8.25%");
    expect(parsed.rate).toBe(825);
    expect(parsed.isDefault).toBe(true);
  });

  it("insert schema accepts only client-managed fields and defaults the rest", () => {
    const parsed = insertTaxClassSchema.parse({
      name: "Sales Tax 5%",
      rate: 500,
    });
    expect(parsed).toEqual({ name: "Sales Tax 5%", rate: 500 });
  });

  it("insert schema strips server-managed fields", () => {
    const parsed = insertTaxClassSchema.parse(validRow);
    expect(parsed).toEqual({
      name: "VAT 8.25%",
      rate: 825,
      isDefault: true,
    });
  });

  it("insert schema requires a name and a rate", () => {
    expect(
      insertTaxClassSchema.safeParse({ rate: 825 }).success,
    ).toBe(false);
    expect(
      insertTaxClassSchema.safeParse({ name: "No rate" }).success,
    ).toBe(false);
  });

  it("update schema only accepts name, rate, and isDefault", () => {
    const parsed = updateTaxClassSchema.parse({
      name: "Sales Tax 5.5%",
      rate: 550,
      isDefault: true,
    });
    expect(parsed).toEqual({
      name: "Sales Tax 5.5%",
      rate: 550,
      isDefault: true,
    });
  });

  it("update schema strips fields outside its pick list", () => {
    const parsed = updateTaxClassSchema.parse({
      name: "Renamed",
      workspaceId: validRow.workspaceId,
      id: validRow.id,
    });
    expect(parsed).toEqual({ name: "Renamed" });
  });

  it("update schema accepts a partial patch", () => {
    const parsed = updateTaxClassSchema.parse({ rate: 0 });
    expect(parsed).toEqual({ rate: 0 });
  });

  it("rejects a wrong-typed rate", () => {
    const result = insertTaxClassSchema.safeParse({
      name: "Bad rate",
      rate: "825",
    });
    expect(result.success).toBe(false);
  });
});
