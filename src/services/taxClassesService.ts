import { z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import type { DBExecutor } from "../db/connect";
import {
  taxClasses,
  selectTaxClassSchema,
} from "../db/schemas/taxClasses";
import { workspaces } from "../db/schemas/workspaces";
import { taxClassActivity } from "../utils/activityDefinitions";
import { ConflictError } from "../utils/ConflictError";
import { isUniqueViolation } from "../utils/dbErrors";
import { InternalError } from "../utils/InternalError";
import { ActivityLogger } from "./activityLoggerService";
import { UsersService } from "./usersService";

const createTaxClassSchema = z.object({
  name: z.string().min(1).max(100),
  rate: z.number().int().min(0),
  isDefault: z.boolean().optional(),
});

type CreateTaxClassInput = z.infer<typeof createTaxClassSchema>;

type CreateTaxClassProps = CreateTaxClassInput & {
  workspaceId: string;
  userId: string;
};

const createTaxClassResponseSchema = z.object({
  taxClass: selectTaxClassSchema.nullable(),
});

type CreateTaxClassResponse = z.infer<typeof createTaxClassResponseSchema>;

const updateTaxClassSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  rate: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

type UpdateTaxClassInput = z.infer<typeof updateTaxClassSchema>;

type UpdateTaxClassProps = UpdateTaxClassInput & {
  id: string;
  workspaceId: string;
  userId: string;
};

const updateTaxClassResponseSchema = z.object({
  taxClass: selectTaxClassSchema.nullable(),
});

type UpdateTaxClassResponse = z.infer<typeof updateTaxClassResponseSchema>;

const getTaxClassesFiltersSchema = z.object({
  workspaceId: z.uuid(),
});

type GetTaxClassesFilters = z.infer<typeof getTaxClassesFiltersSchema>;

type GetTaxClassesProps = {
  filters: GetTaxClassesFilters;
};

const getTaxClassesResponseSchema = z.object({
  taxClasses: z.array(selectTaxClassSchema),
});

type GetTaxClassesResponse = z.infer<typeof getTaxClassesResponseSchema>;

type GetTaxClassByIdProps = {
  id: string;
  workspaceId: string;
};

const getTaxClassByIdResponseSchema = z.object({
  taxClass: selectTaxClassSchema.nullable(),
});

type GetTaxClassByIdResponse = z.infer<typeof getTaxClassByIdResponseSchema>;

type DeleteTaxClassProps = GetTaxClassByIdProps & {
  userId: string;
};

const deleteTaxClassResponseSchema = z.object({
  taxClass: selectTaxClassSchema.nullable(),
});

type DeleteTaxClassResponse = z.infer<typeof deleteTaxClassResponseSchema>;

/**
 * Data access service for tax classes — the workspace's named sales-tax rates
 * ("VAT 8.25%", stored as basis points). A workspace holds at most one
 * default class at the database level (partial unique index); the service
 * keeps the stronger invariant that a workspace with any tax class always has
 * exactly one default: the first created class becomes the default, promoting
 * a new default clears the old one, and deleting the default promotes the
 * oldest remaining class. Unsetting the default flag directly is rejected —
 * the caller must promote another class instead. Tax classes are hard-deleted
 * (they carry no archive flag).
 *
 * Every query is scoped by `workspaceId`; permissions are enforced by the
 * route layer. Accepts either the shared db instance or a transaction
 * executor, so the same service can be reused inside `db.transaction(...)`
 * blocks.
 */
class TaxClassesService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns every tax class of the workspace, oldest created first.
   */
  async getTaxClasses(
    props: GetTaxClassesProps,
  ): Promise<GetTaxClassesResponse> {
    const taxClassRows = await this.db
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.workspaceId, props.filters.workspaceId))
      .orderBy(asc(taxClasses.createdAt), asc(taxClasses.id));

    return { taxClasses: taxClassRows };
  }

  /**
   * Returns a single tax class scoped to the workspace, or null when the id
   * is unknown or belongs to another workspace.
   */
  async getTaxClassById(
    props: GetTaxClassByIdProps,
  ): Promise<GetTaxClassByIdResponse> {
    const [taxClass] = await this.db
      .select()
      .from(taxClasses)
      .where(
        and(
          eq(taxClasses.id, props.id),
          eq(taxClasses.workspaceId, props.workspaceId),
        ),
      )
      .limit(1);

    return { taxClass: taxClass ?? null };
  }

  /**
   * Creates a tax class in the workspace. The first class of a workspace is
   * always the default; passing `isDefault: true` afterwards promotes the new
   * class and demotes the previous default on the same transaction. A name
   * already used in the workspace raises `ConflictError`. A
   * `tax_class.created` activity row is written on the same transaction.
   *
   * Returns null when the workspace does not exist.
   */
  async createTaxClass(
    props: CreateTaxClassProps,
  ): Promise<CreateTaxClassResponse> {
    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { taxClass: null };
    }

    const actorLabel = await this.getActorLabel(props.userId);

    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: taxClasses.id, isDefault: taxClasses.isDefault })
          .from(taxClasses)
          .where(eq(taxClasses.workspaceId, props.workspaceId));

        const promote = props.isDefault === true || existing.length === 0;

        if (promote) {
          await tx
            .update(taxClasses)
            .set({ isDefault: false })
            .where(
              and(
                eq(taxClasses.workspaceId, props.workspaceId),
                eq(taxClasses.isDefault, true),
              ),
            );
        }

        const [taxClass] = await tx
          .insert(taxClasses)
          .values({
            workspaceId: props.workspaceId,
            name: props.name,
            rate: props.rate,
            isDefault: promote,
          })
          .returning();

        if (!taxClass) {
          throw new InternalError("tax class insert returned no row");
        }

        await new ActivityLogger(tx).recordChange(taxClassActivity, {
          organizationId,
          workspaceId: props.workspaceId,
          actor: { userId: props.userId, label: actorLabel },
          action: "created",
          entityId: taxClass.id,
          after: taxClass,
        });

        return { taxClass };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "tax class name already exists in this workspace",
        );
      }

      throw error;
    }
  }

  /**
   * Updates a tax class's name, rate, and/or default flag scoped to the
   * workspace. Setting `isDefault: true` promotes the class and demotes the
   * previous default on the same transaction; setting `isDefault: false` on
   * the current default raises `ConflictError` (promote another class
   * instead, so the workspace never loses its default while classes remain).
   * A no-change request returns the current row without writing an audit
   * row. A name already used by another class of the workspace raises
   * `ConflictError`. A `tax_class.updated` activity row with the field-level
   * diff is written on the same transaction.
   *
   * Returns null when the tax class does not exist in this workspace.
   */
  async updateTaxClass(
    props: UpdateTaxClassProps,
  ): Promise<UpdateTaxClassResponse> {
    const { taxClass: existing } = await this.getTaxClassById({
      id: props.id,
      workspaceId: props.workspaceId,
    });

    if (!existing) {
      return { taxClass: null };
    }

    if (props.isDefault === false && existing.isDefault) {
      throw new ConflictError(
        "cannot unset the default tax class; set another tax class as default instead",
      );
    }

    const values: Partial<typeof taxClasses.$inferInsert> = {};

    if (props.name !== undefined && props.name !== existing.name) {
      values.name = props.name;
    }

    if (props.rate !== undefined && props.rate !== existing.rate) {
      values.rate = props.rate;
    }

    const promote = props.isDefault === true && !existing.isDefault;

    if (Object.keys(values).length === 0 && !promote) {
      return { taxClass: existing };
    }

    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { taxClass: null };
    }

    const actorLabel = await this.getActorLabel(props.userId);

    try {
      return await this.db.transaction(async (tx) => {
        if (promote) {
          await tx
            .update(taxClasses)
            .set({ isDefault: false })
            .where(
              and(
                eq(taxClasses.workspaceId, props.workspaceId),
                eq(taxClasses.isDefault, true),
              ),
            );
        }

        const [taxClass] = await tx
          .update(taxClasses)
          .set({ ...values, ...(promote ? { isDefault: true } : {}) })
          .where(
            and(
              eq(taxClasses.id, props.id),
              eq(taxClasses.workspaceId, props.workspaceId),
            ),
          )
          .returning();

        if (!taxClass) {
          throw new InternalError("tax class update returned no row");
        }

        await new ActivityLogger(tx).recordChange(taxClassActivity, {
          organizationId,
          workspaceId: props.workspaceId,
          actor: { userId: props.userId, label: actorLabel },
          action: "updated",
          entityId: taxClass.id,
          before: existing,
          after: taxClass,
        });

        return { taxClass };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "tax class name already exists in this workspace",
        );
      }

      throw error;
    }
  }

  /**
   * Hard-deletes a tax class (tax classes carry no archive flag — items
   * reference a rate, not a historical row). When the deleted class was the
   * workspace's default, the oldest remaining class is promoted on the same
   * transaction with its own `tax_class.updated` audit row; with no remaining
   * class, the workspace is left without a default until one is created. A
   * `tax_class.deleted` activity row is written on the same transaction.
   *
   * Returns null when the tax class does not exist in this workspace.
   */
  async deleteTaxClass(
    props: DeleteTaxClassProps,
  ): Promise<DeleteTaxClassResponse> {
    const { taxClass: existing } = await this.getTaxClassById({
      id: props.id,
      workspaceId: props.workspaceId,
    });

    if (!existing) {
      return { taxClass: null };
    }

    const organizationId = await this.getWorkspaceOrganizationId(
      props.workspaceId,
    );

    if (!organizationId) {
      return { taxClass: null };
    }

    const actorLabel = await this.getActorLabel(props.userId);

    return await this.db.transaction(async (tx) => {
      const [taxClass] = await tx
        .delete(taxClasses)
        .where(
          and(
            eq(taxClasses.id, props.id),
            eq(taxClasses.workspaceId, props.workspaceId),
          ),
        )
        .returning();

      if (!taxClass) {
        throw new InternalError("tax class delete returned no row");
      }

      await new ActivityLogger(tx).recordChange(taxClassActivity, {
        organizationId,
        workspaceId: props.workspaceId,
        actor: { userId: props.userId, label: actorLabel },
        action: "deleted",
        entityId: taxClass.id,
        before: existing,
      });

      if (existing.isDefault) {
        const [remaining] = await tx
          .select()
          .from(taxClasses)
          .where(eq(taxClasses.workspaceId, props.workspaceId))
          .orderBy(asc(taxClasses.createdAt), asc(taxClasses.id))
          .limit(1);

        if (remaining) {
          const [promoted] = await tx
            .update(taxClasses)
            .set({ isDefault: true })
            .where(eq(taxClasses.id, remaining.id))
            .returning();

          if (!promoted) {
            throw new InternalError("tax class default promotion returned no row");
          }

          await new ActivityLogger(tx).recordChange(taxClassActivity, {
            organizationId,
            workspaceId: props.workspaceId,
            actor: { userId: props.userId, label: actorLabel },
            action: "updated",
            entityId: promoted.id,
            before: remaining,
            after: promoted,
            summary: `${actorLabel} made tax class "${promoted.name}" the workspace default`,
          });
        }
      }

      return { taxClass };
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
  GetTaxClassesProps,
  GetTaxClassesFilters,
  GetTaxClassesResponse,
  GetTaxClassByIdProps,
  GetTaxClassByIdResponse,
  CreateTaxClassInput,
  CreateTaxClassProps,
  CreateTaxClassResponse,
  UpdateTaxClassInput,
  UpdateTaxClassProps,
  UpdateTaxClassResponse,
  DeleteTaxClassProps,
  DeleteTaxClassResponse,
};
export {
  createTaxClassSchema,
  createTaxClassResponseSchema,
  updateTaxClassSchema,
  updateTaxClassResponseSchema,
  getTaxClassesFiltersSchema,
  getTaxClassesResponseSchema,
  getTaxClassByIdResponseSchema,
  deleteTaxClassResponseSchema,
  TaxClassesService,
};
