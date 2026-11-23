import { z } from "@hono/zod-openapi";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DBExecutor } from "../db/connect";
import {
  organizationMembers,
  selectOrganizationMemberSchema,
} from "../db/schemas/organizationMembers";
import {
  selectWorkspaceMemberSchema,
  workspaceMembers,
  workspaceRoles,
} from "../db/schemas/workspaceMembers";
import type { WorkspaceMember } from "../db/schemas/workspaceMembers";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";
import {
  selectWorkspaceSchema,
  workspaces,
} from "../db/schemas/workspaces";
import { selectUserSchema, user } from "../../auth-schema";
import { ActivityLogger } from "./activityLoggerService";
import { workspaceMemberActivity } from "../utils/activityDefinitions";
import { ConflictError } from "../utils/ConflictError";
import { isUniqueViolation } from "../utils/dbErrors";
import { InternalError } from "../utils/InternalError";
import { UsersService } from "./usersService";

const getWorkspaceMembersFiltersSchema = z.object({
  workspaceId: z.uuid(),
  userId: z.string().optional(),
  role: z.enum(workspaceRoles).optional(),
});

type GetWorkspaceMembersFilters = z.infer<
  typeof getWorkspaceMembersFiltersSchema
>;

type GetWorkspaceMembersProps = {
  filters: GetWorkspaceMembersFilters;
};

const workspaceMemberWithRelationsSchema = z.object({
  member: selectWorkspaceMemberSchema,
  workspace: selectWorkspaceSchema,
  organization: selectOrganizationSchema,
  user: selectUserSchema,
  addedByUser: selectUserSchema.nullable(),
});

const getWorkspaceMembersResponseSchema = z.object({
  members: z.array(workspaceMemberWithRelationsSchema),
});

type GetWorkspaceMembersResponse = z.infer<
  typeof getWorkspaceMembersResponseSchema
>;

const addedByUser = alias(user, "added_by_user");

const getWorkspaceMemberPropsSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
});

type GetWorkspaceMemberProps = z.infer<typeof getWorkspaceMemberPropsSchema>;

const getWorkspaceMemberResponseSchema = z.object({
  member: selectWorkspaceMemberSchema.nullable(),
});

type GetWorkspaceMemberResponse = z.infer<
  typeof getWorkspaceMemberResponseSchema
>;

const updateWorkspaceRoleSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  role: z.enum(workspaceRoles),
  actorUserId: z.string().min(1),
});

type UpdateWorkspaceRoleProps = z.infer<typeof updateWorkspaceRoleSchema>;

const updateWorkspaceRoleResponseSchema = z.object({
  member: selectWorkspaceMemberSchema.nullable(),
});

type UpdateWorkspaceRoleResponse = z.infer<
  typeof updateWorkspaceRoleResponseSchema
>;

const addWorkspaceMemberSchema = z.object({
  workspaceId: z.uuid(),
  userId: z.string().min(1),
  role: z.enum(workspaceRoles).optional(),
  addedBy: z.string().min(1).nullish(),
});

type AddWorkspaceMemberProps = z.infer<typeof addWorkspaceMemberSchema>;

const addWorkspaceMemberResponseSchema = z.object({
  member: selectWorkspaceMemberSchema.nullable(),
});

type AddWorkspaceMemberResponse = z.infer<
  typeof addWorkspaceMemberResponseSchema
>;

const removeWorkspaceMemberSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  actorUserId: z.string().min(1),
});

type RemoveWorkspaceMemberProps = z.infer<
  typeof removeWorkspaceMemberSchema
>;

const removeWorkspaceMemberResponseSchema = z.object({
  member: selectWorkspaceMemberSchema.nullable(),
});

type RemoveWorkspaceMemberResponse = z.infer<
  typeof removeWorkspaceMemberResponseSchema
>;

