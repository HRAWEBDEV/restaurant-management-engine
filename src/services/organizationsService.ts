import { z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import slugify from "slugify";
import type { DBExecutor } from "../db/connect";
import { organizationMembers } from "../db/schemas/organizationMembers";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";
import { organizationActivity } from "../utils/activityDefinitions";
import { InternalError } from "../utils/InternalError";
import { ActivityLogger } from "./activityLoggerService";
import { UsersService } from "./usersService";

const ORGANIZATION_SLUG_MAX_LENGTH = 150;
const ORGANIZATION_SLUG_SUFFIX_LENGTH = 8;
const ORGANIZATION_SLUG_ATTEMPTS = 5;

/**
 * Builds the human-readable part of an organization slug. The random suffix
 * is appended per attempt so a conflict can simply be retried.
 */
function toOrganizationSlugBase(name: string) {
  const base = slugify(name, { lower: true, strict: true, trim: true })
    .slice(
      0,
      ORGANIZATION_SLUG_MAX_LENGTH - ORGANIZATION_SLUG_SUFFIX_LENGTH - 1,
    )
    .replace(/-+$/, "");

  return base || "organization";
}

/**
 * Postgres reports unique-constraint violations with SQLSTATE 23505, which Bun
 * surfaces as `errno` on its Postgres errors.
 */
function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    error.errno === "23505"
  );
}

const getOrganizationsFiltersSchema = z.object({
  userId: z.uuid().optional(),
});

type GetOrganizationsFilters = z.infer<typeof getOrganizationsFiltersSchema>;

type GetOrganizationsProps = {
  filters?: GetOrganizationsFilters;
};

const getOrganizationsResponseSchema = z.object({
  organizations: z.array(selectOrganizationSchema),
});

type GetOrganizationsResponse = z.infer<typeof getOrganizationsResponseSchema>;

type GetOrganizationByIdProps = {
  id: string;
};

const getOrganizationByIdResponseSchema = z.object({
  organization: selectOrganizationSchema.nullable(),
});

type GetOrganizationByIdResponse = z.infer<
  typeof getOrganizationByIdResponseSchema
>;

type CreateOrganizationProps = {
  userId: string;
  name: string;
  logo?: string | null;
  description?: string | null;
};

const createOrganizationResponseSchema = z.object({
  organization: selectOrganizationSchema,
});

type CreateOrganizationResponse = z.infer<
  typeof createOrganizationResponseSchema
>;

const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  logo: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

type UpdateOrganizationProps = UpdateOrganizationInput & {
  id: string;
  userId: string;
};

const updateOrganizationResponseSchema = z.object({
  organization: selectOrganizationSchema.nullable(),
});

type UpdateOrganizationResponse = z.infer<
  typeof updateOrganizationResponseSchema
>;

