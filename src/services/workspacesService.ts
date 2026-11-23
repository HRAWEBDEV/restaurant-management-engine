import { z } from "@hono/zod-openapi";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import slugify from "slugify";
import type { DBExecutor } from "../db/connect";
import {
  organizationMembers,
  selectOrganizationMemberSchema,
} from "../db/schemas/organizationMembers";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";
import {
  selectWorkspaceMemberSchema,
  workspaceMembers,
} from "../db/schemas/workspaceMembers";
import { selectWorkspaceSchema, workspaces } from "../db/schemas/workspaces";
import { workspaceActivity } from "../utils/activityDefinitions";
import { isUniqueViolation } from "../utils/dbErrors";
import { InternalError } from "../utils/InternalError";
import { ActivityLogger } from "./activityLoggerService";
import { UsersService } from "./usersService";

const WORKSPACE_SLUG_MAX_LENGTH = 150;
const WORKSPACE_SLUG_SUFFIX_LENGTH = 8;
const WORKSPACE_SLUG_ATTEMPTS = 5;

/**
 * Builds the human-readable part of a workspace slug. The random suffix is
 * appended per attempt so a conflict can simply be retried.
 */
function toWorkspaceSlugBase(name: string) {
  const base = slugify(name, { lower: true, strict: true, trim: true })
    .slice(0, WORKSPACE_SLUG_MAX_LENGTH - WORKSPACE_SLUG_SUFFIX_LENGTH - 1)
    .replace(/-+$/, "");

  return base || "workspace";
}

const getWorkspacesFiltersSchema = z.object({
  userId: z.string(),
});

type GetWorkspacesFilters = z.infer<typeof getWorkspacesFiltersSchema>;

type GetWorkspacesProps = {
  filters: GetWorkspacesFilters;
};

const workspaceWithRelationsSchema = z.object({
  workspace: selectWorkspaceSchema,
  organization: selectOrganizationSchema,
  member: selectOrganizationMemberSchema,
});

const getWorkspacesResponseSchema = z.object({
  workspaces: z.array(workspaceWithRelationsSchema),
});

type GetWorkspacesResponse = z.infer<typeof getWorkspacesResponseSchema>;

type GetWorkspaceByIdProps = {
  id: string;
  userId: string;
};

const getWorkspaceByIdResponseSchema = z.object({
  workspace: selectWorkspaceSchema.nullable(),
});

type GetWorkspaceByIdResponse = z.infer<typeof getWorkspaceByIdResponseSchema>;

/**
 * Service-level response for `getWorkspaceById`: the workspace joined with its
 * organization, the caller's organization membership row, and the caller's
 * workspace membership row when they are a member of the workspace itself.
 * The membership rows carry the roles the route layer needs for
 * `checkLevelPermissions`; all fields are null when the workspace does not
 * exist or the caller is not a member of its organization.
 */
const getWorkspaceWithMembershipResponseSchema = z.object({
  workspace: selectWorkspaceSchema.nullable(),
  organization: selectOrganizationSchema.nullable(),
  membership: selectOrganizationMemberSchema.nullable(),
  workspaceMembership: selectWorkspaceMemberSchema.nullable(),
});

type GetWorkspaceWithMembershipResponse = z.infer<
  typeof getWorkspaceWithMembershipResponseSchema
>;

const createWorkspaceSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
});

type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

type CreateWorkspaceProps = CreateWorkspaceInput & {
  userId: string;
};

const createWorkspaceResponseSchema = z.object({
  workspace: selectWorkspaceSchema.nullable(),
});

type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
});

type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

type UpdateWorkspaceProps = UpdateWorkspaceInput & {
  id: string;
  userId: string;
};

const updateWorkspaceResponseSchema = z.object({
  workspace: selectWorkspaceSchema.nullable(),
});

type UpdateWorkspaceResponse = z.infer<typeof updateWorkspaceResponseSchema>;