/**
 * Data access service for workspace memberships.
 *
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class WorkspaceMembersService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns the memberships of a workspace, oldest join first, joined with the
   * workspace, its organization, the member's user row (through the underlying
   * organization membership), and the user who added them (`addedByUser`, null
   * when unknown). Optionally narrowed by user or role.
   */
  async getWorkspaceMembers(
    props: GetWorkspaceMembersProps,
  ): Promise<GetWorkspaceMembersResponse> {
    const filterConditions: SQL[] = [
      eq(workspaceMembers.workspaceId, props.filters.workspaceId),
    ];

    if (props.filters.userId) {
      filterConditions.push(
        eq(organizationMembers.userId, props.filters.userId),
      );
    }

    if (props.filters.role) {
      filterConditions.push(eq(workspaceMembers.role, props.filters.role));
    }

    const members = await this.db
      .select({
        member: workspaceMembers,
        workspace: workspaces,
        organization: organizations,
        user,
        addedByUser,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .innerJoin(
        organizations,
        eq(workspaces.organizationId, organizations.id),
      )
      .innerJoin(
        organizationMembers,
        eq(workspaceMembers.organizationMemberId, organizationMembers.id),
      )
      .innerJoin(user, eq(organizationMembers.userId, user.id))
      .leftJoin(addedByUser, eq(workspaceMembers.addedBy, addedByUser.id))
      .where(and(...filterConditions))
      .orderBy(asc(workspaceMembers.joinedAt));

    return { members };
  }

  /**
   * Returns a membership by id, scoped to the given workspace — a membership id
   * from another workspace is reported as missing. Returns null when no
   * membership matches.
   */
  async getWorkspaceMemberById(
    props: GetWorkspaceMemberProps,
  ): Promise<GetWorkspaceMemberResponse> {
    const [member] = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.id, props.id),
          eq(workspaceMembers.workspaceId, props.workspaceId),
        ),
      )
      .limit(1);

    return { member: member ?? null };
  }

  /**
   * Updates the role of a workspace membership by id, scoped to the given
   * workspace — a membership id from another workspace is reported as missing.
   * Authorization is enforced by the route layer. The update and a
   * `workspace_member.updated` activity row run on one transaction, diffed
   * against the pre-update row. Returns the updated row or null when the
   * membership does not exist in the workspace.
   */
  async updateWorkspaceRole(
    props: UpdateWorkspaceRoleProps,
  ): Promise<UpdateWorkspaceRoleResponse> {
    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: props.actorUserId,
    });
    const actorLabel = actor?.name ?? "unknown user";

    return this.db.transaction(async (tx) => {
      const { member: before } = await new WorkspaceMembersService(
        tx,
      ).getWorkspaceMemberById({
        id: props.id,
        workspaceId: props.workspaceId,
      });

      if (!before) {
        return { member: null };
      }

      const [member] = await tx
        .update(workspaceMembers)
        .set({ role: props.role })
        .where(eq(workspaceMembers.id, before.id))
        .returning();

      if (!member) {
        throw new InternalError("workspace member role update returned no row");
      }

      // Written on the same transaction, so the audit row commits or rolls
      // back together with the membership.
      await new ActivityLogger(tx).recordChange(workspaceMemberActivity, {
        organizationId: before.organizationId,
        workspaceId: before.workspaceId,
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
   * Inserts a workspace membership for a user who is already a member of the
   * workspace's organization: the workspace supplies the organization, and the
   * user's organization membership row supplies the `organizationMemberId` the
   * composite FK requires. The role defaults to plain `member`; `addedBy`
   * records the acting user, or stays null when the member joined without
   * being added by anyone. Callers must authorize the acting user first.
   * Returns null when the workspace does not exist or the user is not a member
   * of its organization; the membership unique index is the concurrency
   * backstop, so an existing membership raises `ConflictError`. Accepts a
   * transaction executor, so it participates in an enclosing transaction.
   */
  async addWorkspaceMember(
    props: AddWorkspaceMemberProps,
  ): Promise<AddWorkspaceMemberResponse> {
    const [workspace] = await this.db
      .select({ organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, props.workspaceId))
      .limit(1);

    if (!workspace) {
      return { member: null };
    }

    const [organizationMembership] = await this.db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(
            organizationMembers.organizationId,
            workspace.organizationId,
          ),
          eq(organizationMembers.userId, props.userId),
        ),
      )
      .limit(1);

    if (!organizationMembership) {
      return { member: null };
    }

    let member: WorkspaceMember | undefined;

    try {
      [member] = await this.db
        .insert(workspaceMembers)
        .values({
          workspaceId: props.workspaceId,
          organizationMemberId: organizationMembership.id,
          organizationId: workspace.organizationId,
          role: props.role ?? "member",
          addedBy: props.addedBy ?? null,
        })
        .returning();
    } catch (error) {
      // `workspace_members_unique` is the only unique constraint on this
      // table; a violation means the user is already a member.
      if (isUniqueViolation(error)) {
        throw new ConflictError("user is already a member of this workspace");
      }

      throw error;
    }

    if (!member) {
      throw new InternalError("workspace member insert returned no row");
    }

    return { member };
  }

  /**
   * Deletes a workspace membership by id, scoped to the given workspace — a
   * membership id from another workspace is reported as missing. Authorization
   * is enforced by the route layer. The delete and a `workspace_member.deleted`
   * activity row run on one transaction, diffed against the pre-delete row.
   * Returns the deleted row or null when the membership does not exist in the
   * workspace.
   */
  async removeWorkspaceMember(
    props: RemoveWorkspaceMemberProps,
  ): Promise<RemoveWorkspaceMemberResponse> {
    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: props.actorUserId,
    });
    const actorLabel = actor?.name ?? "unknown user";

    return this.db.transaction(async (tx) => {
      const { member: before } = await new WorkspaceMembersService(
        tx,
      ).getWorkspaceMemberById({
        id: props.id,
        workspaceId: props.workspaceId,
      });

      if (!before) {
        return { member: null };
      }

      const [member] = await tx
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, before.id))
        .returning();

      if (!member) {
        throw new InternalError("workspace member delete returned no row");
      }

      // Written on the same transaction, so the audit row commits or rolls
      // back together with the membership.
      await new ActivityLogger(tx).recordChange(workspaceMemberActivity, {
        organizationId: before.organizationId,
        workspaceId: before.workspaceId,
        actor: { userId: props.actorUserId, label: actorLabel },
        action: "deleted",
        entityId: member.id,
        before,
        after: null,
      });

      return { member };
    });
  }
}

export type {
  GetWorkspaceMembersFilters,
  GetWorkspaceMembersProps,
  GetWorkspaceMembersResponse,
  GetWorkspaceMemberProps,
  GetWorkspaceMemberResponse,
  UpdateWorkspaceRoleProps,
  UpdateWorkspaceRoleResponse,
  AddWorkspaceMemberProps,
  AddWorkspaceMemberResponse,
  RemoveWorkspaceMemberProps,
  RemoveWorkspaceMemberResponse,
};
export {
  getWorkspaceMembersFiltersSchema,
  workspaceMemberWithRelationsSchema,
  getWorkspaceMembersResponseSchema,
  getWorkspaceMemberPropsSchema,
  getWorkspaceMemberResponseSchema,
  updateWorkspaceRoleSchema,
  updateWorkspaceRoleResponseSchema,
  addWorkspaceMemberSchema,
  addWorkspaceMemberResponseSchema,
  removeWorkspaceMemberSchema,
  removeWorkspaceMemberResponseSchema,
  WorkspaceMembersService,
};
