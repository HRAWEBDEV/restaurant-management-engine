import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
} from "../../db/__tests__/helpers/factories";
import { activityLogs } from "../../db/schemas/activityLogs";
import { catalogCategories } from "../../db/schemas/catalogCategories";
import { ConflictError } from "../../utils/ConflictError";
import { CatalogCategoriesService } from "../catalogCategoriesService";

const catalogCategoriesService = new CatalogCategoriesService(testDb);

/** Creates a workspace and returns everything the tests need. */
async function createWorkspace() {
  const owner = await createTestUser(testDb, { name: "Hamid" });
  const { organization } = await createTestOrganization(testDb, owner.id);
  const workspace = await createTestWorkspace(testDb, organization.id, owner.id);

  return { owner, organization, workspace };
}

async function createCategory(
  workspaceId: string,
  userId: string,
  name: string,
) {
  const { category } = await catalogCategoriesService.createCategory({
    workspaceId,
    userId,
    name,
  });

  if (!category) {
    throw new Error(`category "${name}" was not created`);
  }

  return category;
}

describe("CatalogCategoriesService.createCategory", () => {
  it("creates the category appended to the end and writes the audit row", async () => {
    const { owner, organization, workspace } = await createWorkspace();

    const first = await createCategory(workspace.id, owner.id, "Starters");
    const second = await createCategory(workspace.id, owner.id, "Drinks");

    expect(first.position).toBe(0);
    expect(second.position).toBe(1);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, second.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "created",
      entityType: "catalog_category",
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      actorLabel: "Hamid",
    });
  });

  it("raises ConflictError when the name is already used in the workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    await createCategory(workspace.id, owner.id, "Starters");

    expect(
      catalogCategoriesService.createCategory({
        workspaceId: workspace.id,
        userId: owner.id,
        name: "Starters",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same name in another workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    await createCategory(workspace.id, owner.id, "Starters");

    const other = await createWorkspace();
    const category = await createCategory(other.workspace.id, owner.id, "Starters");

    expect(category.workspaceId).toBe(other.workspace.id);
  });

  it("returns null when the workspace does not exist", async () => {
    const owner = await createTestUser(testDb);

    const { category } = await catalogCategoriesService.createCategory({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      userId: owner.id,
      name: "Nowhere",
    });

    expect(category).toBeNull();
  });
});

describe("CatalogCategoriesService.getCatalogCategories", () => {
  it("lists the workspace's categories in position order only", async () => {
    const { owner, workspace } = await createWorkspace();
    const starters = await createCategory(workspace.id, owner.id, "Starters");
    const drinks = await createCategory(workspace.id, owner.id, "Drinks");

    const other = await createWorkspace();
    await createCategory(other.workspace.id, other.owner.id, "Other");

    const { categories } = await catalogCategoriesService.getCatalogCategories({
      filters: { workspaceId: workspace.id },
    });

    expect(categories.map((category) => category.id)).toEqual([
      starters.id,
      drinks.id,
    ]);
  });
});

describe("CatalogCategoriesService.getCatalogCategoryById", () => {
  it("returns the category scoped to the workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");

    const { category } = await catalogCategoriesService.getCatalogCategoryById({
      id: created.id,
      workspaceId: workspace.id,
    });

    expect(category?.id).toBe(created.id);
  });

  it("returns null for another workspace's category or an unknown id", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");
    const other = await createWorkspace();

    const foreign = await catalogCategoriesService.getCatalogCategoryById({
      id: created.id,
      workspaceId: other.workspace.id,
    });
    const unknown = await catalogCategoriesService.getCatalogCategoryById({
      id: "00000000-0000-4000-8000-000000000002",
      workspaceId: workspace.id,
    });

    expect(foreign.category).toBeNull();
    expect(unknown.category).toBeNull();
  });
});

