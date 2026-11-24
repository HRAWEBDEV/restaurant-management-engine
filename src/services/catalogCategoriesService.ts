import { z } from "@hono/zod-openapi";
import { and, asc, eq, max } from "drizzle-orm";
import type { DBExecutor } from "../db/connect";
import {
  catalogCategories,
  selectCatalogCategorySchema,
} from "../db/schemas/catalogCategories";
import { workspaces } from "../db/schemas/workspaces";
import { catalogCategoryActivity } from "../utils/activityDefinitions";
import { ConflictError } from "../utils/ConflictError";
import { isUniqueViolation } from "../utils/dbErrors";
import { InternalError } from "../utils/InternalError";
import { ActivityLogger } from "./activityLoggerService";
import { UsersService } from "./usersService";

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
});

type CreateCategoryInput = z.infer<typeof createCategorySchema>;

type CreateCategoryProps = CreateCategoryInput & {
  workspaceId: string;
  userId: string;
};

const createCategoryResponseSchema = z.object({
  category: selectCatalogCategorySchema.nullable(),
});

type CreateCategoryResponse = z.infer<typeof createCategoryResponseSchema>;

const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

type UpdateCategoryProps = UpdateCategoryInput & {
  id: string;
  workspaceId: string;
  userId: string;
};

const updateCategoryResponseSchema = z.object({
  category: selectCatalogCategorySchema.nullable(),
});

type UpdateCategoryResponse = z.infer<typeof updateCategoryResponseSchema>;

const reorderCategoriesSchema = z.object({
  categoryIds: z.array(z.uuid()).min(1),
});

type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>;

type ReorderCategoriesProps = ReorderCategoriesInput & {
  workspaceId: string;
  userId: string;
};

const getCatalogCategoriesFiltersSchema = z.object({
  workspaceId: z.uuid(),
});

type GetCatalogCategoriesFilters = z.infer<
  typeof getCatalogCategoriesFiltersSchema
>;

type GetCatalogCategoriesProps = {
  filters: GetCatalogCategoriesFilters;
};

const getCatalogCategoriesResponseSchema = z.object({
  categories: z.array(selectCatalogCategorySchema),
});

type GetCatalogCategoriesResponse = z.infer<
  typeof getCatalogCategoriesResponseSchema
>;

type GetCatalogCategoryByIdProps = {
  id: string;
  workspaceId: string;
};

const getCatalogCategoryByIdResponseSchema = z.object({
  category: selectCatalogCategorySchema.nullable(),
});

type GetCatalogCategoryByIdResponse = z.infer<
  typeof getCatalogCategoryByIdResponseSchema
>;

const reorderCategoriesResponseSchema = z.object({
  categories: z.array(selectCatalogCategorySchema),
});

type ReorderCategoriesResponse = z.infer<typeof reorderCategoriesResponseSchema>;

/**
 * Data access service for catalog categories — the menu groupings of a
 * workspace ("Starters", "Drinks").
 *
 * Every query is scoped by `workspaceId`; permissions are enforced by the
 * route layer. Deletion is archiving (`is_active = false`): rows stay
 * referenceable by future menu items and orders. Accepts either the shared
 * db instance or a transaction executor, so the same service can be reused
 * inside `db.transaction(...)` blocks.
 */