/**
 * Data access service for organizations.
 *
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class OrganizationsService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns a list of organizations, newest first, optionally narrowed by
   * filters. When `userId` is provided, only organizations the user is a
   * member of are returned.
   */
  async getOrganizations(
    props: GetOrganizationsProps,
  ): Promise<GetOrganizationsResponse> {
    const filterConditions: SQL[] = [];
    const userId = props.filters?.userId;

    if (userId) {
      filterConditions.push(
        inArray(
          organizations.id,
          this.db
            .select({ organizationId: organizationMembers.organizationId })
            .from(organizationMembers)
            .where(eq(organizationMembers.userId, userId)),
        ),
      );
    }

    const result = await this.db
      .select()
      .from(organizations)
      .where(filterConditions.length > 0 ? and(...filterConditions) : undefined)
      .orderBy(desc(organizations.createdAt));

    return { organizations: result };
  }

  /**
   * Creates an organization and its first membership in a single transaction,
   * making `userId` the organization owner.
   *
   * Slugs are server-generated (`slugify` + random suffix) and retried when a
   * concurrent create claims the same value.
   */
  async createOrganization(
    props: CreateOrganizationProps,
  ): Promise<CreateOrganizationResponse> {
    const slugBase = toOrganizationSlugBase(props.name);

    for (let attempt = 0; attempt < ORGANIZATION_SLUG_ATTEMPTS; attempt++) {
      const slug = `${slugBase}-${nanoid(ORGANIZATION_SLUG_SUFFIX_LENGTH)}`;

      try {
        return await this.db.transaction(async (tx) => {
          const [organization] = await tx
            .insert(organizations)
            .values({
              name: props.name,
              slug,
              logo: props.logo ?? null,
              description: props.description ?? null,
            })
            .returning();

          if (!organization) {
            throw new InternalError("organization insert returned no row");
          }

          await tx.insert(organizationMembers).values({
            organizationId: organization.id,
            userId: props.userId,
            role: "owner",
            addedBy: props.userId,
          });

          return { organization };
        });
      } catch (error) {
        if (
          attempt < ORGANIZATION_SLUG_ATTEMPTS - 1 &&
          isUniqueViolation(error)
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new InternalError("could not generate a unique organization slug");
  }

  /**
   * Returns a single organization by id, or null when it does not exist.
   */
  async getOrganizationById(
    props: GetOrganizationByIdProps,
  ): Promise<GetOrganizationByIdResponse> {
    const [organization] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, props.id))
      .limit(1);

    return { organization: organization ?? null };
  }

  /**
   * Updates an organization's name, logo, and/or description by id. A changed
   * name regenerates the organization slug.
   *
   * Permissions are enforced by the route layer; this method only scopes access
   * to the caller's organization membership. Returns the updated row, the
   * current row when no update fields are given, or null when the organization
   * does not exist or the caller is not a member of it.
   *
   * Each mutation runs with an `organization.updated` activity row on the same
   * transaction, diffed against the pre-update row.
   */
  async updateOrganization(
    props: UpdateOrganizationProps,
  ): Promise<UpdateOrganizationResponse> {
    const [existing] = await this.db
      .select({ organization: organizations })
      .from(organizations)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, organizations.id),
          eq(organizationMembers.userId, props.userId),
        ),
      )
      .where(eq(organizations.id, props.id))
      .limit(1);

    if (!existing) {
      return { organization: null };
    }

    const existingOrganization = existing.organization;
    const name = props.name;
    const nameChanged =
      name !== undefined && name !== existingOrganization.name;

    if (
      !nameChanged &&
      props.logo === undefined &&
      props.description === undefined
    ) {
      return { organization: existingOrganization };
    }

    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: props.userId,
    });
    const actorLabel = actor?.name ?? "unknown user";

    if (!nameChanged) {
      return await this.db.transaction(async (tx) => {
        const [organization] = await tx
          .update(organizations)
          .set({ logo: props.logo, description: props.description })
          .where(eq(organizations.id, props.id))
          .returning();

        if (!organization) {
          throw new InternalError("organization update returned no row");
        }

        // Written on the same transaction, so the audit row commits or
        // rolls back together with the organization.
        await new ActivityLogger(tx).recordChange(organizationActivity, {
          organizationId: organization.id,
          actor: { userId: props.userId, label: actorLabel },
          action: "updated",
          entityId: organization.id,
          before: existingOrganization,
          after: organization,
        });

        return { organization };
      });
    }

    const slugBase = toOrganizationSlugBase(name);

    for (let attempt = 0; attempt < ORGANIZATION_SLUG_ATTEMPTS; attempt++) {
      const slug = `${slugBase}-${nanoid(ORGANIZATION_SLUG_SUFFIX_LENGTH)}`;

      try {
        return await this.db.transaction(async (tx) => {
          const [organization] = await tx
            .update(organizations)
            .set({
              name,
              slug,
              logo: props.logo,
              description: props.description,
            })
            .where(eq(organizations.id, props.id))
            .returning();

          if (!organization) {
            throw new InternalError("organization update returned no row");
          }

          // Written on the same transaction, so a slug-conflict retry rolls
          // the audit row back together with the failed update.
          await new ActivityLogger(tx).recordChange(organizationActivity, {
            organizationId: organization.id,
            actor: { userId: props.userId, label: actorLabel },
            action: "updated",
            entityId: organization.id,
            before: existingOrganization,
            after: organization,
          });

          return { organization };
        });
      } catch (error) {
        if (
          attempt < ORGANIZATION_SLUG_ATTEMPTS - 1 &&
          isUniqueViolation(error)
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new InternalError("could not generate a unique organization slug");
  }
}

export type {
  GetOrganizationsProps,
  GetOrganizationsFilters,
  GetOrganizationsResponse,
  GetOrganizationByIdProps,
  GetOrganizationByIdResponse,
  CreateOrganizationProps,
  CreateOrganizationResponse,
  UpdateOrganizationInput,
  UpdateOrganizationProps,
  UpdateOrganizationResponse,
};
export {
  getOrganizationsFiltersSchema,
  getOrganizationsResponseSchema,
  getOrganizationByIdResponseSchema,
  createOrganizationResponseSchema,
  updateOrganizationSchema,
  updateOrganizationResponseSchema,
  OrganizationsService,
};