describe("CatalogCategoriesService.updateCategory", () => {
  it("renames and writes the audit diff", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");

    const { category } = await catalogCategoriesService.updateCategory({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
      name: "Appetizers",
    });

    expect(category?.name).toBe("Appetizers");

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, created.id));
    const updateLogs = logs.filter((log) => log.action === "updated");
    expect(updateLogs).toHaveLength(1);
    expect(updateLogs[0]?.changes).toEqual({
      name: { from: "Starters", to: "Appetizers" },
    });
  });

  it("returns the current row without an audit row on a no-change request", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");

    const { category } = await catalogCategoriesService.updateCategory({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
      name: "Starters",
    });

    expect(category?.id).toBe(created.id);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, created.id));
    expect(logs.filter((log) => log.action === "updated")).toHaveLength(0);
  });

  it("raises ConflictError when renaming to a used name", async () => {
    const { owner, workspace } = await createWorkspace();
    await createCategory(workspace.id, owner.id, "Starters");
    const drinks = await createCategory(workspace.id, owner.id, "Drinks");

    expect(
      catalogCategoriesService.updateCategory({
        id: drinks.id,
        workspaceId: workspace.id,
        userId: owner.id,
        name: "Starters",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("returns null when the category is not in this workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");
    const other = await createWorkspace();

    const { category } = await catalogCategoriesService.updateCategory({
      id: created.id,
      workspaceId: other.workspace.id,
      userId: owner.id,
      name: "Hijacked",
    });

    expect(category).toBeNull();
  });
});

describe("CatalogCategoriesService.archiveCategory", () => {
  it("archives instead of deleting and writes the audit row", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");

    const { category } = await catalogCategoriesService.archiveCategory({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });

    expect(category?.isActive).toBe(false);

    const rows = await testDb
      .select()
      .from(catalogCategories)
      .where(eq(catalogCategories.id, created.id));
    expect(rows).toHaveLength(1);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, created.id));
    const archiveLogs = logs.filter((log) => log.action === "archived");
    expect(archiveLogs).toHaveLength(1);
    expect(archiveLogs[0]?.changes).toEqual({
      isActive: { from: true, to: false },
    });
  });

  it("is idempotent: an already archived category writes no new audit row", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createCategory(workspace.id, owner.id, "Starters");

    await catalogCategoriesService.archiveCategory({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });
    const { category } = await catalogCategoriesService.archiveCategory({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });

    expect(category?.isActive).toBe(false);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, created.id));
    expect(logs.filter((log) => log.action === "archived")).toHaveLength(1);
  });
});

describe("CatalogCategoriesService.reorderCategories", () => {
  it("rewrites positions from the full ordered list and audits only moves", async () => {
    const { owner, workspace } = await createWorkspace();
    const starters = await createCategory(workspace.id, owner.id, "Starters");
    const mains = await createCategory(workspace.id, owner.id, "Mains");
    const drinks = await createCategory(workspace.id, owner.id, "Drinks");

    const { categories } = await catalogCategoriesService.reorderCategories({
      workspaceId: workspace.id,
      userId: owner.id,
      categoryIds: [drinks.id, mains.id, starters.id],
    });

    expect(categories.map((category) => category.name)).toEqual([
      "Drinks",
      "Mains",
      "Starters",
    ]);
    expect(categories.map((category) => category.position)).toEqual([0, 1, 2]);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.workspaceId, workspace.id));
    const reorderLogs = logs.filter((log) =>
      log.summary.includes("reordered category"),
    );
    expect(reorderLogs).toHaveLength(2);
    expect(reorderLogs.map((log) => log.entityId).sort()).toEqual(
      [drinks.id, starters.id].sort(),
    );
  });

  it("raises ConflictError when the list does not match the workspace's categories", async () => {
    const { owner, workspace } = await createWorkspace();
    const starters = await createCategory(workspace.id, owner.id, "Starters");
    const mains = await createCategory(workspace.id, owner.id, "Mains");

    await expect(
      catalogCategoriesService.reorderCategories({
        workspaceId: workspace.id,
        userId: owner.id,
        categoryIds: [starters.id],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const other = await createWorkspace();
    const foreign = await createCategory(
      other.workspace.id,
      other.owner.id,
      "Foreign",
    );

    await expect(
      catalogCategoriesService.reorderCategories({
        workspaceId: workspace.id,
        userId: owner.id,
        categoryIds: [starters.id, mains.id, foreign.id],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rolls back the reorder and its audit rows when the transaction fails", async () => {
    const { owner, workspace } = await createWorkspace();
    const starters = await createCategory(workspace.id, owner.id, "Starters");
    const mains = await createCategory(workspace.id, owner.id, "Mains");

    await expect(
      testDb.transaction(async (tx) => {
        await new CatalogCategoriesService(tx).reorderCategories({
          workspaceId: workspace.id,
          userId: owner.id,
          categoryIds: [mains.id, starters.id],
        });

        throw new Error("rollback");
      }),
    ).rejects.toMatchObject({ message: "rollback" });

    const rows = await testDb
      .select()
      .from(catalogCategories)
      .where(eq(catalogCategories.workspaceId, workspace.id));
    expect(rows.find((row) => row.id === starters.id)?.position).toBe(0);
    expect(rows.find((row) => row.id === mains.id)?.position).toBe(1);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.workspaceId, workspace.id),
          eq(activityLogs.entityType, "catalog_category"),
        ),
      );
    expect(logs.filter((log) => log.summary.includes("reordered"))).toHaveLength(
      0,
    );
  });
});
