import { z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { DBExecutor } from "../db/connect";
import { organizationMembers } from "../db/schemas/organizationMembers";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";

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
};
export {
  getOrganizationsFiltersSchema,
  getOrganizationsResponseSchema,
  getOrganizationByIdResponseSchema,
  OrganizationsService,
};