/**
 * Data access service for workspaces.
 *
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class WorkspacesService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns the workspaces the user has access to through their organization
   * membership, newest first, joined with the workspace's organization and the
   * user's organization membership row.
   */
  async getWorkspaces(
    props: GetWorkspacesProps,
  ): Promise<GetWorkspacesResponse> {
    const filterConditions: SQL[] = [
      eq(organizationMembers.userId, props.filters.userId),
    ];

    const result = await this.db
      .select({
        workspace: workspaces,
        organization: organizations,
        member: organizationMembers,
      })
      .from(workspaces)
      .innerJoin(organizations, eq(workspaces.organizationId, organizations.id))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, workspaces.organizationId),
          eq(organizationMembers.userId, props.filters.userId),
        ),
      )
      .where(and(...filterConditions))
      .orderBy(desc(workspaces.createdAt));

    return { workspaces: result };
  }

  /**
   * Returns a single workspace by id together with the caller's organization
   * membership row, and the caller's workspace membership row when they are a
   * member of the workspace itself. The membership rows carry the roles the
   * route layer needs for `checkLevelPermissions`; all fields are null when
   * the workspace does not exist or the caller is not a member of its
   * organization.
   */
  async getWorkspaceById(
    props: GetWorkspaceByIdProps,
  ): Promise<GetWorkspaceWithMembershipResponse> {
    const [existing] = await this.db
      .select({
        workspace: workspaces,
        organization: organizations,
        membership: organizationMembers,
        workspaceMembership: workspaceMembers,
      })
      .from(workspaces)
      .innerJoin(organizations, eq(workspaces.organizationId, organizations.id))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, workspaces.organizationId),
          eq(organizationMembers.userId, props.userId),
        ),
      )
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.organizationMemberId, organizationMembers.id),
        ),
      )
      .where(eq(workspaces.id, props.id))
      .limit(1);

    return {
      workspace: existing?.workspace ?? null,
      organization: existing?.organization ?? null,
      membership: existing?.membership ?? null,
      workspaceMembership: existing?.workspaceMembership ?? null,
    };
  }

  /**
   * Creates a workspace inside an organization. Permissions are enforced by the
   * route layer; this method only requires an organization membership for the
   * caller, which also supplies the `organizationMemberId`.
   *
   * Slugs are server-generated (`slugify` + random suffix) and retried when a
   * concurrent create claims the same value. The creator is also added as a
   * workspace member with the `admin` role so they appear in member lists. A
   * `workspace.created` activity row is written on the same transaction.
   *
   * Returns null when the caller is not a member of the organization.
   */
  async createWorkspace(
    props: CreateWorkspaceProps,
  ): Promise<CreateWorkspaceResponse> {
    const [membership] = await this.db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, props.organizationId),
          eq(organizationMembers.userId, props.userId),
        ),
      )
      .limit(1);

    if (!membership) {
      return { workspace: null };
    }

    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: props.userId,
    });
    const actorLabel = actor?.name ?? "unknown user";

    const slugBase = toWorkspaceSlugBase(props.name);

    for (let attempt = 0; attempt < WORKSPACE_SLUG_ATTEMPTS; attempt++) {
      const slug = `${slugBase}-${nanoid(WORKSPACE_SLUG_SUFFIX_LENGTH)}`;

      try {
        return await this.db.transaction(async (tx) => {
          const [workspace] = await tx
            .insert(workspaces)
            .values({
              organizationId: props.organizationId,
              name: props.name,
              slug,
              description: props.description ?? null,
              createdBy: props.userId,
            })
            .returning();

          if (!workspace) {
            throw new InternalError("workspace insert returned no row");
          }

          await tx.insert(workspaceMembers).values({
            workspaceId: workspace.id,
            organizationMemberId: membership.id,
            organizationId: props.organizationId,
            role: "admin",
            addedBy: props.userId,
          });

          // Written on the same transaction, so the audit row commits or
          // rolls back together with the workspace.
          await new ActivityLogger(tx).recordChange(workspaceActivity, {
            organizationId: props.organizationId,
            workspaceId: workspace.id,
            actor: { userId: props.userId, label: actorLabel },
            action: "created",
            entityId: workspace.id,
            after: workspace,
          });

          return { workspace };
        });
      } catch (error) {
        if (attempt < WORKSPACE_SLUG_ATTEMPTS - 1 && isUniqueViolation(error)) {
          continue;
        }

        throw error;
      }
    }

    throw new InternalError("could not generate a unique workspace slug");
  }

  /**
   * Updates a workspace's name and/or description by id. A changed name
   * regenerates the workspace slug.
   *
   * Permissions are enforced by the route layer; this method only scopes access
   * to the caller's organization membership. Returns the updated row, the
   * current row when no update fields are given, or null when the workspace
   * does not exist or the caller cannot access it.
   *
   * Each mutation runs with a `workspace.updated` activity row on the same
   * transaction, diffed against the pre-update row.
   */
  async updateWorkspace(
    props: UpdateWorkspaceProps,
  ): Promise<UpdateWorkspaceResponse> {
    const { workspace: existingWorkspace } = await this.getWorkspaceById({
      id: props.id,
      userId: props.userId,
    });

    if (!existingWorkspace) {
      return { workspace: null };
    }

    const name = props.name;
    const nameChanged =
      name !== undefined && name !== existingWorkspace.name;

    if (!nameChanged && props.description === undefined) {
      return { workspace: existingWorkspace };
    }

    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: actor } = await new UsersService(this.db).getUserById({
      id: props.userId,
    });
    const actorLabel = actor?.name ?? "unknown user";

    if (!nameChanged) {
      return await this.db.transaction(async (tx) => {
        const [workspace] = await tx
          .update(workspaces)
          .set({ description: props.description })
          .where(eq(workspaces.id, props.id))
          .returning();

        if (!workspace) {
          throw new InternalError("workspace update returned no row");
        }

        // Written on the same transaction, so the audit row commits or
        // rolls back together with the workspace.
        await new ActivityLogger(tx).recordChange(workspaceActivity, {
          organizationId: existingWorkspace.organizationId,
          workspaceId: workspace.id,
          actor: { userId: props.userId, label: actorLabel },
          action: "updated",
          entityId: workspace.id,
          before: existingWorkspace,
          after: workspace,
        });

        return { workspace };
      });
    }

    const slugBase = toWorkspaceSlugBase(name);

    for (let attempt = 0; attempt < WORKSPACE_SLUG_ATTEMPTS; attempt++) {
      const slug = `${slugBase}-${nanoid(WORKSPACE_SLUG_SUFFIX_LENGTH)}`;

      try {
        return await this.db.transaction(async (tx) => {
          const [workspace] = await tx
            .update(workspaces)
            .set({
              name,
              slug,
              description: props.description,
            })
            .where(eq(workspaces.id, props.id))
            .returning();

          if (!workspace) {
            throw new InternalError("workspace update returned no row");
          }

          // Written on the same transaction, so a slug-conflict retry rolls
          // the audit row back together with the failed update.
          await new ActivityLogger(tx).recordChange(workspaceActivity, {
            organizationId: existingWorkspace.organizationId,
            workspaceId: workspace.id,
            actor: { userId: props.userId, label: actorLabel },
            action: "updated",
            entityId: workspace.id,
            before: existingWorkspace,
            after: workspace,
          });

          return { workspace };
        });
      } catch (error) {
        if (attempt < WORKSPACE_SLUG_ATTEMPTS - 1 && isUniqueViolation(error)) {
          continue;
        }

        throw error;
      }
    }

    throw new InternalError("could not generate a unique workspace slug");
  }
}

export type {
  GetWorkspacesFilters,
  GetWorkspacesProps,
  GetWorkspacesResponse,
  GetWorkspaceByIdProps,
  GetWorkspaceByIdResponse,
  GetWorkspaceWithMembershipResponse,
  CreateWorkspaceInput,
  CreateWorkspaceProps,
  CreateWorkspaceResponse,
  UpdateWorkspaceInput,
  UpdateWorkspaceProps,
  UpdateWorkspaceResponse,
};
export {
  getWorkspacesFiltersSchema,
  workspaceWithRelationsSchema,
  getWorkspacesResponseSchema,
  getWorkspaceByIdResponseSchema,
  getWorkspaceWithMembershipResponseSchema,
  createWorkspaceSchema,
  createWorkspaceResponseSchema,
  updateWorkspaceSchema,
  updateWorkspaceResponseSchema,
  WorkspacesService,
};
