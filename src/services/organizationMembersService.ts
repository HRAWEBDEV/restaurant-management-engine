import { z } from "@hono/zod-openapi";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  addedByUser: selectUserSchema.nullable(),
});

const getOrganizationMembersResponseSchema = z.object({
  members: z.array(organizationMemberWithRelationsSchema),
});

const addedByUser = alias(user, "added_by_user");

type GetOrganizationMembersResponse = z.infer<
  typeof getOrganizationMembersResponseSchema
>;

const updateOrganizationRoleSchema = z.object({
  id: z.uuid(),
  role: z.enum(ogMemberRoles),
});

type UpdateOrganizationRoleProps = z.infer<typeof updateOrganizationRoleSchema>;

const updateOrganizationRoleResponseSchema = z.object({
  member: selectOrganizationMemberSchema.nullable(),
});

type UpdateOrganizationRoleResponse = z.infer<
  typeof updateOrganizationRoleResponseSchema
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
   * the organization, the member's user row, and the user who added them
   * (`addedByUser`, null when unknown). Optionally narrowed by user or role.
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
        addedByUser,
      })
      .from(organizationMembers)
      .innerJoin(
        organizations,
        eq(organizationMembers.organizationId, organizations.id),
      )
      .innerJoin(user, eq(organizationMembers.userId, user.id))
      .leftJoin(addedByUser, eq(organizationMembers.addedBy, addedByUser.id))
      .where(and(...filterConditions))
      .orderBy(asc(organizationMembers.joinedAt));

    return { members };
  }

  /**
   * Updates the role of an organization membership by id, returning the updated
   * row or null when the membership does not exist.
   */
  async updateOrganizationRole(
    props: UpdateOrganizationRoleProps,
  ): Promise<UpdateOrganizationRoleResponse> {
    const [member] = await this.db
      .update(organizationMembers)
      .set({ role: props.role })
      .where(eq(organizationMembers.id, props.id))
      .returning();

    return { member: member ?? null };
  }
}

export type {
  GetOrganizationMembersFilters,
  GetOrganizationMembersProps,
  GetOrganizationMembersResponse,
  UpdateOrganizationRoleProps,
  UpdateOrganizationRoleResponse,
};
export {
  getOrganizationMembersFiltersSchema,
  organizationMemberWithRelationsSchema,
  getOrganizationMembersResponseSchema,
  updateOrganizationRoleSchema,
  updateOrganizationRoleResponseSchema,
  OrganizationMembersService,
};