class CatalogCategoriesService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns every category of the workspace, position first (oldest created
   * breaks ties). Archived categories are included — this is the back-office
   * read; availability filtering happens in the composite menu read.
   */
  async getCatalogCategories(
    props: GetCatalogCategoriesProps,
  ): Promise<GetCatalogCategoriesResponse> {
    const categories = await this.db
      .select()
      .from(catalogCategories)
      .where(eq(catalogCategories.workspaceId, props.filters.workspaceId))
      .orderBy(asc(catalogCategories.position), asc(catalogCategories.createdAt));

    return { categories };
  }

  /**
   * Returns a single category scoped to the workspace, or null when the id is
   * unknown or belongs to another workspace.
   */
  async getCatalogCategoryById(
    props: GetCatalogCategoryByIdProps,
  ): Promise<GetCatalogCategoryByIdResponse> {
    const [category] = await this.db
      .select()
      .from(catalogCategories)
      .where(
        and(
          eq(catalogCategories.id, props.id),
          eq(catalogCategories.workspaceId, props.workspaceId),
        ),
      )
      .limit(1);

    return { category: category ?? null };
  }

  /**
   * Creates a category in the workspace. The new row is appended to the end
   * of the current order (max position + 1). A name already used in the
   * workspace raises `ConflictError`. A `catalog_category.created` activity
   * row is written on the same transaction.
   *
   * Returns null when the workspace does not exist.
   */
  async createCategory(
    props: CreateCategoryProps,
  ): Promise<CreateCategoryResponse> {
    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { category: null };
    }

    const [maxRow] = await this.db
      .select({ maxPosition: max(catalogCategories.position) })
      .from(catalogCategories)
      .where(eq(catalogCategories.workspaceId, props.workspaceId));

    const position = (maxRow?.maxPosition ?? -1) + 1;
    const actorLabel = await this.getActorLabel(props.userId);

    try {
      return await this.db.transaction(async (tx) => {
        const [category] = await tx
          .insert(catalogCategories)
          .values({
            workspaceId: props.workspaceId,
            name: props.name,
            description: props.description ?? null,
            position,
          })
          .returning();

        if (!category) {
          throw new InternalError("catalog category insert returned no row");
        }

        await new ActivityLogger(tx).recordChange(catalogCategoryActivity, {
          organizationId,
          workspaceId: props.workspaceId,
          actor: { userId: props.userId, label: actorLabel },
          action: "created",
          entityId: category.id,
          after: category,
        });

        return { category };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("category name already exists in this workspace");
      }

      throw error;
    }
  }

  /**
   * Updates a category's name, description, and/or active flag scoped to the
   * workspace. A no-change request returns the current row without writing an
   * audit row. A name already used by another category of the workspace
   * raises `ConflictError`. A `catalog_category.updated` activity row with
   * the field-level diff is written on the same transaction.
   *
   * Returns null when the category does not exist in this workspace.
   */
  async updateCategory(
    props: UpdateCategoryProps,
  ): Promise<UpdateCategoryResponse> {
    const { category: existing } = await this.getCatalogCategoryById({
      id: props.id,
      workspaceId: props.workspaceId,
    });

    if (!existing) {
      return { category: null };
    }

    const values: Partial<typeof catalogCategories.$inferInsert> = {};

    if (props.name !== undefined && props.name !== existing.name) {
      values.name = props.name;
    }

    if (
      props.description !== undefined &&
      props.description !== existing.description
    ) {
      values.description = props.description;
    }

    if (props.isActive !== undefined && props.isActive !== existing.isActive) {
      values.isActive = props.isActive;
    }

    if (Object.keys(values).length === 0) {
      return { category: existing };
    }

    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { category: null };
    }

    const actorLabel = await this.getActorLabel(props.userId);

    try {
      return await this.db.transaction(async (tx) => {
        const [category] = await tx
          .update(catalogCategories)
          .set(values)
          .where(
            and(
              eq(catalogCategories.id, props.id),
              eq(catalogCategories.workspaceId, props.workspaceId),
            ),
          )
          .returning();

        if (!category) {
          throw new InternalError("catalog category update returned no row");
        }

        await new ActivityLogger(tx).recordChange(catalogCategoryActivity, {
          organizationId,
          workspaceId: props.workspaceId,
          actor: { userId: props.userId, label: actorLabel },
          action: "updated",
          entityId: category.id,
          before: existing,
          after: category,
        });

        return { category };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("category name already exists in this workspace");
      }

      throw error;
    }
  }

  /**
   * Archives a category (`is_active = false`) instead of deleting it, so rows
   * stay referenceable by menu items and future orders. Archiving an already
   * archived category returns the current row without writing an audit row. A
   * `catalog_category.archived` activity row is written on the same
   * transaction.
   *
   * Returns null when the category does not exist in this workspace.
   */
  async archiveCategory(
    props: GetCatalogCategoryByIdProps & { userId: string },
  ): Promise<UpdateCategoryResponse> {
    const { category: existing } = await this.getCatalogCategoryById({
      id: props.id,
      workspaceId: props.workspaceId,
    });

    if (!existing) {
      return { category: null };
    }

    if (!existing.isActive) {
      return { category: existing };
    }

    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { category: null };
    }

    const actorLabel = await this.getActorLabel(props.userId);

    return await this.db.transaction(async (tx) => {
      const [category] = await tx
        .update(catalogCategories)
        .set({ isActive: false })
        .where(
          and(
            eq(catalogCategories.id, props.id),
            eq(catalogCategories.workspaceId, props.workspaceId),
          ),
        )
        .returning();

      if (!category) {
        throw new InternalError("catalog category archive returned no row");
      }

      await new ActivityLogger(tx).recordChange(catalogCategoryActivity, {
        organizationId,
        workspaceId: props.workspaceId,
        actor: { userId: props.userId, label: actorLabel },
        action: "archived",
        entityId: category.id,
        before: existing,
        after: category,
      });

      return { category };
    });
  }

  /**
   * Rewrites the positions of the workspace's categories from a full ordered
   * id list — the client sends every category id exactly once, in display
   * order, and positions become 0..n-1. A list that does not match the
   * workspace's current categories (stale view, foreign id, duplicate) raises
   * `ConflictError`, so a reorder never silently drops or resurrects rows.
   *
   * Each category whose position actually changed writes a
   * `catalog_category.updated` activity row (diff on `position`) on the same
   * transaction. Returns the categories in the new order.
   */
  async reorderCategories(
    props: ReorderCategoriesProps,
  ): Promise<ReorderCategoriesResponse> {
    const { categories: existing } = await this.getCatalogCategories({
      filters: { workspaceId: props.workspaceId },
    });

    const existingIds = new Set(existing.map((category) => category.id));
    const requestedIds = new Set(props.categoryIds);

    const isSameSet =
      existing.length === props.categoryIds.length &&
      props.categoryIds.every((id) => existingIds.has(id)) &&
      existing.every((category) => requestedIds.has(category.id));

    if (!isSameSet) {
      throw new ConflictError(
        "category ids do not match the workspace's categories",
      );
    }

    if (existing.length === 0) {
      return { categories: [] };
    }

    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { categories: [] };
    }

    const actorLabel = await this.getActorLabel(props.userId);
    const targetPositions = new Map(
      props.categoryIds.map((id, index) => [id, index] as const),
    );

    return await this.db.transaction(async (tx) => {
      const updatedById = new Map<string, typeof catalogCategories.$inferSelect>();

      for (const category of existing) {
        const nextPosition = targetPositions.get(category.id) ?? -1;

        if (nextPosition === category.position) {
          updatedById.set(category.id, category);
          continue;
        }

        const [updated] = await tx
          .update(catalogCategories)
          .set({ position: nextPosition })
          .where(eq(catalogCategories.id, category.id))
          .returning();

        if (!updated) {
          throw new InternalError("catalog category reorder returned no row");
        }

        await new ActivityLogger(tx).recordChange(catalogCategoryActivity, {
          organizationId,
          workspaceId: props.workspaceId,
          actor: { userId: props.userId, label: actorLabel },
          action: "updated",
          entityId: updated.id,
          before: category,
          after: updated,
          summary: `${actorLabel} reordered category "${updated.name}"`,
        });

        updatedById.set(updated.id, updated);
      }

      const categories = props.categoryIds
        .map((id) => updatedById.get(id))
        .filter((category) => category !== undefined);

      return { categories };
    });
  }

  /**
   * Resolves the organization a workspace belongs to, for the audit rows'
   * tenant scope. Returns null when the workspace does not exist.
   */
  private async getWorkspaceOrganizationId(workspaceId: string) {
    const [workspace] = await this.db
      .select({ organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    return workspace?.organizationId ?? null;
  }

  /**
   * Snapshot label for the audit row; survives later user renames/deletes.
   */
  private async getActorLabel(userId: string) {
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: userId,
    });

    return actor?.name ?? "unknown user";
  }
}

export type {
  GetCatalogCategoriesProps,
  GetCatalogCategoriesFilters,
  GetCatalogCategoriesResponse,
  GetCatalogCategoryByIdProps,
  GetCatalogCategoryByIdResponse,
  CreateCategoryInput,
  CreateCategoryProps,
  CreateCategoryResponse,
  UpdateCategoryInput,
  UpdateCategoryProps,
  UpdateCategoryResponse,
  ReorderCategoriesInput,
  ReorderCategoriesProps,
  ReorderCategoriesResponse,
};
export {
  createCategorySchema,
  createCategoryResponseSchema,
  updateCategorySchema,
  updateCategoryResponseSchema,
  reorderCategoriesSchema,
  reorderCategoriesResponseSchema,
  getCatalogCategoriesFiltersSchema,
  getCatalogCategoriesResponseSchema,
  getCatalogCategoryByIdResponseSchema,
  CatalogCategoriesService,
};
