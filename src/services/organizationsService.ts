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
import { InternalError } from "../utils/InternalError";

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
}

export type {
  GetOrganizationsProps,
  GetOrganizationsFilters,
  GetOrganizationsResponse,
  GetOrganizationByIdProps,
  GetOrganizationByIdResponse,
  CreateOrganizationProps,
  CreateOrganizationResponse,
};
export {
  getOrganizationsFiltersSchema,
  getOrganizationsResponseSchema,
  getOrganizationByIdResponseSchema,
  createOrganizationResponseSchema,
  OrganizationsService,
};
