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
import { workspaceMembers } from "../db/schemas/workspaceMembers";
import { selectWorkspaceSchema, workspaces } from "../db/schemas/workspaces";
import { InternalError } from "../utils/InternalError";

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
  workspace: workspaceWithRelationsSchema.nullable(),
});

type GetWorkspaceByIdResponse = z.infer<typeof getWorkspaceByIdResponseSchema>;

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
   * Returns a single workspace by id in the same shape as `getWorkspaces`,
   * joined with its organization and the user's organization membership row.
   * Returns null when the workspace does not exist or the user is not a member
   * of its organization.
   */
  async getWorkspaceById(
    props: GetWorkspaceByIdProps,
  ): Promise<GetWorkspaceByIdResponse> {
    const [workspace] = await this.db
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
          eq(organizationMembers.userId, props.userId),
        ),
      )
      .where(eq(workspaces.id, props.id))
      .limit(1);

    return { workspace: workspace ?? null };
  }

  /**
   * Creates a workspace inside an organization. Permissions are enforced by the
   * route layer; this method only requires an organization membership for the
   * caller, which also supplies the `organizationMemberId`.
   *
   * Slugs are server-generated (`slugify` + random suffix) and retried when a
   * concurrent create claims the same value. The creator is also added as a
   * workspace member with the `admin` role so they appear in member lists.
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

    if (name === undefined || name === existingWorkspace.workspace.name) {
      if (props.description === undefined) {
        return { workspace: existingWorkspace.workspace };
      }

      const [workspace] = await this.db
        .update(workspaces)
        .set({ description: props.description })
        .where(eq(workspaces.id, props.id))
        .returning();

      return { workspace: workspace ?? null };
    }

    const slugBase = toWorkspaceSlugBase(name);

    for (let attempt = 0; attempt < WORKSPACE_SLUG_ATTEMPTS; attempt++) {
      const slug = `${slugBase}-${nanoid(WORKSPACE_SLUG_SUFFIX_LENGTH)}`;

      try {
        const [workspace] = await this.db
          .update(workspaces)
          .set({
            name,
            slug,
            description: props.description,
          })
          .where(eq(workspaces.id, props.id))
          .returning();

        return { workspace: workspace ?? null };
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
  createWorkspaceSchema,
  createWorkspaceResponseSchema,
  updateWorkspaceSchema,
  updateWorkspaceResponseSchema,
  WorkspacesService,
};
