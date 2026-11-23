import { z } from "@hono/zod-openapi";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DBExecutor } from "../db/connect";
import {
  ogMemberRoles,
  organizationMembers,
  selectOrganizationMemberSchema,
} from "../db/schemas/organizationMembers";
import type { OrganizationMember } from "../db/schemas/organizationMembers";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";
import { selectUserSchema, user } from "../../auth-schema";
import { ActivityLogger } from "./activityLoggerService";
import { organizationMemberActivity } from "../utils/activityDefinitions";
import { ConflictError } from "../utils/ConflictError";
import { isUniqueViolation } from "../utils/dbErrors";
import { InternalError } from "../utils/InternalError";
import { UsersService } from "./usersService";

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

/**
 * Limited member view for signed-in callers who are not members of the
 * organization: per member, only the display fields — no ids, roles, or
 * membership metadata.
 */
const getOrganizationMembersLimitedResponseSchema = z.object({
  members: z.array(
    z.object({
      user: selectUserSchema.pick({
        firstName: true,
        lastName: true,
        email: true,
      }),
    }),
  ),
});

type GetOrganizationMembersLimitedResponse = z.infer<
  typeof getOrganizationMembersLimitedResponseSchema
>;

const addedByUser = alias(user, "added_by_user");

type GetOrganizationMembersResponse = z.infer<
  typeof getOrganizationMembersResponseSchema
>;

const getOrganizationMemberPropsSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
});

type GetOrganizationMemberProps = z.infer<typeof getOrganizationMemberPropsSchema>;

const getOrganizationMemberResponseSchema = z.object({
  member: selectOrganizationMemberSchema.nullable(),
});

type GetOrganizationMemberResponse = z.infer<
  typeof getOrganizationMemberResponseSchema
>;

const updateOrganizationRoleSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: z.enum(ogMemberRoles),
  actorUserId: z.string().min(1),
});

type UpdateOrganizationRoleProps = z.infer<typeof updateOrganizationRoleSchema>;

const updateOrganizationRoleResponseSchema = z.object({
  member: selectOrganizationMemberSchema.nullable(),
});

type UpdateOrganizationRoleResponse = z.infer<
  typeof updateOrganizationRoleResponseSchema
>;

const addOrganizationMemberSchema = z.object({
  organizationId: z.uuid(),
  userId: z.string().min(1),
  role: z.enum(ogMemberRoles).optional(),
  addedBy: z.string().min(1).nullish(),
});

type AddOrganizationMemberProps = z.infer<typeof addOrganizationMemberSchema>;

const addOrganizationMemberResponseSchema = z.object({
  member: selectOrganizationMemberSchema,
});

type AddOrganizationMemberResponse = z.infer<
  typeof addOrganizationMemberResponseSchema
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
   * Returns a membership by id, scoped to the given organization — a membership
   * id from another organization is reported as missing. Returns null when no
   * membership matches.
   */
  async getOrganizationMemberById(
    props: GetOrganizationMemberProps,
  ): Promise<GetOrganizationMemberResponse> {
    const [member] = await this.db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.id, props.id),
          eq(organizationMembers.organizationId, props.organizationId),
        ),
      )
      .limit(1);

    return { member: member ?? null };
  }

  /**
   * Updates the role of an organization membership by id, scoped to the given
   * organization — a membership id from another organization is reported as
   * missing. Authorization is enforced by the route layer. The update and an
   * `organization_member.updated` activity row run on one transaction, diffed
   * against the pre-update row. Returns the updated row or null when the
   * membership does not exist in the organization.
   */
  async updateOrganizationRole(
    props: UpdateOrganizationRoleProps,
  ): Promise<UpdateOrganizationRoleResponse> {
    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: props.actorUserId,
    });
    const actorLabel = actor?.name ?? "unknown user";

    return this.db.transaction(async (tx) => {
      const { member: before } = await new OrganizationMembersService(
        tx,
      ).getOrganizationMemberById({
        id: props.id,
        organizationId: props.organizationId,
      });

      if (!before) {
        return { member: null };
      }

      const [member] = await tx
        .update(organizationMembers)
        .set({ role: props.role })
        .where(eq(organizationMembers.id, before.id))
        .returning();

      if (!member) {
        throw new InternalError(
          "organization member role update returned no row",
        );
      }

      // Written on the same transaction, so the audit row commits or rolls
      // back together with the membership.
      await new ActivityLogger(tx).recordChange(organizationMemberActivity, {
        organizationId: props.organizationId,
        actor: { userId: props.actorUserId, label: actorLabel },
        action: "updated",
        entityId: member.id,
        before,
        after: member,
      });

      return { member };
    });
  }

  /**
   * Inserts an organization membership. The role defaults to plain `member`;
   * `addedBy` records the acting user, or stays null when the member joined
   * without being added by anyone. Callers must resolve the
   * target user and authorize the acting user first — the membership unique
   * index is the concurrency backstop, so an existing membership raises
   * `ConflictError`. Accepts a transaction executor, so it participates in an
   * enclosing transaction.
   */
  async addOrganizationMember(
    props: AddOrganizationMemberProps,
  ): Promise<AddOrganizationMemberResponse> {
    let member: OrganizationMember | undefined;

    try {
      [member] = await this.db
        .insert(organizationMembers)
        .values({
          organizationId: props.organizationId,
          userId: props.userId,
          role: props.role ?? "member",
          addedBy: props.addedBy ?? null,
        })
        .returning();
    } catch (error) {
      // `organization_members_unique` is the only unique constraint on this
      // table; a violation means the user is already a member.
      if (isUniqueViolation(error)) {
        throw new ConflictError("user is already a member of this organization");
      }

      throw error;
    }

    if (!member) {
      throw new InternalError("organization member insert returned no row");
    }

    return { member };
  }
}

export type {
  GetOrganizationMembersFilters,
  GetOrganizationMembersProps,
  GetOrganizationMembersResponse,
  GetOrganizationMembersLimitedResponse,
  GetOrganizationMemberProps,
  GetOrganizationMemberResponse,
  UpdateOrganizationRoleProps,
  UpdateOrganizationRoleResponse,
  AddOrganizationMemberProps,
  AddOrganizationMemberResponse,
};
export {
  getOrganizationMembersFiltersSchema,
  organizationMemberWithRelationsSchema,
  getOrganizationMembersResponseSchema,
  getOrganizationMembersLimitedResponseSchema,
  getOrganizationMemberPropsSchema,
  getOrganizationMemberResponseSchema,
  updateOrganizationRoleSchema,
  updateOrganizationRoleResponseSchema,
  addOrganizationMemberSchema,
  addOrganizationMemberResponseSchema,
  OrganizationMembersService,
};
