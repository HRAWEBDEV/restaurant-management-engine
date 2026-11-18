import { z } from "@hono/zod-openapi";
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { DBExecutor } from "../db/connect";
import {
  ogMemberRoles,
  organizationMembers,
  selectOrganizationMemberSchema,
} from "../db/schemas/organizationMembers";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";
import { selectUserSchema, user } from "../../auth-schema";

const getOrganizationMembersFiltersSchema = z.object({
  organizationId: z.uuid(),
  userId: z.string().optional(),
  role: z.enum(ogMemberRoles).optional(),
});

type GetOrganizationMembersFilters = z.infer<
  typeof getOrganizationMembersFiltersSchema
>;

type GetOrganizationMembersProps = {
  filters: GetOrganizationMembersFilters;
};

const organizationMemberWithRelationsSchema = z.object({
  member: selectOrganizationMemberSchema,
  organization: selectOrganizationSchema,
  user: selectUserSchema,
});

const getOrganizationMembersResponseSchema = z.object({
  members: z.array(organizationMemberWithRelationsSchema),
});

type GetOrganizationMembersResponse = z.infer<
  typeof getOrganizationMembersResponseSchema
>;

/**
 * Data access service for organization memberships.
 *
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class OrganizationMembersService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns the memberships of an organization, oldest join first, joined with
   * the organization and the member's user row. Optionally narrowed by user or
   * role.
   */
  async getOrganizationMembers(
    props: GetOrganizationMembersProps,
  ): Promise<GetOrganizationMembersResponse> {
    const filterConditions: SQL[] = [
      eq(organizationMembers.organizationId, props.filters.organizationId),
    ];

    if (props.filters.userId) {
      filterConditions.push(
        eq(organizationMembers.userId, props.filters.userId),
      );
    }

    if (props.filters.role) {
      filterConditions.push(eq(organizationMembers.role, props.filters.role));
    }

    const members = await this.db
      .select({
        member: organizationMembers,
        organization: organizations,
        user,
      })
      .from(organizationMembers)
      .innerJoin(
        organizations,
        eq(organizationMembers.organizationId, organizations.id),
      )
      .innerJoin(user, eq(organizationMembers.userId, user.id))
      .where(and(...filterConditions))
      .orderBy(asc(organizationMembers.joinedAt));

    return { members };
  }
}

export type {
  GetOrganizationMembersFilters,
  GetOrganizationMembersProps,
  GetOrganizationMembersResponse,
};
export {
  getOrganizationMembersFiltersSchema,
  organizationMemberWithRelationsSchema,
  getOrganizationMembersResponseSchema,
  OrganizationMembersService,
};
